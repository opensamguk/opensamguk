import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { LoadActor, prepareLoadFixtures } from './fixtures';
import { LoadHttpError, type LoadInput, type LoadOutput } from './http';
import { LOAD_CONTRACT } from './contract';
import { userWorkload, type WorkloadProcedure } from './workload';
import { expectedOwnedAbort, LoadSseParser, settleLoadSseReader } from './sse';
import type { LoadRun, RequestSample } from './report';
import { emitGeneratorEvent, type GeneratorEvent, type GeneratorEventSink } from './journal';

type FixtureWorld = Awaited<ReturnType<typeof prepareLoadFixtures>>['worlds'][number];
type State = {
  actor: LoadActor;
  cityKey: number;
  nationId: number;
  recipientId: number;
  thinkMs: number;
  turns: LoadOutput<'turns.get'>;
  worker: LoadRun['workers'][number] | null;
};

async function prepareUser(actor: LoadActor, recipientId: number, signal: AbortSignal): Promise<State> {
  const home = await actor.client.request('home.get', { worldId: actor.worldId }, signal);
  const map = await actor.client.request('world.map', { worldId: actor.worldId }, signal);
  const turns = await actor.client.request('turns.get', { worldId: actor.worldId }, signal);
  if (!map.data.nations.length || turns.data.slots.length !== 30) throw new Error('LOAD_USER_CONTEXT_INVALID');
  return {
    actor,
    cityKey: home.data.general.cityKey,
    nationId: map.data.nations[0]!.id,
    recipientId,
    thinkMs: 1000,
    turns: turns.data,
    worker: null,
  };
}

