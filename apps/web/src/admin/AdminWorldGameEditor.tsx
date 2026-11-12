import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { publicFailure } from '../auth/credentials';
import { useTRPCClient } from '../trpc';
import { usePrivateRead } from './usePrivateRead';
import { AdminWorldGameRecords } from './AdminWorldGameRecords';
import { useAdminResultPolling } from './useAdminResultPolling';
import styles from './AdminPages.module.css';

type Editor = inferRouterOutputs<AppRouter>['admin']['game']['editor'];
type Command = inferRouterInputs<AppRouter>['admin']['game']['request'];
type Target = Editor['target'] | 'message' | 'records';
type Row = Editor['rows'][number];
const targets = { general: '장수', nation: '국가', city: '도시', records: '기록', message: '운영 쪽지' } as const;
const isEntity = (target: Target): target is Editor['target'] => target !== 'message' && target !== 'records';
const adjustments = {
  gold: '금',
  rice: '쌀',
  cityKey: '소재 도시 번호',
  crew: '병력',
  crewType: '병종 번호',
  train: '훈련',
  atmos: '사기',
  tech: '기술',
  population: '인구',
  agriculture: '농업',
  commerce: '상업',
  security: '치안',
  defence: '수비',
  wall: '성벽',
  trust: '민심',
} as const;
type Field = keyof typeof adjustments;

function numberFields(row: Row, campaign: boolean): Field[] {
  if ('player' in row)
    return campaign ? ['gold', 'rice', 'cityKey'] : ['gold', 'rice', 'cityKey', 'crew', 'crewType', 'train', 'atmos'];
  if ('ruler' in row) return ['gold', 'rice', 'tech'];
  return ['population', 'agriculture', 'commerce', 'security', 'defence', 'wall', 'trust'];
}

function current(row: Row, field: Field): number {
  return (row as Partial<Record<Field, number>>)[field]!;
}

const operations = {
  adjust: '수치 수정',
  rename: '이름 변경',
  release: '사람 장수를 NPC로 전환',
  clearTurns: '예턴 30칸을 휴식으로 변경',
  remove: '장수 내보내기',
  dismissOffice: '수뇌 임명 해제',
  setRuler: '군주 교체',
  disband: '국가 해산',
} as const;
type Operation = keyof typeof operations;

function available(row: Row): Operation[] {
  if ('player' in row)
    return [
      'adjust',
      'rename',
      ...(row.player ? ['release' as const] : []),
      'clearTurns',
      ...(row.officerLevel === 12 ? [] : ['remove' as const]),
    ];
  if ('ruler' in row)
    return ['adjust', 'rename', 'dismissOffice', ...(row.ruler ? ['setRuler' as const] : []), 'disband'];
  return ['adjust'];
}

function actionFromForm(
  data: FormData,
  row: Row | null,
  operation: Operation,
  campaign: boolean,
): Command['action'] | null {
  const value = (key: string) => String(data.get(key) ?? '').trim();
  if (!row) {
    const generalId = value('generalId');
    const body = value('body');
    if (!body) return null;
    return {
      kind: 'admin.message.send',
      body,
      ...(generalId ? { scope: 'PRIVATE', generalId: Number(generalId) } : { scope: 'WORLD' }),
    };
  }
  const changes =
    operation === 'adjust'
      ? Object.fromEntries(
          numberFields(row, campaign).flatMap((field) => {
            const expected = current(row, field);
            const next = value(field);
            return next && Number(next) !== expected ? [[field, { expected, value: Number(next) }]] : [];
          }),
        )
      : {};
  if (operation === 'adjust' && Object.keys(changes).length === 0) return null;
  if ('player' in row) {
    const generalId = row.id;
    if (operation === 'adjust') return { kind: 'admin.general.adjust', generalId, changes };
    if (operation === 'rename') return { kind: 'admin.general.rename', generalId, name: value('name') };
    if (operation === 'release' || operation === 'clearTurns' || operation === 'remove')
      return { kind: `admin.general.${operation}`, generalId };
    return null;
  }
  if ('ruler' in row) {
    const nationId = row.id;
    if (operation === 'adjust') return { kind: 'admin.nation.adjust', nationId, changes };
    if (operation === 'rename') return { kind: 'admin.nation.rename', nationId, name: value('name') };
    if (operation === 'disband')
      return { kind: 'admin.nation.disband', nationId, expected: { name: row.name, rulerId: row.ruler?.id ?? null } };
    const generalId = Number(value('generalId'));
    if (operation === 'dismissOffice') return { kind: 'admin.nation.dismissOffice', nationId, generalId };
    if (operation === 'setRuler' && row.ruler)
      return { kind: 'admin.nation.setRuler', nationId, generalId, expectedRulerId: row.ruler.id };
    return null;
  }
  return { kind: 'admin.city.adjust', cityKey: row.id, changes };
}

