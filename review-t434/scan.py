import json
from pathlib import Path
import subprocess

PIN = '4a99437b950ea73007e05c84863a6e0be7f6fcd2'
changed = subprocess.check_output(['git', 'diff', '--name-only', PIN, 'HEAD'], text=True).splitlines()
assert all(p.startswith('review-t434/') or p in ('.github/workflows/ci.yml', 'e2e/battleSim.review.spec.ts') for p in changed), changed
assets = list(Path('apps/web/dist/assets').glob('*.js'))
workers = [p for p in assets if p.name.startswith('battle.worker-')]
assert len(workers) == 1, workers
needle = '전투 병종이 없습니다.'
hits = [str(p) for p in assets if needle in p.read_text()]
assert hits == [str(workers[0])], hits
for p in assets:
    for text in ('node:', 'readFile', 'createHash'):
        assert text not in p.read_text(), (str(p), text)
print(json.dumps({'product_sha': PIN, 'probe_sha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), 'changed_only_probe': changed, 'js_files': [str(p) for p in assets], 'simulate_marker_only': hits, 'forbidden_strings': []}, ensure_ascii=False, indent=2))
