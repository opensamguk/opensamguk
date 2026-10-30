// 이 생성 설정 fixture만의 유한 수명과 삭제 조건이다. 전역 runner 설정은 바꾸지 않는다.
export class CreateOptionsBoundary {
  failed = false;
  uncertain = false;
  readonly reasons = new Set<string>();
  readonly pending = new Set<Promise<unknown>>();
  readonly flows = new Set<Promise<unknown>>();
  private readonly workScopes = new Set<CreateOptionsPhase>();
  fail(reason: string, uncertain = false) {
    this.failed = true;
    this.uncertain ||= uncertain;
    this.reasons.add(reason);
    for (const scope of this.workScopes) scope.stop();
  }
  observeHooks(result: { state?: string; hooks?: Partial<Record<string, string>> } | undefined) {
    if (result?.state === 'fail' || result?.hooks?.beforeAll === 'fail') this.fail('vitest-hook-or-suite-failed', true);
  }
  sealWork() {
    for (const scope of this.workScopes) scope.stop();
  }
  phase(label: string, milliseconds: number, work = false, signal?: AbortSignal) {
    const phase = new CreateOptionsPhase(this, label, milliseconds, work, signal);
    if (work) this.workScopes.add(phase);
    return phase;
  }
  finish(phase: CreateOptionsPhase) {
    this.workScopes.delete(phase);
    phase.stop();
  }
  retain<T>(promise: Promise<T>, flow = false) {
    const set = flow ? this.flows : this.pending;
    set.add(promise);
    void promise.then(
      () => set.delete(promise),
      () => {
        set.delete(promise);
        this.fail('original-operation-rejected', true);
      },
    );
    return promise;
  }
}

export class CreateOptionsPhase {
  readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly deadline: number;
  private readonly parent?: AbortSignal;
  private readonly aborted = () => this.expire('vitest-test-aborted');
  constructor(
    private readonly boundary: CreateOptionsBoundary,
    readonly label: string,
    milliseconds: number,
    private readonly work: boolean,
    signal?: AbortSignal,
  ) {
    this.deadline = Date.now() + milliseconds;
    this.timer = setTimeout(() => this.expire(label + '-deadline'), milliseconds);
    if (signal) {
      this.parent = signal;
      signal.addEventListener('abort', this.aborted, { once: true });
      if (signal.aborted) this.aborted();
    }
  }
  stop() {
    clearTimeout(this.timer);
    this.parent?.removeEventListener('abort', this.aborted);
    if (!this.controller.signal.aborted) this.controller.abort();
  }
  private expire(reason: string) {
    this.boundary.fail(reason, true);
    this.stop();
  }
  private check() {
    if (Date.now() >= this.deadline && !this.controller.signal.aborted) this.expire(this.label + '-deadline');
    if (this.controller.signal.aborted || (this.work && this.boundary.failed))
      throw new Error('생성 설정 fixture 작업이 중단됐습니다.');
  }
  private async wait<T>(original: Promise<T>, limit?: number) {
    let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
    try {
      this.check();
      const stopped = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('생성 설정 fixture 기한 또는 중단 경계입니다.'));
        this.controller.signal.addEventListener('abort', onAbort, { once: true });
        if (limit !== undefined)
          timer = setTimeout(
            () => this.expire(this.label + '-operation-timeout'),
            Math.min(limit, this.deadline - Date.now()),
          );
      });
      const value = await Promise.race([original, stopped]);
      this.check();
      return value;
    } finally {
      clearTimeout(timer);
      if (onAbort) this.controller.signal.removeEventListener('abort', onAbort);
    }
  }
  async run<T>(start: () => Promise<T>, limit = 3000) {
    this.check();
    // 이미 시작한 Promise를 받지 않는다. 중단 뒤 thunk가 새 SQL/HTTP를 시작할 수 없다.
    const original = this.boundary.retain(
      Promise.resolve().then(() => {
        this.check();
        return start();
      }),
    );
    return this.wait(original, limit);
  }
  guard<T>(original: Promise<T>) {
    return this.wait(this.boundary.retain(original, true));
  }
}

