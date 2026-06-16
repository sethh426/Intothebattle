#!/usr/bin/env python3
import os, re, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
script_re = re.compile(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.I | re.S)

try:
    from pyld import jsonld
except Exception as e:
    jsonld = None
    PYLD_IMPORT_ERROR = e
else:
    PYLD_IMPORT_ERROR = None

# Provide an offline fallback for the schema.org context so expansion
# works without network access. This maps common terms used in our pages.
LOCAL_SCHEMA_ORG = {
    "@context": {
        "@vocab": "https://schema.org/",
        "SoftwareApplication": "https://schema.org/SoftwareApplication",
        "WebSite": "https://schema.org/WebSite",
        "Organization": "https://schema.org/Organization",
        "FAQPage": "https://schema.org/FAQPage",
        "mainEntity": {"@id": "https://schema.org/mainEntity", "@type": "@id"},
        "name": "https://schema.org/name",
        "url": "https://schema.org/url",
        "description": "https://schema.org/description",
        "publisher": {"@id": "https://schema.org/publisher", "@type": "@id"},
        "offers": "https://schema.org/offers",
        "price": "https://schema.org/price",
        "priceCurrency": "https://schema.org/priceCurrency",
        "Question": "https://schema.org/Question",
        "Answer": "https://schema.org/Answer",
        "acceptedAnswer": {"@id": "https://schema.org/acceptedAnswer", "@type": "@id"}
    }
}

def fallback_expand(data):
    """Small offline fallback for local/dev machines where pyld is unavailable."""
    context = LOCAL_SCHEMA_ORG['@context']

    def iri_for(term):
        value = context.get(term)
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            return value.get('@id', term)
        return f"https://schema.org/{term}"

    def expand_node(node):
        if isinstance(node, list):
            return [expand_node(item) for item in node]
        if not isinstance(node, dict):
            return node

        expanded = {}
        node_type = node.get('@type')
        if node_type:
            expanded['@type'] = [iri_for(node_type)] if isinstance(node_type, str) else node_type

        for key, value in node.items():
            if key in ('@context', '@type'):
                continue
            expanded_key = iri_for(key)
            expanded[expanded_key] = expand_node(value)
        return expanded

    return [expand_node(data)]

# Custom document loader: return the local context for schema.org, otherwise
# fall back to the default requests loader (which may be blocked in this env).
if jsonld is not None:
    def _local_loader(url):
        # match schema.org in various forms (with or without trailing slash and subpaths)
        if isinstance(url, str) and url.startswith('https://schema.org'):
            return {'contextUrl': None, 'documentUrl': url, 'document': LOCAL_SCHEMA_ORG}
        # fall back to requests loader (may attempt network)
        try:
            return jsonld.requests_document_loader(url)
        except Exception as e:
            # Last resort: return an empty context document to allow expansion to proceed
            return {'contextUrl': None, 'documentUrl': url, 'document': {}}

    jsonld.set_document_loader(_local_loader)
else:
    print(f'pyld not available; using offline fallback expansion: {PYLD_IMPORT_ERROR}')

report = {"files":[], "summary": {"total_files":0, "expanded":0, "errors":0}}
html_files = [p for p in ROOT.glob('*.html')]

for f in sorted(html_files):
    text = f.read_text(encoding='utf-8')
    blocks = script_re.findall(text)
    file_report = {"path": str(f.relative_to(ROOT)), "blocks": []}
    for i, block in enumerate(blocks, start=1):
        br = {"index": i, "ok": False, "error": None}
        try:
            data = json.loads(block)
        except Exception as e:
            br['error'] = f'JSON parse error: {e}'
            report['summary']['errors'] += 1
            file_report['blocks'].append(br)
            continue
        try:
            # If the block references the remote schema.org context, inline our local context
            if isinstance(data, dict):
                ctx = data.get('@context')
                if isinstance(ctx, str) and ctx.startswith('https://schema.org'):
                    data['@context'] = LOCAL_SCHEMA_ORG['@context']
            expanded = jsonld.expand(data) if jsonld is not None else fallback_expand(data)
            br['ok'] = True
            br['mode'] = 'pyld' if jsonld is not None else 'fallback'
            br['expanded_sample'] = expanded[:2]
            report['summary']['expanded'] += 1
        except Exception as e:
            br['error'] = f'Expansion error: {e}'
            report['summary']['errors'] += 1
        file_report['blocks'].append(br)
    report['files'].append(file_report)
    report['summary']['total_files'] += 1

out_json = ROOT / 'schema_expansion_report.json'
out_txt = ROOT / 'schema_expansion_report.txt'
out_json.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')

lines = [f"JSON-LD expansion summary: files scanned: {report['summary']['total_files']}, expanded blocks: {report['summary']['expanded']}, errors: {report['summary']['errors']}"]
for fr in report['files']:
    if not fr['blocks']:
        lines.append(f"- {fr['path']}: no JSON-LD blocks")
        continue
    lines.append(f"- {fr['path']}: {len(fr['blocks'])} block(s)")
    for b in fr['blocks']:
        if b['ok']:
            mode = b.get('mode', 'pyld')
            lines.append(f"  - block #{b['index']}: expanded OK ({mode})")
        else:
            lines.append(f"  - block #{b['index']}: ERROR: {b['error']}")

out_txt.write_text('\n'.join(lines), encoding='utf-8')
print('\n'.join(lines))
print(f'Full JSON report: {out_json}')
print(f'Summary text report: {out_txt}')
