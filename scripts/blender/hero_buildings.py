"""
她身边那 8 栋房子（src/vrm/scenes/street.ts 照着摆）：整栋在 Blender 里精建，导出一个 GLB，每栋一个物体（名字 = heroSpecs.json 里的 id）。

    blender -b --factory-startup -P scripts/blender/hero_buildings.py

输出 public/scene/models/hero/hero.glb。规格（宽、进深、每层每个开间的格子、屋顶、遮阳篷、招牌……）读
src/vrm/scenes/kit/heroSpecs.json，和代码共用；立面上每一格的构件借 building_kit.py 的（同一套窗、门、暖帘……）。

比代码拼的房子多的东西：
  墙      有厚度的窗洞（窗套）、一楼墙根的石台基、楼层之间一道腰线、墙角的护角
  屋顶    檐口那几排瓦是真的一片片起伏的瓦（再往上交给贴图）；檐下露出一根根椽子和封檐板；屋脊、鬼瓦、瓦当、檐沟、落水管
  每栋自己的东西：咖啡店遮阳篷下一串小灯泡、门两边的壁灯、阳台上的花和桌椅；陶器店门口摆陶器的长凳；住家的自行车和二楼的晾衣杆；
          土特产店的扭蛋机；三层小楼屋顶的水箱和天线；居酒屋檐下一串小灯笼和啤酒箱；花店门口的花桶；格子门住家的石灯笼和盆景
  招牌    木框（字还是代码画的 canvas，位置和代码算的一样），上面两盏照招牌的小灯

坐标（Blender）：x 沿着路、门脸在 y = 0（街在 -Y，three.js 里是 +Z），房子往 +Y 进深，z 朝上；原点在门脸中点的地面。
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import building_kit as K  # noqa: E402
from kit_common import MODELS, REPO, Builder, anchor, export, fresh_scene  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

OUT = os.path.join(MODELS, 'hero', 'hero.glb')
HERO = json.load(open(os.path.join(REPO, 'src', 'vrm', 'scenes', 'kit', 'heroSpecs.json')))['buildings']
GH, UH = 3.2, 2.9
OV, SO = 0.6, 0.35
T = Matrix.Translation
R = Matrix.Rotation
S = lambda x, y, z: Matrix.Diagonal((x, y, z, 1))  # noqa: E731

BASE_COLORS = {
    **K.COLORS,
    'stone': '#a59f95',
    'stone_dark': '#8c867c',
    'cornice': '#e2dccf',
    'corner': '#d9d2c4',
    'fascia': '#5a4436',
    'rafter': '#6e5544',
    'soffit': '#c9b398',
    'bulb': '#ffe2a8',
    'sign_frame': '#6e5544',
    'chair': '#2e3236',
    'bike': '#2f6db0',
    'tire': '#1c1c1e',
    'cloth_a': '#f3f1ea',
    'cloth_b': '#8fb3d9',
    'cloth_c': '#e6a7a0',
    'gacha_a': '#e8433a',
    'gacha_b': '#2f8fd8',
    'gacha_c': '#f2c230',
    'gacha_dome': '#f4f6f8',
    'crate': '#d8a020',
    'barrel': '#8a5a34',
    'bucket': '#9aa3ab',
    'bonsai': '#3f6e34',
    'stone_lantern': '#9c968c',
    'tank': '#e2e4e2',
    'antenna': '#9a9ea3',
    'coping': '#c8c4bb',
    'roof_flat': '#a9a69f',
}
BASE_SLOTS = {
    **K.SLOTS,
    'stone': 'concrete',
    'stone_dark': 'concrete',
    'fascia': 'wood',
    'rafter': 'wood',
    'soffit': 'wood',
    'sign_frame': 'wood',
    'bulb': 'glow',
    'chair': 'metal',
    'bike': 'metal',
    'gacha_dome': 'glow',
    'barrel': 'wood',
    'bucket': 'metal',
    'antenna': 'metal',
    'coping': 'concrete',
    'stone_lantern': 'concrete',
}


def darker(hex_color, k):
    h = hex_color.lstrip('#')
    r, g, b = (int(h[i : i + 2], 16) for i in (0, 2, 4))
    return '#%02x%02x%02x' % (int(r * k), int(g * k), int(b * k))


def hole_of(name, bw, ya, yb):
    m = K.SPEC['modules'].get(name)
    if not m or not m.get('hole'):
        return None
    u0, v0, u1, v1 = m['hole']
    return (-bw / 2 + u0 * bw, ya + v0 * (yb - ya), -bw / 2 + u1 * bw, ya + v1 * (yb - ya))


class Hero:
    def __init__(self, spec, sc):
        self.h = spec
        self.sc = sc
        self.w = spec['w']
        self.hw = spec['w'] / 2
        self.d = spec['depth']
        self.floors = 1 + len(spec['upper'])
        self.H = GH + UH * len(spec['upper'])
        self.bays = len(spec['ground'])
        self.bw = self.w / self.bays
        colors = dict(BASE_COLORS)
        slots = dict(BASE_SLOTS)
        colors['plaster'] = spec['tint']
        colors['plaster_shade'] = darker(spec['tint'], 0.88)
        slots['plaster'] = 'plaster'
        slots['plaster_shade'] = 'plaster'
        colors['tile'] = spec['roofTint']
        colors['tile_dark'] = darker(spec['roofTint'], 0.62)
        colors['awning'] = spec.get('awning', '#2c3350')
        colors['awning_dark'] = darker(colors['awning'], 0.8)
        slots['awning'] = 'fabric'
        slots['awning_dark'] = 'fabric'
        self.b = Builder(colors, slots)
        self.lights = []

    def light(self, pos, **props):
        self.lights.append((pos, props))

    # ---------------------------------------------------------- 墙
    def wall(self, origin, X, length, ya, yb, holes, color='plaster', depth=0.18):
        """一面墙的一层：origin = 这一段墙的中点（墙根），X = 沿墙的方向（从外面看从左到右），holes = [(x0, z0, x1, z1)]（沿墙的局部坐标）"""
        b = self.b
        O = Vector(origin)
        Xv = Vector(X)
        Z = Vector((0, 0, 1))
        out = Xv.cross(Z)  # 朝外
        p = lambda u, z, dd=0.0: O + Xv * u + Z * z - out * dd  # noqa: E731
        h2 = length / 2
        holes = sorted(holes, key=lambda r: r[0])
        # 竖着切成一条条：洞那一列只剩洞的上下两块
        xs = [-h2]
        for x0, z0, x1, z1 in holes:
            xs += [x0, x1]
        xs.append(h2)
        cols = []
        for i in range(len(xs) - 1):
            cols.append((xs[i], xs[i + 1], holes[i // 2] if i % 2 == 1 else None))
        for a, c, hole in cols:
            if c - a < 1e-3:
                continue
            if hole is None:
                b.quad(p(a, ya), p(c, ya), p(c, yb), p(a, yb), color)
            else:
                _, z0, _, z1 = hole
                if z0 - ya > 1e-3:
                    b.quad(p(a, ya), p(c, ya), p(c, z0), p(a, z0), color)
                if yb - z1 > 1e-3:
                    b.quad(p(a, z1), p(c, z1), p(c, yb), p(a, yb), color)
        # 窗套（洞口四个内侧面）
        for x0, z0, x1, z1 in holes:
            if z0 > ya + 0.01:
                b.quad(p(x0, z0), p(x1, z0), p(x1, z0, depth), p(x0, z0, depth), 'plaster_shade')
            b.quad(p(x0, z1, depth), p(x1, z1, depth), p(x1, z1), p(x0, z1), 'plaster_shade')
            b.quad(p(x0, z0), p(x0, z0, depth), p(x0, z1, depth), p(x0, z1), 'plaster_shade')
            b.quad(p(x1, z0, depth), p(x1, z0), p(x1, z1), p(x1, z1, depth), 'plaster_shade')

    def walls(self):
        h, b, hw, d = self.h, self.b, self.hw, self.d
        for f in range(self.floors):
            ya = 0 if f == 0 else GH + UH * (f - 1)
            yb = GH if f == 0 else ya + UH
            cells = h['ground'] if f == 0 else h['upper'][f - 1]
            holes = []
            for i in range(self.bays):
                cell = cells[i % len(cells)]
                cx = -hw + (i + 0.5) * self.bw
                r = hole_of(cell, self.bw, ya, yb)
                if r:
                    holes.append((cx + r[0], r[1], cx + r[2], r[3]))
                # 构件（借 building_kit 的）：按开间缩放
                fn = K.CELLS.get(cell)
                if fn:
                    H0 = GH if K.SPEC['modules'][cell]['floor'] == 'ground' else UH
                    with b.at(T((cx, 0, ya)) @ S(self.bw / K.CW, 1, (yb - ya) / H0)):
                        fn(b, 0)
                    if f == 0 and not h.get('interior'):
                        for pos, props in K.LIGHTS.get(cell, []):
                            self.light((cx + pos[0] * self.bw / K.CW, pos[1], ya + pos[2]), **props)
            self.wall((0, 0, 0), (1, 0, 0), self.w, ya, yb, holes)
            # 侧墙：一楼素墙；楼上每边一扇小窗（毛玻璃）
            for side in (1, -1):
                sh = []
                if f > 0:
                    sh = [(-0.35 + side * 0.9, ya + 1.0, 0.35 + side * 0.9, ya + 1.75)]
                    with b.at(T((side * hw, d / 2, 0)) @ R(side * math.pi / 2, 4, 'Z') @ T((side * 0.9, 0, 0))):
                        K.frame(b, -0.35, 0.35, ya + 1.0, ya + 1.75, 'alu', 0.04)
                        b.quad((-0.35, K.D - 0.005, ya + 1.0), (0.35, K.D - 0.005, ya + 1.0), (0.35, K.D - 0.005, ya + 1.75), (-0.35, K.D - 0.005, ya + 1.75), 'frost_cool')
                self.wall((side * hw, d / 2, 0), (0, side, 0), d, ya, yb, sh)
            self.wall((0, d, 0), (-1, 0, 0), self.w, ya, yb, [])
        # 石台基（一楼墙根）、腰线、墙角的护角
        gh = h['ground']
        for i in range(self.bays):
            cx = -hw + (i + 0.5) * self.bw
            r = hole_of(gh[i], self.bw, 0, GH)
            segs = [(-self.bw / 2, self.bw / 2)]
            if r and r[1] < 0.3:
                segs = [(-self.bw / 2, r[0]), (r[2], self.bw / 2)]
            for a, c in segs:
                if c - a > 0.02:
                    b.box(cx + a, -0.03, 0, cx + c, 0.01, 0.3, 'stone')
        for side in (1, -1):
            b.box(side * hw - 0.01 if side > 0 else -hw - 0.03, 0.0, 0, side * hw + 0.03 if side > 0 else -hw + 0.01, d, 0.3, 'stone')
        for f in range(1, self.floors):
            z = GH + UH * (f - 1)
            b.box(-hw - 0.03, -0.05, z - 0.08, hw + 0.03, 0.0, z + 0.04, 'cornice')
        for x in (-hw, hw):
            b.box(x - 0.04, -0.04, 0.3, x + 0.04, 0.04, self.H, 'corner')

    # ---------------------------------------------------------- 屋顶
    def slab(self, pts, t=0.12, rafters=True):
        """带厚度的瓦面：pts = 顶面的角（从上往下看逆时针，第一条边是檐口）；檐下的椽子、封檐板"""
        b = self.b
        P = [Vector(q) for q in pts]
        n = (P[1] - P[0]).cross(P[2] - P[0]).normalized()
        top = [b.v(q) for q in P]
        b.face(top, 'tile')
        low = [q - n * t for q in P]
        lowv = [b.v(q) for q in low]
        b.face(list(reversed(lowv)), 'soffit')
        k = len(P)
        for i in range(k):
            j = (i + 1) % k
            b.face([b.v(low[i]), b.v(low[j]), b.v(P[j]), b.v(P[i])], 'fascia')
        if rafters:
            # 檐口下面一根根椽子（从墙伸到檐口）：每 0.45m 一根，在檐底板下面
            e0, e1 = P[0], P[1]
            L = (e1 - e0).length
            ex = (e1 - e0).normalized()
            up = (P[-1] - P[0])
            up = (up - ex * up.dot(ex)).normalized()
            m = int(L / 0.45)
            for s in range(1, m):
                a = e0 + ex * (s * L / m) - n * (t + 0.005)
                c = a + up * OV * 1.05
                self.beam(a, c, 0.04, 0.07, 'rafter', n)

    def beam(self, a, c, w, hgt, color, nrm):
        """a → c 的一根方木（截面 w × hgt，hgt 沿 -nrm 往下）"""
        b = self.b
        a, c = Vector(a), Vector(c)
        ax = (c - a).normalized()
        side = ax.cross(nrm).normalized() * (w / 2)
        dn = -nrm * hgt
        q = [a - side, a + side, c + side, c - side]
        qv = [b.v(x) for x in q]
        qd = [b.v(x + dn) for x in q]
        b.face(qv, color)
        b.face(list(reversed(qd)), color)
        for i in range(4):
            j = (i + 1) % 4
            b.face([qv[j], qv[i], qd[i], qd[j]], color)

    def tile_band(self, e0, e1, up, nrm, rows=3, row=0.3):
        """檐口那几排真的瓦：沿檐口一道道波浪（桟瓦），每排压着下一排，从檐口往上 rows 排"""
        b = self.b
        e0, e1, up, nrm = Vector(e0), Vector(e1), Vector(up).normalized(), Vector(nrm).normalized()
        L = (e1 - e0).length
        ex = (e1 - e0).normalized()
        wave = 0.3
        nu = max(2, int(L / (wave / 4)))
        for r_ in range(rows):
            v0 = r_ * row
            v1 = v0 + row + 0.02
            pts0, pts1 = [], []
            for i in range(nu + 1):
                u = i * L / nu
                hgt = 0.028 * math.sin(2 * math.pi * u / wave) + 0.03
                base = e0 + ex * u
                pts0.append(b.v(base + up * v0 + nrm * (hgt + 0.012)))
                pts1.append(b.v(base + up * v1 + nrm * (hgt * 0.6 + 0.002)))
            for i in range(nu):
                b.face((pts0[i], pts0[i + 1], pts1[i + 1], pts1[i]), 'tile', smooth=True)
            # 瓦的下沿（一道立面）
            for i in range(nu):
                b0 = Vector(pts0[i].co)
                b1 = Vector(pts0[i + 1].co)
                d0 = b.bm.verts.new(b0 - nrm * 0.03)
                d1 = b.bm.verts.new(b1 - nrm * 0.03)
                b.face((d0, d1, pts0[i + 1], pts0[i]), 'tile_dark')

    def part(self, fn, M):
        with self.b.at(M):
            fn(self.b, 0)

    def run(self, fn, mid, length, out, pitch=0.0):
        """沿一条线排 1m 一段的零件（和 street.ts 的 runAlong 一样）：out = 朝外的水平方向"""
        out = Vector(out)
        Z = Vector((0, 0, 1))
        X = out.cross(Z) * -1  # 沿着线（从外面看从左到右）
        X = Z.cross(out)
        n = max(1, round(length))
        for k in range(n):
            c = Vector(mid) + X * (-length / 2 + (k + 0.5) * length / n)
            basis = Matrix((X.to_4d(), (-out).to_4d(), Z.to_4d(), (0, 0, 0, 1))).transposed()
            basis[0][3], basis[1][3], basis[2][3] = c.x, c.y, c.z
            self.part(fn, basis @ R(-pitch, 4, 'X') @ S(length / n, 1, 1))

    def ridge(self, mid, length, out):
        self.run(K.ridge, mid, length, out)
        out = Vector(out)
        Z = Vector((0, 0, 1))
        X = Z.cross(out)
        for sgn in (1, -1):
            c = Vector(mid) + X * (sgn * length / 2)
            Xs = X * sgn
            o = out * sgn
            basis = Matrix((Xs.to_4d(), (-o).to_4d(), Z.to_4d(), (0, 0, 0, 1))).transposed()
            basis[0][3], basis[1][3], basis[2][3] = c.x, c.y, c.z
            self.part(K.ridge_end, basis)

    def eave(self, mid, length, out, pitch, gutter=True):
        self.run(K.eave_tiles, mid, length, out, pitch)
        if gutter:
            m = Vector(mid) + Vector(out) * 0.03
            m.z -= 0.15
            self.run(K.gutter, m, length, out)

    def pipe(self, x, y, top):
        self.part(K.pipe, T((x, y, 0)) @ S(1, 1, top))

    def gable(self, p0, p1, p2):
        b = self.b
        b.face([b.v(p0), b.v(p1), b.v(p2)], 'plaster')

    def roof(self):
        h, hw, d, H = self.h, self.hw, self.d, self.H
        pitch = math.radians(h.get('pitch', 24))
        tan = math.tan(pitch)
        kind = h['roof']
        ye = H - OV * tan
        if kind == 'hira' or (kind == 'yose' and self.w < d):
            yr = H + (d / 2) * tan
            front = [(-hw - SO, -OV, ye), (hw + SO, -OV, ye), (hw + SO, d / 2, yr), (-hw - SO, d / 2, yr)]
            back = [(hw + SO, d + OV, ye), (-hw - SO, d + OV, ye), (-hw - SO, d / 2, yr), (hw + SO, d / 2, yr)]
            for pts, o in ((front, (0, -1, 0)), (back, (0, 1, 0))):
                self.slab(pts)
                e0, e1, up = Vector(pts[0]), Vector(pts[1]), Vector(pts[3]) - Vector(pts[0])
                nrm = (e1 - e0).cross(up).normalized()
                self.tile_band(e0, e1, up, nrm)
                self.eave(((e0 + e1) / 2).to_tuple(), (e1 - e0).length, o, pitch, o[1] < 0)
            self.gable((hw, 0, H), (hw, d, H), (hw, d / 2, yr))
            self.gable((-hw, d, H), (-hw, 0, H), (-hw, d / 2, yr))
            self.ridge((0, d / 2, yr - 0.04), self.w + 2 * SO, (0, -1, 0))
            for x in (-hw + 0.12, hw - 0.12):
                self.pipe(x, -0.07, ye - 0.15)
        elif kind == 'tsuma':
            yr = H + hw * tan
            right = [(hw + OV, d + SO, ye), (hw + OV, -SO, ye), (0, -SO, yr), (0, d + SO, yr)]
            left = [(-hw - OV, -SO, ye), (-hw - OV, d + SO, ye), (0, d + SO, yr), (0, -SO, yr)]
            for pts, o in ((right, (1, 0, 0)), (left, (-1, 0, 0))):
                self.slab(pts)
                e0, e1, up = Vector(pts[0]), Vector(pts[1]), Vector(pts[3]) - Vector(pts[0])
                nrm = (e1 - e0).cross(up).normalized()
                self.tile_band(e0, e1, up, nrm)
                self.eave(((e0 + e1) / 2).to_tuple(), (e1 - e0).length, o, pitch, True)
            self.gable((-hw, 0, H), (hw, 0, H), (0, 0, yr))
            self.gable((hw, d, H), (-hw, d, H), (0, d, yr))
            self.ridge((0, d / 2, yr - 0.04), d + 2 * SO, (1, 0, 0))
            # 山墙朝街：两条深色的破风板 + 顶上一个悬鱼
            b = self.b
            for sx in (1, -1):
                a = Vector((sx * (hw + OV), -SO - 0.03, ye + 0.04))
                c = Vector((0, -SO - 0.03, yr + 0.08))
                self.beam(a, c, 0.06, 0.24, 'fascia', Vector((0, -1, 0)).cross((c - a).normalized()).normalized() * -1)
            b.box(-0.12, -SO - 0.08, yr - 0.45, 0.12, -SO - 0.02, yr - 0.05, 'fascia')
            for sx in (1, -1):
                self.pipe(sx * (hw + 0.05), 0.12, ye - 0.15)
        elif kind == 'yose':
            yr = H + (d / 2) * tan
            xr = hw - d / 2
            El, Er = -hw - OV, hw + OV
            slabs = [
                ([(El, -OV, ye), (Er, -OV, ye), (xr, d / 2, yr), (-xr, d / 2, yr)], (0, -1, 0)),
                ([(Er, d + OV, ye), (El, d + OV, ye), (-xr, d / 2, yr), (xr, d / 2, yr)], (0, 1, 0)),
                ([(Er, -OV, ye), (Er, d + OV, ye), (xr, d / 2, yr)], (1, 0, 0)),
                ([(El, d + OV, ye), (El, -OV, ye), (-xr, d / 2, yr)], (-1, 0, 0)),
            ]
            for pts, o in slabs:
                self.slab(pts)
                e0, e1 = Vector(pts[0]), Vector(pts[1])
                apex = Vector(pts[2]) if len(pts) == 3 else Vector(pts[3])
                up = apex - e0
                nrm = (e1 - e0).cross(up).normalized()
                if o[1] != 0:
                    self.tile_band(e0, e1, up, nrm, rows=2)
                self.eave(((e0 + e1) / 2).to_tuple(), (e1 - e0).length, o, pitch, o[1] < 0)
            if xr > 0.05:
                self.ridge((0, d / 2, yr - 0.04), 2 * xr, (0, -1, 0))
            for x in (-hw + 0.12, hw - 0.12):
                self.pipe(x, -0.07, ye - 0.15)
        else:
            # 平顶：顶面、女儿墙（压顶）、水箱、空调外机、天线
            b = self.b
            b.box(-hw, 0, H, hw, d, H + 0.02, 'roof_flat')
            for x0, y0, x1, y1 in ((-hw - 0.05, -0.05, hw + 0.05, 0.15), (-hw - 0.05, d - 0.15, hw + 0.05, d + 0.05), (-hw - 0.05, 0, -hw + 0.15, d), (hw - 0.15, 0, hw + 0.05, d)):
                b.box(x0, y0, H, x1, y1, H + 0.55, 'plaster')
                b.box(x0 - 0.02, y0 - 0.02, H + 0.55, x1 + 0.02, y1 + 0.02, H + 0.6, 'coping')
            tx, ty = hw - 1.6, d - 1.6
            for dx in (-0.5, 0.5):
                for dy in (-0.5, 0.5):
                    b.box(tx + dx - 0.04, ty + dy - 0.04, H, tx + dx + 0.04, ty + dy + 0.04, H + 0.6, 'steel')
            with b.at(T((tx, ty, H + 0.6))):
                b.lathe([(0.0, 0), (0.62, 0.0), (0.65, 0.05), (0.65, 0.95), (0.6, 1.02), (0.0, 1.1)], 'tank', seg=20)
            for k in range(2):
                b.box(-hw + 0.6 + k * 1.1, 2.0, H + 0.02, -hw + 1.4 + k * 1.1, 2.3, H + 0.6, 'ac')
                with b.at(T((-hw + 0.85 + k * 1.1, 1.995, H + 0.31)) @ R(math.pi / 2, 4, 'X')):
                    b.cyl((0, 0, 0), (0, 0, 0.004), 0.2, 'ac_dark', seg=16)
            b.cyl((-hw + 0.5, d - 0.8, H), (-hw + 0.5, d - 0.8, H + 2.6), 0.025, 'antenna', seg=6)
            for k in range(5):
                z = H + 1.8 + k * 0.14
                b.box(-hw + 0.5 - 0.35 + k * 0.03, d - 0.82, z, -hw + 0.5 + 0.35 - k * 0.03, d - 0.78, z + 0.015, 'antenna')
            self.pipe(hw - 0.12, -0.07, H)

    # ---------------------------------------------------------- 一楼上面：小瓦檐、遮阳篷、阳台、招牌
    def hisashi(self):
        hw = self.hw
        yb = GH - 0.05
        pts = [(-hw - 0.05, -0.95, yb - 0.3), (hw + 0.05, -0.95, yb - 0.3), (hw + 0.05, 0, yb + 0.12), (-hw - 0.05, 0, yb + 0.12)]
        self.slab(pts, 0.08, rafters=False)
        e0, e1, up = Vector(pts[0]), Vector(pts[1]), Vector(pts[3]) - Vector(pts[0])
        nrm = (e1 - e0).cross(up).normalized()
        self.tile_band(e0, e1, up, nrm, rows=3, row=0.32)
        self.run(K.eave_tiles, ((e0 + e1) / 2).to_tuple(), (e1 - e0).length, (0, -1, 0), math.atan2(0.42, 0.95))
        # 托架：每 1.5m 一个三角的木托
        b = self.b
        n = max(2, int(self.w / 1.5))
        for i in range(n + 1):
            x = -hw + 0.1 + i * (self.w - 0.2) / n
            b.prism([(0.0, yb - 0.55), (-0.0, yb - 0.08), (-0.75, yb - 0.25)], x - 0.03, x + 0.03, 'fascia') if False else None
            self.beam((x, -0.01, yb - 0.55), (x, -0.8, yb - 0.27), 0.06, 0.08, 'fascia', Vector((0, 0, 1)))

    def awning(self, lights=False):
        b, hw = self.b, self.hw
        top, low, out = GH - 0.12, GH - 0.72, 1.6
        xa, xb = -hw + 0.15, hw - 0.15
        b.quad((xa, -out, low), (xb, -out, low), (xb, 0, top), (xa, 0, top), 'awning')
        b.quad((xb, -out, low), (xa, -out, low), (xa, 0, top), (xb, 0, top), 'awning_dark')
        # 垂边：一个个半圆的波浪
        n = max(4, int((xb - xa) / 0.32))
        for i in range(n):
            a = xa + i * (xb - xa) / n
            c = a + (xb - xa) / n
            pts = [(a, -out, low)]
            for k in range(1, 6):
                t = k / 6
                pts.append((a + (c - a) * t, -out, low - 0.22 - 0.06 * math.sin(math.pi * t)))
            pts.append((c, -out, low))
            vs = [b.v(q) for q in pts]
            b.face(vs, 'awning')
            b.face(list(reversed([b.v(q) for q in pts])), 'awning_dark')
        b.box(xa, -out - 0.005, low - 0.025, xb, -out + 0.005, low, 'white')
        for x, s in ((xa, -1), (xb, 1)):
            tri = [(x, 0, top), (x, -out, low), (x, -out, low - 0.22), (x, 0, top - 0.2)]
            vs = [b.v(q) for q in tri]
            b.face(vs if s > 0 else list(reversed(vs)), 'awning_dark')
            b.face(list(reversed([b.v(q) for q in tri])) if s > 0 else [b.v(q) for q in tri], 'awning_dark')
        for x in (xa + 0.1, xb - 0.1):
            b.cyl((x, -0.02, low - 0.35), (x, -out + 0.05, low + 0.02), 0.015, 'iron', seg=6)
        if lights:
            # 遮阳篷前沿下面一串小灯泡（夜里亮），一段段垂下来
            m = int((xb - xa) / 0.35)
            prev = None
            for i in range(m + 1):
                x = xa + 0.1 + i * (xb - xa - 0.2) / m
                sag = 0.1 * math.sin(math.pi * ((i % 4) / 4))
                pnt = (x, -out + 0.12, low - 0.3 - sag)
                b.sphere(pnt, 0.03, 'bulb', seg=6, rings=4)
                if prev:
                    b.cyl(prev, pnt, 0.004, 'black', seg=3, caps=False)
                prev = pnt
            self.light((0, -out + 0.1, low - 0.4), color='#ffcf8a', intensity=0.0, radius=0.0, glow=0.0, hours=[17, 23])

    def balcony(self, i0, i1, cafe=False):
        b, hw, bw = self.b, self.hw, self.bw
        xa, xb = -hw + i0 * bw + 0.05, -hw + i1 * bw - 0.05
        yb, dd = GH, 0.95
        b.box(xa, -dd, yb - 0.12, xb, 0, yb, 'wood_mid')
        b.box(xa, -dd, yb + 0.92, xb, -dd + 0.06, yb + 1.0, 'wood_mid')
        b.box(xa, -dd + 0.01, yb + 0.05, xb, -dd + 0.05, yb + 0.1, 'wood_mid')
        for x in (xa, xb - 0.06):
            b.box(x, -dd, yb, x + 0.06, 0, yb + 1.0, 'wood_mid')
        x = xa + 0.12
        while x < xb - 0.06:
            b.box(x, -dd + 0.015, yb + 0.1, x + 0.035, -dd + 0.045, yb + 0.92, 'wood_mid')
            x += 0.13
        # 栏杆外挂的花箱
        for cx in (xa + 0.8, (xa + xb) / 2, xb - 0.8):
            with b.at(T((0, -dd - 0.02, yb + 0.8))):
                K.flowers(b, cx, 0.0, 0.7, 0)
        if cafe:
            # 一张小圆桌、两把椅子
            cx = (xa + xb) / 2 + 1.2
            with b.at(T((cx, -0.5, yb))):
                b.cyl((0, 0, 0), (0, 0, 0.7), 0.02, 'chair', seg=6)
                b.cyl((0, 0, 0.7), (0, 0, 0.72), 0.3, 'white', seg=16)
                b.cyl((0, 0, 0.0), (0, 0, 0.02), 0.2, 'chair', seg=12)
                for sx in (-1, 1):
                    with b.at(T((sx * 0.5, 0, 0))):
                        for dx in (-0.16, 0.16):
                            for dy in (-0.16, 0.16):
                                b.cyl((dx, dy, 0), (dx, dy, 0.45), 0.012, 'chair', seg=4, caps=False)
                        b.box(-0.2, -0.2, 0.43, 0.2, 0.2, 0.46, 'chair')
                        b.box(sx * 0.18, -0.2, 0.46, sx * 0.2, 0.2, 0.85, 'chair')

    def sign_frame(self, lamps=True):
        h, b = self.h, self.b
        sw = min(self.w - 0.6, 3.6)
        sy = GH + 0.12 if h.get('hisashi') else GH - 0.72
        z = 0.06 if h.get('hisashi') else 0.04
        b.box(-sw / 2 - 0.04, -(z - 0.01), sy - 0.04, sw / 2 + 0.04, 0.0, sy + sw / 4 + 0.04, 'sign_frame')
        if lamps:
            # 两盏照招牌的小灯（鹅颈臂）
            for sx in (-0.3, 0.3):
                x = sx * sw
                top = sy + sw / 4 + 0.05
                b.cyl((x, 0, top + 0.05), (x, -0.25, top + 0.25), 0.012, 'iron', seg=6)
                b.cyl((x, -0.25, top + 0.25), (x, -0.4, top + 0.18), 0.012, 'iron', seg=6)
                with b.at(T((x, -0.42, top + 0.16)) @ R(-0.9, 4, 'X')):
                    b.lathe([(0.0, 0.0), (0.05, 0.0), (0.07, 0.08), (0.0, 0.09)], 'iron', seg=10, close_bottom=False)
                    b.cyl((0, 0, -0.005), (0, 0, 0.001), 0.045, 'bulb', seg=10)
                self.light((x, -0.5, top + 0.05), color='#ffe0b0', intensity=1.2, radius=3.5, glow=0.3, glowGain=0.8, hours=[17, 23])

    # ---------------------------------------------------------- 每栋自己的东西
    def props(self):
        b, hw, i = self.b, self.hw, self.h['id']
        if i == 'cafe':
            # 门两边的壁灯
            door = 2
            cx = -hw + (door + 0.5) * self.bw
            for sx in (-1, 1):
                x = cx + sx * (self.bw / 2 + 0.05)
                b.box(x - 0.05, -0.03, 2.3, x + 0.05, 0.0, 2.45, 'iron')
                b.cyl((x, -0.03, 2.38), (x, -0.16, 2.38), 0.012, 'iron', seg=6)
                with b.at(T((x, -0.2, 2.26))):
                    b.lathe([(0.0, 0.0), (0.05, 0.0), (0.07, 0.06), (0.07, 0.18), (0.0, 0.2)], 'bulb', seg=10)
                    b.lathe([(0.075, 0.18), (0.09, 0.2), (0.0, 0.26)], 'iron', seg=10, close_bottom=False)
                self.light((x, -0.3, 2.35), color='#ffd090', intensity=2.0, radius=5.0, glow=0.4, hours=[16, 23])
            # 门口两盆橄榄树（盆 + 细树干 + 一团叶子）
            for x in (cx - self.bw / 2 - 0.45, cx + self.bw / 2 + 0.45):
                with b.at(T((x, -0.45, 0))):
                    b.cyl((0, 0, 0), (0, 0, 0.5), 0.22, 'white', r1=0.26, seg=12)
                    b.cyl((0, 0, 0.5), (0, 0, 1.3), 0.025, 'barrel', seg=6)
                    for k, (dx, dz) in enumerate(((0, 1.55), (-0.15, 1.4), (0.16, 1.45), (0.03, 1.75))):
                        b.sphere((dx, 0.02 * k, dz), 0.22 - 0.02 * k, 'leaf' if k % 2 else 'leaf_dark', seg=8, rings=5)
        elif i == 'pottery':
            # 门口一张长凳，摆着陶器
            with b.at(T((self.bw * 0.95, -0.55, 0))):
                b.box(-0.55, -0.18, 0.38, 0.55, 0.18, 0.43, 'wood_light')
                for x in (-0.48, 0.42):
                    b.box(x, -0.15, 0, x + 0.06, 0.15, 0.38, 'wood_mid')
                for k, x in enumerate((-0.4, -0.15, 0.1, 0.35)):
                    hgt = 0.12 + 0.05 * (k % 2)
                    with b.at(T((x, 0, 0.43))):
                        b.lathe([(0.0, 0), (0.07, 0.005), (0.09, hgt * 0.5), (0.05, hgt * 0.9), (0.06, hgt), (0.0, hgt)], ['terracotta', 'white', 'box_c', 'pot'][k], seg=10)
            # 门口的大陶缸
            with b.at(T((-self.bw * 0.95, -0.4, 0))):
                b.lathe([(0.0, 0), (0.18, 0.0), (0.28, 0.25), (0.26, 0.5), (0.2, 0.58), (0.22, 0.6), (0.0, 0.6)], 'pot', seg=14)
        elif i == 'house':
            # 一辆自行车靠着墙、门口几盆花、二楼的晾衣杆和衣服
            with b.at(T((1.6, -0.3, 0))):
                for x in (-0.5, 0.5):
                    b.torus((x, 0, 0.33), 0.3, 0.02, 'tire', seg=16, rseg=4, axis='y')
                for p, q in (((-0.5, 0, 0.33), (0.05, 0, 0.75)), ((0.05, 0, 0.75), (0.5, 0, 0.33)), ((-0.5, 0, 0.33), (0.0, 0, 0.33)), ((0.0, 0, 0.33), (0.05, 0, 0.75)), ((0.0, 0, 0.33), (-0.1, 0, 0.82)), ((0.5, 0, 0.33), (0.4, 0, 0.9))):
                    b.cyl(p, q, 0.016, 'bike', seg=5)
                b.box(-0.2, -0.08, 0.82, 0.0, 0.08, 0.86, 'black')
                b.cyl((0.3, -0.25, 0.92), (0.45, 0.25, 0.92), 0.012, 'steel', seg=5)
            for k, x in enumerate((-2.4, -2.05)):
                with b.at(T((x, -0.3, 0))):
                    b.cyl((0, 0, 0), (0, 0, 0.25), 0.12, 'terracotta', r1=0.15, seg=10)
                    b.sphere((0, 0, 0.36), 0.16, 'leaf', seg=8, rings=5)
                    b.sphere((0.05, -0.05, 0.47), 0.05, ['flower_pink', 'flower_yellow'][k], seg=6, rings=4)
            z = GH + 1.9
            for sx in (-1, 1):
                b.box(-1.5 + sx * 1.3 - 0.02, -0.55, z - 0.02, -1.5 + sx * 1.3 + 0.02, 0.0, z + 0.02, 'steel')
            b.cyl((-2.8, -0.5, z), (-0.2, -0.5, z), 0.015, 'steel', seg=6)
            for k, x in enumerate((-2.5, -2.0, -1.55, -1.05, -0.6)):
                hgt = 0.5 + 0.15 * (k % 2)
                b.box(x - 0.18, -0.505, z - hgt, x + 0.18, -0.495, z, ['cloth_a', 'cloth_b', 'cloth_c', 'cloth_a', 'cloth_b'][k])
        elif i == 'souvenir':
            # 扭蛋机：三台叠在门边，正面亮着
            with b.at(T((-self.hw + 0.55, -0.35, 0))):
                for k in range(3):
                    x = k * 0.42 - 0.42 + (self.bw * 0.5)
                    for lvl in range(2):
                        z0 = lvl * 0.62
                        col = ['gacha_a', 'gacha_b', 'gacha_c'][(k + lvl) % 3]
                        b.box(x - 0.19, -0.17, z0, x + 0.19, 0.17, z0 + 0.6, col)
                        b.box(x - 0.15, -0.175, z0 + 0.28, x + 0.15, -0.165, z0 + 0.56, 'gacha_dome')
                        b.cyl((x, -0.18, z0 + 0.15), (x, -0.2, z0 + 0.15), 0.05, 'steel', seg=10)
            self.light((-self.hw + 0.55 + self.bw * 0.5, -0.8, 0.9), color='#f4f8ff', intensity=1.5, radius=3.5, glow=0.5, glowGain=0.3, onAt=0.05)
        elif i == 'izakaya':
            # 小瓦檐下一串小红灯笼、门口的啤酒箱和酒桶
            n = 7
            for k in range(n):
                x = -self.hw + 0.4 + k * (self.w - 0.8) / (n - 1)
                with b.at(T((x, -0.75, GH - 0.72))):
                    b.cyl((0, 0, 0.22), (0, 0, 0.35), 0.004, 'black', seg=3, caps=False)
                    b.lathe([(0.05, 0.0), (0.075, 0.04), (0.085, 0.11), (0.075, 0.18), (0.05, 0.22)], 'lantern', seg=10)
            self.light((0, -0.85, GH - 0.65), color='#ff6a40', intensity=1.5, radius=4.0, glow=0.0, hours=[17, 1])
            with b.at(T((self.hw - 0.55, -0.4, 0))):
                for lvl in range(3):
                    b.box(-0.24, -0.17, lvl * 0.3, 0.24, 0.17, lvl * 0.3 + 0.28, 'crate')
                    for dx in (-0.12, 0.0, 0.12):
                        b.cyl((dx, -0.05, lvl * 0.3 + 0.28), (dx, -0.05, lvl * 0.3 + 0.33), 0.03, 'black', seg=6)
            with b.at(T((-self.hw + 0.45, -0.35, 0))):
                b.lathe([(0.0, 0), (0.22, 0.0), (0.26, 0.3), (0.22, 0.6), (0.0, 0.6)], 'barrel', seg=14)
                for z in (0.08, 0.3, 0.52):
                    b.torus((0, 0, z), 0.24 + 0.02 * math.sin(math.pi * z / 0.6), 0.012, 'iron', seg=14, rseg=4)
        elif i == 'flower':
            # 门口一排插满花的铁桶
            for k in range(6):
                x = -self.hw + 0.6 + k * 0.45
                with b.at(T((x, -1.25, 0))):
                    b.cyl((0, 0, 0), (0, 0, 0.32), 0.14, 'bucket', r1=0.17, seg=10)
                    for j in range(5):
                        a = j * 1.3 + k
                        dx, dy = 0.07 * math.cos(a), 0.07 * math.sin(a)
                        b.cyl((dx * 0.3, dy * 0.3, 0.3), (dx, dy, 0.62 + 0.05 * (j % 2)), 0.006, 'leaf_dark', seg=3, caps=False)
                        b.sphere((dx, dy, 0.65 + 0.05 * (j % 2)), 0.045, ['flower_pink', 'flower_yellow', 'flower_white', 'flower_red'][(j + k) % 4], seg=6, rings=4)
        elif i == 'lattice':
            # 石灯笼、盆景
            with b.at(T((self.hw - 0.7, -0.6, 0))):
                b.box(-0.18, -0.18, 0, 0.18, 0.18, 0.12, 'stone_lantern')
                b.cyl((0, 0, 0.12), (0, 0, 0.5), 0.07, 'stone_lantern', seg=8)
                b.box(-0.2, -0.2, 0.5, 0.2, 0.2, 0.56, 'stone_lantern')
                b.box(-0.14, -0.14, 0.56, 0.14, 0.14, 0.78, 'stone_lantern')
                b.box(-0.1, -0.145, 0.62, 0.1, -0.14, 0.72, 'lamp')
                b.prism([(-0.28, -0.28), (0.28, -0.28), (0.28, 0.28), (-0.28, 0.28)], 0.78, 0.84, 'stone_lantern')
                b.lathe([(0.25, 0.84), (0.0, 1.0)], 'stone_lantern', seg=4, close_bottom=False)
            self.light((self.hw - 0.7, -0.85, 0.67), color='#ffd090', intensity=0.8, radius=2.5, glow=0.25, hours=[18, 23])
            for k, x in enumerate((-self.hw + 2.4, -self.hw + 2.9)):
                with b.at(T((x, -0.35, 0))):
                    b.box(-0.18, -0.12, 0, 0.18, 0.12, 0.12, 'terracotta')
                    b.cyl((0, 0, 0.12), (0.05, 0, 0.35), 0.02, 'barrel', seg=5)
                    b.sphere((0.08, 0, 0.42), 0.14, 'bonsai', seg=8, rings=5, scale=(1.3, 1, 0.6))
                    b.sphere((-0.08, 0, 0.33), 0.1, 'bonsai', seg=8, rings=5, scale=(1.3, 1, 0.6))

    def build(self):
        h = self.h
        self.walls()
        self.roof()
        if h.get('hisashi'):
            self.hisashi()
        if h.get('awning'):
            self.awning(lights=h['id'] == 'cafe')
        if h.get('balcony'):
            self.balcony(*h['balcony'], cafe=h['id'] == 'cafe')
        if h.get('sign') is not None:
            self.sign_frame()
        self.props()
        obj = self.b.finish(self.sc, h['id'])
        obj.data.set_sharp_from_angle(angle=math.radians(38))
        for k, (pos, props) in enumerate(self.lights):
            anchor(self.sc, obj, f'light{k}', pos, **props)
        return obj


def main():
    sc = fresh_scene('hero_buildings')
    objs = [Hero(h, sc).build() for h in HERO]
    export(sc, OUT, objs)


if __name__ == '__main__':
    main()
