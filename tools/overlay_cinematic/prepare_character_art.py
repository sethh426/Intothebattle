from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public' / 'assets' / 'overlay-cinematic' / 'portraits'
SOURCES = ROOT / 'docs' / 'art' / 'overlay-cinematic' / 'sources'
OUT.mkdir(parents=True, exist_ok=True)

SHEETS = [
    (SOURCES / 'prismatic-hero-trio.png', ['solar-vanguard', 'prism-arcanist', 'tempest-lancer']),
    (SOURCES / 'solar-hero-trio.png', ['verdant-oracle', 'moonveil-huntress', 'emberforged-colossus']),
]

for source, names in SHEETS:
    image = Image.open(source).convert('RGBA')
    width, height = image.size
    for index, name in enumerate(names):
        left = round(width * index / 3)
        right = round(width * (index + 1) / 3)
        crop = image.crop((left, 0, right, height))
        alpha_box = crop.getchannel('A').getbbox()
        if alpha_box:
            crop = crop.crop(alpha_box)
        target = Image.new('RGBA', (640, 1024))
        crop.thumbnail((610, 990), Image.Resampling.LANCZOS)
        target.alpha_composite(crop, ((640 - crop.width) // 2, 1024 - crop.height - 10))
        target.save(OUT / f'{name}.webp', 'WEBP', lossless=True, quality=95, method=6)

portal = Image.open(SOURCES / 'prismatic-horde-portal.png').convert('RGBA')
portal.save(OUT / 'prismatic-horde-portal.webp', 'WEBP', lossless=True, quality=95, method=6)

boss = Image.open(SOURCES / 'celestial-rift-regent.png').convert('RGBA')
boss.thumbnail((768, 1152), Image.Resampling.LANCZOS)
boss.save(OUT / 'celestial-rift-regent.webp', 'WEBP', quality=90, method=6)

board = Image.open(ROOT / 'docs' / 'art' / 'overlay-cinematic' / 'concepts' / 'direction-02-prismatic-celestial.png').convert('RGB')
w, h = board.size
region = board.crop((w // 2, int(h * .39), w, int(h * .81)))
region.thumbnail((1280, 620), Image.Resampling.LANCZOS)
region.save(OUT / 'prismatic-takeover-map.webp', 'WEBP', quality=88, method=6)
