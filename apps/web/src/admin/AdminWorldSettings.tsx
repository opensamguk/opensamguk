import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { publicFailure } from '../auth/credentials';
import { useTRPCClient } from '../trpc';
import { usePrivateRead } from './usePrivateRead';
import { useAdminResultPolling } from './useAdminResultPolling';
import styles from './AdminPages.module.css';

type Settings = inferRouterOutputs<AppRouter>['admin']['world']['settings'];
type Reply = inferRouterOutputs<AppRouter>['admin']['world']['requestSetting'];
type Command = inferRouterInputs<AppRouter>['admin']['world']['requestSetting'];
type Setting = Command['setting'];
type Option<K> = Extract<Setting, { key: K }>['value'];
const integer = (value: string) => (value.trim() ? Number(value) : NaN);
const minute = (value: string) => {
  const [hour, min] = value.split(':').map(Number);
  return hour === undefined || min === undefined ? NaN : hour * 60 + min;
};
const time = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const allowed = {
  on: '허용',
  off: '금지',
  open: '열림',
  closed: '닫힘',
  city: '주둔 도시',
  territory: '국가 보유 도시',
} as const;
const entryChoices = {
  npcPlay: ['off', 'on'],
  generalCreation: ['closed', 'open'],
  recruitmentLocation: ['city', 'territory'],
} as const;
const sections = [
  ['기본 설정', ['name', 'turn', 'endYear']],
  ['입장 설정', ['npcPlay', 'generalCreation']],
  ['진행 규칙', ['truce', 'recruitmentLocation', 'foundUntil', 'peace', 'aggression', 'smallWorld', 'lateJoin']],
] as const;
type Field = (typeof sections)[number][1][number];
const labels: Record<Field, string> = {
  name: '월드 이름',
  turn: '턴 간격 (분)',
  endYear: '종료 연도',
  npcPlay: 'NPC 무장 플레이',
  generalCreation: '신규 장수 생성',
  truce: '야간 휴전',
  recruitmentLocation: '모병·징병 지역 조건',
  foundUntil: '건국 가능 기간 (개월)',
  peace: '초반 보호 기간 (개월)',
  aggression: 'NPC 공격성',
  smallWorld: '소규모 월드 보정',
  lateJoin: '후발 장수 보정',
};
const ruleOptions = {
  foundUntil: 'protection.foundUntilMonths',
  peace: 'protection.peaceMonths',
  aggression: 'npc.aggression',
  smallWorld: 'boost.smallWorld',
  lateJoin: 'boost.lateJoin',
} as const;
function fieldValue(settings: Settings, field: Field): string {
  switch (field) {
    case 'name':
      return settings.name;
    case 'turn':
      return String(settings.turnTermMinutes);
    case 'endYear':
      return settings.endYear?.toString() ?? '';
    case 'npcPlay':
      return settings.entry.npcPlay;
    case 'generalCreation':
      return settings.entry.generalCreation;
    case 'recruitmentLocation':
      return settings.recruitmentLocation;
    case 'truce':
      return settings.truce ? 'on' : 'off';
    case 'foundUntil':
      return settings.rules?.protection.foundUntilMonths.toString() ?? '';
    case 'peace':
      return settings.rules?.protection.peaceMonths.toString() ?? '';
    case 'aggression':
      return settings.rules?.npc.aggression.toString() ?? '';
    case 'smallWorld':
      return JSON.stringify(settings.rules?.boost.smallWorld ?? null, null, 2);
    case 'lateJoin':
      return JSON.stringify(settings.rules?.boost.lateJoin ?? null, null, 2);
  }
}
function settingValue(field: Field, value: string, truce: { start: string; end: string; offset: string }): Setting {
  switch (field) {
    case 'name':
      return { kind: 'admin.world.rename', name: value };
    case 'turn':
      return { kind: 'admin.world.setTurnTerm', turnTermMinutes: integer(value) };
    case 'endYear':
      return { kind: 'admin.world.setEndYear', endYear: value.trim() ? integer(value) : null };
    case 'truce':
      return {
        kind: 'admin.world.setTruce',
        truce:
          value === 'off'
            ? null
            : {
                startMinute: minute(truce.start),
                endMinute: minute(truce.end),
                utcOffsetMinutes: integer(truce.offset),
              },
      };
    case 'npcPlay':
      return { kind: 'admin.world.setOption', key: 'entry.npcPlay', value: value === 'on' ? 'on' : 'off' };
    case 'recruitmentLocation':
      return {
        kind: 'admin.world.setOption',
        key: 'recruitment.location',
        value: value === 'city' ? 'city' : 'territory',
      };
    case 'generalCreation':
      return {
        kind: 'admin.world.setOption',
        key: 'entry.generalCreation',
        value: value === 'open' ? 'open' : 'closed',
      };
    case 'smallWorld':
      return {
        kind: 'admin.world.setOption',
        key: 'boost.smallWorld',
        value: JSON.parse(value) as Option<'boost.smallWorld'>,
      };
    case 'lateJoin':
      return {
        kind: 'admin.world.setOption',
        key: 'boost.lateJoin',
        value: JSON.parse(value) as Option<'boost.lateJoin'>,
      };
    default:
      return { kind: 'admin.world.setOption', key: ruleOptions[field], value: integer(value) };
  }
}
function currentText(settings: Settings, field: Field) {
  const value = fieldValue(settings, field);
  if (field in entryChoices) return allowed[value as keyof typeof allowed];
  if (field === 'truce') {
    const truce = settings.truce;
    return truce ? `${time(truce.startMinute)}–${time(truce.endMinute)} (UTC ${truce.utcOffsetMinutes}분)` : '꺼짐';
  }
  if (field in ruleOptions && !settings.canChangeRules) return '지원하지 않음';
  if (field === 'smallWorld' || field === 'lateJoin') return value === 'null' ? '꺼짐' : '적용 중';
  return value || '설정 없음';
}
function pointerKey(viewerId: string, worldId: string) {
  return `admin.world.setting:${viewerId}:${worldId}`;
}
export function hasWorldSettingRequest(viewerId: string, worldId: string) {
  return settingPointer(pointerKey(viewerId, worldId)) !== null;
}
function settingPointer(key: string, value?: string | null) {
  try {
    if (value === undefined) {
      const stored = sessionStorage.getItem(key);
      return stored && /^[\da-f-]{36}$/i.test(stored) ? stored : null;
    }
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* 화면을 닫기 전에는 상태에서 요청 번호를 유지한다. */
  }
  return null;
}

