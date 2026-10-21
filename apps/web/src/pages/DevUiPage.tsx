import { Portrait } from '../portrait/Portrait';
import { imageBaseUrl } from '../portrait/portraitUrl';
import { DisabledReason } from '../ui/DisabledReason';
import { NationBadge } from '../ui/NationBadge';
import { StatTable } from '../ui/StatTable';
import { EmptyState, ErrorState } from '../ui/States';
import { ValueDelta } from '../ui/ValueDelta';

// 개발 모드에서만 열리는 부품 모음. 상태별 모습을 한눈에 본다.
export function DevUiPage() {
  return (
    <main style={{ maxWidth: 720, margin: '32px auto', display: 'grid', gap: 24 }}>
      <h1>UI 부품</h1>
      <section>
        <h2>StatTable</h2>
        <StatTable
          caption="도시 수치"
          rows={[
            { label: '인구', value: 152_340, max: 620_500 },
            { label: '농업', value: 1_000, max: 12_500 },
            { label: '성벽', value: null, max: 12_200, hiddenReason: '다른 국가 정보' },
          ]}
        />
      </section>
      <section>
        <h2>ValueDelta</h2>
        <ValueDelta value={1234} /> <ValueDelta value={-56} /> <ValueDelta value={0} />
      </section>
      <section>
        <h2>NationBadge</h2>
        <NationBadge name="조조" color="#000080" /> <NationBadge name="원소" color="#ffd700" />{' '}
        <NationBadge name="재야" color={null} />
      </section>
      <section>
        <h2>EmptyState / ErrorState</h2>
        <EmptyState title="기록이 없습니다">첫 턴이 실행되면 여기에 나옵니다.</EmptyState>
        <ErrorState title="불러오지 못했습니다" onRetry={() => undefined} />
      </section>
      <section>
        <h2>Portrait</h2>
        <p>
          base URL: <code data-testid="image-base-url">{imageBaseUrl}</code>
        </p>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <Portrait id={10002} name="정원" variant="portrait" />
          <Portrait id={10002} name="정원" variant="icon" />
          <Portrait id={10002} name="정원" variant="thumb" />
          <Portrait id={11000} name="공도" variant="icon" />
          <Portrait id={null} name="유비" variant="portrait" />
          <Portrait id={null} name="관우" variant="icon" />
          <Portrait id={9999} name="장비" variant="thumb" />
        </div>
      </section>
      <section>
        <h2>DisabledReason</h2>
        <DisabledReason reason="교전 중인 상대가 아닙니다">출병</DisabledReason>
      </section>
    </main>
  );
}
