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
