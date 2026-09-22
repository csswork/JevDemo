# Jev × three-vrm

文本驱动的角色表演管线 demo（一期）。

```
        输入层            判断层
文本 → DeepSeek ──→ Jev ──→ Act IR (JSON) ──→ Adapter ──→ three-vrm
        说什么          怎么演        ↑
                             唯一的契约在这里
```

二期把输入层换成 gpt-live-1 的实时语音，**右边全不动** ——
Act IR 的时间锚点本来就是为"决策时还不知道音频时长"设计的。

## 跑起来

```bash
npm install && npm run dev
```

模型已放在 `public/models/`，无需额外下载。

## 目录

| 路径 | 职责 | 换渲染引擎时 |
|---|---|---|
| `src/act/` | Act IR 定义、锚点解析、时间轴编译 | **保留** |
| `src/jev/` | 表演决策器（接口 + 规则模板 + HTTP） | **保留** |
| `server/` | 服务端代理 + DeepSeek 输入层 + JevStation 适配层（key 只在这里） | 视情况 |
| `src/vrm/` | three-vrm 渲染与分层动画 | 重写 |
| `src/speech/` | TTS 封装 | 视情况 |
| `src/runtime.ts` | 把上面几层串起来的运行时 | 改适配 |

`act/` 和 `jev/` 不 import 任何 three.js 符号，这是有意为之：换成 Live2D 或
AnimeActEngine 时，需要重写的只有 `vrm/`。

## Act IR

Jev 输出的不是动画，是一份**表演脚本**。四条轨道各自独立：

```jsonc
{
  "speech": "唔<b:think>……让我想想。这个问题得分两头看<b:turn>，你更关心哪一边？",
  "emotion": { "valence": 0.1, "arousal": 0.45 },
  "tracks": {
    "posture": "idle_alert",
    "expression": [
      { "at": 0,                    "preset": "neutral",  "weight": 1.0, "fade": 0.15 },
      { "at": { "anchor": "think" }, "preset": "sad",     "weight": 0.3, "fade": 0.35 },
      { "at": { "anchor": "turn" },  "preset": "relaxed", "weight": 0.7, "fade": 0.30 }
    ],
    "gesture": [],
    "gaze": [
      { "at": 0,                     "target": "camera" },
      { "at": { "anchor": "think" }, "target": "up", "hold": 1.8 },
      { "at": { "anchor": "turn" },  "target": "camera" }
    ]
  }
}
```

两个关键设计：

**时间锚点用 `<b:name>` 而不是秒数。** 做表演决策的那一刻 TTS 还没合成，时长是未知的。
字符位置是语义稳定的，等音频就绪后再换算（`act/anchors.ts`）。锚点名恰好是手势 id 时
自动触发同名手势，否则就是纯时间标记。二期接实时语音流后，用 TTS 的 boundary 事件
持续校正同一套锚点即可，`makeMeasuredMapper` 已经留好了口子。

**词表是闭集。** LLM 自由发挥出来的动作名映射不到 clip 库。枚举定义在 `act/schema.ts`，
`sanitizeAct()` 对越界值就近修正而不是抛错，`jev/actSchemaPrompt.ts` 里的 prompt 片段
由同一份枚举生成，不会漂。

## 配置

编辑 `.env.local`（已 gitignore），**改完重启 dev server**：

```bash
# 判断层：JevStation —— 决定"怎么演"
JEVSTATION_API_KEY=sk_...        # 在 JevStation 的 Settings 里创建
JEVSTATION_URL=...               # 可选，自部署时改

# 输入层：DeepSeek —— 决定"说什么"
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-flash    # 可选。要质量换 deepseek-v4-pro，代价是慢
```

两层各自独立：只配 Jev 就用规则模板出台词，只配 DeepSeek 则表演回落到规则模板，
两个都不配整条链路照样跑（纯 `MockDecider`）。

### 输入层：DeepSeek

一期用它替代实时语音交互，**只负责"说什么"，完全不碰"怎么演"**。
所以 `server/persona.md` 里只写人格和说话方式，写表情动作是无效的 ——
Act IR 不从这里来。

