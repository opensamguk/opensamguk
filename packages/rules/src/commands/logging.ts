import { koreanParticle, logDisplayName, logPartsToText, type LeafPart, type LogPart } from '@opensamguk/shared';

export const logSentence = (parts: LogPart[]) => ({ text: logPartsToText(parts), parts });

export const textPart = (v: string): LeafPart => ({ t: 'text', v });
export const numPart = (v: number, digits: 0 | 1 | 2 = 0): LeafPart => ({ t: 'num', v, digits });
export const actPart = (key: string, name: string): LeafPart => ({ t: 'act', key, name });
export const cityPart = (city: { cityKey: number; name: string }): LeafPart => ({
  t: 'city',
  key: city.cityKey,
  name: city.name,
});
export const nationPart = ({ id, name, color }: { id: number; name: string; color: string }): LeafPart => ({
  t: 'nation',
  id,
  name,
  color,
});
export const generalPart = (general: { id: number; name: string; userId: string | null }): LeafPart => ({
  t: 'general',
  id: general.id,
  name: logDisplayName(general.name, general.userId === null),
});
export function destination(city: { cityKey: number; name: string }, action: string): LeafPart[] {
  const particle = koreanParticle(city.name, '으로/로');
  return [
    cityPart(city),
    textPart(particle ? `${particle} ` : ' 방면으로 '),
    actPart(action === '귀환' ? 'return' : 'move', action),
    textPart('했습니다.'),
  ];
}
