import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';
import { Tag, type TagTone } from '../ui/Tag';
import { ValueDelta } from '../ui/ValueDelta';
import styles from './Account.module.css';
import own from './HeritagePanel.module.css';

type Heritage = inferRouterOutputs<AppRouter>['heritage']['mine'];
type Entry = Heritage['entries'][number];

const KIND: Record<Entry['kind'], [string, TagTone]> = {
  SEASON_CREDIT: ['기수 지급', 'info'],
  CREATION_SPEND: ['생성 사용', 'muted'],
  BENEFIT_SPEND: ['혜택 구매', 'muted'],
  CREATION_REFUND: ['반환', 'accent'],
  FORFEIT: ['몰수', 'danger'],
};

const REFUND: Record<NonNullable<Entry['refund']>['reason'], string> = {
  ADMIN_END: '관리자 강제 종료',
  ADMIN_RESET: '관리자 초기화',
};

function describe(entry: Entry, first: number) {
  if (entry.kind === 'SEASON_CREDIT') {
    if (!entry.credit) return '월드 종료 지급';
    const { activityMonths, activityPoints, winPoints } = entry.credit;
    const months =
      `직접 명령한 게임 달 ${activityMonths}개월` +
      (activityPoints > 0 ? `로 ${activityPoints}점` : ` (${first}개월부터 1점)`);
    return winPoints > 0 ? `${months} · 통일 국가 소속 ${winPoints}점` : months;
  }
  if (entry.kind === 'CREATION_SPEND') return '장수 생성에 사용';
  if (entry.kind === 'BENEFIT_SPEND') return '장수 유산 혜택 구매에 사용';
  if (entry.kind === 'CREATION_REFUND') {
    const cause = entry.refund ? REFUND[entry.refund.reason] : '관리자 강제 종료·초기화';
    return `${cause}로 이 월드에서 장수 생성에 쓴 점수 반환`;
  }
  return entry.worldId === null ? '탈퇴 처리로 남은 점수 몰수' : '탈퇴한 계정이라 반환분을 몰수';
}

// 계정 화면의 유산 포인트 첩 (T4-96 AC-P2-33). 값은 AccountPage가 계정 확인과 함께 읽은 스냅샷만 쓴다.
// 기록 id는 렌더 키로만 쓰고 월드는 이름으로만 보인다.
export function HeritagePanel({ heritage }: { heritage: Heritage }) {
  const first = heritage.activityMonths[0] ?? 12;
  return (
    <section className={`${styles.panel} ${styles.wide}`} aria-labelledby="heritage-title">
      <h2 id="heritage-title">유산 포인트</h2>
      <p className={own.balance}>
        <span className={own.label}>보유</span>
        <strong className={own.points}>{heritage.balance}</strong>
        <span>점</span>
      </p>
      <p className={own.text}>
        유산 월드에서 포인트를 받고 장수 생성에 쓸 수 있습니다. 혜택을 지원하는 월드에서는 내 장수의 혜택도 구매할 수
        있습니다. 장수 생성에 1점이 능력치 +1이며 능력치 하나에 +{heritage.perStat}, 한 장수에 +{heritage.perGeneral}
        까지입니다.
      </p>
      <details className={own.rules}>
        <summary>받는 기준과 돌려받는 경우</summary>
        <ul>
          <li>
            유산 월드가 통일이나 마지막 해로 끝나면 그 월드에서 직접 명령한 게임 달 수를 셉니다.{' '}
            {heritage.activityMonths.join('·')}개월에 닿을 때마다 1점을 받습니다. 통일로 끝날 때 통일한 국가 소속이면{' '}
            {heritage.winPoints}점을 더 받습니다. 한 월드에서 받는 점수는 {heritage.perSeason}점까지입니다.
          </li>
          <li>
            관리자가 월드를 강제로 끝내거나 초기화하면 그 월드에서 장수 생성에 쓴 점수를 모두 돌려받고 새 점수는 받지
            않습니다.
          </li>
          <li>통일이나 마지막 해로 정상 종료한 월드에서 쓴 점수는 돌려받지 않습니다.</li>
          <li>보유 점수에는 상한이 없습니다. 탈퇴하면 남은 점수는 몰수되어 되살리지 않습니다.</li>
        </ul>
      </details>
      {(heritage.activeWorlds?.length ?? 0) > 0 && (
        <>
          <h3 className={own.subtitle}>진행 중인 유산 월드</h3>
          <ul>
            {heritage.activeWorlds.map((world) => (
              <li key={world.worldId}>
                <b>{world.worldName}</b> · 직접 명령 {world.activityMonths}개월 · 활동으로 {world.activityPoints}점
                {world.monthsToNextPoint === null ? '' : ` · 다음 기준까지 ${world.monthsToNextPoint}개월`}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 id="heritage-history" className={own.subtitle}>
        최근 기록
      </h3>
      {heritage.entries.length === 0 ? (
        <p className={own.empty}>아직 유산 기록이 없습니다. 유산 월드가 끝나면 이곳에 지급 기록이 남습니다.</p>
      ) : (
        <>
          <ul className={own.history} aria-labelledby="heritage-history">
            {heritage.entries.map((entry) => {
              const [label, tone] = KIND[entry.kind];
              return (
                <li key={entry.id}>
                  <time className={own.date} dateTime={entry.createdAt}>
                    {new Date(entry.createdAt).toLocaleDateString('ko-KR')}
                  </time>
                  <span className={own.kind}>
                    <Tag tone={tone}>{label}</Tag>
                  </span>
                  <span className={own.what}>
                    {entry.worldId === null ? null : entry.worldName ? (
                      <b>{entry.worldName}</b>
                    ) : (
                      <b className={own.gone}>삭제된 월드</b>
                    )}
                    <span>{describe(entry, first)}</span>
                  </span>
                  <span className={own.delta}>
                    <ValueDelta value={entry.delta} />점
                  </span>
                </li>
              );
            })}
          </ul>
          <p className={own.note}>최근 20건까지 보입니다.</p>
        </>
      )}
    </section>
  );
}