二期接 gpt-live-1 时替换掉的就是这一层（`server/deepseek.ts`），
`judgePerformance` 往右的东西一行都不用改。

延迟是这层的主要成本，所以默认 `deepseek-flash`，且默认**不发**
`thinking` / `reasoning_effort`（官方文档没写 `disabled` 取值，省略最稳）。
要开推理设 `DEEPSEEK_REASONING_EFFORT`。

### 判断层：Jev 是判断模型，不是对话模型

这一点决定了整个接法：**Jev 不生成文本**。它接收一个 `state` 和一组类型化问题，
返回带概率分布和置信度的类型化答案（`POST /api/v1/systemone`）。

这反而比让通用 LLM 吐 Act IR 更合适：

| Jev 的能力 | 在这里的用法 |
|---|---|
| `choice` 的 criteria 是闭集 | 和 `act/schema.ts` 的词表天然对齐，不可能出现"发明了一个不存在的手势名" |
| `choice` 回**整个概率分布** | 直接喂 `ExpressionLayer.setBlend` —— 混合表情白拿。`happy 0.52 + surprised 0.29` 比单一 `happy 1.0` 像人得多 |
| `score` 回级别之间的连续值 | 正好当 blendshape 权重用 |
| `confidence` | 决定"敢不敢演"：模型自己都不确定时收着演，比演错一个强表情好看 |
| `noul` 是 0–1 概率 | 「中途会不会移开视线」→ 概率越高，移开得越久 |

问题集刻意卡在 **5 个**（emotion / intensity / gaze / posture / looks_away）——
文档说超过 5 个问题或 state 超过 8000 字符，单次评估从 1 credit 变 3 credit。
问题是并行评估的，加问题几乎不增加延迟，所以要加密度时优先考虑的是 credit 而不是时间。

节拍结构在代码里合成（`server/jevstation.ts` 的 `composeAct`），这正是 Jev 文档建议的
"拆成原子问题，用自己的公式组合"：Jev 判断整句的表演基调，三个 expression beat 和
gaze 的进出时机由代码按字符位置插锚点。

Jev 拿到的 `state` 同时带用户输入和角色要说的话 —— 表演是**回应**，
只看台词判断不出"她是在附和还是在反驳"。

### 自建服务

想把两层都自己做，就走 passthrough：

```bash
JEV_MODE=passthrough
JEV_ENDPOINT=http://localhost:8787/act
JEV_API_KEY=...                  # 可选，默认发 Authorization: Bearer
                                 # 自定义头用 JEV_AUTH_HEADER=X-API-Key
```

契约 `POST {input, history, draft}` → `ActScript`。UI 右侧「Act IR 契约」面板有完整字段说明。

### key 为什么不放前端

Vite 只把 `VITE_` 前缀的变量注入客户端 bundle —— 反过来说，**任何带 `VITE_` 前缀的
key 都等于公开**，开 DevTools 就能看到。所以这里的变量一律不加前缀，由
`server/jevProxy.ts`（一个 Vite dev-server 中间件）在 Node 侧读取，浏览器只打同源的
`/api/act`，不持有任何凭据。

上线时这个中间件要换成真正的服务端路由——它只在 `vite dev` 下生效，`vite build`
产物里没有它。

不管走哪条路，代理返回前都会过一遍 `sanitizeAct()`：越界值就近夹紧、非法枚举丢弃。
决策层再怎么抽风，角色也不会卡死。

## 渲染分层

每帧顺序固定（`vrm/character.ts`）：

```
resetNormalizedPose → idle → gesture → gaze → flush → expression → lipsync → vrm.update
```

各层只往 `PoseAccumulator` 里加偏移，互相不知道对方存在。这是避免动作打架的关键，
也是"一句话一个表情=PPT翻页"的解药——四条轨道可以在不同时间点各自变化。

一期聚焦半身表情，所以：手势默认关闭（Act IR 里照常产出，只是不落到骨骼）、
肢体动作量默认压到 0.25。UI 右侧可以随时打开。

