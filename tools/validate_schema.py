#!/usr/bin/env python3
import os, re, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

script_re = re.compile(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.I | re.S)

report = {"files":[], "summary": {"total_files":0, "files_with_jsonld":0, "total_blocks":0, "errors":0, "warnings":0}}

html_files = [p for p in ROOT.glob('*.html')]

for f in sorted(html_files):
    text = f.read_text(encoding='utf-8')
    blocks = script_re.findall(text)
    file_report = {"path": str(f.relative_to(ROOT)), "blocks": []}
    if blocks:
        report['summary']['files_with_jsonld'] += 1
    for i, block in enumerate(blocks, start=1):
        report['summary']['total_blocks'] += 1
        br = {"index": i, "raw": block.strip()[:500], "ok": False, "errors": [], "warnings": []}
        try:
            data = json.loads(block)
        except json.JSONDecodeError as e:
            br['errors'].append(f'JSON parse error: {e}')
            report['summary']['errors'] += 1
            file_report['blocks'].append(br)
            continue
        # basic checks
        if not isinstance(data, (dict, list)):
            br['warnings'].append('Top-level JSON-LD is not an object or array')
            report['summary']['warnings'] += 1
        # Normalize to list of graph objects
        entries = []
        if isinstance(data, dict) and '@graph' in data and isinstance(data['@graph'], list):
            entries = data['@graph']
        elif isinstance(data, list):
            entries = data
        else:
            entries = [data]
        for e in entries:
            if not isinstance(e, dict):
                br['warnings'].append('Graph entry is not an object')
                report['summary']['warnings'] += 1
                continue
            if '@context' not in e and '@context' not in data:
                br['warnings'].append('Missing @context (recommended: https://schema.org)')
                report['summary']['warnings'] += 1
            t = e.get('@type') or data.get('@type')
            if not t:
                br['warnings'].append('Missing @type for JSON-LD entity')
                report['summary']['warnings'] += 1
            else:
                # Some light type-specific checks
                if isinstance(t, str) and t.lower().find('faq') >= 0:
                    # expect mainEntity
                    me = e.get('mainEntity') or data.get('mainEntity')
                    if not me or not isinstance(me, list):
                        br['errors'].append('FAQ JSON-LD missing mainEntity array')
                        report['summary']['errors'] += 1
                if isinstance(t, str) and t.lower().find('softwareapplication') >= 0:
                    if not e.get('name') or not e.get('url'):
                        br['warnings'].append('SoftwareApplication should include name and url')
                        report['summary']['warnings'] += 1
                if isinstance(t, str) and t.lower().find('website') >= 0:
                    if not e.get('url'):
                        br['warnings'].append('WebSite should include url')
                        report['summary']['warnings'] += 1
        if not br['errors']:
            br['ok'] = True
        file_report['blocks'].append(br)
    report['files'].append(file_report)
    report['summary']['total_files'] += 1

# Save report
out_json = ROOT / 'schema_validation_report.json'
out_txt = ROOT / 'schema_validation_report.txt'
out_json.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')

lines = []
lines.append(f"Schema validation summary: files scanned: {report['summary']['total_files']}, files with JSON-LD: {report['summary']['files_with_jsonld']}, blocks: {report['summary']['total_blocks']}, errors: {report['summary']['errors']}, warnings: {report['summary']['warnings']}")
for fr in report['files']:
    if not fr['blocks']:
        lines.append(f"- {fr['path']}: no JSON-LD blocks found")
        continue
    lines.append(f"- {fr['path']}: {len(fr['blocks'])} JSON-LD block(s)")
    for b in fr['blocks']:
        status = 'OK' if b['ok'] and not b['errors'] else 'ISSUES'
        lines.append(f"  - block #{b['index']}: {status}")
        for err in b['errors']:
            lines.append(f"    ERROR: {err}")
        for w in b['warnings']:
            lines.append(f"    WARN: {w}")

out_txt.write_text('\n'.join(lines), encoding='utf-8')
print('\n'.join(lines))
print(f'Full JSON report: {out_json}')
print(f'Summary text report: {out_txt}')

sys.exit(0)
