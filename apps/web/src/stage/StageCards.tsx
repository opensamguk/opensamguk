// 성 화면의 늘 보이는 작은 판(INT-29 완성 그림 04): 왼쪽 장수 카드, 오른쪽 도시 판과 예턴 다섯 칸, 왼쪽 아래 기록.
// 큰 판(내 장수, 도시, 예턴 서랍)은 카드를 누르거나 왼쪽 단추로 연다. 보이는 값은 메인과 같은 home.get이다(devsam 동등성).
import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';
import type { Home } from '../game/types';
import { displayName, officerName } from '../game/names';
import { Portrait } from '../portrait/Portrait';
import { LogKindIcon } from '../text/RichText';
import styles from './StageCards.module.css';

const n = (value: number) => value.toLocaleString('ko-KR');
const kit = (file: string) => {
  const source = `apps/web/src/art/ui/kit-b/${file}.webp`;
  return hasPublicImage(source) ? publicImageUrl(source) : null;
};

function Row({ icon, label, value }: { icon: string; label: string; value: string }) {
  const url = kit(icon);
  return (
    <div className={styles.row}>
      {url ? <img src={url} alt="" className={styles.rowIcon} /> : <span className={styles.rowIcon} />}
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

export function GeneralCard({ home, cityName, onOpen }: { home: Home; cityName: string; onOpen: () => void }) {
  const general = home.general;
  const name = displayName(general.name);
  const stats: Array<[string, string, number | undefined]> = [
    ['icon-stat-leadership', '통솔', general.leadership],
    ['icon-stat-strength', '무력', general.strength],
    ['icon-stat-intel', '지력', general.intel],
    ['icon-stat-politics', '정치', 'politics' in general ? (general.politics as number | undefined) : undefined],
    ['icon-stat-charm', '매력', 'charm' in general ? (general.charm as number | undefined) : undefined],
  ];
  return (
    <button
      type="button"
      className={`kit-list-general ${styles.card} ${styles.general}`}
      onClick={onOpen}
      aria-label={`내 장수 ${name}: 판 열기`}
    >
      <span className={styles.face}>
        <Portrait id={general.portraitId} name={name} variant="portrait" size={72} decorative />
      </span>
      <span className={styles.body}>
        <strong className={styles.title}>{name}</strong>
        <span className={styles.sub}>
          {home.nation ? home.nation.name : '재야'}, {officerName(general.officerLevel, general.nationId !== null)},{' '}
          {cityName}
        </span>
        {stats
          .filter((stat): stat is [string, string, number] => typeof stat[2] === 'number')
          .map(([icon, label, value]) => (
            <Row key={label} icon={icon} label={label} value={String(value)} />
          ))}
      </span>
    </button>
  );
}

export function CityCard({ home, cityName, onOpen }: { home: Home; cityName: string; onOpen: () => void }) {
  const city = home.city;
  if (!city) return null;
  const value = (key: string, maxKey?: string) => {
    const record = city as Record<string, unknown>;
    const now = record[key];
    if (typeof now !== 'number') return null;
    const max = maxKey ? record[maxKey] : undefined;
    return typeof max === 'number' ? `${n(now)} / ${n(max)}` : n(now);
  };
  const rows: Array<[string, string, string | null]> = [
    ['icon-res-population', '인구', value('population', 'populationMax')],
    ['icon-res-agriculture', '농업', value('agriculture', 'agricultureMax')],
    ['icon-res-commerce', '상업', value('commerce', 'commerceMax')],
    ['icon-res-security', '치안', value('security', 'securityMax')],
    ['icon-res-defence', '수비', value('defence', 'defenceMax')],
    ['icon-res-wall', '성벽', value('wall', 'wallMax')],
  ];
  return (
    <button
      type="button"
      className={`kit-list-city ${styles.card} ${styles.city}`}
      onClick={onOpen}
      aria-label={`${cityName}: 도시 판 열기`}
    >
      <strong className={styles.title}>{cityName}</strong>
      {rows
        .filter((row): row is [string, string, string] => row[2] !== null)
        .map(([icon, label, text]) => (
          <Row key={label} icon={icon} label={label} value={text} />
        ))}
    </button>
  );
}

export function TurnsCard({ home, onOpen }: { home: Home; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`kit-paper ${styles.card} ${styles.turns}`}
      onClick={onOpen}
      aria-label="내 예턴 서랍 열기"
    >
      <strong className={styles.paperTitle}>내 예턴</strong>
      <ol className={styles.turnList}>
        {home.turnsPreview.map((slot) => {
          const empty = !('commandKey' in slot) || !slot.commandKey;
          return (
            <li key={slot.slot} className="kit-row" data-empty={empty || undefined}>
              <b>{slot.slot + 1}</b> {empty ? '빈 칸' : (slot as { name?: string }).name}
            </li>
          );
        })}
      </ol>
    </button>
  );
}

export function LogCard({ home, onOpen }: { home: Home; onOpen: () => void }) {
  const logs = home.recentLogs.slice(0, 4);
  if (logs.length === 0) return null;
  return (
    <button
      type="button"
      className={`kit-tooltip ${styles.card} ${styles.logs}`}
      onClick={onOpen}
      aria-label="기록 판 열기"
    >
      {logs.map((log) => (
        <span key={log.id} className={styles.log}>
          <LogKindIcon kind={log.kind} />
          <span>{log.text}</span>
        </span>
      ))}
    </button>
  );
}
