# 潮汐咖啡馆 · 参考图精细建模

用户明确要求参照 `reference/user-cafe.png` 改用 Blender 精细建模。上一版草模不作为最终成果，原记录存入 `previous-concept/`。

## 实际成果

- 可编辑、已打包纹理的源文件：`blender/tide-cafe.blend`。
- 建模脚本：项目根目录 `scripts/blender/anime_cafe_room.py`。
- 实际主图、窗边座位、收银台、纵深座位区：`renders/blender-*.png`。
- 几何审计：`blender/geometry-audit.json`，含真实结构开口与逐对象评估三角形数量。
- 生成记录、机位与同源灯具清单：`blender/authoring-metadata.json`。
- 参考图和本地制作的菜单、植物装饰画保存在包内。

## 重建

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/anime_cafe_room.py -- --one main
```

完整四机位省略 `--one main`。`--quick` 用于迭代检查。`--all` 增加四角、三天花视角与真实舞台机位。

用 `blender/render_reviews.py` 从保存的 `.blend` 渲染任意命名机位，不需重新生成几何。`blender/audit_source.py` 评估最终网格与开口。

## 当前阶段

用户以“看起来不错，加入场景列表看看”确认当前外观并授权本地集成。背景列表已加入“潮汐咖啡馆”（`animeCafe`）。高精度与精简备用 GLB 在 `public/scene/models/anime_cafe/`，同源灯具清单由浏览器加载。运行时使用独立可复用的 PBR 纹理、原始菜单/装饰画 UV 与实时光照；已弃用造成脏斑与串色的整室图集。20 个独立碰撞体保留真实门窗和拱门开口。

门窗使用 `glass.ts` 的粗糙物理透射玻璃，保留折射与反射，将外景细节模糊；甜点柜复用街景的清透玻璃着色器，并单独降低及限制反射亮度。菜单为中文，原本空白的背面墙补有木墙裙、植物画和欢迎牌。

`align_cafe_structure.py` 根据四个真实门窗洞口之间的墙垛统一设置五排柱梁，窗框收进洞口，并移除横穿玻璃的墙裙压条。`audit_cafe_structure.py` 对实际评估网格和实体墙射线做验证，记录在 `blender/structure-alignment.json`；五根窗侧立柱均由实体墙支撑，柱脚到梁底高度一致。`refine_cafe_joinery.py` 分别制作固定上亮窗、独立门扇、嵌入玻璃和内外把手。

`refine_cafe_exterior.py` 将窗外整理为三组完整树冠、带海岸地面的六栋有门窗和坡屋顶的建筑。主建模脚本调用这些修订，重建不会恢复散乱叶片或遮挡窗洞的旧柱位。

运行时导出：`scripts/blender/export_anime_cafe.py`。导出哈希、实际 GLB 验证和实机截图在 `runtime/`。本地构建及 lint 通过；尚未部署。预算为零，全部本地建模。技能通用验证器的强制 Meshy 预算字段与此方案冲突，如实保留校验失败，不将它标记为完整技能门禁通过。

门口 A 字迎宾牌已增加双面中文今日推荐、咖啡杯与植物粉笔画及八枚黄铜固定件。`decorate_cafe_entrance.py` 从现有木板的实际变换定位装饰面，主建模脚本也调用此修订。实际运行时截图：`runtime/entrance-sign-preview.png`。

靠垫与座位修订：`refine_cafe_seating.py` 生成鼓起的亚麻布靠垫及缝边，以实际网格测量坐垫、靠背接触；椅子按各自桌面定位和朝向。球形树冠和旧树干从 Blender 源文件移除，实际咖啡馆复用街景 `createTreeMaker` 与第三方 `@dgreenheck/ez-tree`（MIT）的 Ash/Oak 树种、树皮/叶片贴图和风动材质，在运行时添加三棵树；这三棵树不包含在房间 GLB 三角形/纹理预算统计中。实机截图：`runtime/seating-preview.png`、`runtime/street-trees-preview.png`。
