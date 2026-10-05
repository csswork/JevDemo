"""Bake four distant crown silhouettes from existing MIT ez-tree leaf textures.

Run with Python + Pillow + numpy; no model or paid generation dependencies.
"""
from pathlib import Path
import hashlib
import json
import random

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'node_modules/@dgreenheck/ez-tree/src/lib/assets/leaves'
OUT = ROOT / 'public/scene/eztree'
atlas = Image.new('RGBA', (512, 512))
source_names = ['oak_color.png', 'ash_color.png']
leaves = [Image.open(SOURCES / name).convert('RGBA') for name in source_names]

for variant in range(4):
    rng = random.Random(9231 + variant)
    crown = Image.new('RGBA', (256, 256))
    for _ in range(150):
        # Leaf clusters overlap densely inside an irregular rounded crown.
        angle = rng.uniform(0, np.pi * 2)
        radius = rng.random() ** .5
        x = 128 + np.cos(angle) * radius * (65 + variant * 3)
        y = 128 + np.sin(angle) * radius * (61 - variant * 2)
        size = rng.randrange(42, 71)
        leaf = leaves[rng.randrange(2)].resize((size, size), Image.Resampling.LANCZOS)
        leaf = leaf.rotate(rng.uniform(-180, 180), Image.Resampling.BICUBIC, expand=True)
        alpha = leaf.getchannel('A')
        leaf = ImageEnhance.Brightness(leaf).enhance(.68 + (1 - y / 256) * .52)
        leaf.putalpha(alpha)
        crown.alpha_composite(leaf, (int(x - leaf.width / 2), int(y - leaf.height / 2)))
    # Retain leaf detail but unify its palette with the illustrated landscape.
    pixels = np.array(crown).astype(np.float32)
    luminance = (pixels[:, :, 0] * .21 + pixels[:, :, 1] * .72 + pixels[:, :, 2] * .07) / 125
    for channel, base in enumerate((120, 166, 91)):
        pixels[:, :, channel] = np.clip(base * luminance, 0, 255)
    crown = Image.fromarray(pixels.astype(np.uint8))
    # Dilate RGB beneath transparent pixels to prevent dark mipmap fringes.
    alpha = crown.getchannel('A')
    rgb = crown.convert('RGB').filter(ImageFilter.MaxFilter(9))
    rgb.paste(crown.convert('RGB'), mask=alpha)
    rgb.putalpha(alpha)
    atlas.paste(rgb, ((variant % 2) * 256, (variant // 2) * 256))

OUT.mkdir(parents=True, exist_ok=True)
atlas.save(OUT / 'far-canopy.png', optimize=True)
metadata = {
    'license': 'MIT', 'copyright': '2024 Daniel Greenheck',
    'license_file': 'LICENSE', 'generator': 'scripts/bake-far-canopy.py',
    'sources': {name: hashlib.sha256((SOURCES / name).read_bytes()).hexdigest() for name in source_names},
    'size': [512, 512], 'variants': 4,
    'output_sha256': hashlib.sha256((OUT / 'far-canopy.png').read_bytes()).hexdigest(),
}
(OUT / 'far-canopy.provenance.json').write_text(json.dumps(metadata, indent=2) + '\n')
print('Baked 512x512 RGBA crown atlas with four variants.')
