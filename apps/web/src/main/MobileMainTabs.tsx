import { useLocation, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import styles from './MobileMainTabs.module.css';

// 375px 메인 하단 막대 (INT-25 5단계). 좁은 화면(<768px)에서는 메인 패널을 하나씩 바꿔 본다.
// 고른 패널은 주소의 해시에 둔다. 새로고침·뒤로 가기에도 남고, 다른 화면의 `예턴` 링크(#main-commands)로도 바로 연다.
// 768px 이상에서는 막대를 그리지 않고 모든 패널을 지금 배치대로 함께 보인다.
export const MOBILE_PANELS = [
  { key: 'map', label: '지도', hash: '' },
  { key: 'commands', label: '예턴', hash: 'main-commands' },
  { key: 'status', label: '현황', hash: 'main-status' },
  { key: 'records', label: '기록', hash: 'main-records' },
  { key: 'messages', label: '메시지', hash: 'main-messages' },
  { key: 'menu', label: '메뉴', hash: 'main-menu' },
] as const;

export type MobilePanel = (typeof MOBILE_PANELS)[number]['key'];

// 한 패널에 여러 칸이 있으면 칸마다 따로 tabpanel을 둔다. 데스크톱 격자에서 칸의 문서 순서를 바꾸지 않기 위해서다.
export const PANEL_PARTS: Partial<Record<MobilePanel, readonly string[]>> = {
  status: ['city', 'nation', 'general'],
};

// 메인 칸 이름(data-main-area, 머리글 id의 main- 뒤)이 속한 패널.
const AREA_PANEL: Record<string, MobilePanel> = {
  map: 'map',
  commands: 'commands',
  status: 'status',
  city: 'status',
  nation: 'status',
  general: 'status',
  records: 'records',
  'general-records': 'records',
  'nation-records': 'records',
  'world-records': 'records',
  messages: 'messages',
  menu: 'menu',
};

export function panelOfArea(area: string): MobilePanel {
  return AREA_PANEL[area] ?? 'map';
}

// 해시가 없거나 모르는 값이면 지도다.
export function panelFromHash(hash: string): MobilePanel {
  const value = hash.replace(/^#/, '');
  return value.startsWith('main-') ? panelOfArea(value.slice('main-'.length)) : 'map';
}

export function panelHash(panel: MobilePanel): string {
  return MOBILE_PANELS.find((item) => item.key === panel)!.hash;
}

export const panelTabId = (panel: MobilePanel) => `main-tab-${panel}`;
export const panelElementId = (panel: MobilePanel, part?: string) =>
  part ? `main-panel-${panel}-${part}` : `main-panel-${panel}`;

const controlsOf = (panel: MobilePanel) =>
  (PANEL_PARTS[panel]?.map((part) => panelElementId(panel, part)) ?? [panelElementId(panel)]).join(' ');

// 주소 해시의 패널과 패널 바꾸기. 바꾸기는 주소만 바꾸고(replace) 기록을 쌓지 않으며 ?city와 화면 위치는 그대로 둔다.
// then은 바뀐 패널이 그려진 뒤에 부른다(같은 패널이면 바로). 주소로 들어오면(새로고침·다른 화면의 링크·뒤로 가기) onArrive를 부른다.
// onArrive가 바뀌어도 다시 부르지 않는다. 해시나 scope(월드)가 바뀔 때만 부른다.
export function useMainPanel({
  scope,
  onArrive,
  onOpen,
}: {
  scope: string;
  onArrive: (hash: string) => void;
  onOpen: () => void;
}) {
  const hash = useLocation({ select: (location) => location.hash });
  const panel = panelFromHash(hash);
  const navigate = useNavigate();
  const callbacks = useRef({ onArrive, onOpen });
  useEffect(() => {
    callbacks.current = { onArrive, onOpen };
  }, [onArrive, onOpen]);
  const afterSwitch = useRef<(() => void) | null>(null);
  useEffect(() => {
    const run = afterSwitch.current;
    afterSwitch.current = null;
    if (run) run();
    else callbacks.current.onArrive(hash);
  }, [hash, scope]);
  const openPanel = useCallback(
    (next: MobilePanel, then?: () => void) => {
      const run = then ?? (() => callbacks.current.onOpen());
      if (next === panel) {
        run();
        return;
      }
      afterSwitch.current = run;
      void navigate({
        to: '.',
        search: true,
        hash: panelHash(next),
        replace: true,
        resetScroll: false,
        hashScrollIntoView: false,
      });
    },
    [navigate, panel],
  );
  return { hash, panel, openPanel };
}

export type TabNote = {
  // 단추 모서리에 얹는 짧은 표. 화면 읽기에는 describedBy 쪽 문장을 읽힌다.
  badge?: string | null | undefined;
  danger?: boolean | undefined;
  // 시험과 꾸미기에 쓰는 상태 이름(예턴 저장 상태 등)
  status?: string | undefined;
  describedBy?: string | undefined;
};

export function MobileMainBar({
  active,
  onSelect,
  notes = {},
}: {
  active: MobilePanel;
  onSelect: (panel: MobilePanel) => void;
  notes?: Partial<Record<MobilePanel, TabNote>>;
}) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  // 수동 활성화: 화살표·Home·End는 초점만 옮기고 Enter·Space(단추 누르기)로 바꾼다.
  // 메시지 패널은 열면 읽음 처리를 하므로 지나가기만 해도 열리지 않게 한다.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = MOBILE_PANELS.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    tabs.current[next]?.focus();
  };
  return (
    <div className={styles.bar} role="tablist" aria-label="메인 화면" aria-orientation="horizontal">
      {MOBILE_PANELS.map(({ key, label }, index) => {
        const note = notes[key];
        const selected = key === active;
        return (
          <button
            key={key}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={panelTabId(key)}
            className={styles.tab}
            aria-selected={selected}
            aria-controls={controlsOf(key)}
            aria-describedby={note?.describedBy}
            tabIndex={selected ? 0 : -1}
            data-status={note?.status}
            onClick={() => onSelect(key)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {label}
            {note?.badge ? (
              <span className={styles.badge} data-danger={note.danger ? 'true' : undefined} aria-hidden="true">
                {note.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// 패널 하나(또는 패널의 칸 하나)를 감싼다. 넓은 화면에서는 display: contents라 안의 칸이 그대로 메인 격자에 놓이고,
// 좁은 화면에서는 고른 패널만 보인다. tabpanel 역할도 좁은 화면에서만 준다.
export function MobileTabPanel({
  panel,
  part,
  active,
  narrow,
  className,
  children,
}: {
  panel: MobilePanel;
  part?: string;
  active: MobilePanel;
  narrow: boolean;
  className?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <div
      id={panelElementId(panel, part)}
      className={className}
      data-mobile-panel={panel}
      data-active={panel === active}
      role={narrow ? 'tabpanel' : undefined}
      aria-labelledby={narrow ? panelTabId(panel) : undefined}
    >
      {children}
    </div>
  );
}
