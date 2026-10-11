#!/usr/bin/env python3
"""Build the Flow Arena page from arena.template.html.

The GitHub bridge (create_or_update_file) carries file content as a single
command-line argument (~128KB OS limit) and cannot carry binary files, so:
  - persona art ships as base64 data URIs in two JS files (arena-art-a.js,
    arena-art-b.js) that assign window.ART_A / window.ART_B;
  - the hero art is inlined into arena.html as a data URI;
  - every produced file stays under ~125KB so the bridge can push it.
PNG masters live in assets/arena-art/.
"""
import base64, io, json, os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = os.path.join(ROOT, 'assets', 'arena-art')
A_IDS = ['vex', 'audrey']
B_IDS = ['echo', 'fade']
C_IDS = ['longshot', 'rook']

def data_uri(png_path, size, quality):
    im = Image.open(png_path).convert('RGB')
    if size: im = im.resize(size, Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=quality)
    return 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode()

def write(name, content):
    p = os.path.join(ROOT, name)
    open(p, 'w').write(content)
    print('wrote', name, len(content), 'bytes')
    assert len(content) < 125000, f'{name} too large for bridge push'

art_a = {pid: data_uri(os.path.join(ART, f'{pid}.png'), (480, 480), 74) for pid in A_IDS}
art_b = {pid: data_uri(os.path.join(ART, f'{pid}.png'), (480, 480), 74) for pid in B_IDS}
art_c = {pid: data_uri(os.path.join(ART, f'{pid}.png'), (480, 480), 74) for pid in C_IDS}
write('arena-art-a.js', 'window.ART_A = ' + json.dumps(art_a) + ';\n')
write('arena-art-b.js', 'window.ART_B = ' + json.dumps(art_b) + ';\n')
write('arena-art-c.js', 'window.ART_C = ' + json.dumps(art_c) + ';\n')

hero = data_uri(os.path.join(ART, 'hero.png'), (840, 560), 66)
write('arena-art-d.js', 'window.ART_D = ' + json.dumps({'hero': hero}) + ';\n')

tpl = open(os.path.join(ROOT, 'arena.template.html')).read()
assert 'arena-art/' not in tpl, 'unreplaced art path reference remains'
write('arena.html', tpl)
