"""
街景的远景（src/vrm/scenes/seaside.ts 用）：灯塔、防波堤、消波块、跨海桥、对岸小镇的几种房子。导出一个 GLB，每样一个物体。

    blender -b --factory-startup -P scripts/blender/far_scenery.py

输出 public/scene/models/far/far.glb。都在 200m~1.5km 外：代码把它们（几百栋房子、几十个消波块）合进一两个网格里，
一个材质一次绘制（远处看不出贴图，全靠顶点色）。

  lighthouse   白色的圆塔（塔身两道浅灰的线、三扇小窗、门）、深色的走廊和栏杆、玻璃灯室（夜里发光）和里面的透镜、
               圆顶、通风球、避雷针。原点在塔底（防波堤顶面），灯室中心离塔底 12.95m（和代码里光束的位置一样）
  breakwater   防波堤的一段（沿 x 10m）：堤身、外侧（+Y）的挡浪墙、系船柱。原点在堤顶面的中线上
  tetrapod     消波块（四脚块）：四条腿朝正四面体的四个方向
  bridge       斜拉桥（沿 x 360m，代码按实际长度缩放）：箱梁的桥面、栏杆、两座 H 形的桥塔、扇形的斜拉索、边跨的桥墩、
               桥面两边一排路灯（夜里亮）、塔顶的红色航空灯。原点在桥中点的海面上
  house_a / house_b / house_c / apartment / warehouse / temple / chimney
               对岸小镇的房子（两层坡顶、两层四坡顶、平房、四层公寓、仓库、寺庙、工厂烟囱）。墙的槽叫 wall、屋顶叫 roof：
               代码给每栋换一个墙色、瓦色；夜里的窗灯按墙面的位置在着色器里画（见 seaside.ts 的 farWindows）

坐标：Z 朝上，正面朝 -Y（three.js 里 +Z）。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kit_common import MODELS, Builder, anchor, export, fresh_scene  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

OUT = os.path.join(MODELS, 'far', 'far.glb')
T = Matrix.Translation
R = Matrix.Rotation

COLORS = {
    'white': '#f6f6f2',
    'band': '#c9ccd0',
    'dark': '#3a4250',
    'lamp': '#fff2d0',
    'glass': '#9fc4d4',
    'concrete': '#cfcac0',
    'concrete_wet': '#8f8c86',
    'bollard': '#2e3236',
    'tetra': '#bdb8ae',
    'deck': '#e6e9ec',
    'deck_dark': '#9ea4aa',
    'cable': '#f0f2f4',
    'tower': '#eef1f3',
    'red': '#ff3020',
    'wall': '#ffffff',
    'roof': '#ffffff',
    'trim': '#d8d6d0',
    'window_dark': '#59636e',
    'warehouse': '#c9d0d6',
    'temple_roof': '#3b4048',
    'temple_wood': '#8a3a2a',
    'chimney_red': '#c8402e',
}
SLOTS = {
    'lamp': 'glow',
    'red': 'glow',
    'wall': 'wall',
    'roof': 'roof',
}


def B():
    return Builder(COLORS, SLOTS)


# ---------------------------------------------------------------- 灯塔
def build_lighthouse(sc):
    b = B()
    b.lathe([(2.8, 0), (2.8, 1.0), (2.6, 1.2)], 'concrete', seg=16, smooth=False, close_top=False)
    # 塔身（往上收），两道浅灰的线
    b.lathe(
        [(2.6, 1.2), (1.9, 1.2), (1.85, 4.5), (1.86, 4.6), (1.85, 4.7), (1.6, 8.5), (1.61, 8.6), (1.6, 8.7), (1.35, 11.7)],
        ['white', 'white', 'band', 'band', 'white', 'band', 'band', 'white'],
        seg=24,
        close_bottom=False,
        close_top=False,
    )
    # 门、三扇小窗（朝 -Y）
    b.box(-0.45, -1.95, 1.2, 0.45, -1.7, 3.0, 'dark')
    for z in (5.5, 7.6, 10.0):
        r = 1.9 - (1.9 - 1.35) * (z - 1.2) / 10.5
        b.box(-0.18, -r - 0.03, z, 0.18, -r + 0.1, z + 0.5, 'dark')
    # 走廊（外挑的圆盘）+ 栏杆
    b.lathe([(1.35, 11.6), (2.05, 11.7), (2.05, 11.95), (1.3, 12.0)], 'dark', seg=24, close_bottom=False)
    for k in range(20):
        a = 2 * math.pi * k / 20
        b.cyl((1.95 * math.cos(a), 1.95 * math.sin(a), 11.95), (1.95 * math.cos(a), 1.95 * math.sin(a), 12.85), 0.03, 'dark', seg=4, caps=False)
    b.torus((0, 0, 12.85), 1.95, 0.04, 'dark', seg=24, rseg=4)
    # 灯室：玻璃（夜里发光）、竖的窗框、里面的透镜
    b.lathe([(0.95, 12.15), (0.95, 13.75)], 'lamp', seg=16, close_bottom=False, close_top=False, smooth=False)
    for k in range(8):
        a = 2 * math.pi * k / 8
        b.box(0.93 * math.cos(a) - 0.03, 0.93 * math.sin(a) - 0.03, 12.15, 0.93 * math.cos(a) + 0.03, 0.93 * math.sin(a) + 0.03, 13.75, 'dark')
    b.lathe([(1.0, 12.0), (1.0, 12.15)], 'dark', seg=16, close_bottom=False)
    b.lathe([(0.0, 12.6), (0.4, 12.7), (0.45, 12.95), (0.4, 13.2), (0.0, 13.3)], 'lamp', seg=12)
    # 圆顶、通风球、避雷针
    b.lathe([(1.12, 13.75), (1.1, 13.9), (0.95, 14.25), (0.65, 14.5), (0.0, 14.62)], 'dark', seg=20, close_bottom=True)
    b.sphere((0, 0, 14.82), 0.2, 'dark', seg=10, rings=6)
    b.cyl((0, 0, 15.0), (0, 0, 16.2), 0.025, 'dark', seg=4)
    return b.finish(sc, 'lighthouse')


def build_breakwater(sc):
    b = B()
    b.box(-5, -1.7, -2.4, 5, 1.7, 0.0, 'concrete', faces=['-y', '+y', '+z'])
    b.box(-5, -1.72, -2.4, 5, -1.7, -1.6, 'concrete_wet', faces=['-y'])
    b.box(-5, 1.7, -2.4, 5, 1.72, -1.6, 'concrete_wet', faces=['+y'])
    # 外侧的挡浪墙
    b.box(-5, 0.9, 0.0, 5, 1.7, 1.0, 'concrete', faces=['-y', '+y', '+z'])
    # 两个系船柱
    for x in (-2.5, 2.5):
        with b.at(T((x, -0.9, 0.0))):
            b.lathe([(0.16, 0.0), (0.14, 0.3), (0.2, 0.36), (0.0, 0.4)], 'bollard', seg=10, close_bottom=False)
    return b.finish(sc, 'breakwater')


def build_tetrapod(sc):
    b = B()
    dirs = [Vector((0, 0, 1)), Vector((0.943, 0, -0.333)), Vector((-0.471, 0.816, -0.333)), Vector((-0.471, -0.816, -0.333))]
    for d in dirs:
        b.cyl((0, 0, 0), tuple(d * 1.3), 0.55, 'tetra', r1=0.3, seg=8)
    b.sphere((0, 0, 0), 0.62, 'tetra', seg=10, rings=6)
    return b.finish(sc, 'tetrapod')


# ---------------------------------------------------------------- 斜拉桥
def build_bridge(sc):
    b = B()
    L = 360.0
    hl = L / 2
    zt, zb = 9.8, 8.2
    # 桥面（箱梁）：顶面、两个侧面、底面
    b.box(-hl, -4.6, zb, hl, 4.6, zt, 'deck', faces=['-y', '+y', '+z', '-z'])
    b.box(-hl, -4.65, zb, hl, -4.6, zb + 0.5, 'deck_dark', faces=['-y'])
    b.box(-hl, 4.6, zb, hl, 4.65, zb + 0.5, 'deck_dark', faces=['+y'])
    # 栏杆
    for y in (-4.45, 4.45):
        b.box(-hl, y - 0.08, zt, hl, y + 0.08, zt + 1.0, 'deck', faces=['-y', '+y', '+z'])
    # 两座 H 形桥塔
    marks = []
    for tx in (-60.0, 60.0):
        for y in (-5.4, 5.4):
            b.box(tx - 1.2, y - 1.0, -3.0, tx + 1.2, y + 1.0, 56.0, 'tower', faces=['-y', '+y', '-x', '+x', '+z'])
        for z0, z1 in ((zb - 2.2, zb - 0.2), (38.0, 40.0), (52.0, 54.0)):
            b.box(tx - 1.0, -4.4, z0, tx + 1.0, 4.4, z1, 'tower', faces=['-y', '+y', '-x', '+x', '+z', '-z'])
        # 塔顶的红色航空灯（夜里闪）
        for y in (-5.4, 5.4):
            b.box(tx - 0.4, y - 0.4, 56.0, tx + 0.4, y + 0.4, 56.6, 'red')
            marks.append((tx, y, 56.6))
        # 斜拉索：两个索面，每边 11 根，从塔顶扇形拉到桥面
        for y in (-5.4, 5.4):
            for k in range(11):
                zt_k = 54.5 - k * 1.3
                for sgn in (-1, 1):
                    xd = tx + sgn * (12 + k * 9.5)
                    if abs(xd) > hl - 2:
                        continue
                    b.cyl((tx, y * 0.95, zt_k), (xd, y * 0.82, zt + 0.3), 0.22, 'cable', seg=4, caps=False, smooth=False)
    # 边跨的桥墩
    for px in (-150.0, 150.0, -105.0, 105.0):
        b.box(px - 1.4, -3.0, -3.0, px + 1.4, 3.0, zb, 'tower', faces=['-y', '+y', '-x', '+x'])
    # 桥面两边一排路灯（灯杆 + 夜里亮的灯头），每 30m 一盏
    lamps = []
    x = -hl + 15
    while x < hl - 10:
        for y in (-4.45, 4.45):
            b.box(x - 0.12, y - 0.12, zt + 1.0, x + 0.12, y + 0.12, zt + 7.0, 'deck_dark')
            b.box(x - 0.5, y - 0.5 * (1 if y > 0 else -1) - 0.2, zt + 6.9, x + 0.5, y - 0.5 * (1 if y > 0 else -1) + 0.2, zt + 7.2, 'lamp')
            lamps.append((x, y - 0.5 * (1 if y > 0 else -1), zt + 6.8))
        x += 30
    obj = b.finish(sc, 'bridge')
    for i, p in enumerate(marks):
        anchor(sc, obj, f'light_air{i}', p, color='#ff2a18', intensity=0.0, radius=0.0, glow=7.0, glowGain=2.2, onAt=0.1, blink=[1.6, 0.45, i * 0.4])
    for i, p in enumerate(lamps):
        anchor(sc, obj, f'light_deck{i}', p, color='#ffd8a0', intensity=0.0, radius=0.0, glow=3.2, glowGain=1.2, onAt=0.2)
    return obj


# ---------------------------------------------------------------- 对岸小镇的房子
def gable_house(b, w, d, h, pitch, roof_color='roof', hip=False):
    """长方体的墙 + 坡顶（hip = 四坡顶）。正面朝 -Y"""
    hw, hd = w / 2, d / 2
    b.box(-hw, -hd, 0, hw, hd, h, 'wall', faces=['-y', '+y', '-x', '+x'])
    rise = hd * math.tan(math.radians(pitch))
    o = 0.5
    if hip:
        xr = max(0.0, hw - hd)
        P = lambda x, y, z: b.v((x, y, z))  # noqa: E731
        e = [P(-hw - o, -hd - o, h), P(hw + o, -hd - o, h), P(hw + o, hd + o, h), P(-hw - o, hd + o, h)]
        r0, r1 = P(-xr, 0, h + rise), P(xr, 0, h + rise)
        b.face((e[0], e[1], r1, r0), roof_color)
        b.face((e[2], e[3], r0, r1), roof_color)
        b.face((e[1], e[2], r1), roof_color)
        b.face((e[3], e[0], r0), roof_color)
    else:
        b.quad((-hw - o, -hd - o, h - o * math.tan(math.radians(pitch))), (hw + o, -hd - o, h - o * math.tan(math.radians(pitch))), (hw + o, 0, h + rise), (-hw - o, 0, h + rise), roof_color)
        b.quad((hw + o, hd + o, h - o * math.tan(math.radians(pitch))), (-hw - o, hd + o, h - o * math.tan(math.radians(pitch))), (-hw - o, 0, h + rise), (hw + o, 0, h + rise), roof_color)
        for sx in (1, -1):
            v = [b.v((sx * hw, -hd, h)), b.v((sx * hw, hd, h)), b.v((sx * hw, 0, h + rise))]
            b.face(v if sx > 0 else list(reversed(v)), 'wall')


def build_town(sc):
    objs = []
    b = B()
    gable_house(b, 8, 7, 5.6, 26)
    b.box(-0.6, -3.55, 0, 0.6, -3.5, 2.1, 'window_dark')
    objs.append(b.finish(sc, 'house_a'))
    b = B()
    gable_house(b, 9, 8, 6.0, 24, hip=True)
    objs.append(b.finish(sc, 'house_b'))
    b = B()
    gable_house(b, 11, 7, 3.2, 22)
    objs.append(b.finish(sc, 'house_c'))
    # 四层公寓：平顶，每层一道阳台的白边
    b = B()
    b.box(-8, -5, 0, 8, 5, 12, 'wall', faces=['-y', '+y', '-x', '+x', '+z'])
    for k in range(1, 4):
        z = k * 3.0
        b.box(-8.1, -5.9, z - 0.15, 8.1, -5, z + 0.95, 'trim', faces=['-y', '+z', '-z', '-x', '+x'])
    b.box(-8.2, -5.2, 12, 8.2, 5.2, 12.6, 'trim', faces=['-y', '+y', '-x', '+x', '+z'])
    objs.append(b.finish(sc, 'apartment'))
    # 仓库：宽、矮、浅蓝灰的波形屋顶
    b = B()
    b.box(-12, -8, 0, 12, 8, 6, 'warehouse', faces=['-y', '+y', '-x', '+x'])
    b.quad((-12.3, -8.3, 6), (12.3, -8.3, 6), (12.3, 0, 7.6), (-12.3, 0, 7.6), 'roof')
    b.quad((12.3, 8.3, 6), (-12.3, 8.3, 6), (-12.3, 0, 7.6), (12.3, 0, 7.6), 'roof')
    for sx in (1, -1):
        v = [b.v((sx * 12, -8, 6)), b.v((sx * 12, 8, 6)), b.v((sx * 12, 0, 7.6))]
        b.face(v if sx > 0 else list(reversed(v)), 'warehouse')
    objs.append(b.finish(sc, 'warehouse'))
    # 寺庙：朱红的柱子、深色的大屋顶（檐角往上翘）
    b = B()
    b.box(-9, -7, 0, 9, 7, 1.0, 'trim')
    b.box(-7, -5, 1.0, 7, 5, 6.5, 'wall', faces=['-y', '+y', '-x', '+x'])
    for x in (-6.5, -2.2, 2.2, 6.5):
        b.box(x - 0.3, -5.6, 1.0, x + 0.3, -5.0, 6.5, 'temple_wood')
    e = [(-10.5, -8.5, 6.2), (10.5, -8.5, 6.2), (10.5, 8.5, 6.2), (-10.5, 8.5, 6.2)]
    P = [b.v(p) for p in e]
    tips = [b.v((-11.2, -9.2, 6.9)), b.v((11.2, -9.2, 6.9)), b.v((11.2, 9.2, 6.9)), b.v((-11.2, 9.2, 6.9))]
    r0, r1 = b.v((-4.0, 0, 12.5)), b.v((4.0, 0, 12.5))
    b.face((tips[0], tips[1], r1, r0), 'temple_roof')
    b.face((tips[2], tips[3], r0, r1), 'temple_roof')
    b.face((tips[1], tips[2], r1), 'temple_roof')
    b.face((tips[3], tips[0], r0), 'temple_roof')
    del P
    objs.append(b.finish(sc, 'temple'))
    # 工厂的烟囱：红白相间，顶上一盏红灯（夜里闪）
    b = B()
    b.box(-6, -4, 0, 6, 4, 7, 'warehouse', faces=['-y', '+y', '-x', '+x', '+z'])
    prof = []
    cols = []
    for k in range(9):
        z0 = k * 4.5
        prof.append((1.4 - k * 0.07, z0))
        cols.append('chimney_red' if k % 2 else 'white')
    prof.append((0.8, 40.5))
    with b.at(T((3.0, 1.0, 0))):
        b.lathe(prof, cols, seg=12, close_bottom=False)
        b.box(-0.3, -0.3, 40.5, 0.3, 0.3, 41.1, 'red')
    obj = b.finish(sc, 'chimney')
    anchor(sc, obj, 'light_air0', (3.0, 1.0, 41.2), color='#ff2a18', intensity=0.0, radius=0.0, glow=6.0, glowGain=2.0, onAt=0.1, blink=[2.0, 0.5, 0.0])
    objs.append(obj)
    return objs


def main():
    sc = fresh_scene('far_scenery')
    objs = [build_lighthouse(sc), build_breakwater(sc), build_tetrapod(sc), build_bridge(sc), *build_town(sc)]
    for o in objs:
        o.data.set_sharp_from_angle(angle=math.radians(40))
    export(sc, OUT, objs)


if __name__ == '__main__':
    main()
