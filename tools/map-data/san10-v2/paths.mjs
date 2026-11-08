import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 저장소 안의 초안 자료 위치. 생성물은 data/, 검사 중간 파일은 임시 폴더에 둔다.
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..').replaceAll('\\', '/');
export const S = `${REPO}/resources/map-drafts/san10-v2`;
export const RETINUE_CHECK = path.join(os.tmpdir(), 'san10-v2-retinue-check.json');
