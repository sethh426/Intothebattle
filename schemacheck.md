Schema Check
============

This file documents how to run a live JSON-LD expansion validation (dereferencing the official schema.org context) and an offline fallback validator included in this repo.

1) Quick connectivity test (PowerShell)

```powershell
# Test access to schema.org
Invoke-WebRequest -Uri https://schema.org -UseBasicParsing -TimeoutSec 10
# or with curl
curl https://schema.org
```

2) Install dependencies

```powershell
python -m pip install --upgrade pip
python -m pip install pyld requests
```

3) Run the remote expansion validator (dereferences live schema.org)

Save the script `tools/validate_schema_expand_remote.py` (or reuse the snippet below) and run:

```powershell
python tools\validate_schema_expand_remote.py
```

The script outputs `schema_expansion_report_remote.json` and `schema_expansion_report_remote.txt` in the repository root.

Remote expansion script (use as-is):

```python
from pathlib import Path
import re, json
from pyld import jsonld

ROOT = Path('.')
script_re = re.compile(r'<script[^>]+type=[\"\']application/ld\+json[\"\'][^>]*>(.*?)</script>', re.I|re.S)

report = {"files":[], "summary":{"total_files":0, "expanded":0, "errors":0}}
for f in sorted(ROOT.glob('*.html')):
    text = f.read_text(encoding='utf-8')
    blocks = script_re.findall(text)
    fr = {"path": str(f), "blocks": []}
    for i, block in enumerate(blocks, start=1):
        br = {"index": i, "ok": False, "error": None}
        try:
            data = json.loads(block)
        except Exception as e:
            br['error'] = f'JSON parse error: {e}'
            report['summary']['errors'] += 1
            fr['blocks'].append(br)
            continue
        try:
            expanded = jsonld.expand(data)  # this will dereference remote contexts
            br['ok'] = True
            br['expanded_sample'] = expanded[:2]
            report['summary']['expanded'] += 1
        except Exception as e:
            br['error'] = f'Expansion error: {e}'
            report['summary']['errors'] += 1
        fr['blocks'].append(br)
    report['files'].append(fr)
    report['summary']['total_files'] += 1

Path('schema_expansion_report_remote.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')

lines = [f"JSON-LD expansion summary: files scanned: {report['summary']['total_files']}, expanded blocks: {report['summary']['expanded']}, errors: {report['summary']['errors']}"]
for fr in report['files']:
    if not fr['blocks']:
        lines.append(f"- {fr['path']}: no JSON-LD blocks")
        continue
    lines.append(f"- {fr['path']}: {len(fr['blocks'])} block(s)")
    for b in fr['blocks']:
        if b['ok']:
            lines.append(f"  - block #{b['index']}: expanded OK")
        else:
            lines.append(f"  - block #{b['index']}: ERROR: {b['error']}")

Path('schema_expansion_report_remote.txt').write_text('\n'.join(lines), encoding='utf-8')
print('\n'.join(lines))
```

4) Offline fallback

This repo already includes `tools/validate_schema_expand.py` which performs expansion using a minimal local `schema.org` context when network access is unavailable. It writes `schema_expansion_report_offline.*` files.

5) Files produced by validators

- `schema_validation_report.json` / `.txt` — syntactic checks (already present)
- `schema_expansion_report_offline.json` / `.txt` — offline expansion using local context
- `schema_expansion_report_remote.json` / `.txt` — produced when running the remote expansion validator

6) Next steps

- Run the remote script locally and paste `schema_expansion_report_remote.txt` here if you want me to analyze live expansion differences.
- Optionally, I can update `tools/validate_schema_expand.py` to prefer remote and fall back to local automatically (I can add that if you want).
