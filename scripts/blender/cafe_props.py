"""
她身边那家咖啡店店里的小物件（src/vrm/scenes/streetInterior.ts 摆）：程序生成，导出一个 GLB，每件一个物体，
名字和原来用的 Poly Pizza 模型一样（代码按名字找、按高度缩放、按位置摆，不用改）。

    blender -b --factory-startup -P scripts/blender/cafe_props.py

输出 public/scene/models/cafe/props.glb。都按真实尺寸建，原点在底面中心，正面朝 -Y（three.js 里 +Z）。

  吧台上   espresso_machine（不锈钢的意式咖啡机：两个冲煮头和手柄、蒸汽棒、压力表、温杯盘、滴水盘）、cup_tea（杯碟）、cup（马克杯）、
           frappe（透明杯的星冰乐：奶油、吸管、拱盖）、cake（草莓奶油蛋糕，切掉一块）、cupcake、croissant、muffin、donut_sprinkles
  家具     lamp_round_table（吧台上的台灯，灯罩亮）、bar_stool、round_table、chair（小酒馆的木椅）、couch_medium、rug_round、
           coffee_table、bookcase_books（一排排书）、wall_painting_1（海边小镇的画）
  灯、植物 light_ceiling（吊灯：吊线、深绿的金属灯罩、亮着的灯泡）、houseplant_1（琴叶榕）、houseplant_2（一团圆叶的）、houseplant_3（小多肉）

材质槽见 kit_common.py；glow = 灯泡、台灯灯罩（营业时间亮，代码按时间调）。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kit_common import MODELS, Builder, export, fresh_scene  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

OUT = os.path.join(MODELS, 'cafe', 'props.glb')
T = Matrix.Translation
R = Matrix.Rotation
S = lambda x, y, z: Matrix.Diagonal((x, y, z, 1))  # noqa: E731

COLORS = {
    'steel': '#c9ced3',
    'steel_dark': '#6e747a',
    'black': '#222326',
    'white': '#f6f4ee',
    'cream': '#f3ead8',
    'coffee': '#4a2c1a',
    'latte': '#b88a5e',
    'gauge': '#f4f2ea',
    'red': '#c8322a',
    'glass': '#dfe8ea',
    'straw': '#3f9a5a',
    'cake_sponge': '#e9c98e',
    'cake_cream': '#fbf6ec',
    'strawberry': '#d8343a',
    'choco': '#5a3424',
    'liner': '#d77d9a',
    'frost_pink': '#f4b8c8',
    'cherry': '#b0182a',
    'croissant': '#d99a4e',
    'croissant_dark': '#b06d2c',
    'muffin': '#a8683a',
    'glaze': '#f08cb0',
    'sprinkle_a': '#f6e04a',
    'sprinkle_b': '#5ac0e8',
    'sprinkle_c': '#ffffff',
    'dough': '#d9a060',
    'wood': '#ffffff',
    'wood_dark': '#a2805f',
    'shade': '#fff0d0',
    'bulb': '#ffe2a8',
    'brass': '#c9a050',
    'green_shade': '#2f4a3c',
    'leather': '#7a4a32',
    'sofa': '#5f7f86',
    'sofa_dark': '#4b666c',
    'rug_a': '#c9a37a',
    'rug_b': '#8a5a3c',
    'rug_c': '#e8d8bc',
    'book_a': '#8a2f2a',
    'book_b': '#2f4f7a',
    'book_c': '#d9c08a',
    'book_d': '#3f6a4a',
    'book_e': '#e8e4da',
    'book_f': '#5a3a5a',
    'frame': '#5a3a28',
    'sky': '#8fc4e8',
    'sea': '#2f74b0',
    'sand': '#e8d8b0',
    'hill': '#5f9a4c',
    'sun': '#fff2c0',
    'pot': '#c46a42',
    'pot_white': '#eeeae2',
    'soil': '#3b2b20',
    'leaf': '#3f7f3a',
    'leaf_light': '#5aa04a',
    'stem': '#6a4a30',
    'succulent': '#7fb08a',
}
SLOTS = {
    'steel': 'metal',
    'steel_dark': 'metal',
    'brass': 'metal',
    'glass': 'glass',
    'wood': 'wood',
    'wood_dark': 'wood',
    'frame': 'wood',
    'shade': 'glow',
    'bulb': 'glow',
}


def B():
    return Builder(COLORS, SLOTS)


def cup_on_saucer(b, x=0.0, y=0.0):
    with b.at(T((x, y, 0))):
        b.lathe([(0.0, 0.0), (0.055, 0.0), (0.075, 0.008), (0.078, 0.012), (0.0, 0.012)], 'white', seg=16)
        b.lathe([(0.0, 0.012), (0.03, 0.012), (0.042, 0.03), (0.046, 0.07), (0.04, 0.07), (0.036, 0.034), (0.0, 0.03)], 'white', seg=16)
        b.cyl((0, 0, 0.062), (0, 0, 0.063), 0.04, 'latte', seg=14)
        b.torus((0.05, 0, 0.045), 0.015, 0.004, 'white', seg=8, rseg=4, axis='y')


def espresso_machine(sc):
    b = B()
    W, D, H = 0.6, 0.45, 0.42
    b.box(-W / 2, -D / 2, 0.06, W / 2, D / 2, H, 'steel')
    b.box(-W / 2 - 0.01, -D / 2 - 0.01, 0.0, W / 2 + 0.01, D / 2 + 0.01, 0.06, 'black')
    # 顶上的温杯盘（一圈栏杆）+ 几个倒扣的杯子
    b.box(-W / 2 + 0.02, -D / 2 + 0.02, H, W / 2 - 0.02, D / 2 - 0.02, H + 0.01, 'steel_dark')
    for x in (-W / 2 + 0.02, W / 2 - 0.02):
        b.cyl((x, -D / 2 + 0.02, H + 0.01), (x, D / 2 - 0.02, H + 0.01), 0.006, 'steel', seg=6)
    for k in range(4):
        with b.at(T((-0.18 + k * 0.11, 0.0, H + 0.01))):
            b.lathe([(0.0, 0.05), (0.038, 0.05), (0.03, 0.0), (0.0, 0.0)], 'white', seg=12)
    # 正面：深色的面板、两个压力表、两个冲煮头和手柄、蒸汽棒、滴水盘
    f = -D / 2
    b.box(-W / 2 + 0.03, f - 0.005, 0.2, W / 2 - 0.03, f, H - 0.03, 'black')
    for x in (-0.1, 0.1):
        with b.at(T((x, f - 0.006, H - 0.08)) @ R(math.pi / 2, 4, 'X')):
            b.cyl((0, 0, 0), (0, 0, 0.012), 0.035, 'steel', seg=14)
            b.cyl((0, 0, 0.012), (0, 0, 0.013), 0.03, 'gauge', seg=14)
    for x in (-0.15, 0.15):
        b.cyl((x, f - 0.04, 0.25), (x, f - 0.04, 0.2), 0.035, 'steel', seg=12)
        b.cyl((x, f - 0.04, 0.2), (x, f - 0.04, 0.17), 0.04, 'steel_dark', seg=12)
        b.cyl((x, f - 0.06, 0.18), (x, f - 0.2, 0.17), 0.012, 'black', seg=8)
    b.cyl((0.26, f - 0.02, 0.24), (0.27, f - 0.07, 0.1), 0.006, 'steel', seg=6)
    b.box(-W / 2 + 0.04, f - 0.12, 0.06, W / 2 - 0.04, f, 0.08, 'steel_dark')
    with b.at(T((-0.15, f - 0.06, 0.08))):
        b.lathe([(0.0, 0.0), (0.03, 0.0), (0.035, 0.05), (0.0, 0.045)], 'white', seg=12)
    return b.finish(sc, 'espresso_machine')


def cup_tea(sc):
    b = B()
    cup_on_saucer(b)
    return b.finish(sc, 'cup_tea')


def cup(sc):
    b = B()
    b.lathe([(0.0, 0.0), (0.04, 0.0), (0.042, 0.09), (0.037, 0.09), (0.036, 0.008), (0.0, 0.008)], 'white', seg=16)
    b.cyl((0, 0, 0.075), (0, 0, 0.076), 0.037, 'coffee', seg=14)
    b.torus((0.048, 0, 0.05), 0.022, 0.006, 'white', seg=10, rseg=5, axis='y')
    return b.finish(sc, 'cup')


def frappe(sc):
    b = B()
    b.lathe([(0.0, 0.0), (0.03, 0.0), (0.042, 0.14), (0.0, 0.14)], 'latte', seg=16)
    b.lathe([(0.032, 0.0), (0.045, 0.15)], 'glass', seg=16, close_bottom=False, close_top=False, smooth=True)
    b.lathe([(0.044, 0.15), (0.045, 0.165), (0.03, 0.2), (0.0, 0.205)], 'cream', seg=16, close_bottom=True)
    b.cyl((0.01, 0.0, 0.14), (0.02, 0.0, 0.27), 0.004, 'straw', seg=6)
    return b.finish(sc, 'frappe')


def cake(sc):
    b = B()
    # 切掉一块（缺一个 50° 的扇形）：分几段扇形的柱子拼
    n = 14
    gap = math.radians(50)
    for k in range(n):
        a0 = gap / 2 + k * (2 * math.pi - gap) / n
        a1 = a0 + (2 * math.pi - gap) / n
        pts = [(0, 0), (0.12 * math.cos(a0), 0.12 * math.sin(a0)), (0.12 * math.cos(a1), 0.12 * math.sin(a1))]
        b.prism(pts, 0.0, 0.035, 'cake_sponge')
        b.prism(pts, 0.035, 0.045, 'cake_cream')
        b.prism(pts, 0.045, 0.08, 'cake_sponge')
        b.prism(pts, 0.08, 0.1, 'cake_cream')
    for k in range(7):
        a = gap / 2 + 0.3 + k * (2 * math.pi - gap - 0.6) / 6
        b.sphere((0.085 * math.cos(a), 0.085 * math.sin(a), 0.115), 0.016, 'strawberry', seg=8, rings=5)
        b.sphere((0.1 * math.cos(a + 0.2), 0.1 * math.sin(a + 0.2), 0.105), 0.012, 'cake_cream', seg=6, rings=4)
    return b.finish(sc, 'cake')


def cupcake(sc):
    b = B()
    b.lathe([(0.0, 0.0), (0.03, 0.0), (0.04, 0.04), (0.0, 0.04)], 'liner', seg=14, smooth=False)
    b.lathe([(0.042, 0.04), (0.045, 0.055), (0.035, 0.07), (0.022, 0.085), (0.01, 0.095), (0.0, 0.1)], 'frost_pink', seg=14, close_bottom=True)
    b.sphere((0, 0, 0.105), 0.01, 'cherry', seg=8, rings=5)
    return b.finish(sc, 'cupcake')


def croissant(sc):
    b = B()
    # 弯成月牙的一节节圆台，两头细
    segs = 7
    for k in range(segs):
        t0, t1 = k / segs, (k + 1) / segs
        a0, a1 = math.pi * (0.15 + 0.7 * t0), math.pi * (0.15 + 0.7 * t1)
        r0 = 0.012 + 0.022 * math.sin(math.pi * t0)
        r1 = 0.012 + 0.022 * math.sin(math.pi * t1)
        p0 = (0.06 * math.cos(a0), 0.06 * math.sin(a0) - 0.03, r0)
        p1 = (0.06 * math.cos(a1), 0.06 * math.sin(a1) - 0.03, r1)
        b.cyl(p0, p1, r0, 'croissant' if k % 2 else 'croissant_dark', r1=r1, seg=10)
    return b.finish(sc, 'croissant')


def muffin(sc):
    b = B()
    b.lathe([(0.0, 0.0), (0.028, 0.0), (0.036, 0.04), (0.0, 0.04)], 'liner', seg=14, smooth=False)
    b.lathe([(0.04, 0.04), (0.045, 0.05), (0.035, 0.07), (0.0, 0.078)], 'muffin', seg=14, close_bottom=True)
    for k in range(5):
        a = k * 1.3
        b.sphere((0.02 * math.cos(a), 0.02 * math.sin(a), 0.072), 0.006, 'choco', seg=6, rings=4)
    return b.finish(sc, 'muffin')


def donut(sc):
    b = B()
    b.torus((0, 0, 0.018), 0.035, 0.018, 'dough', seg=20, rseg=10)
    b.torus((0, 0, 0.024), 0.035, 0.015, 'glaze', seg=20, rseg=8)
    cols = ['sprinkle_a', 'sprinkle_b', 'sprinkle_c']
    for k in range(18):
        a = k * 0.349 + 0.1
        r = 0.035 + 0.008 * math.sin(k * 2.3)
        with b.at(T((r * math.cos(a), r * math.sin(a), 0.039)) @ R(k * 0.7, 4, 'Z')):
            b.box(-0.004, -0.0012, 0, 0.004, 0.0012, 0.002, cols[k % 3])
    return b.finish(sc, 'donut_sprinkles')


def lamp_table(sc):
    b = B()
    b.lathe([(0.0, 0.0), (0.07, 0.0), (0.07, 0.015), (0.02, 0.025), (0.0, 0.025)], 'brass', seg=16)
    b.cyl((0, 0, 0.025), (0, 0, 0.25), 0.008, 'brass', seg=8)
    b.sphere((0, 0, 0.24), 0.025, 'bulb', seg=10, rings=6)
    b.lathe([(0.12, 0.2), (0.06, 0.34)], 'shade', seg=20, close_bottom=False, close_top=False, smooth=True)
    b.lathe([(0.06, 0.34), (0.12, 0.2)], 'shade', seg=20, close_bottom=False, close_top=False, smooth=True)
    return b.finish(sc, 'lamp_round_table')


def bar_stool(sc):
    b = B()
    b.cyl((0, 0, 0.74), (0, 0, 0.78), 0.18, 'wood', seg=20)
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        b.cyl((0.12 * math.cos(a), 0.12 * math.sin(a), 0.74), (0.2 * math.cos(a), 0.2 * math.sin(a), 0.0), 0.012, 'black', seg=6)
    b.torus((0, 0, 0.28), 0.17, 0.008, 'black', seg=16, rseg=4)
    return b.finish(sc, 'bar_stool')


def round_table(sc):
    b = B()
    b.cyl((0, 0, 0.71), (0, 0, 0.74), 0.36, 'wood', seg=24)
    b.cyl((0, 0, 0.04), (0, 0, 0.71), 0.025, 'black', seg=10)
    b.lathe([(0.0, 0.0), (0.24, 0.0), (0.24, 0.02), (0.05, 0.05), (0.0, 0.05)], 'black', seg=20)
    return b.finish(sc, 'round_table')


def chair(sc):
    b = B()
    b.box(-0.21, -0.21, 0.44, 0.21, 0.2, 0.47, 'wood')
    for x in (-0.18, 0.18):
        b.box(x - 0.018, -0.18 - 0.018, 0.0, x + 0.018, -0.18 + 0.018, 0.44, 'wood_dark')
        b.box(x - 0.018, 0.17 - 0.018, 0.0, x + 0.018, 0.17 + 0.018, 0.95, 'wood_dark')
    for z in (0.62, 0.74, 0.86):
        b.box(-0.18, 0.15, z, 0.18, 0.185, z + 0.06, 'wood')
    b.box(-0.18, -0.17, 0.18, 0.18, -0.15, 0.2, 'wood_dark')
    return b.finish(sc, 'chair')


def couch(sc):
    b = B()
    W = 1.8
    b.box(-W / 2, -0.42, 0.12, W / 2, 0.42, 0.4, 'sofa')
    b.box(-W / 2, 0.22, 0.4, W / 2, 0.42, 0.85, 'sofa_dark')
    for sx in (-1, 1):
        b.box(sx * W / 2 - (0.16 if sx > 0 else 0), -0.42, 0.12, sx * W / 2 + (0.0 if sx > 0 else 0.16), 0.42, 0.62, 'sofa_dark')
    for k in range(2):
        x0 = -W / 2 + 0.16 + k * (W - 0.32) / 2
        b.box(x0 + 0.01, -0.38, 0.4, x0 + (W - 0.32) / 2 - 0.01, 0.22, 0.52, 'sofa')
        b.box(x0 + 0.05, 0.08, 0.5, x0 + (W - 0.32) / 2 - 0.05, 0.22, 0.78, 'sofa')
    for x in (-W / 2 + 0.06, W / 2 - 0.06):
        for y in (-0.36, 0.36):
            b.cyl((x, y, 0.0), (x, y, 0.12), 0.025, 'wood_dark', r1=0.03, seg=8)
    return b.finish(sc, 'couch_medium')


def rug(sc):
    b = B()
    b.lathe([(0.0, 0.0), (1.0, 0.0), (1.0, 0.008), (0.0, 0.008)], 'rug_a', seg=40)
    for r, c in ((0.85, 'rug_b'), (0.55, 'rug_c'), (0.3, 'rug_b')):
        b.torus((0, 0, 0.009), r, 0.03, c, seg=40, rseg=3)
    return b.finish(sc, 'rug_round')


def coffee_table(sc):
    b = B()
    b.box(-0.55, -0.32, 0.38, 0.55, 0.32, 0.42, 'wood')
    b.box(-0.5, -0.28, 0.1, 0.5, 0.28, 0.12, 'wood_dark')
    for x in (-0.5, 0.48):
        for y in (-0.28, 0.26):
            b.box(x, y, 0.0, x + 0.03, y + 0.03, 0.38, 'wood_dark')
    return b.finish(sc, 'coffee_table')


def bookcase(sc):
    b = B()
    W, D, H = 0.9, 0.32, 1.9
    b.box(-W / 2, -D / 2, 0, -W / 2 + 0.03, D / 2, H, 'wood_dark')
    b.box(W / 2 - 0.03, -D / 2, 0, W / 2, D / 2, H, 'wood_dark')
    b.box(-W / 2, D / 2 - 0.02, 0, W / 2, D / 2, H, 'wood_dark')
    cols = ['book_a', 'book_b', 'book_c', 'book_d', 'book_e', 'book_f']
    k = 0
    for i in range(6):
        z = i * (H - 0.04) / 5
        b.box(-W / 2, -D / 2, z, W / 2, D / 2, z + 0.03, 'wood_dark')
        if i == 5:
            break
        x = -W / 2 + 0.04
        while x < W / 2 - 0.08:
            t = 0.025 + 0.02 * ((k * 7) % 3) / 2
            h = 0.2 + 0.08 * ((k * 5) % 4) / 3
            lean = 0.0
            b.box(x, -D / 2 + 0.04, z + 0.03, x + t, D / 2 - 0.03, z + 0.03 + h, cols[k % 6])
            x += t + 0.004 + lean
            k += 1
            if k % 9 == 0:
                x += 0.06
    return b.finish(sc, 'bookcase_books')


def painting(sc):
    b = B()
    W, H = 0.9, 0.62
    # 画面：天、海、沙滩、山、太阳（几块色块），外面一圈木框；正面朝 -Y
    b.box(-W / 2, -0.01, 0, W / 2, 0.0, H * 0.55, 'sea')
    b.box(-W / 2, -0.01, H * 0.55, W / 2, 0.0, H, 'sky')
    b.box(-W / 2, -0.012, 0, W / 2, -0.01, H * 0.18, 'sand')
    with b.at(T((0, 0, H * 0.55)) @ R(math.pi / 2, 4, 'X')):
        b.prism([(-W / 2, 0.0), (-0.02, 0.0), (-0.22, 0.14), (-0.36, 0.09)], 0.011, 0.013, 'hill')
    with b.at(T((0.25, -0.013, H * 0.78)) @ R(math.pi / 2, 4, 'X')):
        b.cyl((0, 0, 0), (0, 0, 0.002), 0.06, 'sun', seg=16)
    fw = 0.05
    b.box(-W / 2 - fw, -0.03, -fw, W / 2 + fw, 0.01, 0.0, 'frame')
    b.box(-W / 2 - fw, -0.03, H, W / 2 + fw, 0.01, H + fw, 'frame')
    b.box(-W / 2 - fw, -0.03, 0, -W / 2, 0.01, H, 'frame')
    b.box(W / 2, -0.03, 0, W / 2 + fw, 0.01, H, 'frame')
    return b.finish(sc, 'wall_painting_1')


def light_ceiling(sc):
    b = B()
    # 天花板上的吸顶盘 → 吊线 → 金属灯罩（深绿，里面白）→ 灯泡（亮）。原点在灯罩底边下面一点（代码按总高缩放）
    top = 0.85
    b.cyl((0, 0, top - 0.02), (0, 0, top), 0.06, 'black', seg=12)
    b.cyl((0, 0, 0.26), (0, 0, top - 0.02), 0.004, 'black', seg=4)
    # 外面（轮廓从下往上：面朝外）、里面（从上往下：面朝里，从下面看得到白色的内壁）
    b.lathe([(0.21, 0.04), (0.2, 0.06), (0.07, 0.18), (0.05, 0.22), (0.03, 0.26)], 'green_shade', seg=24, close_bottom=False, close_top=True)
    b.lathe([(0.0, 0.225), (0.045, 0.22), (0.065, 0.18), (0.195, 0.06), (0.205, 0.04)], 'white', seg=24, close_bottom=False, close_top=False)
    b.sphere((0, 0, 0.1), 0.045, 'bulb', seg=12, rings=8)
    b.cyl((0, 0, 0.14), (0, 0, 0.2), 0.015, 'brass', seg=8)
    return b.finish(sc, 'light_ceiling')


def plant(sc, name, kind):
    b = B()
    if kind == 1:
        # 琴叶榕：白色的高盆、一根树干、一片片大叶子（往外斜的四边形）
        b.lathe([(0.0, 0.0), (0.16, 0.0), (0.19, 0.34), (0.0, 0.34)], 'pot_white', seg=16)
        b.cyl((0, 0, 0.32), (0, 0, 0.33), 0.17, 'soil', seg=14)
        b.cyl((0, 0, 0.33), (0.02, 0, 1.1), 0.02, 'stem', seg=6)
        for k in range(26):
            a = k * 2.4
            z = 0.5 + 0.62 * (k / 26) ** 0.8
            L = 0.3 - 0.08 * (k / 26)
            c = Vector((0.02 * math.cos(a), 0.02 * math.sin(a), z))
            dvec = Vector((math.cos(a), math.sin(a), 0.5)).normalized()
            side = Vector((-math.sin(a), math.cos(a), 0)) * L * 0.42
            tip = c + dvec * L
            mid = c + dvec * L * 0.5
            vs = [b.v(c), b.v(mid + side), b.v(tip), b.v(mid - side)]
            b.face(vs, 'leaf' if k % 2 else 'leaf_light', smooth=True)
            b.face(list(reversed([b.v(c), b.v(mid + side), b.v(tip), b.v(mid - side)])), 'leaf', smooth=True)
    elif kind == 2:
        b.lathe([(0.0, 0.0), (0.13, 0.0), (0.16, 0.22), (0.0, 0.22)], 'pot', seg=14)
        for k in range(9):
            a = k * 2.1
            r = 0.08 + 0.05 * (k % 3) / 2
            b.sphere((r * math.cos(a), r * math.sin(a), 0.3 + 0.07 * (k % 4)), 0.1, 'leaf' if k % 2 else 'leaf_light', seg=8, rings=5)
    else:
        b.lathe([(0.0, 0.0), (0.06, 0.0), (0.07, 0.07), (0.0, 0.07)], 'pot', seg=12)
        for k in range(7):
            a = k * 0.9
            with b.at(T((0.02 * math.cos(a), 0.02 * math.sin(a), 0.07)) @ R(a, 4, 'Z') @ R(0.5, 4, 'Y')):
                b.lathe([(0.0, 0.0), (0.012, 0.01), (0.008, 0.05), (0.0, 0.06)], 'succulent', seg=6)
    return b.finish(sc, name)


def main():
    sc = fresh_scene('cafe_props')
    objs = [
        espresso_machine(sc),
        cup_tea(sc),
        cup(sc),
        frappe(sc),
        cake(sc),
        cupcake(sc),
        croissant(sc),
        muffin(sc),
        donut(sc),
        lamp_table(sc),
        bar_stool(sc),
        round_table(sc),
        chair(sc),
        couch(sc),
        rug(sc),
        coffee_table(sc),
        bookcase(sc),
        painting(sc),
        light_ceiling(sc),
        plant(sc, 'houseplant_1', 1),
        plant(sc, 'houseplant_2', 2),
        plant(sc, 'houseplant_3', 3),
    ]
    for o in objs:
        o.data.set_sharp_from_angle(angle=math.radians(38))
    export(sc, OUT, objs)


if __name__ == '__main__':
    main()
