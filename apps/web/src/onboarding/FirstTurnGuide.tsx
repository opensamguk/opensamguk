import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import mapIcon from '../art/icons/map.png';
import nationIcon from '../art/icons/nation.png';
import turnsIcon from '../art/icons/turns.png';
import { automated, dismissGuide, isGuideDismissed, rememberWorld } from './guideStorage';
import styles from './FirstTurnGuide.module.css';

// 첫 턴 안내 (INT-20, 시안 S2-Onboard). 지금 화면에서 사실인 것만 적는다. 규칙·수치는 바꾸지 않는다.
export const GUIDE_STEPS = [
  {
    icon: mapIcon,
    label: '지도 보기',
    hint: '내 도시와 이웃',
    title: '지도에서 내 도시를 찾으세요',
    text: '지도의 도시를 누르면 도시 정보 칸에 그 도시의 수치가 나옵니다. 다른 도시를 보다가 내 도시로 단추를 누르면 내 장수가 있는 도시로 돌아옵니다.',
  },
  {
    icon: turnsIcon,
    label: '예턴 넣기',
    hint: '칸 고르고 명령',
    title: '예턴에 첫 명령을 넣으세요',
    text: '명령 목록의 예턴은 30칸입니다. 한 턴은 게임 달력의 한 달이고 턴마다 1칸씩 실행합니다. 칸을 고른 뒤 명령 찾기에서 명령을 골라 넣으세요.',
  },
  {
    icon: nationIcon,
    label: '저장',
    hint: '저장해야 실행됩니다',
    title: '저장해야 명령이 실행됩니다',
    text: '칸에 넣은 명령은 저장 단추를 눌러야 서버에 남습니다. 저장하지 않은 편집은 턴이 와도 실행되지 않습니다.',
  },
] as const;

// 장수가 있는 플레이어가 이 월드의 메인을 처음 열 때 한 번 띄운다. 닫으면 월드별로 기억한다.
// 월드 화면 어디서든 마지막 월드를 적어 두어 도움말의 다시 보기 링크가 쓴다.
export function FirstTurnGuide({ worldId, show }: { worldId: string; show: boolean }) {
  const [open, setOpen] = useState(() => !automated() && !isGuideDismissed(worldId));
  useEffect(() => rememberWorld(worldId), [worldId]);
  if (!open || !show) return null;
  return (
    <GuideDialog
      onClose={() => {
        dismissGuide(worldId);
        setOpen(false);
      }}
    />
  );
}

function GuideDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const titleId = useId();
  const textId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const current = GUIDE_STEPS[step]!;
  const last = GUIDE_STEPS.length - 1;

  // 열 때 앞의 초점을 기억했다가 닫으면 돌려준다.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => previous?.focus();
  }, []);
  // 단계가 바뀌면 단추가 사라질 수 있으므로 제목으로 초점을 옮겨 새 단계를 읽힌다.
  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialog.current) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled])')];
    const first = focusable[0];
    const end = focusable[focusable.length - 1];
    if (!first || !end) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === heading.current)) {
      event.preventDefault();
      end.focus();
    } else if (!event.shiftKey && (active === end || !dialog.current.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={styles.backdrop}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        className={styles.dialog}
        data-testid="first-turn-guide"
        onKeyDown={onKeyDown}
      >
        <span className={styles.plaque}>
          첫 턴 안내 · <span className="num">{step + 1}</span> / <span className="num">{GUIDE_STEPS.length}</span>
        </span>
        <h2 ref={heading} id={titleId} className={styles.title} tabIndex={-1}>
          {current.title}
        </h2>
        <p id={textId} className={styles.text}>
          {current.text}
        </p>
        <ol className={styles.steps}>
          {GUIDE_STEPS.map((item, index) => (
            <li
              key={item.label}
              className={index === step ? `${styles.step} ${styles.current}` : styles.step}
              aria-current={index === step ? 'step' : undefined}
            >
              <img className="pixel-art" src={item.icon} alt="" width={48} height={48} />
              <strong>
                <span className="num">{index + 1}</span>. {item.label}
              </strong>
              <span className={styles.hint}>{item.hint}</span>
            </li>
          ))}
        </ol>
        <div className={styles.actions}>
          {step > 0 ? (
            <button type="button" className={styles.secondary} onClick={() => setStep(step - 1)}>
              이전
            </button>
          ) : null}
          {step < last ? (
            <button type="button" className={styles.primary} onClick={() => setStep(step + 1)}>
              다음
            </button>
          ) : null}
          <button type="button" className={`${styles.secondary} ${styles.close}`} onClick={onClose}>
            안내 닫기
          </button>
        </div>
        <p className={styles.note}>한 번 닫으면 이 월드에서는 다시 뜨지 않습니다. 도움말에서 다시 볼 수 있습니다.</p>
      </div>
    </div>
  );
}
