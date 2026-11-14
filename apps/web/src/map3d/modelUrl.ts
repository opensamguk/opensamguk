import { imageBaseUrl } from '../portrait/portraitUrl';
import names from './modelNames.json';

export const MAP_MODEL_NAMES: readonly string[] = names;
const approvedNames = new Set(MAP_MODEL_NAMES);

export function mapModelUrl(name: string): string {
  if (!approvedNames.has(name)) throw new Error('Unknown map model');
  return imageBaseUrl + '/public/map3d/models/' + name + '.glb';
}
