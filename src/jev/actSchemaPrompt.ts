import { EMOTIONS, GAZE_TARGETS, GESTURES, POSTURES } from '../act/schema';

/**
 * 给 Jev（或任何 LLM）的 output schema 说明。
 *
 * 两条是实践中最容易被忽略、但直接决定观感的：
 *   - 必须按语义节拍切分，一句话至少 2~3 个 beat。一句话一个表情 = PPT 翻页。
 *   - 动作名必须来自闭集。自由发挥出来的名字这边映射不到，会被 sanitize 丢掉。
 */
export const ACT_SCHEMA_PROMPT = `你要输出一段"表演脚本"JSON，描述角色说什么、以及怎么演。

字段：
{
  "speech": string,        // 台词。可内联时间锚点 <b:手势名>，标记会在播放前剥离
  "emotion": { "valence": -1..1, "arousal": 0..1 },
  "tracks": {
    "posture": ${POSTURES.map((p) => JSON.stringify(p)).join(' | ')},
    "expression": [{ "at": 秒数 | {"anchor":"锚点名"}, "preset": 表情, "weight": 0..1, "fade": 秒 }],
    "gesture":    [{ "at": 秒数 | {"anchor":"锚点名"}, "clip": 手势, "weight": 0..1, "speed": 0.25..3 }],
    "gaze":       [{ "at": 秒数 | {"anchor":"锚点名"}, "target": 视线目标, "hold": 秒 }]
  }
}

表情闭集：${EMOTIONS.join(' / ')}
手势闭集：${GESTURES.join(' / ')}
视线闭集：${GAZE_TARGETS.join(' / ')}

硬性要求：
1. at 优先用 {"anchor": ...}，不要猜秒数 —— 你做决策时 TTS 时长还不知道。
2. 台词里写 <b:wave> 即可自动触发同名手势，不必在 gesture 数组里重复声明。
3. **表演密度**：每段台词至少给 2~3 个 expression beat，在语义转折处切换。
   只在开头给一个表情，角色看起来会像 PPT 翻页。
4. 思考、回避、不确定时把 gaze 移开（away_left / up / down）并给 hold，
   说重点时移回 camera。视线是最廉价也最有效的"有内心活动"信号。
5. 所有枚举值必须一字不差，不要发明新名字。

只输出 JSON，不要任何额外文字。`;
