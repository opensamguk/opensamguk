import { useState, type FormEvent } from 'react';
import { useTRPCClient } from '../trpc';
import { usePrivateRead } from './usePrivateRead';
import styles from './AdminPages.module.css';

const kinds = {
  general: '장수 상세',
  generalLogs: '장수 기록',
  generalInputs: '장수 입력',
  nationLogs: '국가 이력',
  battles: '전투 기록',
} as const;
type Kind = keyof typeof kinds;
type Filter = { kind: Kind; id?: number; fromTick?: number; toTick?: number };
type RecordPage = { items: { title: string; data?: string }[]; nextCursor: string | null };
const details = (value: unknown) => JSON.stringify(value, null, 2);

export function AdminWorldGameRecords({ viewerId, worldId }: { viewerId: string; worldId: string }) {
  const client = useTRPCClient();
  const query = usePrivateRead<RecordPage>(viewerId);
  const [kind, setKind] = useState<Kind>('general');
  const [filter, setFilter] = useState<Filter | null>(null);

  function load(filter: Filter, cursor?: string) {
    const { kind, id, ...ticks } = filter;
    const input = { worldId, ...ticks, ...(cursor ? { cursor } : {}) };
    void query.read(async (signal) => {
      const game = client.admin.game;
      const options = { signal };
      switch (kind) {
        case 'general': {
          const general = await game.general.query({ worldId, generalId: id! }, options);
          return { items: [{ title: `${general.name} (${general.id})`, data: details(general) }], nextCursor: null };
        }
        case 'generalLogs': {
          const result = await game.generalLogs.query({ ...input, generalId: id! }, options);
          return { ...result, items: result.items.map((row) => ({ title: `${row.tick}틱 · ${row.text}` })) };
        }
        case 'generalInputs': {
          const result = await game.generalInputs.query({ ...input, generalId: id! }, options);
          return {
            ...result,
            items: result.items.map((row) => ({
              title: `${row.kind} · ${row.status} · 요청 ${row.id}`,
              data: details(row),
            })),
          };
        }
        case 'nationLogs': {
          const result = await game.nationLogs.query(
            { ...input, ...(id === undefined ? {} : { nationId: id }) },
            options,
          );
          return {
            ...result,
            items: result.items.map((row) => ({
              title: `${row.tick}틱 · 국가 ${row.nationId}`,
              data: details(row.data),
            })),
          };
        }
        case 'battles': {
          const result = await game.battles.query(
            { ...input, ...(id === undefined ? {} : { generalId: id }) },
            options,
          );
          return { ...result, items: result.items.map((row) => ({ title: `${row.tick}틱 · ${row.text}` })) };
        }
      }
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const number = (key: string) => {
      const value = data.get(key);
      return value ? { [key]: Number(value) } : {};
    };
    const next = { kind, ...number('id'), ...number('fromTick'), ...number('toTick') };
    setFilter(next);
    load(next);
  }

  const generalOnly = kind === 'general' || kind === 'generalLogs' || kind === 'generalInputs';
  return (
    <section aria-label="운영 기록">
      <form className={styles.noticeForm} onSubmit={submit} onInput={query.clear}>
        <label>
          기록 종류
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.currentTarget.value as Kind);
              query.clear();
            }}
          >
            {Object.entries(kinds).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label key={kind}>
          {kind === 'nationLogs' ? '국가 번호' : '장수 번호'}
          {generalOnly ? '' : ' (선택)'}
          <input name="id" type="number" min={1} max={2147483647} required={generalOnly} />
        </label>
        {kind !== 'general' ? (
          <div className={styles.worldSettingsFields}>
            <label>
              시작 틱 <input name="fromTick" type="number" min={0} />
            </label>
            <label>
              끝 틱 <input name="toTick" type="number" min={0} />
            </label>
          </div>
        ) : null}
        <button type="submit" disabled={query.pending}>
          기록 조회
        </button>
      </form>
      {query.pending ? <p role="status">기록을 읽고 있습니다.</p> : null}
      {query.error ? <p role="alert">{query.error}</p> : null}
      {query.data ? (
        <>
          {query.data.items.length === 0 ? (
            <p>일치하는 기록이 없습니다.</p>
          ) : (
            <ul className={styles.worlds} aria-label="운영 기록 결과">
              {query.data.items.map(({ title, data }, index) => (
                <li key={index}>
                  {data === undefined ? (
                    title
                  ) : (
                    <details>
                      <summary>{title}</summary>
                      <pre className={styles.noticeBody}>{data}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
          {query.data.nextCursor && filter ? (
            <button type="button" onClick={() => load(filter, query.data?.nextCursor ?? undefined)}>
              다음 기록
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
