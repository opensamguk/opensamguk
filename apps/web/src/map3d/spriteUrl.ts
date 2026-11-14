import { imageBaseUrl } from '../portrait/portraitUrl';
import names from './spriteNames.json';
import geometry from './spriteGeometry.json';

export const MAP_SPRITE_GEOMETRY = geometry;

export const MAP_SPRITE_NAMES: readonly string[] = names;
const approvedNames = new Set(MAP_SPRITE_NAMES);

export function mapSpriteUrl(name: string): string {
  if (!approvedNames.has(name)) throw new Error('Unknown map sprite');
  return imageBaseUrl + '/public/map3d/sprites/' + name + '.webp';
}