## 踩过的坑

这几条都是这个 demo 里花时间最多的地方，换模型时大概率会再遇到：

**VRM 的静止姿态是 T-pose，不是 A-pose。** 直接播手势会得到一个一直摊着手的角色。
需要一个"垂手"的基础姿态（约 70°），所有手势 clip 都相对它书写。

**`VRMUtils.rotateVRM0()` 会让弹簧骨炸开。** 它把 `vrm.scene` 整体转 180°，
而弹簧骨记录的是上一帧的**世界**位置；旋转后每个关节的世界坐标瞬间跳到镜像位置，
被当成巨大的速度输入。这个模型 `dragForce` 只有 0.05，阻尼极低，于是头发和裙子
会炸成放射状且再也收不回来。必须在旋转之后 `springBoneManager.reset()` 重新播种。
同理，载入时要先把姿态 snap 到位、空跑几帧、再 reset，否则从 T-pose 缓动到垂手的
过程同样会甩飞头发。

**VRM 0.x 的骨骼局部轴与 1.0 差一个绕 Y 的 180°。** 等价于对欧拉角的 X/Z 分量取反
（`gestures.ts` 的 `axisFlip`）。所有 clip 只按 VRM 1.0 规范写一次即可。

**别把上面那个 180° 混进世界空间的方向计算。** 这里有两个不同的 180°：一个是
`rotateVRM0` 加在 `vrm.scene` 上的场景旋转，一个是骨骼局部轴的差异。前者之后
**两种版本的模型在世界空间里都面朝 +Z**，所以"看向某点"的偏航就是
`atan2(dir.x, dir.z)`，不需要任何偏移；后者只影响欧拉角怎么落到骨骼上，由
`axisFlip` 负责。一旦在方向计算里多减一个 π，头就会永远偏着约 20° 且看不出原因
（`gaze.ts` 里留了注释）。

**情绪 blendshape 是整脸烘焙的。** VRoid 的 `happy` 同时改眼睛和嘴，viseme 也改嘴，
叠满就成了打哈欠。解法是让口型给情绪让位（`mouthOcclusion()`），情绪本身靠眉眼
仍然读得出来。

**同一个权重在不同模型上长相天差地别。** 实测这个模型 `happy` 超过 0.6 眼睛就闭成
`^^`。所以 Jev 给的是**语义强度**，渲染侧有一张模型标定表把它换算成实际可用的
blendshape 权重（`expressions.ts` 的 `DEFAULT_CEILING`，UI 里可以实时拨）。
把这层放在渲染侧而不是 prompt 里 —— 换模型时改一张表，Jev 一个字都不用动。

**VRM 0.x 没有 `surprised`。** VRoid 把它放在自定义槽 `Surprised`（大写 S）里。
表情名做大小写无关解析，解析不到再降级到最接近的替代。

## 一期的取舍

- **口型不做音素对齐。** 中文要做准得先出拼音再映射 viseme，投入产出比不划算。
  现在按字符哈希选 viseme（口型和台词一一绑定、可复现），标点处强制闭口。
  接 Azure / ElevenLabs 这类能给音素时间戳的 TTS 后，`LipSyncLayer` 直接换数据源即可。
- **TTS 用 Web Speech API。** 零配置，但拿不到音频流，所以口型只能靠估算时长驱动。
- **手势是程序化关键帧，不是 .vrma。** 能自由下载的 VRMA 动作包极少，而对话场景
  高频用的是点头/摇头/歪头这种小动作，写死反而更可控。需要时用
  `@pixiv/three-vrm-animation` 走 AnimationMixer 另起一层。

## 调试

开发模式下 `window.__jev` 挂着运行时：

```js
__jev.character.expression.override('happy', 1)   // 钉死某个表情槽
__jev.character.idle.setBodyMotion(1)             // 放开肢体动作
__jev.layersEnabled = false                       // 只跑 vrm.update，隔离问题来源
```

## 模型

`public/models/Sendagaya_Shino.vrm` —— VRoid 官方示例模型，**CC0**。
详见 `public/models/LICENSE.txt`。
