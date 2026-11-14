"""Generate D-095 Rodin comparison assets from the approved text prompts."""
import argparse
import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

BASE = 'https://api.hyper3d.com/api/v2'
PROMPTS = {
    'capital': 'Late Han China fortified imperial capital, weathered grey brick courses, crenellations, four tall tiled corner towers, three-tier south gate with curved eaves, yellow glazed palace, 150 courtyard roofs on grid streets, trees, moat and bridge, square plinth. Original realistic game asset, no text.',
    'pass': 'Late Han China Hulao Pass on a compact square base: two natural rock cliffs joined by a crenellated aged grey brick fortress, three arch openings through the wall, tall two-tier gatehouse with curved tile eaves. Original realistic game asset, no text.',
    'camp': 'Late Han China field encampment, wood palisade, two watchtowers and an entrance, cloth tents, square dirt base and simple paths. Original realistic game asset, no text.',
    'houses': 'Late Han China cluster of courtyard houses on a square plinth, dark curved clay tiled roofs, weathered cream walls, timber doors, narrow dirt lane, water well and two trees. Original realistic game asset, no text.',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--env-file', type=Path, default=Path('D:/codex-tools/secrets/ai3d.env'))
    parser.add_argument('--terms', type=Path, required=True)
    args = parser.parse_args()
    settings = (line.partition('=') for line in args.env_file.read_text(encoding='utf-8-sig').splitlines()
                if '=' in line and not line.lstrip().startswith('#'))
    key = os.environ.get('RODIN_API_KEY') or next(
        (value.strip().strip("'"+chr(34)) for name, _, value in settings
         if name.strip().removeprefix('export ') == 'RODIN_API_KEY'), '')
    if not key or not args.terms.is_file():
        parser.error('Rodin API key and local terms snapshot required')

    def call(path, data=None, content_type='application/json'):
        if isinstance(data, dict):
            data = json.dumps(data).encode()
        request = Request(BASE + path, data, headers={'Authorization': 'Bearer ' + key, 'Content-Type': content_type})
        with urlopen(request, timeout=40) as response:
            result = json.load(response)
        if result.get('error'):
            raise RuntimeError(f'Rodin {path}: {result["error"]}')
        return result

    args.output.mkdir(parents=True, exist_ok=True)
    manifest = args.output / 'sources.json'
    records = json.loads(manifest.read_text()) if manifest.exists() else {}
    for name, prompt in PROMPTS.items():
        output = args.output / (name + '.glb')
        if output.exists() and name in records:
            continue
        fields = {'prompt': prompt, 'tier': 'Gen-2.5-Extreme-Low', 'mesh_mode': 'Raw',
                  'geometry_file_format': 'glb', 'material': 'PBR', 'seed': '314'}
        boundary = '----opensamguk-d095-rodin'
        form = ''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"\r\n\r\n{value}\r\n'
                       for field, value in fields.items()) + f'--{boundary}--\r\n'
        task = call('/rodin', form.encode(), 'multipart/form-data; boundary=' + boundary)
        print(f'{name}: submitted, credits consumed {task.get("consumed")}', flush=True)
        deadline = time.monotonic() + 420
        pause = 5
        while time.monotonic() < deadline:
            time.sleep(pause)
            try:
                result = call('/status', {'subscription_key': task['jobs']['subscription_key']})
            except HTTPError as error:
                if error.code != 429:
                    raise
                pause = max(pause, int(error.headers.get('Retry-After', 15)))
                continue
            states = [job['status'] for job in result.get('jobs', [])]
            if 'Failed' in states:
                raise RuntimeError(f'{name}: Rodin job failed')
            if states and all(state == 'Done' for state in states):
                break
            pause = min(30, pause + 5)
        else:
            raise RuntimeError(f'{name}: Rodin deadline elapsed')
        result = call('/download', {'task_uuid': task['uuid']})
        item = next(entry for entry in result['list'] if entry['name'].endswith('.glb'))
        with urlopen(item['url'], timeout=60) as response:
            data = response.read()
        if not data.startswith(b'glTF'):
            raise RuntimeError(f'{name}: invalid GLB')
        output.write_bytes(data)
        records[name] = {'service': 'Hyper3D Rodin API', 'plan': 'free',
                         'generatedAt': datetime.now(timezone.utc).isoformat(), 'tier': fields['tier'],
                         'prompt': prompt, 'inputSha256': hashlib.sha256(prompt.encode()).hexdigest(),
                         'sha256': hashlib.sha256(data).hexdigest(),
                         'terms': os.path.relpath(args.terms, args.output).replace(os.sep, '/')}
        manifest.write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
        print(f'{name}: downloaded GLB', flush=True)


if __name__ == '__main__':
    try:
        main()
    except HTTPError as error:
        raise SystemExit(f'Rodin HTTP {error.code}') from None
