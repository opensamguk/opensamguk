// 이름 효과를 입힌 글 (INT-29, 사용자 2026-11-14). 텍스트 효과 목록은 docs/plans/INT-29.md 「텍스트 효과」에 있다.
// - 장수: 원형 초상(소속 세력색 테두리) + 굵은 이름
// - 세력: 세력색 네모 + 굵은 이름
// - 도시: 소속 세력색 성 아이콘 + 점선 밑줄 이름
// - 숫자: 굵게, 부호가 +면 초록·−면 빨강
// 월드의 장수·세력·도시 목록은 지도 조회(world.map) 캐시에서 온다. 아직 없으면 글을 그대로 보인다.
import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from 'react';
import { displayName } from '../game/names';
import { useWorldMap } from '../game/queries';
import { Portrait } from '../portrait/Portrait';
import { StageIcon, type StageIconName } from '../ui/GameIcon';
import { buildMatcher, type EntityMatcher, type TextEntity, type TextPiece } from './entities';
import styles from './RichText.module.css';

export function useTextEntities(worldId: string | undefined): EntityMatcher | null {
  const map = useWorldMap(worldId ?? '');
  const data = worldId ? map.data : undefined;
  return useMemo(() => {
    if (!data) return null;
    const color = new Map(data.nations.map((nation) => [nation.id, nation.color]));
    const cityColor = new Map(
      data.cities.map((city) => [city.key, city.nationId === null ? null : (color.get(city.nationId) ?? null)]),
    );
    const entities: TextEntity[] = [
      ...data.nations.map((nation) => ({
        kind: 'nation' as const,
        name: nation.name,
        color: nation.color,
        id: nation.id,
      })),
      ...(data.generals ?? []).map((general) => ({
        kind: 'general' as const,
        name: displayName(general.name),
        portraitId: general.portraitId,
        color: general.nationId === null ? null : (color.get(general.nationId) ?? null),
        id: general.id,
      })),
      ...data.cities.map((city) => ({
        kind: 'city' as const,
        name: city.name,
        color: cityColor.get(city.key) ?? null,
        id: city.key,
      })),
    ];
    return buildMatcher(entities);
  }, [data]);
}

// 기록 묶음(장수 동향, 개인 기록 등) 단위로 이름 목록을 한 번 깔고, 그 안의 줄들은 <Rich>로 쓴다.
const MatcherContext = createContext<EntityMatcher | null>(null);
export function TextEntityScope({ worldId, children }: { worldId: string; children: ReactNode }) {
  const matcher = useTextEntities(worldId);
  return <MatcherContext.Provider value={matcher}>{children}</MatcherContext.Provider>;
}
export function Rich({ text, actor }: { text: string; actor?: TextEntity | undefined }) {
  return <RichText text={text} matcher={useContext(MatcherContext)} actor={actor} />;
}

const tint = (color: string | null | undefined): CSSProperties => ({ ['--tint' as string]: color ?? '#8c7b5a' });

// actor: 줄의 주인공(장수 동향의 장수). 안개로 지도 목록에 없는 장수도 글 맨 앞 이름에 초상을 붙인다.
export function RichText({
  text,
  matcher,
  actor,
}: {
  text: string;
  matcher: EntityMatcher | null;
  actor?: TextEntity | undefined;
}) {
  const pieces = useMemo((): TextPiece[] => {
    const base: TextPiece[] = matcher ? matcher.pieces(text) : [{ type: 'text', text }];
    const first = base[0];
    if (!actor || !first || first.type !== 'text' || !first.text.startsWith(actor.name)) return base;
    const rest = first.text.slice(actor.name.length);
    return [
      { type: 'entity', text: actor.name, entity: actor },
      ...(rest ? [{ type: 'text' as const, text: rest }] : []),
      ...base.slice(1),
    ];
  }, [matcher, text, actor]);
  return (
    <>
      {pieces.map((piece, i) => {
        if (piece.type === 'text') return piece.text;
        if (piece.type === 'number')
          return (
            <b key={i} className={`${styles.num} ${piece.sign > 0 ? styles.up : piece.sign < 0 ? styles.down : ''}`}>
              {piece.text}
            </b>
          );
        const { entity } = piece;
        if (entity.kind === 'general')
          return (
            <span key={i} className={styles.general} style={tint(entity.color)} data-entity="general">
              <Portrait
                id={entity.portraitId ?? null}
                name={entity.name}
                variant="icon"
                shape="round"
                size={18}
                decorative
              />
              <b>{piece.text}</b>
            </span>
          );
        if (entity.kind === 'nation')
          return (
            <span key={i} className={styles.nation} style={tint(entity.color)} data-entity="nation">
              <i aria-hidden="true" />
              <b>{piece.text}</b>
            </span>
          );
        return (
          <span key={i} className={styles.city} style={tint(entity.color)} data-entity="city">
            <StageIcon name="city" size={13} />
            {piece.text}
          </span>
        );
      })}
    </>
  );
}

// 기록 종류 → 줄 앞 아이콘과 색조. 모르는 종류는 아이콘 없이 둔다.
const KIND_ICON: Record<string, { icon: StageIconName; tone: 'war' | 'good' | 'bad' | 'state' | 'calm' }> = {
  conquest: { icon: 'capture', tone: 'war' },
  capture: { icon: 'capture', tone: 'war' },
  victory: { icon: 'victory', tone: 'good' },
  defeat: { icon: 'defeat', tone: 'bad' },
  battle: { icon: 'battle', tone: 'war' },
  domestic: { icon: 'domestic', tone: 'calm' },
  betrayal: { icon: 'betrayal', tone: 'bad' },
  found: { icon: 'found', tone: 'state' },
  fall: { icon: 'fall', tone: 'bad' },
  declare: { icon: 'declare', tone: 'war' },
  review: { icon: 'review', tone: 'calm' },
  success: { icon: 'success', tone: 'good' },
  failure: { icon: 'failure', tone: 'bad' },
};

export function LogKindIcon({ kind }: { kind: string }) {
  const entry = KIND_ICON[kind];
  if (!entry) return null;
  return (
    <span className={`${styles.kind} ${styles[entry.tone]}`} data-log-icon={kind}>
      <StageIcon name={entry.icon} size={14} />
    </span>
  );
}
