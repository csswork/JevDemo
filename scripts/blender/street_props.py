"""
街景的街道设施（src/vrm/scenes/street.ts 用）：程序生成，导出一个 GLB，每样东西一个物体（名字就是 three.js 那边找它的名字）。

    blender -b --factory-startup -P scripts/blender/street_props.py

输出 public/scene/models/street/props.glb。写法、材质槽、顶点色、光源标记见 kit_common.py。

  lamp        海边步道的复古柱灯：八角形的铸铁底座、带线脚的灯柱、乳白的球形灯罩（夜里发光）、铸铁的灯帽和尖顶。
              灯罩中心离地 4.18m；灯柱 3.75m 那里够细，挂得上旗子的铁臂（旗子还是代码画的）
  pole        水泥电线杆（10.8m，往上收）：脚钉、编号牌、横担 + 斜撑、三个瓷绝缘子（两个在横担两头、一个在杆顶）、
              低压的短横担、电话线的挂架和接线盒。电线挂在哪由几个空物体标出来（wire0..2、tel、drop），代码照着画线
  transformer 柱上变压器（圆桶 + 散热片 + 三个套管 + 抱箍），挂在电线杆朝着路的方向的侧面
  pole_lamp   电线杆上的小路灯（日本街道常见的防犯灯）：一根伸向路的灯臂、LED 灯头（底面发光）
  vending     自动售货机：蓝色的机身、顶上的灯箱、三排亮着的饮料（每瓶一个颜色）和价格按钮、投币口、取物口
  board       立式 A 字小黑板：两块带木框的黑板，顶上铰在一起；黑板面 uv 0..1（代码换成 canvas 画的黑板）
  bench       长凳：五条木板的座面、两条靠背、铸铁的侧架
  planter_l / planter_s   木花箱（大 / 小）：横的木板、四角立柱、上沿压条、土面（灌木代码种进去）
  grate       侧沟的铁格栅（顺着路 0.6m × 横着 0.34m）
  manhole     井盖（圆的铸铁盖，凸起的同心圆和放射状的筋）
  rail_post   栏杆的立柱（圆管、底座法兰、顶上一个圆球；横杆还是代码沿路扫出来的）
  nobori      布旗的旗杆和注水底座（旗面还是代码画的，会随风摆）

坐标：Z 朝上，正面朝 -Y（three.js 里朝 +Z，代码用 frameAt 让 +Z 朝着路）。
电线杆按代码里的局部坐标建：X 顺着路、-Y（three 的 +Z）朝陆地那一侧，+Y 朝路。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kit_common import MODELS, Builder, anchor, export, fresh_scene  # noqa: E402
from mathutils import Matrix  # noqa: E402

OUT = os.path.join(MODELS, 'street', 'props.glb')

COLORS = {
    'iron': '#1f2827',
    'iron_hi': '#2d3a38',
    'brass': '#a8874a',
    'globe': '#f6f1e6',
    'concrete': '#e6e2da',
    'concrete_low': '#bdb6aa',
    'steel': '#8f9499',
    'steel_dark': '#55595e',
    'porcelain': '#efeee9',
    'plate': '#f4f4f0',
    'plate_blue': '#2a5aa8',
    'warning': '#e8c22e',
    'led_body': '#d4d7da',
    'led': '#f0f3ff',
    'vend_blue': '#2f68b0',
    'vend_white': '#f2f4f5',
    'vend_dark': '#1d2024',
    'vend_panel': '#f4f7fb',
    'vend_back': '#e8eef6',
    'vend_btn': '#8cc0ff',
    'can_red': '#d8352c',
    'can_blue': '#2b6fd0',
    'can_green': '#3aa05a',
    'can_orange': '#f08a24',
    'can_white': '#f2f2f0',
    'can_brown': '#8a5432',
    'can_yellow': '#f2c230',
    'can_black': '#2a2a2c',
    'wood': '#ffffff',
    'wood_dark': '#c09a7c',
    'board': '#ffffff',
    'soil': '#3b2b20',
    'grate': '#2b2d30',
    'grate_bar': '#3c3f44',
    'manhole': '#3c3c3e',
    'manhole_hi': '#4c4c50',
    'post': '#2c3036',
    'plastic': '#4f545b',
    'pole_white': '#ecece8',
}
SLOTS = {
    'iron': 'metal',
    'iron_hi': 'metal',
    'brass': 'metal',
    'globe': 'glow',
    'concrete': 'concrete',
    'concrete_low': 'concrete',
    'steel': 'metal',
    'steel_dark': 'metal',
    'led': 'glow',
    'vend_panel': 'lightbox',
    'vend_back': 'lightbox',
    'vend_btn': 'lightbox',
    'can_red': 'lightbox',
    'can_blue': 'lightbox',
    'can_green': 'lightbox',
    'can_orange': 'lightbox',
    'can_white': 'lightbox',
    'can_brown': 'lightbox',
    'can_yellow': 'lightbox',
    'can_black': 'lightbox',
    'wood': 'wood',
    'wood_dark': 'wood',
    'board': 'board',
    'grate': 'metal',
    'grate_bar': 'metal',
    'manhole': 'metal',
    'manhole_hi': 'metal',
    'post': 'metal',
}

T = Matrix.Translation
R = Matrix.Rotation


def B():
    return Builder(COLORS, SLOTS)


# ---------------------------------------------------------------- 路灯
def build_lamp(sc):
    b = B()
    # 底座 + 灯柱 + 灯颈（一条轮廓转一圈：八角形的底座用 8 段，上面的用 20 段）
    b.lathe(
        [(0.21, 0), (0.21, 0.05), (0.19, 0.07), (0.19, 0.1), (0.16, 0.13), (0.155, 0.4), (0.175, 0.43), (0.175, 0.46), (0.13, 0.5), (0.1, 0.56)],
        'iron',
        seg=8,
        smooth=False,
    )
    b.lathe(
        [
            (0.1, 0.56),
            (0.086, 0.62),
            (0.062, 3.5),
            (0.074, 3.53),
            (0.074, 3.6),
            (0.06, 3.63),
            (0.058, 3.8),
            (0.07, 3.83),
            (0.1, 3.88),
            (0.12, 3.92),
            (0.13, 3.95),
            (0.1, 3.97),
        ],
        ['iron', 'iron', 'iron_hi', 'iron_hi', 'iron', 'iron', 'iron', 'iron', 'iron', 'brass', 'brass'],
        seg=20,
        close_bottom=False,
    )
    # 灯柱中段一圈细环
    b.torus((0, 0, 1.25), 0.074, 0.012, 'iron_hi', seg=20, rseg=6)
    # 灯罩下面四个小卷草（小环）托着
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        with b.at(T((math.cos(a) * 0.1, math.sin(a) * 0.1, 3.86)) @ R(a, 4, 'Z') @ R(math.pi / 2, 4, 'X')):
            b.torus((0, 0, 0), 0.04, 0.008, 'iron', seg=12, rseg=5)
    # 乳白的球形灯罩
    b.sphere((0, 0, 4.18), 0.24, 'globe', seg=24, rings=14)
    # 灯帽 + 尖顶
    b.lathe([(0.12, 4.37), (0.155, 4.395), (0.165, 4.43), (0.125, 4.47), (0.065, 4.5), (0.035, 4.56), (0.018, 4.6), (0.03, 4.62), (0.0, 4.7)], 'iron', seg=20)
    obj = b.finish(sc, 'lamp')
    anchor(sc, obj, 'light', (0, 0, 4.18), color='#ffd6a0', intensity=75.0, radius=24.0, glow=0.9)
    return obj


# ---------------------------------------------------------------- 电线杆
H = 10.8


def pole_r(z):
    return 0.19 + (0.13 - 0.19) * z / H


def build_pole(sc):
    b = B()
    b.lathe([(0.19, 0), (pole_r(0.35), 0.35), (0.13, H)], ['concrete_low', 'concrete'], seg=16, close_bottom=False, close_top=False)
    # 杆顶：一顶圆帽
    b.lathe([(0.13, H), (0.135, H + 0.02), (0.08, H + 0.06), (0.0, H + 0.08)], 'concrete', seg=16, close_bottom=False)
    # 脚钉：1.8m 往上，左右交替（顺着路的方向伸出去）
    z = 1.8
    k = 0
    while z < 9.6:
        sgn = 1 if k % 2 == 0 else -1
        r = pole_r(z)
        b.cyl((sgn * (r - 0.02), 0, z), (sgn * (r + 0.15), 0, z), 0.012, 'steel_dark', seg=6)
        b.cyl((sgn * (r + 0.15), 0, z), (sgn * (r + 0.15), 0, z + 0.05), 0.012, 'steel_dark', seg=6)
        z += 0.45
        k += 1
    # 编号牌：朝着路（+Y）
    r = pole_r(1.7)
    b.box(-0.08, r - 0.005, 1.5, 0.08, r + 0.008, 1.84, 'plate')
    b.box(-0.08, r + 0.008, 1.76, 0.08, r + 0.01, 1.84, 'plate_blue')
    b.box(-0.06, r + 0.008, 1.55, 0.06, r + 0.01, 1.58, 'plate_blue')
    # 黄黑的警示带（离地 0.3~1.8m，有的杆子有；这里画一圈黄色的反光贴）
    b.cyl((0, 0, 2.3), (0, 0, 2.42), pole_r(2.3) + 0.004, 'warning', r1=pole_r(2.42) + 0.004, seg=16, caps=False)
    # 横担（槽钢，穿过杆子，横着路）+ 两根斜撑
    zc = H - 0.75
    b.box(-0.05, -0.95, zc, 0.05, 0.95, zc + 0.12, 'steel')
    for s in (-1, 1):
        b.cyl((0, s * 0.12, H - 1.25), (0, s * 0.7, zc + 0.01), 0.012, 'steel', seg=6)
    # 绝缘子：两个在横担两头，一个在杆顶
    insul = [(0.022, 0), (0.05, 0.025), (0.028, 0.045), (0.055, 0.07), (0.03, 0.095), (0.05, 0.12), (0.024, 0.15), (0.018, 0.18)]
    tops = []
    for y in (-0.85, 0.85):
        with b.at(T((0, y, zc + 0.12))):
            b.lathe(insul, 'porcelain', seg=12)
        tops.append((0, y, zc + 0.12 + 0.18))
    with b.at(T((0, 0, H + 0.06))):
        b.lathe(insul, 'porcelain', seg=12)
    tops.insert(1, (0, 0, H + 0.06 + 0.18))
    # 低压的短横担（入户线从这里拉到墙上）+ 两个小绝缘子
    zl = H - 1.65
    b.box(-0.05, -0.6, zl, 0.05, 0.6, zl + 0.1, 'steel')
    small = [(0.015, 0), (0.035, 0.02), (0.02, 0.04), (0.03, 0.06), (0.012, 0.08)]
    for y in (-0.5, 0.5):
        with b.at(T((0, y, zl + 0.1))):
            b.lathe(small, 'porcelain', seg=10)
    # 电话线的挂架 + 接线盒
    b.box(0.12, -0.05, 6.1, 0.24, 0.05, 6.3, 'steel_dark')
    b.box(pole_r(5.5), -0.1, 5.35, pole_r(5.5) + 0.12, 0.1, 5.75, 'plastic')
    b.box(pole_r(5.5) - 0.02, -0.12, 5.42, pole_r(5.5) + 0.01, 0.12, 5.46, 'steel_dark')
    b.box(pole_r(5.5) - 0.02, -0.12, 5.64, pole_r(5.5) + 0.01, 0.12, 5.68, 'steel_dark')
    obj = b.finish(sc, 'pole')
    for i, t in enumerate(tops):
        anchor(sc, obj, f'wire{i}', t)
    anchor(sc, obj, 'tel', (0.24, 0, 6.2))
    anchor(sc, obj, 'drop', (0.0, -0.5, zl + 0.18))
    return obj


def build_transformer(sc):
    """柱上变压器：中心在 (0.55, 0, 8.0)（杆子的局部坐标，和代码原来的位置一样），两道抱箍搂着杆子"""
    b = B()
    cx, cz = 0.55, 7.95
    with b.at(T((cx, 0, cz - 0.45))):
        b.lathe([(0.27, 0), (0.28, 0.02), (0.28, 0.8), (0.27, 0.82), (0.24, 0.86), (0.0, 0.9)], 'steel', seg=20)
        # 散热片：一圈竖的薄板
        for k in range(14):
            a = 2 * math.pi * k / 14 + 0.2
            if abs(math.cos(a) + 1) < 0.25:
                continue  # 贴着杆子的那一侧不放
            with b.at(R(a, 4, 'Z')):
                b.box(0.28, -0.006, 0.1, 0.36, 0.006, 0.7, 'steel_dark')
        # 三个套管（瓷）
        for dx in (-0.12, 0.0, 0.12):
            with b.at(T((dx, 0.0, 0.86))):
                b.lathe([(0.03, 0), (0.045, 0.03), (0.03, 0.06), (0.04, 0.09), (0.02, 0.12)], 'porcelain', seg=10)
        # 铭牌（黄）
        b.box(-0.07, -0.29, 0.45, 0.07, -0.28, 0.6, 'warning')
    # 抱箍：杆子到变压器的两道托架
    for z in (cz - 0.3, cz + 0.25):
        b.box(pole_r(z) - 0.02, -0.04, z, cx - 0.2, 0.04, z + 0.05, 'steel_dark')
        b.torus((0, 0, z + 0.025), pole_r(z) + 0.01, 0.012, 'steel_dark', seg=16, rseg=5)
    return b.finish(sc, 'transformer')


def build_pole_lamp(sc):
    """电线杆上的防犯灯：5.1m 高，灯臂往 +Y（路那边）伸 0.85m、稍微往上翘；灯头底面是发光的 LED"""
    b = B()
    z0 = 5.1
    r0 = pole_r(z0)
    b.torus((0, 0, z0), r0 + 0.012, 0.014, 'steel_dark', seg=16, rseg=5)
    pts = [(0, r0, z0), (0, 0.35, z0 + 0.06), (0, 0.65, z0 + 0.16), (0, 0.8, z0 + 0.2)]
    for p, q in zip(pts, pts[1:]):
        b.cyl(p, q, 0.018, 'led_body', seg=8)
    with b.at(T((0, 0.86, z0 + 0.18))):
        b.box(-0.07, -0.12, -0.04, 0.07, 0.14, 0.03, 'led_body')
        b.box(-0.055, -0.1, -0.048, 0.055, 0.12, -0.04, 'led')
    obj = b.finish(sc, 'pole_lamp')
    anchor(sc, obj, 'light', (0, 0.87, z0 + 0.1), color='#eef2ff', intensity=22.0, radius=13.0, glow=0.42)
    return obj


# ---------------------------------------------------------------- 自动售货机
def build_vending(sc):
    b = B()
    X, Y0, Y1, Hh = 0.52, -0.38, 0.37, 1.86
    # 机身（正面另做）
    b.box(-X, Y0 + 0.02, 0.1, X, Y1, 1.62, 'vend_blue', faces=['+x', '-x', '+y'])
    b.box(-X, Y0, 1.62, X, Y1, Hh, 'vend_white', faces=['+x', '-x', '+y', '+z', '-y'])
    b.box(-X, Y0 + 0.02, 0, X, Y1, 0.1, 'vend_dark', faces=['+x', '-x', '+y', '-y'])
    f = Y0  # 正面
    # 顶上的灯箱（广告）
    b.box(-0.48, f - 0.012, 1.65, 0.48, f, 1.83, 'vend_panel', faces=['-y', '-z', '+z', '-x', '+x'])
    # 展示窗：往里凹 6cm，后面一整块亮的背板，三层货架，每层八瓶（亮的、各种颜色），下面一排价格按钮
    wx0, wx1, wz0, wz1 = -0.46, 0.46, 0.98, 1.58
    b.box(-X, f, wz1, X, f + 0.02, 1.62, 'vend_blue', faces=['-y', '-z'])
    b.box(-X, f, 0.42, X, f + 0.02, wz0, 'vend_white', faces=['-y', '+z'])
    b.box(-X, f, wz0, wx0, f + 0.02, wz1, 'vend_blue', faces=['-y', '+x'])
    b.box(wx1, f, wz0, X, f + 0.02, wz1, 'vend_blue', faces=['-y', '-x'])
    back = f + 0.12
    b.quad((wx0, back, wz0), (wx1, back, wz0), (wx1, back, wz1), (wx0, back, wz1), 'vend_back')
    b.quad((wx0, f + 0.02, wz0), (wx0, back, wz0), (wx0, back, wz1), (wx0, f + 0.02, wz1), 'vend_white')
    b.quad((wx1, back, wz0), (wx1, f + 0.02, wz0), (wx1, f + 0.02, wz1), (wx1, back, wz1), 'vend_white')
    cans = ['can_red', 'can_blue', 'can_green', 'can_orange', 'can_white', 'can_brown', 'can_yellow', 'can_black']
    for row in range(3):
        zb = wz0 + 0.03 + row * 0.19
        b.box(wx0, f + 0.02, zb - 0.012, wx1, back, zb, 'vend_white')
        for i in range(8):
            x = wx0 + 0.06 + i * ((wx1 - wx0 - 0.12) / 7)
            c = cans[(i * 3 + row * 5) % len(cans)]
            tall = 0.12 if (i + row) % 3 else 0.15
            b.cyl((x, back - 0.045, zb), (x, back - 0.045, zb + tall), 0.03, c, seg=10)
            b.cyl((x, back - 0.045, zb + tall), (x, back - 0.045, zb + tall + 0.02), 0.012, c, seg=8)
            b.box(x - 0.022, f - 0.006, zb - 0.045, x + 0.022, f + 0.002, zb - 0.025, 'vend_btn')
    # 下面：投币 / 纸币口、找零口（右边一块金属板），左边一块白板
    b.box(0.18, f - 0.015, 0.5, 0.44, f, 0.92, 'steel', faces=['-y', '-x', '+x', '+z', '-z'])
    b.box(0.24, f - 0.02, 0.8, 0.38, f - 0.015, 0.84, 'vend_dark')
    b.box(0.24, f - 0.02, 0.7, 0.38, f - 0.015, 0.74, 'vend_dark')
    b.box(0.26, f - 0.03, 0.55, 0.36, f - 0.015, 0.63, 'vend_dark')
    b.box(-0.44, f - 0.006, 0.5, 0.1, f, 0.9, 'vend_blue', faces=['-y'])
    # 取物口：凹进去的黑口子 + 一块挡板
    b.box(-X, f, 0.1, X, f + 0.02, 0.42, 'vend_white', faces=['-y', '+z'])
    b.box(-0.36, f - 0.005, 0.13, 0.24, f + 0.001, 0.36, 'vend_dark', faces=['-y'])
    b.box(-0.34, f - 0.012, 0.25, 0.22, f - 0.004, 0.35, 'vend_dark')
    obj = b.finish(sc, 'vending')
    anchor(sc, obj, 'light', (0, -0.72, 1.05), color='#e4eeff', intensity=3.5, radius=5.0, glow=1.1, glowGain=0.22, onAt=0.05)
    return obj


# ---------------------------------------------------------------- A 字小黑板
def build_board(sc):
    """两块往外斜 0.2 弧度的黑板，顶上铰在一起（铰链在 z = 0.86）。黑板面朝外，uv 0..1（从外面看字是正的）"""
    b = B()
    W, Hb, fw = 0.56, 0.84, 0.035
    for side in (-1, 1):  # -1 = 正面（-Y），1 = 背面
        tilt = R(side * 0.2, 4, 'X')
        with b.at(T((0, 0, 0.88)) @ tilt @ T((0, 0, -0.88))):
            y0 = side * 0.012
            # 黑板面（外面那一面）
            hw = W / 2
            zb, zt = 0.06, 0.06 + Hb
            yo = side * 0.016
            if side < 0:
                b.quad((-hw, yo, zb), (hw, yo, zb), (hw, yo, zt), (-hw, yo, zt), 'board', uv=[(0, 0), (1, 0), (1, 1), (0, 1)])
            else:
                b.quad((hw, yo, zb), (-hw, yo, zb), (-hw, yo, zt), (hw, yo, zt), 'board', uv=[(0, 0), (1, 0), (1, 1), (0, 1)])
            b.box(-hw, -0.008 + y0, zb, hw, 0.008 + y0, zt, 'iron', faces=['+y' if side < 0 else '-y'])
            # 木框：两根竖的（往下伸成腿）、上下两根横的
            b.box(-hw - fw, -0.02 + y0, 0.0, -hw, 0.02 + y0, zt + fw, 'wood_dark')
            b.box(hw, -0.02 + y0, 0.0, hw + fw, 0.02 + y0, zt + fw, 'wood_dark')
            b.box(-hw, -0.02 + y0, zt, hw, 0.02 + y0, zt + fw, 'wood_dark')
            b.box(-hw, -0.02 + y0, zb - fw, hw, 0.02 + y0, zb, 'wood_dark')
    # 铰链（两个小圆柱）
    for x in (-0.22, 0.22):
        b.cyl((x - 0.03, 0, 0.92), (x + 0.03, 0, 0.92), 0.012, 'steel', seg=8)
    return b.finish(sc, 'board')


# ---------------------------------------------------------------- 长凳
def build_bench(sc):
    b = B()
    # 座面：五条木板（顺着凳子），中间留缝
    for i in range(5):
        y = -0.2 + i * 0.082
        b.box(-0.75, y, 0.405, 0.75, y + 0.07, 0.44, 'wood')
    # 靠背：两条，往后仰
    with b.at(T((0, 0.21, 0.44)) @ R(-0.16, 4, 'X')):
        for z in (0.16, 0.3):
            b.box(-0.75, -0.012, z, 0.75, 0.024, z + 0.09, 'wood')
    # 铸铁侧架：侧面的轮廓（yz 平面）沿 x 拉出 4cm 厚
    side = [(-0.22, 0.0), (-0.16, 0.0), (-0.13, 0.36), (0.14, 0.36), (0.17, 0.0), (0.23, 0.0), (0.21, 0.4), (0.3, 0.84), (0.25, 0.85), (0.17, 0.42), (-0.2, 0.42)]
    P = Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1)))  # 拉伸坐标 (u, v, w) → (w, u, v)
    for x in (-0.64, 0.6):
        with b.at(T((x, 0, 0)) @ P):
            b.prism(side, 0.0, 0.04, 'iron')
    return b.finish(sc, 'bench')


# ---------------------------------------------------------------- 花箱
def build_planter(sc, name, w, d, h):
    b = B()
    hw, hd = w / 2, d / 2
    post = 0.05
    # 四角立柱
    for sx in (-1, 1):
        for sy in (-1, 1):
            x0 = sx * hw - (post if sx > 0 else 0)
            y0 = sy * hd - (post if sy > 0 else 0)
            b.box(x0, y0, 0, x0 + post, y0 + post, h, 'wood_dark')
    # 横板：每面三条，板之间留一道暗缝
    n = 3
    gap = 0.008
    ph = (h - 0.04 - gap * (n - 1)) / n
    for i in range(n):
        z0 = 0.02 + i * (ph + gap)
        b.box(-hw + post, -hd + 0.005, z0, hw - post, -hd + 0.025, z0 + ph, 'wood')
        b.box(-hw + post, hd - 0.025, z0, hw - post, hd - 0.005, z0 + ph, 'wood')
        b.box(-hw + 0.005, -hd + post, z0, -hw + 0.025, hd - post, z0 + ph, 'wood')
        b.box(hw - 0.025, -hd + post, z0, hw - 0.005, hd - post, z0 + ph, 'wood')
    # 上沿压条
    b.box(-hw - 0.015, -hd - 0.015, h, hw + 0.015, -hd + 0.035, h + 0.025, 'wood_dark')
    b.box(-hw - 0.015, hd - 0.035, h, hw + 0.015, hd + 0.015, h + 0.025, 'wood_dark')
    b.box(-hw - 0.015, -hd + 0.035, h, -hw + 0.035, hd - 0.035, h + 0.025, 'wood_dark')
    b.box(hw - 0.035, -hd + 0.035, h, hw + 0.015, hd - 0.035, h + 0.025, 'wood_dark')
    # 土面
    b.quad((-hw + 0.03, -hd + 0.03, h - 0.04), (hw - 0.03, -hd + 0.03, h - 0.04), (hw - 0.03, hd - 0.03, h - 0.04), (-hw + 0.03, hd - 0.03, h - 0.04), 'soil')
    return b.finish(sc, name)


# ---------------------------------------------------------------- 格栅、井盖、栏杆立柱、旗杆
def build_grate(sc):
    b = B()
    L, Wd = 0.6, 0.34
    b.box(-L / 2, -Wd / 2, 0, L / 2, -Wd / 2 + 0.03, 0.014, 'grate')
    b.box(-L / 2, Wd / 2 - 0.03, 0, L / 2, Wd / 2, 0.014, 'grate')
    b.box(-L / 2, -Wd / 2 + 0.03, 0, -L / 2 + 0.03, Wd / 2 - 0.03, 0.014, 'grate')
    b.box(L / 2 - 0.03, -Wd / 2 + 0.03, 0, L / 2, Wd / 2 - 0.03, 0.014, 'grate')
    b.box(-L / 2 + 0.03, -Wd / 2 + 0.03, -0.03, L / 2 - 0.03, Wd / 2 - 0.03, -0.029, 'grate')  # 底下的暗处
    x = -L / 2 + 0.05
    while x < L / 2 - 0.04:
        b.box(x - 0.007, -Wd / 2 + 0.03, -0.02, x + 0.007, Wd / 2 - 0.03, 0.016, 'grate_bar')
        x += 0.042
    return b.finish(sc, 'grate')


def build_manhole(sc):
    b = B()
    b.lathe([(0.34, 0.0), (0.34, 0.006), (0.32, 0.007), (0.0, 0.011)], 'manhole', seg=40, close_bottom=False, smooth=False)
    for r in (0.29, 0.2, 0.11):
        b.torus((0, 0, 0.009), r, 0.006, 'manhole_hi', seg=40, rseg=4)
    for k in range(16):
        a = 2 * math.pi * k / 16
        with b.at(R(a, 4, 'Z')):
            b.box(0.12, -0.005, 0.006, 0.28, 0.005, 0.014, 'manhole_hi')
    b.cyl((0, 0, 0.006), (0, 0, 0.015), 0.05, 'manhole_hi', seg=16)
    return b.finish(sc, 'manhole')


def build_rail_post(sc):
    b = B()
    b.lathe([(0.055, 0), (0.055, 0.012), (0.03, 0.025), (0.026, 0.035), (0.026, 0.57), (0.03, 0.58)], 'post', seg=12, close_top=False)
    b.sphere((0, 0, 0.6), 0.034, 'post', seg=12, rings=8)
    for z in (0.3, 0.55):
        b.torus((0, 0, z), 0.031, 0.007, 'post', seg=12, rseg=5)
    return b.finish(sc, 'rail_post')


def build_nobori(sc):
    b = B()
    # 注水底座：圆角的长方块（深灰塑料），顶上一个盖子
    b.box(-0.21, -0.15, 0, 0.21, 0.15, 0.13, 'plastic')
    b.box(-0.18, -0.12, 0.13, 0.18, 0.12, 0.16, 'plastic')
    b.cyl((0.1, 0.0, 0.16), (0.1, 0.0, 0.18), 0.03, 'plate', seg=10)
    b.cyl((0, 0, 0.16), (0, 0, 0.24), 0.03, 'plastic', seg=10)
    b.cyl((0, 0, 0.2), (0, 0, 2.55), 0.016, 'pole_white', seg=10)
    b.sphere((0, 0, 2.56), 0.02, 'pole_white', seg=10, rings=6)
    return b.finish(sc, 'nobori')


def main():
    sc = fresh_scene('street_props')
    objs = [
        build_lamp(sc),
        build_pole(sc),
        build_transformer(sc),
        build_pole_lamp(sc),
        build_vending(sc),
        build_board(sc),
        build_bench(sc),
        build_planter(sc, 'planter_l', 1.2, 0.5, 0.45),
        build_planter(sc, 'planter_s', 0.9, 0.4, 0.4),
        build_grate(sc),
        build_manhole(sc),
        build_rail_post(sc),
        build_nobori(sc),
    ]
    for o in objs:
        o.data.set_sharp_from_angle(angle=math.radians(38))
    export(sc, OUT, objs)


main()
