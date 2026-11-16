#!/usr/bin/env python3
"""Build the INT-28 mountain mask from the pinned INT-27 SAN10 height field.

git show 57f8d715290a8b5c0146b49531deae9fd2b8c151:apps/web/src/map3d/heights/san10.ts > san10.ts
python tools/map-data/build-supply-mountains.py san10.ts
pnpm exec prettier --write packages/rules/src/world/map/supplyMountains.json
"""
import base64
import hashlib
import json
import math
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
directory = root / "packages/rules/src/world/map"
mask = next(row for row in json.loads((directory / "territoryLand.json").read_text()) if row["canvas"]["width"] == 1400)
source = Path(sys.argv[1]).read_text(encoding="utf-8-sig")
height, depth = (base64.b64decode(re.search(rf"export const {key} = '([^']+)'", source)[1]) for key in ("data", "depth"))
digest = hashlib.sha256(height + depth).hexdigest()
if digest != "09eb8433896cd5040d8efeb61b8da3743859d497bd28ef4b107019aaeb039687":
    raise ValueError("Unexpected SAN10 DEM digest")

land = base64.b64decode(mask["land"])
columns, rows = mask["columns"], mask["rows"]
mountain = bytearray(len(land))
for idx in range(columns * rows):
    if not land[idx >> 3] & (1 << (idx % 8)):
        continue
    u, v = mask["originX"] + idx % columns + 0.5, mask["originY"] + idx // columns + 0.5
    x = (u - v) * 8 / math.sqrt(2) + 700
    y = (u + v) * 8 / math.sqrt(2) + 500
    sample = height[round(y / 1000 * 499) * 700 + round(x / 1400 * 699)]
    if (sample / 255) ** 2 * 9000 >= 1500:
        mountain[idx >> 3] |= 1 << (idx % 8)

output = {key: mask[key] for key in ("basemap", "originX", "originY", "columns", "rows")}
output.update(heightSha256=digest, minimumMetres=1500, mountain=base64.b64encode(mountain).decode())
(directory / "supplyMountains.json").write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
