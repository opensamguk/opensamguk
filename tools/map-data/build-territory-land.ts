import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { terrainGrid } from '../../apps/web/src/main/terrainTiles';
import { decodeDepth, decodeMetres, groundAt, heightFieldFromMetres } from '../../apps/web/src/map3d/terrain3d';
import * as operational from '../../apps/web/src/map3d/heights/operational';
import * as san10 from '../../apps/web/src/map3d/heights/san10';
import { fromTile, assignTerritory } from '../../packages/shared/src/territory';
import { palette as opPalette } from '../../apps/web/src/main/pixel-basemap.json';
import { palette as sanPalette } from '../../apps/web/src/main/san10-pixel-basemap.json';
// Run from the repository root with the two basemap PNGs converted to raw RGBA
// in the supplied directory. The exact palettes, height and coast calculations are the 3D map's.
const [rgbaDirectory] = process.argv.slice(2);
if (!rgbaDirectory) throw new Error('Usage: pnpm exec tsx tools/map-data/build-territory-land.ts <RGBA directory>');
const result = [];
for (const [id, heights, palette, file] of [
  ['integration', operational, opPalette, 'pixel-basemap'],
  ['san10', san10, sanPalette, 'san10-pixel-basemap'],
] as const) {
  const { canvas, basemap } = JSON.parse(readFileSync('resources/map/' + id + '.json', 'utf8'));
  const { columns, rows } = heights;
  const rgba = readFileSync(join(rgbaDirectory, file + '.rgba'));
  if (rgba.length !== columns * rows * 4) throw new Error('Basemap RGBA dimensions do not match: ' + file);
  const grid = { columns, rows, cells: terrainGrid(rgba, columns, rows, palette) };
  const lake = Object.keys(opPalette).indexOf('lake');
  const field = heightFieldFromMetres(grid, decodeMetres(heights), decodeDepth(heights, columns, rows));
  const tile = 8;
  const land = assignTerritory([], canvas, tile, () => false);
  const bytes = new Uint8Array(Math.ceil(land.owner.length / 8));
  for (let i = 0; i < land.owner.length; i++) {
    const p = fromTile(
      land.originX + (i % land.columns) + 0.5,
      land.originY + Math.floor(i / land.columns) + 0.5,
      canvas,
      tile,
    );
    if (p.x < 0 || p.y < 0 || p.x > canvas.width || p.y > canvas.height) continue;
    const u = p.x / canvas.width,
      v = p.y / canvas.height;
    const ci = Math.min(columns - 1, Math.floor(u * columns));
    const ri = Math.min(rows - 1, Math.floor(v * rows));
    const raw = field[Math.round(v * (rows - 1)) * columns + Math.round(u * (columns - 1))]!;
    if ((groundAt(field, grid, canvas, p.x, p.y) > 0 && raw > 0.05) || grid.cells[ri * columns + ci] === lake)
      bytes[i >> 3]! |= 1 << (i % 8);
  }
  const { originX, originY, columns: tileColumns, rows: tileRows } = land;
  result.push({
    canvas,
    basemap,
    originX,
    originY,
    columns: tileColumns,
    rows: tileRows,
    land: Buffer.from(bytes).toString('base64'),
  });
}
writeFileSync('packages/rules/src/world/map/territoryLand.json', JSON.stringify(result, null, 2) + '\n');