export function AdminWorldSettings({
  viewerId,
  worldId,
  onClose,
  onApplied,
}: {
  viewerId: string;
  worldId: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const client = useTRPCClient();
  const { read, data, pending, error } = usePrivateRead<Settings>(viewerId);
  const load = useCallback(
    () => read((signal) => client.admin.world.settings.query({ worldId }, { signal })),
    [client, read, worldId],
  );
  const pointer = pointerKey(viewerId, worldId);
  const [requestKey, setRequestKey] = useState(() => settingPointer(pointer));
  const [command, setCommand] = useState<Command | null>(null);
  const [field, setField] = useState<Field | null>(null);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [truce, setTruce] = useState({ start: '', end: '', offset: '' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestMissing, setRequestMissing] = useState(false);
  const [pollPaused, setPollPaused] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const hideDraft = () => {
      generation.current++;
      setCommand(null);
      setField(null);
      setValue('');
      setReason('');
      setMessage('');
      setRequestMissing(false);
    };
    for (const event of ['blur', 'focus', 'offline', 'online']) window.addEventListener(event, hideDraft);
    document.addEventListener('visibilitychange', hideDraft);
    void load();
    panel.current?.focus();
    return () => {
      mounted.current = false;
      generation.current++;
      for (const event of ['blur', 'focus', 'offline', 'online']) window.removeEventListener(event, hideDraft);
      document.removeEventListener('visibilitychange', hideDraft);
    };
  }, [load]);

  function select(settings: Settings, next: Field) {
    setField(next);
    setValue(fieldValue(settings, next));
    setTruce({
      start: time(settings.truce?.startMinute ?? 120),
      end: time(settings.truce?.endMinute ?? 360),
      offset: String(settings.truce?.utcOffsetMinutes ?? 540),
    });
    setReason('');
    setMessage('');
  }
  function clearRequest() {
    settingPointer(pointer, null);
    setRequestKey(null);
    setCommand(null);
  }
  async function run(id: string, input?: Command) {
    if (inFlight.current) return;
    inFlight.current = true;
    const own = generation.current;
    setBusy(true);
    setRequestMissing(false);
    try {
      const result: Reply = input
        ? await client.admin.world.requestSetting.mutate(input)
        : await client.admin.world.settingRequest.query({ expectedUserId: viewerId, worldId, idempotencyKey: id });
      if (!mounted.current || generation.current !== own) return;
      if (result.status === 'PENDING') {
        setPollPaused(false);
        setMessage(`변경 요청 ${result.requestId} 접수 완료. 엔진 적용을 기다리고 있습니다.`);
        return;
      }
      clearRequest();
      if (result.status === 'APPLIED') {
        setField(null);
        setMessage(`변경 요청 ${result.requestId} 적용 완료.`);
        onApplied();
        void load();
      } else {
        const detail = result.result;
        setMessage(detail && 'message' in detail ? detail.message : '설정 변경 요청이 거부됐습니다.');
        void load();
      }
    } catch (failure) {
      if (!mounted.current || generation.current !== own) return;
      const code = publicFailure(failure)?.code;
      if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'NOT_FOUND') setPollPaused(true);
      if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
        setField(null);
        setReason('');
        setCommand(null);
        setMessage('관리자 계정과 권한을 다시 확인하세요.');
        void load();
      } else if (input && (code === 'BAD_REQUEST' || code === 'CONFLICT')) {
        clearRequest();
        setMessage('요청을 찾지 못했거나 월드 상태가 달라졌습니다. 현재 설정을 확인하세요.');
        void load();
      } else {
        if (!input && code === 'NOT_FOUND' && !command) {
          setRequestMissing(true);
          setMessage('접수 여부를 아직 확인하지 못했습니다. 다시 조회하거나 감사 기록에서 확인하세요.');
          return;
        }
        setMessage('응답을 확인하지 못했습니다. 같은 번호로 요청 또는 결과를 다시 확인하세요.');
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function submit() {
    if (!field || !data || requestKey || inFlight.current) return;
    let setting: Setting;
    try {
      setting = settingValue(field, value, truce);
    } catch {
      setMessage('보정 설정의 JSON 형식을 확인하세요.');
      return;
    }
    if (!reason.trim() || (setting.kind === 'admin.world.setTurnTerm' && setting.turnTermMinutes < 1)) {
      setMessage('변경 값과 사유를 확인하세요.');
      return;
    }
    const id = crypto.randomUUID();
    const input = { expectedUserId: viewerId, worldId, idempotencyKey: id, reason: reason.trim(), setting };
    settingPointer(pointer, id);
    setRequestKey(id);
    setPollPaused(false);
    setCommand(input);
    void run(id, input);
  }
  useAdminResultPolling(requestKey, pollPaused, (id) => void run(id));
  const editable = data?.status === 'RUNNING' || data?.status === 'PAUSED';
  return (
    <section ref={panel} tabIndex={-1} className={styles.worldSettings} aria-label="월드 설정 편집">
      <div className={styles.worldSettingsHeader}>
        <h3>{data ? `${data.name} 설정` : '월드 설정'}</h3>
        <button type="button" disabled={busy} onClick={onClose}>
          닫기
        </button>
      </div>
      {pending ? <p role="status">현재 설정을 읽고 있습니다.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {requestKey ? (
        <div className={styles.worldSettingsHeader}>
          <button type="button" disabled={busy} onClick={() => void run(requestKey)}>
            적용 결과 조회
          </button>
          {requestMissing ? (
            <button
              type="button"
              onClick={() => {
                clearRequest();
                setRequestMissing(false);
                setMessage('이 화면의 요청 번호를 지웠습니다.');
              }}
            >
              감사 기록 확인 후 요청 번호 지우기
            </button>
          ) : null}
          {command ? (
            <button type="button" disabled={busy} onClick={() => void run(requestKey, command)}>
              같은 요청 다시 보내기
            </button>
          ) : null}
        </div>
      ) : null}
      {!pending && !data ? (
        <button type="button" onClick={() => void load()}>
          현재 설정 조회
        </button>
      ) : null}
      {data && !editable ? <p>진행 중이거나 일시정지한 월드에서 설정을 변경할 수 있습니다.</p> : null}
      {data
        ? sections.map(([title, fields]) => (
            <fieldset key={title} className={styles.worldSettingsFields}>
              <legend>{title}</legend>
              {fields.map((item) => (
                <button
                  type="button"
                  key={item}
                  aria-pressed={field === item}
                  aria-label={`${labels[item]} ${currentText(data, item)}`}
                  disabled={
                    !editable ||
                    Boolean(requestKey) ||
                    busy ||
                    (item in ruleOptions && !data.canChangeRules) ||
                    (item === 'npcPlay' && !data.canChangeNpcPlay)
                  }
                  onClick={() => select(data, item)}
                >
                  <span>{labels[item]}</span>
                  <strong>{currentText(data, item)}</strong>
                </button>
              ))}
            </fieldset>
          ))
        : null}
      {field && editable ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset className={styles.form} disabled={busy || Boolean(requestKey)}>
            <legend>{labels[field]} 변경</legend>
            <label>
              {labels[field]}
              {field === 'npcPlay' || field === 'generalCreation' || field === 'recruitmentLocation' ? (
                <select value={value} onChange={(event) => setValue(event.target.value)}>
                  {entryChoices[field].map((choice) => (
                    <option key={choice} value={choice}>
                      {allowed[choice]}
                    </option>
                  ))}
                </select>
              ) : field === 'truce' ? (
                <select value={value} onChange={(event) => setValue(event.target.value)}>
                  <option value="off">꺼짐</option>
                  <option value="on">켜짐</option>
                </select>
              ) : field === 'smallWorld' || field === 'lateJoin' ? (
                <textarea rows={8} value={value} required onChange={(event) => setValue(event.target.value)} />
              ) : (
                <input
                  type={field === 'name' ? 'text' : 'number'}
                  value={value}
                  step={field === 'aggression' ? 'any' : 1}
                  placeholder={field === 'endYear' ? '미설정' : undefined}
                  required={field !== 'endYear'}
                  onChange={(event) => setValue(event.target.value)}
                />
              )}
            </label>
            {field === 'truce' && value === 'on' ? (
              <>
                <label>
                  휴전 시작 시각
                  <input
                    type="time"
                    required
                    value={truce.start}
                    onChange={(event) => setTruce({ ...truce, start: event.target.value })}
                  />
                </label>
                <label>
                  휴전 종료 시각
                  <input
                    type="time"
                    required
                    value={truce.end}
                    onChange={(event) => setTruce({ ...truce, end: event.target.value })}
                  />
                </label>
                <label>
                  UTC 시차 (분)
                  <input
                    type="number"
                    required
                    min={-720}
                    max={840}
                    value={truce.offset}
                    onChange={(event) => setTruce({ ...truce, offset: event.target.value })}
                  />
                </label>
              </>
            ) : null}
            <label>
              변경 사유
              <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <button type="submit">변경 요청</button>
          </fieldset>
        </form>
      ) : null}
    </section>
  );
}