function pointer(key: string, update?: string | null): string | null {
  try {
    if (update === null) sessionStorage.removeItem(key);
    else if (update !== undefined) sessionStorage.setItem(key, update);
    else return sessionStorage.getItem(key);
  } catch {
    // 요청 번호는 화면이 열려 있는 동안 상태에도 유지한다.
  }
  return null;
}
const pointerKey = (viewerId: string, worldId: string) => `admin.game.editor:${viewerId}:${worldId}`;
export const hasGameEditorRequest = (viewerId: string, worldId: string) => !!pointer(pointerKey(viewerId, worldId));

export function AdminWorldGameEditor({
  viewerId,
  worldId,
  worldName,
  editable,
  onClose,
}: {
  viewerId: string;
  worldId: string;
  worldName: string;
  editable: boolean;
  onClose: () => void;
}) {
  const client = useTRPCClient();
  const query = usePrivateRead<Editor>(viewerId);
  const panel = useRef<HTMLElement>(null);
  const generation = useRef(0);
  const locked = useRef(false);
  const [target, setTarget] = useState<Target>('general');
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const key = pointerKey(viewerId, worldId);
  const [request, setRequest] = useState(() => pointer(key));
  const [command, setCommand] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [pollPaused, setPollPaused] = useState(false);
  const [message, setMessage] = useState('');
  const [formVersion, setFormVersion] = useState(0);

  useEffect(() => {
    const clear = () => {
      generation.current++;
      setSelected(null);
      setSearch('');
      setActiveSearch('');
      setCommand(null);
      setMessage('');
      setMissing(false);
      setFormVersion((version) => version + 1);
    };
    for (const event of ['blur', 'focus', 'offline', 'online']) window.addEventListener(event, clear);
    document.addEventListener('visibilitychange', clear);
    panel.current?.focus();
    return () => {
      generation.current++;
      for (const event of ['blur', 'focus', 'offline', 'online']) window.removeEventListener(event, clear);
      document.removeEventListener('visibilitychange', clear);
    };
  }, []);

  const row = query.data?.rows.find((item) => item.id === selected) ?? null;
  function lookup(category: Editor['target'], term: string, after?: number) {
    setSelected(null);
    setActiveSearch(term);
    void query.read((signal) =>
      client.admin.game.editor.query(
        { worldId, target: category, search: term, ...(after === undefined ? {} : { after }) },
        { signal },
      ),
    );
  }
  function clearRequest() {
    pointer(key, null);
    setRequest(null);
    setCommand(null);
    setMissing(false);
  }

  async function run(id: string, input?: Command) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setMissing(false);
    const own = generation.current;
    try {
      const result = input
        ? await client.admin.game.request.mutate(input)
        : await client.admin.game.requestStatus.query({ worldId, expectedUserId: viewerId, idempotencyKey: id });
      if (own !== generation.current) return;
      if (result.status === 'PENDING') {
        setPollPaused(false);
        setMessage(`운영 요청 ${result.requestId} 접수 완료. 엔진 적용을 기다리고 있습니다.`);
        return;
      }
      clearRequest();
      setMessage(
        result.status === 'APPLIED'
          ? `운영 요청 ${result.requestId} 적용 완료.`
          : result.result && 'message' in result.result
            ? result.result.message
            : '운영 요청을 적용하지 못했습니다.',
      );
      setFormVersion((version) => version + 1);
      if (editable && isEntity(target)) lookup(target, activeSearch);
    } catch (error) {
      if (own !== generation.current) return;
      const code = publicFailure(error)?.code;
      if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'NOT_FOUND') setPollPaused(true);
      if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
        setCommand(null);
        setSelected(null);
        query.clear();
        setFormVersion((version) => version + 1);
        setMessage('관리자 계정과 권한을 다시 확인하세요.');
      } else if (input && ['BAD_REQUEST', 'CONFLICT', 'NOT_FOUND'].includes(code ?? '')) {
        clearRequest();
        setMessage('월드 상태와 요청 값을 다시 확인하세요.');
        if (editable && isEntity(target)) lookup(target, activeSearch);
      } else {
        setMissing(!input && code === 'NOT_FOUND' && !command);
        setMessage('접수 여부를 확인하지 못했습니다. 같은 번호로 결과를 다시 조회하거나 감사 기록을 확인하세요.');
      }
    } finally {
      locked.current = false;
      if (panel.current) setBusy(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>, operation: Operation) {
    event.preventDefault();
    if (!editable || request || locked.current || (target !== 'message' && !row)) return;
    const form = new FormData(event.currentTarget);
    const action = actionFromForm(form, row, operation, query.data?.target === 'general' && query.data.campaign);
    const reason = String(form.get('reason') ?? '').trim();
    if (!action || !reason) {
      setMessage('바꿀 값과 사유를 확인하세요.');
      return;
    }
    const idempotencyKey = crypto.randomUUID();
    const input = { worldId, expectedUserId: viewerId, idempotencyKey, reason, action };
    pointer(key, idempotencyKey);
    setRequest(idempotencyKey);
    setPollPaused(false);
    setCommand(input);
    void run(idempotencyKey, input);
  }
  useAdminResultPolling(request, pollPaused, (id) => void run(id));

  return (
    <section ref={panel} tabIndex={-1} className={styles.worldSettings} aria-label="월드 게임 편집">
      <div className={styles.worldSettingsHeader}>
        <h3>{worldName} 게임 편집</h3>
        <button type="button" disabled={busy} onClick={onClose}>
          닫기
        </button>
      </div>
      {message ? <p role="status">{message}</p> : null}
      {request ? (
        <div className={styles.worldSettingsHeader}>
          <button type="button" disabled={busy} onClick={() => void run(request)}>
            적용 결과 조회
          </button>
          {command ? (
            <button type="button" disabled={busy} onClick={() => void run(request, command)}>
              같은 요청 다시 보내기
            </button>
          ) : null}
          {missing ? (
            <button type="button" disabled={busy} onClick={clearRequest}>
              감사 기록 확인 후 요청 번호 지우기
            </button>
          ) : null}
        </div>
      ) : editable ? (
        <>
          <form
            className={styles.noticeForm}
            onSubmit={(event) => {
              event.preventDefault();
              if (isEntity(target)) lookup(target, search);
            }}
          >
            <label>
              편집 대상
              <select
                value={target}
                onChange={(event) => {
                  const next = event.currentTarget.value as Target;
                  setTarget(next);
                  setSelected(null);
                  setSearch('');
                  query.clear();
                  if (isEntity(next)) lookup(next, '');
                }}
              >
                {Object.entries(targets).map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {isEntity(target) ? (
              <>
                <label>
                  이름 또는 번호{' '}
                  <input value={search} maxLength={50} onChange={(event) => setSearch(event.currentTarget.value)} />
                </label>
                <button type="submit" disabled={query.pending}>
                  대상 조회
                </button>
              </>
            ) : null}
          </form>
          {query.pending ? <p role="status">편집 대상을 읽고 있습니다.</p> : null}
          {query.error ? <p role="alert">{query.error}</p> : null}
          {query.data?.target === target ? (
            <>
              <div className={styles.worldSettingsFields}>
                {query.data.rows.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={selected === item.id}
                    onClick={() => {
                      setSelected(item.id);
                      setMessage('');
                    }}
                  >
                    <strong>
                      {item.name} ({item.id})
                    </strong>
                    {'player' in item ? (
                      <span>
                        {item.player ? '사람' : 'NPC'} · {item.nation?.name ?? '재야'} · {item.city.name}
                      </span>
                    ) : null}
                    {'ruler' in item ? <span>군주 {item.ruler?.name ?? '없음'}</span> : null}
                  </button>
                ))}
              </div>
              {query.data.rows.length === 0 ? <p>일치하는 대상이 없습니다.</p> : null}
              {query.data.next !== null ? (
                <button type="button" onClick={() => lookup(target, activeSearch, query.data!.next!)}>
                  다음 50개
                </button>
              ) : null}
            </>
          ) : null}
          {row || target === 'message' ? (
            <EditorForm
              key={`${target}:${row?.id}:${formVersion}`}
              row={row}
              campaign={query.data?.target === 'general' && query.data.campaign}
              onSubmit={submit}
            />
          ) : null}
          {target === 'records' ? <AdminWorldGameRecords viewerId={viewerId} worldId={worldId} /> : null}
        </>
      ) : null}
    </section>
  );
}

