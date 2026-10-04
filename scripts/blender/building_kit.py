"""
房子的构件库（src/vrm/scenes/street.ts 的 building() 拼装用）：每种立面格子一个构件，外加屋顶的零件。

    blender -b --factory-startup -P scripts/blender/building_kit.py

输出 public/scene/models/building_kit/kit.glb。每个构件两档：NAME（精细，近处）和 NAME_lod1（简化，远处和山坡上的房子）。

开口的位置、大小读 src/vrm/scenes/kit/kitSpec.json（和代码共用）：构件按"标准开间"建 —— 宽 2.6m、一楼高 3.2m、楼上高 2.9m，
代码按实际开间的宽度缩放。墙上的洞、洞口四周的窗套是代码做的，构件只管洞里和墙外的东西：
窗框往里缩 12cm、玻璃（pane，代码换成室内映射）、窗台、暖帘、灯笼、门灯、信箱、空调外机、落水管……

坐标：Blender Z 朝上；开间的中心线在 x = 0、宽 ±1.3；墙面在 y = 0，街在 -Y（three.js 里是 +Z），往墙里是 +Y。
材质槽：wood / metal / paint / fabric / pane / frost / glow / tile / concrete（见 kit_common.py）。
光源：空物体 light…，自定义属性写颜色、强度、照多远、光晕、亮的钟点（hours）。
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kit_common import MODELS, REPO, Builder, anchor, export, fresh_scene  # noqa: E402
from mathutils import Matrix  # noqa: E402

OUT = os.path.join(MODELS, 'building_kit', 'kit.glb')
SPEC = json.load(open(os.path.join(REPO, 'src', 'vrm', 'scenes', 'kit', 'kitSpec.json')))
CW = SPEC['cellW']
HG = SPEC['groundH']
HU = SPEC['upperH']

COLORS = {
    'wood_dark': '#7d6a5e',
    'wood_mid': '#9a8576',
    'wood_light': '#c7ad92',
    'wood_raw': '#d9c2a4',
    'alu': '#b7bcc1',
    'alu_dark': '#6b7178',
    'alu_white': '#e9e4d8',
    'iron': '#2e3236',
    'brass': '#c9a050',
    'pane': '#ffffff',
    'frost_warm': '#efe6d4',
    'frost_cool': '#e4e8ea',
    'paper': '#f1e2c2',
    'noren': '#23345e',
    'noren_red': '#7a2a24',
    'white': '#f4f4f0',
    'lantern': '#d8392c',
    'lamp': '#fff1d6',
    'black': '#1e1e20',
    'steel': '#8f9499',
    'ac': '#e6e6e2',
    'ac_dark': '#3a3d40',
    'meter': '#cfd2d4',
    'pipe': '#b9bcbf',
    'mailbox': '#4e5359',
    'terracotta': '#b5653e',
    'leaf': '#4f8a3a',
    'leaf_dark': '#36662b',
    'flower_pink': '#e88aa8',
    'flower_yellow': '#f2d14a',
    'flower_white': '#f6f2ea',
    'flower_red': '#d8433a',
    'pot': '#8a5a3c',
    'box_a': '#d9c08a',
    'box_b': '#c26b4a',
    'box_c': '#6a8fb5',
    'tile': '#ffffff',
    'tile_dark': '#c8c8c8',
    'concrete': '#d8d4cc',
    'shutter': '#c3c7cb',
    'shutter_dark': '#8d9298',
}
SLOTS = {
    'wood_dark': 'wood',
    'wood_mid': 'wood',
    'wood_light': 'wood',
    'wood_raw': 'wood',
    'alu': 'metal',
    'alu_dark': 'metal',
    'alu_white': 'metal',
    'iron': 'metal',
    'brass': 'metal',
    'steel': 'metal',
    'shutter': 'metal',
    'shutter_dark': 'metal',
    'pane': 'pane',
    'frost_warm': 'frost',
    'frost_cool': 'frost',
    'paper': 'frost',
    'lantern': 'glow',
    'lamp': 'glow',
    'noren': 'fabric',
    'noren_red': 'fabric',
    'tile': 'tile',
    'tile_dark': 'tile',
    'concrete': 'concrete',
}

T = Matrix.Translation
R = Matrix.Rotation
D = 0.12  # 窗框往墙里缩多少（玻璃在 y = D - 0.005）
FY0, FY1 = D - 0.045, D + 0.03  # 窗框的前后


def hole(name, H):
    u0, v0, u1, v1 = SPEC['modules'][name]['hole']
    return (-CW / 2 + u0 * CW, -CW / 2 + u1 * CW, v0 * H, v1 * H)


def frame(b, x0, x1, z0, z1, color, fw=0.05, y0=FY0, y1=FY1):
    b.box(x0, y0, z0, x0 + fw, y1, z1, color)
    b.box(x1 - fw, y0, z0, x1, y1, z1, color)
    b.box(x0 + fw, y0, z1 - fw, x1 - fw, y1, z1, color)
    b.box(x0 + fw, y0, z0, x1 - fw, y1, z0 + fw, color)


def pane(b, x0, x1, z0, z1, color='pane', y=D - 0.005):
    b.quad((x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1), color)


def vbar(b, x, z0, z1, color, w=0.04, y0=FY0 + 0.01, y1=FY1 - 0.005):
    b.box(x - w / 2, y0, z0, x + w / 2, y1, z1, color)


def hbar(b, z, x0, x1, color, w=0.04, y0=FY0 + 0.01, y1=FY1 - 0.005):
    b.box(x0, y0, z - w / 2, x1, y1, z + w / 2, color)


def sill(b, x0, x1, z, color, out=0.07):
    b.box(x0 - 0.06, -out, z - 0.05, x1 + 0.06, D, z, color)


def flowers(b, cx, cz, w, lod, pot_color='terracotta', n=None):
    """一个花箱 / 一排小盆：箱子 + 叶子团 + 花点"""
    b.box(cx - w / 2, -0.22, cz, cx + w / 2, -0.02, cz + 0.16, pot_color)
    if lod:
        b.box(cx - w / 2 + 0.02, -0.2, cz + 0.16, cx + w / 2 - 0.02, -0.04, cz + 0.24, 'leaf')
        return
    n = n or max(3, int(w / 0.16))
    cols = ['flower_pink', 'flower_yellow', 'flower_white', 'flower_red']
    for i in range(n):
        x = cx - w / 2 + (i + 0.5) * w / n
        b.sphere((x, -0.12, cz + 0.2), 0.075, 'leaf' if i % 2 else 'leaf_dark', seg=6, rings=4)
        b.sphere((x + 0.02, -0.15, cz + 0.27), 0.032, cols[i % 4], seg=5, rings=3)


def wainscot(b, x0, x1, z0, z1, color='wood_dark', lod=0):
    """窗下面的木护墙板（贴在墙面上，往外 2cm）"""
    b.box(x0, -0.025, z0, x1, 0.0, z1, color)
    if not lod:
        n = max(2, int((x1 - x0) / 0.6))
        for i in range(n):
            a = x0 + (i + 0.5) * (x1 - x0) / n
            b.box(a - (x1 - x0) / n / 2 + 0.04, -0.035, z0 + 0.06, a + (x1 - x0) / n / 2 - 0.04, -0.025, z1 - 0.06, 'wood_mid')


# ---------------------------------------------------------------- 一楼的店面
def cafe_win(b, lod):
    x0, x1, z0, z1 = hole('CAFE_WIN', HG)
    frame(b, x0, x1, z0, z1, 'wood_mid', 0.07)
    pane(b, x0, x1, z0, z1)
    vbar(b, 0, z0, z1, 'wood_mid', 0.06)
    if not lod:
        hbar(b, z1 - 0.36, x0, x1, 'wood_mid', 0.05)
    sill(b, x0, x1, z0, 'wood_mid', 0.1)
    wainscot(b, x0, x1, 0.3, z0 - 0.05, lod=lod)


def cafe_door(b, lod):
    x0, x1, z0, z1 = hole('CAFE_DOOR', HG)
    frame(b, x0, x1, z0, z1, 'wood_mid', 0.07)
    pane(b, x0, x1, z0, z1)
    dl, dr = -0.6, 0.56
    vbar(b, dl, z0, z1, 'wood_mid', 0.08)
    vbar(b, dr, z0, z1, 'wood_mid', 0.08)
    hbar(b, z1 - 0.36, x0, x1, 'wood_mid', 0.05)
    # 门扇：木框 + 下面的踢脚板 + 黄铜把手；两边的侧窗下面也是木板
    b.box(dl + 0.04, FY0 + 0.005, z0, dr - 0.04, FY1, z0 + 0.32, 'wood_mid')
    if not lod:
        b.box(dl + 0.04, FY0, z1 - 0.44, dr - 0.04, FY1, z1 - 0.38, 'wood_mid')
        b.cyl((dr - 0.14, FY0 - 0.06, 1.15), (dr - 0.14, FY0 - 0.06, 1.55), 0.014, 'brass', seg=8)
        for z in (1.15, 1.55):
            b.cyl((dr - 0.14, FY0 - 0.06, z), (dr - 0.14, FY0, z), 0.01, 'brass', seg=6)
    for a, c in ((x0, dl), (dr, x1)):
        b.box(a + 0.03, FY0 + 0.01, z0, c - 0.03, FY1, z0 + 0.5, 'wood_mid')
    # 门口一块石板
    b.box(dl - 0.1, -0.5, 0.0, dr + 0.1, 0.0, 0.3, 'concrete')


def shop_win(b, lod):
    x0, x1, z0, z1 = hole('SHOP_WIN', HG)
    frame(b, x0, x1, z0, z1, 'wood_light', 0.07)
    pane(b, x0, x1, z0, z1)
    for x in (-0.4, 0.4):
        vbar(b, x, z0, z1, 'wood_light', 0.05)
    sill(b, x0, x1, z0, 'wood_light', 0.08)
    # 窗下：一个往外伸的木台子，摆几件陶器
    b.box(x0 + 0.05, -0.32, 0.3, x1 - 0.05, 0.0, z0 - 0.06, 'wood_mid')
    b.box(x0, -0.36, z0 - 0.08, x1, 0.0, z0 - 0.04, 'wood_light')
    if not lod:
        for i, x in enumerate((-0.8, -0.35, 0.15, 0.6, 0.95)):
            h = 0.12 + 0.06 * (i % 3)
            with b.at(T((x, -0.18, z0 - 0.04))):
                b.lathe([(0.0, 0), (0.06, 0.005), (0.08, h * 0.5), (0.05, h * 0.9), (0.055, h), (0.0, h)], ['white', 'terracotta', 'box_c', 'white', 'white'][i % 5], seg=10)


def souvenir(b, lod):
    x0, x1, z0, z1 = hole('SOUVENIR', HG)
    frame(b, x0, x1, z0, z1, 'alu_dark', 0.05)
    pane(b, x0, x1, z0, z1)
    vbar(b, 0, z0, z1, 'alu_dark', 0.05)
    b.box(x0, -0.01, 0.3, x1, 0.0, z0, 'alu_dark')  # 下面的不锈钢踢脚板
    # 门口的货摊：一张木桌、几个装特产的盒子
    b.box(x0 + 0.2, -0.75, 0.6, x1 - 0.9, -0.15, 0.66, 'wood_light')
    for x in (x0 + 0.25, x1 - 0.95):
        b.box(x, -0.72, 0.0, x + 0.05, -0.18, 0.6, 'wood_mid')
    if not lod:
        cols = ['box_a', 'box_b', 'box_c', 'box_a', 'box_b']
        x = x0 + 0.3
        i = 0
        while x < x1 - 1.05:
            w = 0.18 + 0.05 * (i % 3)
            b.box(x, -0.66, 0.66, x + w, -0.32 + 0.05 * (i % 2), 0.66 + 0.08 + 0.04 * (i % 3), cols[i % 5])
            x += w + 0.04
            i += 1


def glass_shop(b, lod):
    x0, x1, z0, z1 = hole('GLASS_SHOP', HG)
    frame(b, x0, x1, z0, z1, 'alu_dark', 0.05)
    pane(b, x0, x1, z0, z1)
    vbar(b, 0, z0, z1, 'alu_dark', 0.05)
    if not lod:
        hbar(b, z1 - 0.45, x0, x1, 'alu_dark', 0.04)
        b.box(0.08, FY0 - 0.06, 0.9, 0.11, FY0 - 0.03, 1.5, 'steel')
        b.box(-0.11, FY0 - 0.06, 0.9, -0.08, FY0 - 0.03, 1.5, 'steel')


def flower(b, lod):
    x0, x1, z0, z1 = hole('FLOWER', HG)
    frame(b, x0, x1, z0, z1, 'alu_white', 0.05)
    pane(b, x0, x1, z0, z1)
    vbar(b, 0, z0, z1, 'alu_white', 0.05)
    # 门口的两层花架：木板台阶，上面一排排花盆
    for k, (y0, y1, z) in enumerate(((-0.9, -0.55, 0.32), (-0.55, -0.2, 0.62))):
        b.box(x0 + 0.1, y0, z - 0.04, x1 - 0.1, y1, z, 'wood_raw')
        for x in (x0 + 0.12, x1 - 0.16):
            b.box(x, y0 + 0.02, 0, x + 0.04, y1 - 0.02, z - 0.04, 'wood_mid')
        if not lod:
            n = 7
            for i in range(n):
                x = x0 + 0.25 + i * (x1 - x0 - 0.5) / (n - 1)
                yc = (y0 + y1) / 2
                b.cyl((x, yc, z), (x, yc, z + 0.14), 0.07, 'pot', r1=0.085, seg=6, caps=False)
                b.sphere((x, yc, z + 0.22), 0.11, 'leaf' if i % 2 else 'leaf_dark', seg=6, rings=4)
                c = ['flower_pink', 'flower_yellow', 'flower_white', 'flower_red'][(i + k) % 4]
                for j in range(2):
                    a = j * 3.1 + i
                    b.sphere((x + 0.06 * math.cos(a), yc + 0.06 * math.sin(a), z + 0.31), 0.04, c, seg=5, rings=3)
        else:
            b.box(x0 + 0.15, y0 + 0.05, z, x1 - 0.15, y1 - 0.05, z + 0.28, 'leaf')


def noren(b, lod):
    x0, x1, z0, z1 = hole('NOREN', HG)
    # 门框（深色的木柱、上面一根梁）
    b.box(x0 - 0.06, -0.04, 0.0, x0 + 0.06, D + 0.05, z1 + 0.1, 'wood_dark')
    b.box(x1 - 0.06, -0.04, 0.0, x1 + 0.06, D + 0.05, z1 + 0.1, 'wood_dark')
    b.box(x0 - 0.06, -0.06, z1, x1 + 0.06, D + 0.05, z1 + 0.16, 'wood_dark')
    # 两扇木格子拉门，糊着毛玻璃（夜里透出暖光）
    mid = (x0 + x1) / 2
    for a, c, yy in ((x0 + 0.06, mid + 0.03, D + 0.02), (mid - 0.03, x1 - 0.06, D - 0.02)):
        b.quad((a, yy - 0.01, z0), (c, yy - 0.01, z0), (c, yy - 0.01, z1), (a, yy - 0.01, z1), 'frost_warm')
        frame(b, a, c, z0, z1, 'wood_mid', 0.05, yy - 0.025, yy + 0.015)
        if not lod:
            n = 4
            for i in range(1, n):
                vbar(b, a + i * (c - a) / n, z0, z1, 'wood_mid', 0.022, yy - 0.022, yy + 0.01)
            for z in (z0 + 0.6, z0 + 1.2, z0 + 1.75):
                hbar(b, z, a, c, 'wood_mid', 0.022, yy - 0.022, yy + 0.01)
    b.box(x0, -0.03, 0.0, x1, D + 0.05, z0, 'wood_dark')  # 门槛
    # 暖帘：挂在一根细杆上，三幅深蓝的布，中间一幅上一个白色的圆（店的记号）
    rod_z = z1 - 0.06
    b.cyl((x0 - 0.02, -0.12, rod_z), (x1 + 0.02, -0.12, rod_z), 0.012, 'wood_dark', seg=6)
    nw = (x1 - x0 - 0.06) / 3
    for i in range(3):
        a = x0 + 0.03 + i * nw
        c = a + nw - 0.03
        drop = 0.85
        b.box(a, -0.115, rod_z - drop, c, -0.1, rod_z, 'noren')
        if i == 1:
            cx = (a + c) / 2
            with b.at(T((cx, -0.118, rod_z - 0.32)) @ R(math.pi / 2, 4, 'X')):
                b.cyl((0, 0, 0), (0, 0, 0.003), 0.13, 'white', seg=20)
                if not lod:
                    b.cyl((0, 0, -0.001), (0, 0, 0.004), 0.1, 'noren', seg=20)
                    b.box(-0.05, -0.02, -0.002, 0.05, 0.02, 0.005, 'white')
        if not lod:
            # 布下沿一道白色的波纹（一条细边）
            b.box(a, -0.119, rod_z - drop + 0.12, c, -0.114, rod_z - drop + 0.16, 'white')


def lattice(b, lod):
    x0, x1, z0, z1 = hole('LATTICE', HG)
    b.box(x0 - 0.06, -0.04, 0.0, x0 + 0.06, D + 0.05, z1 + 0.12, 'wood_dark')
    b.box(x1 - 0.06, -0.04, 0.0, x1 + 0.06, D + 0.05, z1 + 0.12, 'wood_dark')
    b.box(x0 - 0.06, -0.06, z1, x1 + 0.06, D + 0.05, z1 + 0.16, 'wood_dark')
    # 格子后面：纸拉门（夜里透光）
    b.quad((x0, D + 0.04, z0), (x1, D + 0.04, z0), (x1, D + 0.04, z1), (x0, D + 0.04, z1), 'paper')
    # 竖格子：细木条一根挨一根
    step = 0.05 if not lod else 0.1
    x = x0 + 0.08
    while x < x1 - 0.06:
        b.box(x, -0.005, z0, x + 0.022, 0.03, z1, 'wood_dark')
        x += step
    for z in (z0, z0 + 0.95, z1 - 0.06):
        b.box(x0 + 0.06, -0.02, z, x1 - 0.06, 0.035, z + 0.06, 'wood_dark')
    b.box(x0, -0.03, 0.0, x1, D + 0.05, z0, 'wood_dark')


def shutter(b, lod):
    x0, x1, z0, z1 = hole('SHUTTER', HG)
    # 卷帘盒、两边的导轨、帘片（一道道横楞）、下面的底梁
    b.box(x0 - 0.05, -0.28, z1, x1 + 0.05, 0.0, z1 + 0.32, 'shutter_dark')
    for x in (x0, x1 - 0.06):
        b.box(x, -0.08, 0.0, x + 0.06, 0.0, z1, 'shutter_dark')
    if lod:
        b.quad((x0 + 0.06, -0.04, z0), (x1 - 0.06, -0.04, z0), (x1 - 0.06, -0.04, z1), (x0 + 0.06, -0.04, z1), 'shutter')
    else:
        z = z0
        k = 0
        while z < z1 - 0.01:
            zz = min(z + 0.075, z1)
            y = -0.045 if k % 2 == 0 else -0.035
            b.quad((x0 + 0.06, y, z), (x1 - 0.06, y, z), (x1 - 0.06, y - 0.004, zz), (x0 + 0.06, y - 0.004, zz), 'shutter')
            b.quad((x0 + 0.06, y - 0.004, zz), (x1 - 0.06, y - 0.004, zz), (x1 - 0.06, y + 0.008, zz), (x0 + 0.06, y + 0.008, zz), 'shutter_dark')
            z = zz
            k += 1
        b.box(-0.12, -0.07, 0.25, 0.12, -0.04, 0.3, 'steel')  # 把手
    b.box(x0 + 0.06, -0.07, 0.0, x1 - 0.06, -0.02, 0.06, 'shutter_dark')


def genkan(b, lod):
    x0, x1, z0, z1 = hole('GENKAN', HG)
    frame(b, x0, x1, z0, z1, 'alu', 0.06)
    mid = (x0 + x1) / 2
    for a, c, yy in ((x0 + 0.06, mid + 0.02, D + 0.015), (mid - 0.02, x1 - 0.06, D - 0.015)):
        b.quad((a, yy, z0 + 0.06), (c, yy, z0 + 0.06), (c, yy, z1 - 0.06), (a, yy, z1 - 0.06), 'frost_cool')
        frame(b, a, c, z0 + 0.06, z1 - 0.06, 'alu', 0.045, yy - 0.02, yy + 0.02)
        if not lod:
            hbar(b, z0 + 0.95, a, c, 'alu', 0.03, yy - 0.015, yy + 0.015)
    # 台阶、门上的小雨棚（两个斜撑）
    b.box(x0 - 0.15, -0.45, 0.0, x1 + 0.15, 0.0, z0, 'concrete')
    b.box(x0 - 0.25, -0.65, z1 + 0.22, x1 + 0.25, 0.0, z1 + 0.27, 'alu')
    if not lod:
        for x in (x0 - 0.15, x1 + 0.15):
            b.cyl((x, -0.01, z1 + 0.02), (x, -0.55, z1 + 0.22), 0.012, 'alu', seg=6)
    # 门灯（右边墙上，夜里亮）、信箱、门铃、门牌
    lx = x1 + 0.32
    b.box(lx - 0.05, -0.04, 1.93, lx + 0.05, 0.0, 2.17, 'iron')
    b.box(lx - 0.07, -0.16, 1.98, lx + 0.07, -0.04, 2.14, 'lamp')
    b.box(lx - 0.08, -0.17, 2.14, lx + 0.08, -0.03, 2.17, 'iron')
    b.box(lx - 0.17, -0.12, 1.05, lx + 0.17, 0.0, 1.4, 'mailbox')
    if not lod:
        b.box(lx - 0.14, -0.125, 1.32, lx + 0.14, -0.12, 1.34, 'black')
        b.box(lx - 0.05, -0.04, 1.5, lx + 0.05, 0.0, 1.64, 'white')
        b.box(lx - 0.1, -0.015, 1.72, lx + 0.1, 0.0, 1.8, 'wood_raw')


def izakaya(b, lod):
    x0, x1, z0, z1 = hole('IZAKAYA', HG)
    b.box(x0 - 0.07, -0.05, 0.0, x0 + 0.07, D + 0.05, z1 + 0.12, 'wood_dark')
    b.box(x1 - 0.07, -0.05, 0.0, x1 + 0.07, D + 0.05, z1 + 0.12, 'wood_dark')
    b.box(x0 - 0.07, -0.08, z1, x1 + 0.07, D + 0.05, z1 + 0.2, 'wood_dark')
    # 格子拉门：纸后面的暖光（营业时间亮）
    b.quad((x0 + 0.07, D, z0), (x1 - 0.07, D, z0), (x1 - 0.07, D, z1), (x0 + 0.07, D, z1), 'paper')
    step = 0.06 if not lod else 0.12
    x = x0 + 0.1
    while x < x1 - 0.08:
        b.box(x, D - 0.04, z0, x + 0.02, D - 0.01, z1, 'wood_dark')
        x += step
    for z in (z0 + 0.7, z1 - 0.5):
        b.box(x0 + 0.07, D - 0.045, z, x1 - 0.07, D - 0.005, z + 0.04, 'wood_dark')
    b.box(x0, -0.04, 0.0, x1, D + 0.05, z0, 'wood_dark')
    # 短暖帘（深蓝）
    rod_z = z1 - 0.05
    b.box(x0 + 0.05, -0.13, rod_z - 0.5, x1 - 0.05, -0.11, rod_z, 'noren')
    if not lod:
        for k in range(1, 4):
            x = x0 + 0.05 + k * (x1 - x0 - 0.1) / 4
            b.box(x - 0.015, -0.135, rod_z - 0.5, x + 0.015, -0.105, rod_z - 0.12, 'wood_dark')
        for cx in (x0 + (x1 - x0) * 0.3, x0 + (x1 - x0) * 0.62):
            b.box(cx - 0.15, -0.134, rod_z - 0.38, cx + 0.15, -0.131, rod_z - 0.14, 'white')
    # 红灯笼：右边挂一个（夜里亮）
    lx, lz = x1 - 0.32, 1.72
    b.cyl((lx, -0.3, lz + 0.26), (lx, -0.3, z1 + 0.05), 0.006, 'black', seg=4)
    with b.at(T((lx, -0.3, lz - 0.24))):
        b.lathe([(0.11, 0.0), (0.11, 0.04)], 'black', seg=14, close_top=False)
        b.lathe([(0.11, 0.04), (0.15, 0.1), (0.17, 0.24), (0.15, 0.38), (0.11, 0.44)], 'lantern', seg=14, close_bottom=False, close_top=False)
        b.lathe([(0.11, 0.44), (0.11, 0.48)], 'black', seg=14, close_bottom=False)


def wall_g(b, lod):
    x0, x1, z0, z1 = hole('WALL_G', HG)
    frame(b, x0, x1, z0, z1, 'alu', 0.04)
    b.quad((x0, D - 0.005, z0), (x1, D - 0.005, z0), (x1, D - 0.005, z1), (x0, D - 0.005, z1), 'frost_cool')
    if not lod:
        for x in (x0 + (x1 - x0) / 3, x0 + 2 * (x1 - x0) / 3):
            b.box(x - 0.008, -0.03, z0, x + 0.008, -0.015, z1, 'iron')
    # 燃气表 + 管子、通风口
    b.box(-0.85, -0.16, 1.05, -0.55, 0.0, 1.38, 'meter')
    b.cyl((-0.78, -0.06, 0.0), (-0.78, -0.06, 1.05), 0.022, 'pipe', seg=8)
    b.cyl((-0.62, -0.06, 1.38), (-0.62, -0.06, 2.1), 0.016, 'pipe', seg=8)
    b.box(-0.95, -0.03, 2.45, -0.7, 0.0, 2.7, 'steel')
    if not lod:
        for k in range(5):
            z = 2.48 + k * 0.045
            b.box(-0.93, -0.045, z, -0.72, -0.03, z + 0.015, 'alu_dark')


# ---------------------------------------------------------------- 楼上的窗
def win_wood(b, lod):
    x0, x1, z0, z1 = hole('WIN_WOOD', HU)
    frame(b, x0, x1, z0, z1, 'wood_mid', 0.05)
    pane(b, x0, x1, z0, z1)
    if not lod:
        vbar(b, 0, z0, z1, 'wood_mid', 0.04)
        hbar(b, (z0 + z1) / 2, x0, x1, 'wood_mid', 0.04)
    sill(b, x0, x1, z0, 'wood_mid', 0.09)


def win_alu(b, lod):
    x0, x1, z0, z1 = hole('WIN_ALU', HU)
    frame(b, x0, x1, z0, z1, 'alu', 0.045)
    pane(b, x0, x1, z0, z1)
    mid = (x0 + x1) / 2
    # 两扇推拉窗：一前一后，中间的竖框
    vbar(b, mid - 0.02, z0, z1, 'alu', 0.04, FY0, FY0 + 0.03)
    vbar(b, mid + 0.02, z0, z1, 'alu', 0.04, FY0 + 0.035, FY1)
    b.box(x0 - 0.03, -0.05, z0 - 0.03, x1 + 0.03, D, z0, 'alu')
    flowers(b, mid, z0 - 0.2, (x1 - x0) * 0.8, lod)


def win_lattice(b, lod):
    x0, x1, z0, z1 = hole('WIN_LATTICE', HU)
    frame(b, x0, x1, z0, z1, 'alu', 0.045)
    pane(b, x0, x1, z0, z1)
    # 面格子（防盗的铁栅）：墙外 6cm，竖条 + 三道横档
    g0, g1 = -0.08, -0.06
    b.box(x0 - 0.04, g0, z0 - 0.04, x1 + 0.04, g1, z0, 'iron')
    b.box(x0 - 0.04, g0, z1, x1 + 0.04, g1, z1 + 0.04, 'iron')
    if not lod:
        x = x0 + 0.05
        while x < x1 - 0.03:
            b.box(x - 0.008, g0, z0, x + 0.008, g1, z1, 'iron')
            x += 0.1
        b.box(x0 - 0.04, g0, (z0 + z1) / 2 - 0.01, x1 + 0.04, g1, (z0 + z1) / 2 + 0.01, 'iron')
        for x in (x0 - 0.04, x1):
            b.box(x, g1, z0 - 0.04, x + 0.04, 0.0, z0, 'iron')
            b.box(x, g1, z1, x + 0.04, 0.0, z1 + 0.04, 'iron')


def wall_u(b, lod):
    # 圆形的通风罩（右上）+ 一个小电表箱
    with b.at(T((0.75, 0.0, 2.35)) @ R(math.pi / 2, 4, 'X')):
        b.lathe([(0.07, 0.0), (0.08, -0.03), (0.08, -0.09), (0.0, -0.1)], 'white', seg=14)
    if not lod:
        b.box(0.7, -0.09, 2.24, 0.8, -0.05, 2.27, 'alu_dark')


def balc_door(b, lod):
    x0, x1, z0, z1 = hole('BALC_DOOR', HU)
    frame(b, x0, x1, z0, z1, 'alu_dark', 0.05)
    pane(b, x0, x1, z0, z1)
    mid = (x0 + x1) / 2
    vbar(b, mid - 0.025, z0, z1, 'alu_dark', 0.05, FY0, FY0 + 0.03)
    vbar(b, mid + 0.025, z0, z1, 'alu_dark', 0.05, FY0 + 0.035, FY1)
    if not lod:
        hbar(b, z0 + 0.25, x0, x1, 'alu_dark', 0.04)


def win_small(b, lod):
    x0, x1, z0, z1 = hole('WIN_SMALL', HU)
    frame(b, x0, x1, z0, z1, 'alu', 0.04)
    b.quad((x0, D - 0.005, z0), (x1, D - 0.005, z0), (x1, D - 0.005, z1), (x0, D - 0.005, z1), 'frost_cool')
    if not lod:
        for x in (x0 + (x1 - x0) / 3, x0 + 2 * (x1 - x0) / 3):
            b.box(x - 0.008, -0.05, z0 - 0.02, x + 0.008, -0.035, z1 + 0.02, 'iron')
    b.box(x0 - 0.02, -0.04, z0 - 0.025, x1 + 0.02, D, z0, 'alu')


def win_tall(b, lod):
    x0, x1, z0, z1 = hole('WIN_TALL', HU)
    frame(b, x0, x1, z0, z1, 'wood_mid', 0.05)
    pane(b, x0, x1, z0, z1)
    vbar(b, 0, z0, z1, 'wood_mid', 0.04)
    if not lod:
        for k in (1, 2):
            hbar(b, z0 + k * (z1 - z0) / 3, x0, x1, 'wood_mid', 0.04)
    # 法式窗外一道低的铁栏杆
    b.box(x0 - 0.05, -0.18, z0 + 0.85, x1 + 0.05, -0.15, z0 + 0.88, 'iron')
    if not lod:
        x = x0
        while x <= x1 + 0.01:
            b.box(x - 0.008, -0.175, z0, x + 0.008, -0.155, z0 + 0.86, 'iron')
            x += 0.11


def wall_ac(b, lod):
    x0, x1, z0, z1 = hole('WALL_AC', HU)
    frame(b, x0, x1, z0, z1, 'alu', 0.04)
    pane(b, x0, x1, z0, z1)
    # 空调外机：挂在墙上的架子上，正面一个风扇罩；管子顺着墙往上进屋
    ax, az = 0.62, 0.32
    b.box(ax - 0.4, -0.3, az, ax + 0.4, -0.02, az + 0.56, 'ac')
    for x in (ax - 0.32, ax + 0.32):
        b.box(x - 0.02, -0.34, az - 0.04, x + 0.02, 0.0, az, 'steel')
    with b.at(T((ax - 0.1, -0.302, az + 0.28)) @ R(math.pi / 2, 4, 'X')):
        b.cyl((0, 0, 0), (0, 0, 0.004), 0.2, 'ac_dark', seg=24 if not lod else 12)
    if not lod:
        with b.at(T((ax - 0.1, -0.307, az + 0.28)) @ R(math.pi / 2, 4, 'X')):
            for r in (0.08, 0.14, 0.19):
                b.torus((0, 0, 0), r, 0.006, 'ac', seg=20, rseg=4)
        for k in range(6):
            z = az + 0.08 + k * 0.07
            b.box(ax + 0.2, -0.305, z, ax + 0.36, -0.3, z + 0.025, 'ac_dark')
    b.box(ax + 0.3, -0.09, az + 0.56, ax + 0.38, -0.02, z1 + 0.1, 'white')
    b.box(ax - 0.1, -0.09, z1 + 0.1, ax + 0.38, -0.02, z1 + 0.18, 'white')


def side_win(b, lod):
    x0, x1, z0, z1 = hole('SIDE_WIN', HU)
    frame(b, x0, x1, z0, z1, 'alu', 0.04)
    pane(b, x0, x1, z0, z1)
    b.box(x0 - 0.02, -0.04, z0 - 0.025, x1 + 0.02, D, z0, 'alu')


def side_pipe(b, lod):
    b.cyl((0.85, -0.08, 0.0), (0.85, -0.08, HU), 0.04, 'pipe', seg=10 if not lod else 6)
    if not lod:
        for z in (0.6, 1.6, 2.6):
            b.box(0.8, -0.04, z, 0.9, 0.0, z + 0.03, 'pipe')


def side(b, lod):
    pass


# ---------------------------------------------------------------- 屋顶零件
def ridge(b, lod):
    """屋脊：1m 一段（x -0.5..0.5），底下两层平瓦、上面一道半圆的盖瓦"""
    b.box(-0.5, -0.14, 0.0, 0.5, 0.14, 0.07, 'tile_dark')
    b.box(-0.5, -0.11, 0.07, 0.5, 0.11, 0.13, 'tile_dark')
    seg = 8 if not lod else 4
    prof = []
    for k in range(seg + 1):
        a = math.pi * k / seg
        prof.append((0.11 * math.cos(a), 0.13 + 0.09 * math.sin(a)))
    pts = [(-0.5, y, z) for y, z in prof]
    pts2 = [(0.5, y, z) for y, z in prof]
    for k in range(seg):
        b.quad(pts[k], pts2[k], pts2[k + 1], pts[k + 1], 'tile', smooth=True)


def ridge_end(b, lod):
    """鬼瓦（屋脊两头）：在 x = 0 处、朝 +X；一块往上翘的厚板 + 中间一个圆"""
    with b.at(R(math.pi / 2, 4, 'Z') @ R(math.pi / 2, 4, 'X')):
        b.prism([(-0.17, 0.0), (0.17, 0.0), (0.21, 0.3), (0.11, 0.4), (0.0, 0.35), (-0.11, 0.4), (-0.21, 0.3)], -0.03, 0.06, 'tile_dark')
    if not lod:
        with b.at(T((0.065, 0.0, 0.19)) @ R(math.pi / 2, 4, 'Y')):
            b.cyl((0, 0, 0), (0, 0, 0.02), 0.08, 'tile', seg=16)


def eave_tiles(b, lod):
    """檐口的一排瓦当：1m 一段（x -0.5..0.5），顺着坡往上（+Y）铺一截半圆的筒瓦，檐边一个个圆瓦当朝外（-Y）。
    原点在檐口的上沿；代码把它转到坡的角度上"""
    n = 4
    for i in range(n):
        x = -0.5 + (i + 0.5) / n
        if not lod:
            b.cyl((x, -0.02, 0.05), (x, 0.0, 0.05), 0.065, 'tile_dark', seg=8)
            prof = [(0.055 * math.cos(math.pi * k / 4), 0.05 + 0.05 * math.sin(math.pi * k / 4)) for k in range(5)]
            for k in range(4):
                (y0, z0), (y1, z1) = prof[k], prof[k + 1]
                b.quad((x + y0, 0.0, z0), (x + y0, 0.45, z0), (x + y1, 0.45, z1), (x + y1, 0.0, z1), 'tile', smooth=True)
        else:
            b.box(x - 0.06, -0.02, 0.0, x + 0.06, 0.4, 0.1, 'tile')


def gutter(b, lod):
    """檐沟：1m 一段，半圆的槽（开口朝上），在檐口下面"""
    seg = 8 if not lod else 4
    prof = [(0.06 * math.cos(math.pi + math.pi * k / seg), 0.06 * math.sin(math.pi + math.pi * k / seg)) for k in range(seg + 1)]
    for k in range(seg):
        (y0, z0), (y1, z1) = prof[k], prof[k + 1]
        b.quad((-0.5, y0, z0), (-0.5, y1, z1), (0.5, y1, z1), (0.5, y0, z0), 'pipe', smooth=True)
        b.quad((0.5, y0 * 0.92, z0 * 0.92), (0.5, y1 * 0.92, z1 * 0.92), (-0.5, y1 * 0.92, z1 * 0.92), (-0.5, y0 * 0.92, z0 * 0.92), 'pipe', smooth=True)


def pipe(b, lod):
    """落水管：1m 一段，竖的"""
    b.cyl((0, 0, 0), (0, 0, 1), 0.04, 'pipe', seg=10 if not lod else 6, caps=False)


CELLS = {
    'CAFE_WIN': cafe_win,
    'CAFE_DOOR': cafe_door,
    'SHOP_WIN': shop_win,
    'SOUVENIR': souvenir,
    'GLASS_SHOP': glass_shop,
    'FLOWER': flower,
    'NOREN': noren,
    'LATTICE': lattice,
    'SHUTTER': shutter,
    'GENKAN': genkan,
    'IZAKAYA': izakaya,
    'WALL_G': wall_g,
    'WIN_WOOD': win_wood,
    'WIN_ALU': win_alu,
    'WIN_LATTICE': win_lattice,
    'WALL_U': wall_u,
    'BALC_DOOR': balc_door,
    'WIN_SMALL': win_small,
    'WIN_TALL': win_tall,
    'WALL_AC': wall_ac,
    'SIDE_WIN': side_win,
    'SIDE_PIPE': side_pipe,
    'ridge': ridge,
    'ridge_end': ridge_end,
    'eave_tiles': eave_tiles,
    'gutter': gutter,
    'pipe': pipe,
}

# 光源（只在精细那一档挂；代码对两档用同一份）：位置在标准开间的坐标里
LIGHTS = {
    'CAFE_WIN': [((0, -0.9, 1.4), dict(color='#ffd9a8', intensity=3.5, radius=6.0, glow=0.0, hours=[7, 23]))],
    'CAFE_DOOR': [((0, -0.9, 1.4), dict(color='#ffd9a8', intensity=3.5, radius=6.0, glow=0.0, hours=[7, 23]))],
    'SHOP_WIN': [((0, -0.9, 1.4), dict(color='#fff0d8', intensity=3.5, radius=6.0, glow=0.0, hours=[7, 22]))],
    'SOUVENIR': [((0, -0.9, 1.4), dict(color='#fff0d8', intensity=3.5, radius=6.0, glow=0.0, hours=[7, 22]))],
    'GLASS_SHOP': [((0, -0.9, 1.4), dict(color='#fff4e6', intensity=3.5, radius=6.0, glow=0.0, hours=[7, 22]))],
    'FLOWER': [((0, -0.9, 1.4), dict(color='#fff4e6', intensity=3.5, radius=6.0, glow=0.0, hours=[7, 22]))],
    'NOREN': [((0, -0.7, 1.2), dict(color='#ffd8a0', intensity=3.0, radius=5.0, glow=0.0, hours=[11, 22]))],
    'IZAKAYA': [
        ((0.824, -0.3, 1.72), dict(color='#ff5a3c', intensity=2.0, radius=4.0, glow=0.55, glowGain=1.3, hours=[17, 1])),
        ((0, -0.7, 1.2), dict(color='#ffc080', intensity=3.0, radius=5.0, glow=0.0, hours=[17, 1])),
    ],
    'GENKAN': [((0.762, -0.2, 2.06), dict(color='#ffe2b0', intensity=1.4, radius=4.0, glow=0.35, hours=[17, 24]))],
}


def main():
    sc = fresh_scene('building_kit')
    objs = []
    for name, fn in CELLS.items():
        for lod in (0, 1):
            b = Builder(COLORS, SLOTS)
            if lod:
                b.box_faces = ['-y', '+z']
            fn(b, lod)
            if not b.bm.faces:
                b.bm.free()
                continue
            obj = b.finish(sc, name if lod == 0 else f'{name}_lod1')
            obj.data.set_sharp_from_angle(angle=math.radians(38))
            if lod == 0:
                for i, (pos, props) in enumerate(LIGHTS.get(name, [])):
                    anchor(sc, obj, f'light{i}', pos, **props)
            objs.append(obj)
    export(sc, OUT, objs)


# 被 hero_buildings.py import 的时候不跑（只借用上面的构件函数）
if __name__ == '__main__':
    main()