export async function runNativeLoad(
  worlds: readonly FixtureWorld[],
  options: { mode: 'formal' | 'smoke'; seed: string; signal: AbortSignal; onEvent?: GeneratorEventSink },
) {
  if (worlds.length !== 2 || new Set(worlds.map((world) => world.worldId)).size !== 2)
    throw new Error('LOAD_TWO_WORLDS_REQUIRED');
  const perWorld = options.mode === 'formal' ? LOAD_CONTRACT.usersPerWorld : 5;
  if (worlds.some((world) => world.users.length < perWorld || world.actors.length !== 109))
    throw new Error('LOAD_ACTORS_MISSING');
  const owned = new AbortController();
  const signal = AbortSignal.any([options.signal, owned.signal]);
  const emit = async (event: GeneratorEvent) => {
    if (options.onEvent) await emitGeneratorEvent(options.onEvent, event, signal);
  };
  const sse: LoadRun['sse'] = [];
  const samples: RequestSample[] = [];
  const attempts: LoadRun['attempts'] = [];
  const workerEvidence: LoadRun['workers'] = [];
  const pumps: Promise<void>[] = [];
  const setups: Promise<State>[] = [];
  const workers: Promise<void>[] = [];
  const failures: LoadRun['generatorFailures'] = [];
  let stopping = false;
  let warmupStartedAt = 0,
    measurementStartedAt = 0,
    measurementFinishedAt = 0;
  // 연결 대기는 유한하며 본문 스트림에는 전체 실행의 signal을 유지한다.
  const setupTimer = setTimeout(() => owned.abort(), 30_000);
  async function connect(actor: LoadActor, worldIndex: number, userIndex: number) {
    signal.throwIfAborted();
    const entry = {
      worldId: actor.worldId,
      userId: actor.userId,
      readyAt: null as number | null,
      closedAt: null as number | null,
      failed: false,
    };
    sse.push(entry);
    const response = await actor.client.openSse(actor.worldId, signal);
    signal.throwIfAborted();
    const reader = response.body!.getReader();
    const parser = new LoadSseParser();
    let resolveReady!: () => void, rejectReady!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = () => reject(new Error('LOAD_SSE_NOT_READY'));
    });
    const pump = (async () => {
      try {
        while (!signal.aborted) {
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) break;
          parser.feed(next.value);
          if (parser.ready && entry.readyAt === null) {
            entry.readyAt = Date.now();
            if (options.onEvent) await emit({ kind: 'sse', state: 'ready', worldIndex, userIndex, at: entry.readyAt });
            resolveReady();
          }
        }
        if (!stopping) {
          entry.failed = true;
          failures.push('SSE_EARLY_END');
        }
      } catch (error) {
        if (!expectedOwnedAbort(error, owned.signal, stopping)) {
          entry.failed = true;
          failures.push('SSE_READ_FAILED');
        }
      } finally {
        if (entry.readyAt === null) rejectReady();
        const closed = await settleLoadSseReader(reader, owned.signal, stopping);
        if (!closed) {
          entry.failed = true;
          failures.push('SSE_CANCEL_FAILED');
        } else entry.closedAt = Date.now();
      }
    })().catch(() => {
      entry.failed = true;
      failures.push('SSE_PUMP_CLEANUP_FAILED');
    });
    pumps.push(pump);
    await ready;
  }
  try {
    signal.throwIfAborted();
    for (const [worldIndex, world] of worlds.entries()) {
      for (const [index, actor] of world.users.slice(0, perWorld).entries()) {
        const recipient = world.actors[(index + 1) % world.actors.length]!;
        setups.push(
          (async () => {
            const state = await prepareUser(actor, recipient.generalId, signal);
            signal.throwIfAborted();
            await connect(actor, worldIndex, index);
            signal.throwIfAborted();
            return state;
          })(),
        );
      }
    }
    const states = await Promise.all(setups);
    clearTimeout(setupTimer);
    signal.throwIfAborted();
    const warmupMs = options.mode === 'formal' ? LOAD_CONTRACT.warmupMs : 1000;
    const measurementMs = options.mode === 'formal' ? LOAD_CONTRACT.measurementMs : 60_000;
    const startedMono = performance.now();
    warmupStartedAt = Date.now();
    measurementStartedAt = warmupStartedAt + warmupMs;
    measurementFinishedAt = measurementStartedAt + measurementMs;
    if (options.onEvent)
      await emit({ kind: 'start', at: warmupStartedAt, measurementStartedAt, measurementFinishedAt });
    const timestamp = () => warmupStartedAt + performance.now() - startedMono;
    async function request<P extends WorkloadProcedure>(state: State, procedure: P, input: LoadInput<P>) {
      const worker = state.worker;
      if (!worker) throw new Error('LOAD_WORKER_MISSING');
      const elapsed = performance.now() - startedMono;
      const startedAt = warmupStartedAt + elapsed;
      const phase = elapsed < warmupMs ? ('warmup' as const) : ('measure' as const);
      const attempt = {
        worldId: state.actor.worldId,
        userId: state.actor.userId,
        sequence: ++worker.attempted,
        procedure,
        thinkMs: state.thinkMs,
        startedAt,
        completedAt: null as number | null,
      };
      attempts.push(attempt);
      // journal 대기도 실제 요청 시작~본문 완료 시간에 포함한다. 후크로 지연을 축소하지 않는다.
      if (options.onEvent)
        await emit({
          kind: 'attempt',
          worldIndex: worker.worldIndex,
          userIndex: worker.userIndex,
          sequence: attempt.sequence,
          procedure,
          thinkMs: state.thinkMs,
          at: startedAt,
        });
      signal.throwIfAborted();
      try {
        const result = await state.actor.client.request(procedure, input, signal);
        let stale = false;
        if (procedure === 'turns.set' && result.data && typeof result.data === 'object' && 'ok' in result.data)
          stale = result.data.ok === false;
        const finishedAt = timestamp();
        attempt.completedAt = finishedAt;
        worker.completed++;
        const sample: RequestSample = {
          sequence: attempt.sequence,
          worldId: state.actor.worldId,
          userId: state.actor.userId,
          procedure,
          phase,
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
          thinkMs: state.thinkMs,
          status: result.status,
          outcome: stale ? 'stale' : 'success',
        };
        samples.push(sample);
        if (options.onEvent)
          await emit({
            kind: 'complete',
            worldIndex: worker.worldIndex,
            userIndex: worker.userIndex,
            sequence: sample.sequence,
            at: finishedAt,
            durationMs: sample.durationMs,
            status: sample.status,
            outcome: sample.outcome,
          });
        signal.throwIfAborted();
        return result.data;
      } catch (error) {
        if (!(error instanceof LoadHttpError)) throw new Error('LOAD_CLIENT_FAILURE', { cause: error });
        const finishedAt = timestamp();
        attempt.completedAt = finishedAt;
        worker.completed++;
        const sample: RequestSample = {
          sequence: attempt.sequence,
          worldId: state.actor.worldId,
          userId: state.actor.userId,
          procedure,
          phase,
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
          thinkMs: state.thinkMs,
          status: error.status,
          outcome: error.status === 0 ? 'network-error' : error.status >= 400 ? 'http-error' : 'protocol-error',
        };
        samples.push(sample);
        if (options.onEvent)
          await emit({
            kind: 'complete',
            worldIndex: worker.worldIndex,
            userIndex: worker.userIndex,
            sequence: sample.sequence,
            at: finishedAt,
            durationMs: sample.durationMs,
            status: sample.status,
            outcome: sample.outcome,
          });
        signal.throwIfAborted();
        return undefined;
      }
    }
    async function action(state: State, procedure: WorkloadProcedure) {
      const worldId = state.actor.worldId;
      switch (procedure) {
        case 'home.get': {
          const value = await request(state, procedure, { worldId });
          if (value) state.cityKey = value.general.cityKey;
          break;
        }
        case 'world.summary':
          await request(state, procedure, { worldId });
          break;
        case 'world.map': {
          const value = await request(state, procedure, { worldId });
          if (value?.nations[0]) state.nationId = value.nations[0].id;
          break;
        }
        case 'world.list':
          await request(state, procedure, undefined);
          break;
        case 'city.get':
          await request(state, procedure, { worldId, cityKey: state.cityKey });
          break;
        case 'nation.get':
          await request(state, procedure, { worldId, nationId: state.nationId });
          break;
        case 'turns.get': {
          const value = await request(state, procedure, { worldId });
          if (value) state.turns = value;
          break;
        }
        case 'turns.set': {
          const value = await request(state, procedure, {
            worldId,
            revision: state.turns.revision,
            slots: state.turns.slots,
          });
          if (value) state.turns = { revision: value.revision, slots: value.slots };
          break;
        }
        case 'message.list':
          await request(state, procedure, { worldId, scope: 'PRIVATE' });
          break;
        case 'message.send':
          await request(state, procedure, {
            worldId,
            scope: 'PRIVATE',
            toGeneralId: state.recipientId,
            body: '부하 검사 메시지',
          });
          break;
        case 'ranking.generals':
          await request(state, procedure, { worldId, by: 'dedication' });
          break;
        case 'ranking.nations':
          await request(state, procedure, { worldId, by: 'cities' });
          break;
      }
    }
    for (const [index, state] of states.entries()) {
      const workload = userWorkload(options.seed, Math.floor(index / perWorld), index % perWorld);
      workers.push(
        (async () => {
          const worker: LoadRun['workers'][number] = {
            worldId: state.actor.worldId,
            userId: state.actor.userId,
            worldIndex: Math.floor(index / perWorld),
            userIndex: index % perWorld,
            startedAt: timestamp(),
            finishedAt: null,
            attempted: 0,
            completed: 0,
            terminal: 'failed',
          };
          workerEvidence.push(worker);
          state.worker = worker;
          try {
            if (options.onEvent)
              await emit({
                kind: 'worker',
                worldIndex: worker.worldIndex,
                userIndex: worker.userIndex,
                state: 'started',
                at: worker.startedAt,
              });
            while (performance.now() - startedMono < warmupMs + measurementMs) {
              signal.throwIfAborted();
              const next = workload.next();
              state.thinkMs = next.thinkMs;
              await action(state, next.procedure);
              signal.throwIfAborted();
              const remaining = warmupMs + measurementMs - (performance.now() - startedMono);
              if (remaining > 0) await delay(Math.min(next.thinkMs, remaining), undefined, { signal });
            }
            signal.throwIfAborted();
            worker.terminal = 'window-complete';
            if (options.onEvent)
              await emit({
                kind: 'worker',
                worldIndex: worker.worldIndex,
                userIndex: worker.userIndex,
                state: 'window-complete',
                at: timestamp(),
              });
          } catch (error) {
            worker.terminal = signal.aborted ? 'aborted' : 'failed';
            throw error;
          } finally {
            worker.finishedAt = timestamp();
          }
        })(),
      );
    }
    await Promise.all(workers);
    signal.throwIfAborted();
  } catch {
    failures.push('LOAD_GENERATOR_INTERRUPTED_OR_FAILED');
  } finally {
    clearTimeout(setupTimer);
    stopping = true;
    owned.abort();
    const settled = await Promise.allSettled([...setups, ...workers, ...pumps]);
    if (settled.some((entry) => entry.status === 'rejected')) failures.push('GENERATOR_TASK_REJECTED');
  }
  return {
    mode: options.mode,
    workloadSeed: options.seed,
    workers: workerEvidence,
    attempts,
    warmupStartedAt,
    measurementStartedAt,
    measurementFinishedAt,
    requests: samples,
    sse,
    generatorFailures: [...failures],
    complete: failures.length === 0 && measurementFinishedAt > 0,
  };
}
