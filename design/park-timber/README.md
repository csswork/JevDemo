# 公园木作

以现有公园的旧木色和尺度为基础，在 Blender 5.2.2 中重新建模。原 weathered_brown_planks 贴图文件保持原样；逐块选取木料内部区域，避免把照片中的板缝映射进单块家具。几何为本项目自行制作，无新增下载资产。

- 平台：约 14 cm 宽木板，1.5–2.4 m 左右的错缝接头，轻微倒角和小幅材色差异。
- 栈道：采样运行时相同曲线，近 18.2 m 木板按弯道切成适合的轮廓，准确裁掉与平台重叠的部分。更远处仍用原轻量路面。
- 桌凳：三块宽板、简洁斜撑脚和横撑；小凳改为三腿圆凳。
- 长椅：浅凹坐面、后倾靠背、弯曲铁架和木扶手，支架位于靠背后方。

同材质构件离线合并；近景路板按平台与三条道路分四个网格。没有额外灯光、反射或后处理。原几何用于加载失败回退及相机碰撞；模型成功加载后隐藏原可见表面。

重建：

```sh
node scripts/blender/sample_park_paths.mjs
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/park_timber.py
```

产物：本目录 `park-timber.blend` 为可编辑源文件，`public/scene/models/park/timber.glb` 为正式运行资源。`validation.json` 记录网格、面数及文件摘要。GLB 为 7 个网格、8 个材质 primitive、27,896 个三角形，约 1.50 MiB；两个长椅共享原型几何。

预览：`http://127.0.0.1:5678/design/park-timber/`，提供新旧模型和三个机位。预览复用正式 `createPark`；默认正式公园启用新模型。

检查：主应用构建与预览 TypeScript 检查通过；lint 无错误，有既有 motion-workbench 提示。GLB 的坐标、法线和 UV 均为有限数，每个 primitive 有顶点色，资源三角形低于 45,000 的预算。视觉检查覆盖栈道衔接、桌凳和长椅。运行统计仅用于同机位绘制成本对照，未进行 FPS/GPU 时间基准。