type Query = (sql: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
export type OwnedCreateState = {
  name: string;
  baselineAbsent: boolean;
  createSent: boolean;
  createOutcome: 'not-sent' | 'unknown' | 'confirmed';
  initialOid?: string;
  workSettled: boolean;
  clientsClosed: boolean;
  primaryApplicationName: string;
};
export type OwnedCreateAudit = {
  attempted: boolean;
  complete: boolean;
  firstCatalog?: string[];
  finalCatalog?: string[];
  recoveredOid?: string;
  connections?: number;
  identityKnown: boolean;
  primaryConnections?: number;
  dropOutcome: 'not-sent' | 'unknown' | 'confirmed';
  rowsAfterDrop?: number;
};
const catalogSql = 'SELECT oid::text AS oid FROM pg_database WHERE datname=$1';
const positiveOid = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value);
export async function auditOwnedCreate(
  boundary: CreateOptionsBoundary,
  phase: CreateOptionsPhase,
  state: OwnedCreateState,
  query: Query,
  receipt: OwnedCreateAudit,
) {
  if (!/^t305_create_options_[a-f0-9]{32}_test$/.test(state.name))
    throw new Error('자기 UUID 시험 DB 이름을 확인하세요.');
  if (!state.createSent) return;
  receipt.attempted = true;
  const primary = (
    await phase.run(() =>
      query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1', [
        state.primaryApplicationName,
      ]),
    )
  ).rows;
  const primaryCount = primary.length === 1 ? Number(primary[0]!.count) : NaN;
  if (Number.isSafeInteger(primaryCount) && primaryCount >= 0) receipt.primaryConnections = primaryCount;
  if (primaryCount !== 0) boundary.fail('primary-admin-backend-not-closed', true);
  // CREATE 응답·최초 OID가 없어도 별도 연결에서 정확한 자기 이름을 관측한다.
  const first = (await phase.run(() => query(catalogSql, [state.name]))).rows;
  receipt.firstCatalog = first.map((row) => String(row.oid));
  const counts = (
    await phase.run(() => query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [state.name]))
  ).rows;
  const count = counts.length === 1 ? Number(counts[0]!.count) : NaN;
  if (Number.isSafeInteger(count) && count >= 0) receipt.connections = count;
  else boundary.fail('connection-count-unknown', true);
  const final = (await phase.run(() => query(catalogSql, [state.name]))).rows;
  receipt.finalCatalog = final.map((row) => String(row.oid));
  const oid = first.length === 1 && positiveOid(first[0]!.oid) ? first[0]!.oid : undefined;
  const same = oid !== undefined && final.length === 1 && final[0]!.oid === oid;
  const initialMatches = state.initialOid === undefined || state.initialOid === oid;
  receipt.identityKnown = state.baselineAbsent && same && initialMatches;
  if (receipt.identityKnown && oid !== undefined) receipt.recoveredOid = oid;
  if (
    !state.baselineAbsent ||
    !initialMatches ||
    first.length > 1 ||
    final.length > 1 ||
    (first.length !== 0 && !same) ||
    (first.length === 0 && final.length !== 0)
  )
    boundary.fail('catalog-identity-uncertain', true);
  receipt.complete = state.workSettled && state.clientsClosed && primaryCount === 0 && boundary.pending.size === 0;
  if (!receipt.complete || count !== 0) boundary.fail('original-work-or-connections-unsettled', true);
  // 복구한 OID만으로 불명확한 CREATE를 성공으로 바꾸지 않는다.
  const mayDrop =
    !boundary.failed &&
    !boundary.uncertain &&
    receipt.complete &&
    receipt.identityKnown &&
    state.createOutcome === 'confirmed' &&
    state.initialOid === oid &&
    count === 0;
  if (!mayDrop) return;
  await phase.run(async () => {
    if (boundary.failed || boundary.uncertain || boundary.pending.size !== 1)
      throw new Error('삭제 직전 작업 경계가 바뀌었습니다.');
    receipt.dropOutcome = 'unknown';
    return query(`DROP DATABASE "${state.name}"`, []);
  });
  receipt.dropOutcome = 'confirmed';
  receipt.rowsAfterDrop = (await phase.run(() => query(catalogSql, [state.name]))).rows.length;
  if (receipt.rowsAfterDrop !== 0) boundary.fail('post-drop-catalog-not-empty', true);
}
