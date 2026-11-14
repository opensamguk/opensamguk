import { imageBaseUrl } from '../portrait/portraitUrl';
import names from './textureNames.json';

export const MAP_TEXTURE_NAMES: readonly string[] = names;
const approvedNames = new Set(MAP_TEXTURE_NAMES);

export function mapTextureUrl(name: string): string {
  if (!approvedNames.has(name)) throw new Error('Unknown map texture');
  return imageBaseUrl + '/public/map3d/textures/' + name + '.webp';
}
