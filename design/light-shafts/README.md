## 阴影体积光预览（three-good-godrays）

当前预览页默认使用 `three-good-godrays@0.12.1`，通过太阳阴影和场景深度进行体积采样。正式公园和预览共用 `src/vrm/godrays/parkGodrays.ts`。公园调试面板提供体积光参数，同一个 Save 将 `godrays` 写入 `public/scene-defaults/park.json`，同一服务下跨浏览器共用。可切换「树叶遮挡体积光 / 原光束面片 / 关闭光束」对比，三个模式共享后处理输出，避免比较时色调映射不同。

默认半分辨率、64 步、双边滤波；控件包括密度、亮度上限、距离衰减、采样数、分辨率、光色。FPS 为页面帧间隔统计，包含浏览器调度，不能作为 GPU 基准。PCF 阴影由库复制深度以兼容 Three.js r186 的比较采样。npm overrides 仅覆盖这两个包的 Three.js peer 版本；上游声明支持至 r182，目前已在本项目 r186 浏览器中验证，但其他设备仍需测试。

独立封装：`godrays.ts`，负责参数更新、resize 和销毁。复用现有主光及投影物；树叶的 alpha-test 与阴影覆盖范围决定效果细节。无需也不应再调整手工光束数量。预览 UI 参数仅在预览内生效。正式公园使用独立保存的配置，关闭时跳过后处理；切换场景会销毁后处理资源。

上游：https://github.com/Ameobea/three-good-godrays 。库许可证允许使用与修改，版权声明保留在依赖包 LICENSE。林下增强通过 `canopyScattering.ts` 对固定版本的采样着色器作带兼容性检查的扩展；未修改 node_modules。升级库需先通过兼容测试。

---

以下是旧光束组件的历史说明（正式公园已隐藏旧面片，数量和范围不再用于新体积光）：

# 林间光：可复用丁达尔效果

组件：`src/vrm/scenes/lightShafts.ts`。公园通过原 `sunlight.ts` 兼容出口使用它，尘埃仍单独绘制。预览地址 `http://127.0.0.1:5678/design/light-shafts/`，提供实时参数、三个预设、三个实景机位和开关。

```ts
import { createLightShafts } from './lightShafts';

const light = createLightShafts([
  { ground: [0, 0, -5], length: 16, width: 1.5, intensity: 0.8 },
], sunDirection, new THREE.Color(1, .92, .77), {
  intensity: .72, softness: .72, breakup: .58,
});
scene.add(light.mesh);
light.update(elapsedSeconds); // 每帧，绝对累计秒数
light.setParameters({ width: 1.3, speed: .2 });
light.setSunDirection(newDirection); // 世界坐标方向
light.setColor('#fff6e3');
const saved = light.getParameters(); // 独立 JSON 对象
light.setParameters(saved);
light.dispose(); // 场景卸载时；从父节点移除 mesh
```

参数：亮度 `intensity`、宽度倍率 `width`、边缘柔和度 `softness`、细束层次 `breakup`、柔雾比例 `haze`、流动速度 `speed`、向下扩散 `spread`、近景淡出距离 `nearFade`、远景淡出距离 `farFade`。数值有范围限制，非有限值忽略。速度改变保持相位连续，设为零时停在当前形态。光色、太阳方向和布置列表使用独立 setter；`setShafts` 供布置变化时调用，不应逐帧替换。

主要改进：每束固定朝向基底，避免顶点分别旋转造成扭曲；轴向视角有安全退化与淡出；非周期叶隙和细束噪声缓慢流动；散射亮度饱和限制及宽底光减少硬条纹；近远距离、顶部和落地处渐隐。

成本：15 束光共一次绘制、30 个三角形（旧版 1,440），不增加纹理、灯光、离屏目标或全屏通道。片元包含两次平滑二维噪声，透明覆盖仍会消耗像素处理时间；宽度和数量越大，开销越高。尚未做 GPU 时间/FPS 基准，不能由三角形减少推断帧率提升。

遮挡采用场景深度测试，不采样太阳阴影图。光束落点仍应布置在树冠间隙，深度相交不具备体积软交界。预览调参只影响当前页面；正式公园的「调试 → 丁达尔光束」支持实时调整，Save 通过现有场景配置接口写入 `public/scene-defaults/park.json` 的 `lightShafts` 字段。重新加载或切换场景会读取各场景文件，同一服务下跨浏览器共用；静态部署可读取随构建发布的 JSON，写入需要开发或预览服务。旧文件没有该字段时自动使用默认值。

公园调试面板另提供数量（0–48 束）和覆盖范围（0.25–2 倍水平距离）；默认 15 束、1 倍范围，围绕活动区以黄金角分布，覆盖前后左右，世界位置不随镜头移动。布局以固定种子生成，增加数量时保留已有光束，范围变化重新采样地面高度。仅调整布局时更新实例缓冲，逐帧不重建；仍为一次绘制，最多 96 个三角形。更多光束及更大透明覆盖会增加片元开销。

本轮修正：阴影相机设定范围后更新投影矩阵，保证库的深度换算与实际投影一致。预览使用 `volumetricShadows:true`，保留整个太阳阴影视锥内的树木投影；正式公园也启用该阴影覆盖策略。增加 10–70° 太阳高度与逆光观察视角。64 步会比此前 32 步增加采样开销，仍可调低。

## 林下光束增强

`canopyScattering.ts` 将散射集中到地面以上、树冠以下，远处平滑衰减；对真实阴影相邻位置采样，减弱开阔处均匀亮雾，增强叶隙周围的光束，并平滑抑制低强度散射。属于美术化增强，并非完整物理散射模型。每个受光采样点最多增加一次阴影查询，半分辨率 64 步不变，无新增通道或纹理；未测 GPU 耗时，不承诺性能不变。依赖固定为 0.12.1，着色器入口变动会明确报错。公园默认密度 0.022、上限 0.5、衰减 0.2、太阳高度 42°，仍可调节并 Save。
