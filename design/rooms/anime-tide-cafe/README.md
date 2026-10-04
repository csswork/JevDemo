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

本轮是用户明确授权的参考图精细建模修订。Function/Form 保持待审阅，未伪造批准。尚未导出运行时 GLB、改动背景选择器或部署。预算为零，全部本地建模。技能通用验证器的强制 Meshy 预算字段与此方案冲突，如实保留校验失败。
