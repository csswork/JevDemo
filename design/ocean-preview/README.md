# 双层 FFT 海洋组件

预览：http://127.0.0.1:5678/sky-preview/ 。默认双层 FFT，正式街景已接入，调试面板下方“天空与海洋”共用 Save。海洋控制提供 128² / 256² 波场、上一版解析波浪和原街景海洋对照。

## 接口

`createOceanRenderer({ y, shore: {map,bounds,max}, breakwater, reflectionLayer, shoreAnchor?, waveDirection? })`

- 将 group 加入场景；每帧先 update(timeState,dt,camera,{sun,moon})，再 renderSimulation(renderer)、renderReflection(renderer,scene,camera)，最后渲染主画面。
- setParameters({waves,roughness,foam,reflection,glitter})，默认 .55/.28/.32/.88/.60。
- setResolution(128|256) 重建并释放旧波场；simulationStats 提供分辨率、纹理预算和模拟绘制次数。
- setPaused(boolean) 冻结波场与泡沫；冻结后若波浪强度没有变化，会跳过模拟。
- setQuality('low'|'balanced'|'high') 控制反射分辨率 .30/.50/.75，单轴上限 1024。
- setWind(degrees,speed) 沿用泡沫细纹风移控制。主波谱方向由岸线决定，不随天空风向旋转。
- dispose() 释放自有纹理、目标、几何和材质；调用方原始岸线纹理由调用方拥有。

## 波场

192m 涌浪层和 23m 细浪层按 6m 波长分界。CPU 初始化固定种子 JONSWAP/TMA 波谱，GPU 推进色散相位并执行二维逆 FFT。一次打包计算水平位移、高度、坡度和位移导数。

几何、反射畸变、菲涅耳和日月 GGX 高光共享波场；细节按几何间距和屏幕像素足迹采样 mip，减少远处闪烁。坡度法线使用位移雅可比的对角近似。完整交叉项法线、水下折射、浅水折射及浮力不在此版本范围内。

浪峰压缩触发泡沫历史缓冲，历史按位移差回溯、扩散并按实际 dt 衰减。岸边泡沫仍以岸线距离和连续推进函数近似，没有求解浅水波破碎。

主浪向是岸线距离图负梯度在 shoreAnchor 周围的加权方向，可用 waveDirection 覆盖。波谱围绕它分散；时间相位保证主要能量向岸传播。尚未处理每一段弯曲岸线的折射和反射。

## 成本和验证

近处网格 32,768 个三角形，远海 2 个。两个波场共用 FFT ping-pong 目标；频谱与中间场为 RGBA32F，结果和泡沫为 RGBA16F。含结果/泡沫 mip 的纹理预算约 3.51 MiB（128²）/14.03 MiB（256²），不含几何、反射和驱动开销。每次推进 34/38 次模拟绘制。反射强度为 0 时跳过反射，隐藏海洋时跳过模拟。

需要 WebGL2 的 EXT_color_buffer_float；保留解析版本用于不支持浮点目标的平台。默认 128²，256² 可在预览直接切换。

“验证波场”使用单频、无水平位移的 GPU 波场，检查128²/256² 两档、两个时刻、20 个点的高度、坡度及传播符号，读回仅在验证时执行。高度容差 .002m，坡度容差 .0001。TypeScript 和 oxlint 检查通过。

“性能对比”固定当前天空、镜头与场景时间，海浪以 1/60 秒推进。每档预热 16 帧、采样 48 帧。GPU 查询覆盖 FFT、镜面反射、天空云及主画面；CPU 指标为这段渲染提交时间，不包含街景动画更新。测量过程中冻结正常动画循环，最后恢复原算法、分辨率和暂停状态。GPU 查询不可用或发生 disjoint 时不报告无效数据。测量应在海洋和街景显示状态下运行；性能受视角、设备、温度和驱动影响，单轮结果不能用于保证帧率。

## 来源

打包频谱字段和蝶形布局参考并改编自 [abyssal-ocean](https://github.com/squall01337/abyssal-ocean)，Copyright (c) 2026 Sacha (@squall01337)，MIT；完整声明见 ABYSSAL-LICENSE.txt。沿用本项目天空、时间、岸线和镜面反射接口，没有移植其独立天空、SSR 或整套后处理。

本机 1280×720、15:00、波光视角、均衡反射，48 个有效 GPU 样本的复测中位数：解析版 3.066ms，FFT128 3.800ms，FFT256 3.738ms；CPU 提交分别 1.9/2.3/3.0ms。两档 GPU 差距小于本次测量波动，不能据此认定 256 更快。报告保存在 fft-benchmark-final.json。默认 128 以限制内存与 CPU 提交开销。此数据不是帧率保证。

代码已移入 `src/vrm/ocean/`；本目录的 TS 模块重新导出生产实现，避免预览和正式街景分叉。
