# Jev × three-vrm

文本驱动的角色表演管线 demo（一期）。

```
        输入层                          判断层
文本 → DeepSeek ──→ 台词 ──→ 立刻开口（基线表演）
        说什么         └──→ Jev ──→ 升级还没触发的节拍
                             怎么演
```

两层天然串行 —— Jev 判断的对象就是 DeepSeek 写出来的那句话，没有它无从判断。
既然不能并发，就让**说话别等判断**：台词一到就开口并套用基线表演，Jev 的结果
晚几百毫秒回来，再替换掉还没触发的节拍。实测感知延迟从 1.97s 降到 1.28s，
省掉的正好是判断层那一段。

二期把输入层换成 gpt-live-1 的实时语音，**右边全不动** ——
Act IR 的时间锚点本来就是为"决策时还不知道音频时长"设计的，
渐进升级需要的也正是这套锚点。

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
# 判断层：Jev —— 决定"怎么演"。后端按 key 前缀自动识别
JEV_KEY=vck_...                  # 或 sk_...
DEEPSEEK_API_KEY=sk-...          # 输入层：决定"说什么"
```

完整可选项见 `.env.example`。

Jev 有三种接法，端点、鉴权、响应形状都不一样，`server/jev.ts` 按 key 前缀自动分流：

| 前缀 | 后端 | 端点 | 差异 |
|---|---|---|---|
| `vck_` | Vercel AI Gateway | `ai-gateway.vercel.sh/typesafe/v1/systemone` | **必须**带 `model: "typesafe-ai/jev"`；answers 在顶层；计费在 `provider_metadata.gateway.cost`（美元） |
| `sk_` | JevStation | `jevstation.com/api/v1/systemone` | `model` 被忽略；answers 包在 `data` 里；另带 credits 余额 |
| 其它 | TypeSafe 直连 | `api.typesafe.ai/v1/systemone` | 候补名单；形状同 Vercel |

自动识别不对时用 `JEV_BACKEND` / `JEV_BASE_URL` / `JEV_MODEL` 覆盖。

**Vercel AI Gateway 的坑**：免费额度需要先在账户里绑定信用卡才会解锁，否则所有请求
返回 403 `customer_verification_required`。这个错误走的是网关边缘的
`{"error":{"message","type"}}` 形状，和 Vercel 文档里写的扁平 `{message, error_type}`
不是一回事，所以 `jev.ts` 两种都认，解析不出来就把原文透出来。

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
| `confidence` | 轻度对冲表演幅度（0.75~1.0），**不能重压**，理由见下 |
| `noul` 是 0–1 概率 | 「中途会不会移开视线」→ 概率越高，移开得越久 |

问题集刻意卡在 **5 个**（emotion / intensity / gaze / posture / looks_away）——
文档说超过 5 个问题或 state 超过 8000 字符，单次评估从 1 credit 变 3 credit。
问题是并行评估的，加问题几乎不增加延迟，所以要加密度时优先考虑的是 credit 而不是时间。

节拍结构在代码里合成（`server/jevstation.ts` 的 `composeAct`），这正是 Jev 文档建议的
"拆成原子问题，用自己的公式组合"：Jev 判断整句的表演基调，三个 expression beat 和
gaze 的进出时机由代码按字符位置插锚点。

Jev 拿到的 `state` 同时带用户输入和角色要说的话 —— 表演是**回应**，
只看台词判断不出"她是在附和还是在反驳"。

#### confidence 不能拿来重压幅度

踩过一次反向的坑。文档说 confidence 就是从概率分布的形状导出的：集中=高，分散=低。
所以**低 confidence 不等于"Jev 不确定"，而等于"情绪本身就是混的"**。实测：

| 台词 | 分布 | confidence |
|---|---|---|
| 「诶？你居然记得这个」 | surprised 1.00 | 0.99 |
| 「这个功能有三种实现方式」 | neutral 0.96 | 0.95 |
| 「……算了，我也说不清楚」 | sad 0.62 + neutral 0.30 | 0.54 |
| 「哈，行吧。反正我也习惯了」 | sad 0.38 + relaxed 0.31 + angry 0.17 | **0.26** |

最后一条是苦笑，三路混合，语义上完全正确 —— 苦笑就是难过 + 强装轻松 + 一点不甘。
但最初按文档的三档法把低 confidence 压到 0.45 倍，结果情绪最丰富的句子演得最淡：
分布已经用来做混合了，再拿同一个信号去衰减幅度，等于对复杂情绪双重惩罚。

现在只保留 0.75~1.0 的轻度对冲。留一点是因为分布也可能在**对立**情绪之间摊平
（happy 0.5 / angry 0.5），那种脸全给满会很怪。

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

## 渐进式管线

三个端点，前两个是渐进式的两段：

| 端点 | 干什么 | 失败时 |
|---|---|---|
| `POST /api/speech` | 只出台词（输入层） | 抛错，角色说不出话 |
| `POST /api/judge` | 判断这句话怎么演 | **不抛错**，退回基线表演 |
| `POST /api/act` | 一次性拿完整脚本 | passthrough 模式和不支持渐进的调用方走这条 |

前端拿到台词立刻 `runtime.play(baselineAct(speech))` 开口，同时不 await 地发出
`/api/judge`；结果回来后 `runtime.upgrade(act)`。

`TimelinePlayer.upgrade()` 保留已经走过的时间，把**还没触发**的节拍整体换掉，
已经过去的一次性补齐立即应用。前提是台词和时长一致（`Runtime.upgrade` 里校验，
不一致就放弃升级）—— 否则口型会和台词错位。

判断层是增强而不是硬依赖：Jev 挂了、余额没了、超时，角色照样把话说完，
只是表演停在基线。UI 左上角会亮一条降级提示，原因在右侧面板里。

### 判断层要设超时（实测很重要）

走 Vercel AI Gateway 的延迟方差很大。实测同一条请求连打 6 次：

```
1.03s   19.46s   1.03s   3.81s   2.09s   14.04s
```

多数落在 0.7~1s，但见过 19.5s。Jev 官方宣称比 LLM 快两个数量级，所以这几乎肯定是
网关的排队/冷启动开销，不是模型本身。

这里的要害不是慢，是**过期的判断没有价值**：一句台词只播 3~6 秒，`upgrade()` 只能改
还没触发的节拍，判断回来时台词已经说完就什么都改不了，那次调用纯属浪费。
所以 `JEV_TIMEOUT_MS` 默认 6000，超了就干净放弃、退回基线，
重试也受同一个 deadline 约束（否则退避会把"及时放弃"的意义抵消掉）。

### 同一时刻的表情拍会合并

这是踩过一次的坑，值得单独说。`composeAct` 把 Jev 的概率分布摊成多个 `at` 相同的
expression beat，本意是"这是一张混合的脸"。但渲染层如果对每一拍单独调
`setExclusive`，后一拍会把前一拍清零，分布直接退化成 top-1 —— **混合表情等于白做，
而且从返回的 JSON 上完全看不出来**（JSON 里两拍都在）。

所以 `compileAct` 按解析后的时刻分组，同一时刻的若干拍合成一条带 `mix` 的事件，
渲染层一次 `setBlend`。验证要看 `expressionManager.getValue()` 的真实权重，
光看 Act IR 的 JSON 会漏掉这类问题。

## 谁说了算

前端**没有任何表演参数的控件**。留一个滑块就意味着"到底谁说了算"没有唯一答案，
所以情绪、强度、视线、姿态全部交给 Jev，UI 只做只读展示。

但"全部由 Jev 控制"这句话需要拆开讲，三类东西性质完全不同：

**① Jev 判断的（每句话一次评估）**

| 参数 | 问题类型 | 落到哪 |
|---|---|---|
| 情绪概率分布 | choice | `ExpressionLayer.setBlend` 的混合权重 |
| 强度 | score | 权重的整体倍率 |
| 视线目标 | choice | `GazeLayer.look` |
| 待机基调 | choice | `IdleLayer.setPosture` |
| 是否中途移开视线 | noul | 中段 gaze beat 及其保持时长 |

**② 自主的不随意行为（不该由 Jev 管，也管不了）**

眨眼、眼球微扫视、呼吸、重心转移、头部微漂移、微表情闪动、口型。

这些是连续发生的生理层动作，Jev 是**每句话一次**的判断模型：问它"现在该不该眨眼"
既没有语义可判断，也会让成本和延迟完全失控。它们由 `idle.ts` / `expressions.ts` /
`lipsync.ts` 用噪声和随机间隔自行驱动 —— 去掉之后角色会立刻变成会说话的贴图。

**③ 渲染侧的硬编码常量（不是表演决策，是设备标定和合成规则）**

| 常量 | 在哪 | 是什么 |
|---|---|---|
| `DEFAULT_CEILING` | `expressions.ts` | 每个情绪在**这个模型**上的可用上限。实测 happy 超过 0.6 就闭眼 |
| 混合门槛 `0.15` | `jev.ts` | 概率低于此值的情绪不进混合，滤长尾噪声 |
| `confidenceGain` | `jev.ts` | 0.75~1.0 的轻度对冲 |
| 节拍衰减 `0.75 / 0.55` | `jev.ts` | 三拍结构里中段和收尾的相对幅度 |
| `bodyMotion 0.25` | `idle.ts` | 半身景别下的肢体动作总量 |

这一类**刻意不交给 Jev**：它们描述的是"这个模型能演到什么程度"和"怎么把一次判断
摊成三个节拍"，换个 VRM 模型就要重调，而 Jev 对模型一无所知。把它们写进 Jev 的
问题集，等于让判断模型去记每个角色模型的 blendshape 脾气。

调这些值走 `window.__jev`（仅 dev），不进产品 UI。

### 测试指令

拆掉滑块之后，调试用文本指令代替：

```
测试: 开心 90%                        单一情绪
测试: 难过 40% 放松 30%               混合，验证概率分布真的叠加了
测试: 开心 60% | 今天天气不错          自定义台词
test: happy 90%                       英文同义
```

中文别名认这些：开心/高兴/快乐/笑、生气/愤怒/不爽、难过/伤心/低落/委屈、
放松/温和/平和、惊讶/意外/吃惊/震惊、中性/平静。

要点是它**构造一份合成的 Jev 答案**，再走 `composeAct` —— 和真实链路共用同一份
合成代码（`src/act/fromJev.ts`，为此从 `server/` 挪到了共享层）。
如果测试路径自己另算一套 Act IR，测出来的东西不作数。

跳过 DeepSeek 和真实 Jev：不花钱、不等网络、结果可复现。

### 三个节拍要发整个混合，不能只发主导情绪

又一个只看 JSON 发现不了的坑。`composeAct` 把一次判断摊成三拍（起 / 中段 0.75 /
收尾 0.55），最初中段和收尾只发 `dominant`。单一情绪时没问题，但混合表情会在 45%
处被**拍平成主导情绪** —— 苦笑演到半句就变成纯难过，前面混出来的脸没了。

现在每一拍都发整个混合、只缩放幅度。实测 sad 40% + relaxed 30% 那句：

| t | sad | relaxed | neutral |
|---|---|---|---|
| 0.4s | 0.669 | 0.503 | 0.501 |
| 1.8s | 0.590 | 0.443 | 0.443 |
| 3.4s | 0.375 | 0.281 | 0.281 |

比例恒定，幅度递减 —— 表情的性质保住，只有强度在收。

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
