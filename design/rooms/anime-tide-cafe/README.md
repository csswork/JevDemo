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

用户以“看起来不错，加入场景列表看看”确认当前外观并授权本地集成。背景列表已加入“潮汐咖啡馆”（`animeCafe`）。高精度与精简备用 GLB 在 `public/scene/models/anime_cafe/`，同源灯具清单由浏览器加载。静态光影烘焙成三个共享图集，金属与玻璃使用实时材质；20 个独立碰撞体保留真实门窗和拱门开口。

运行时导出：`scripts/blender/export_anime_cafe.py`。导出哈希、实际 GLB 验证和实机截图在 `runtime/`。本地构建及 lint 通过；尚未部署。预算为零，全部本地建模。技能通用验证器的强制 Meshy 预算字段与此方案冲突，如实保留校验失败，不将它标记为完整技能门禁通过。