function EditorForm({
  row,
  campaign,
  onSubmit,
}: {
  row: Row | null;
  campaign: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>, operation: Operation) => void;
}) {
  const [operation, setOperation] = useState<Operation>('adjust');
  const [privateMessage, setPrivateMessage] = useState(false);
  return (
    <form className={styles.noticeForm} onSubmit={(event) => onSubmit(event, operation)}>
      {row ? (
        <>
          <h4>
            {row.name} ({row.id})
          </h4>
          <label>
            조치
            <select value={operation} onChange={(event) => setOperation(event.currentTarget.value as Operation)}>
              {available(row).map((kind) => (
                <option key={kind} value={kind}>
                  {operations[kind]}
                </option>
              ))}
            </select>
          </label>
          {operation === 'adjust' ? (
            <div className={styles.worldSettingsFields}>
              {numberFields(row, campaign).map((field) => (
                <label key={field}>
                  {adjustments[field]} (현재 {current(row, field)})
                  <input type="number" name={field} min={0} step={field === 'tech' || field === 'trust' ? 'any' : 1} />
                </label>
              ))}
            </div>
          ) : null}
          {operation === 'rename' ? (
            <label>
              새 이름 <input name="name" maxLength={30} required />
            </label>
          ) : null}
          {operation === 'dismissOffice' || operation === 'setRuler' ? (
            <label>
              {operation === 'setRuler' ? '새 군주 장수 번호' : '임명을 해제할 장수 번호'}{' '}
              <input name="generalId" type="number" min={1} required />
            </label>
          ) : null}
          {['release', 'clearTurns', 'remove', 'dismissOffice', 'setRuler', 'disband'].includes(operation) ? (
            <label key={operation}>
              <input type="checkbox" required /> {row.name}의 {operations[operation]} 조치를 확인했습니다.
            </label>
          ) : null}
        </>
      ) : (
        <>
          <label>
            수신 범위
            <select
              value={privateMessage ? 'private' : 'world'}
              onChange={(event) => setPrivateMessage(event.currentTarget.value === 'private')}
            >
              <option value="world">월드 전체</option>
              <option value="private">장수 한 명</option>
            </select>
          </label>
          {privateMessage ? (
            <label>
              받는 장수 번호 <input name="generalId" type="number" min={1} required />
            </label>
          ) : null}
          <label>
            쪽지 내용 <textarea name="body" maxLength={1000} required />
          </label>
        </>
      )}
      <label>
        운영 사유 <input name="reason" maxLength={200} required />
      </label>
      <button type="submit">엔진에 요청</button>
    </form>
  );
}
