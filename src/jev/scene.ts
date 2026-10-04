/**
 * 角色此刻所在的场景：前端每一轮跟着对话一起发给服务端，输入层（DeepSeek）据此知道"我们在哪、几点了"
 * （描述怎么写见 server/scene.ts）。
 *
 * 只发结构化的事实，不发文字描述 —— 怎么跟模型说是服务端的事，前端不碰 prompt。
 */
export interface SceneContext {
  /**
   * 背景场景（BackdropId，见 vrm/stage.ts）。这里写成 string：服务端也引用这个文件，
   * 不能顺着类型把浏览器那一侧的 three.js 场景代码带过去。服务端没写过描述的背景按"一个新地方"说
   */
  id: string;
  /**
   * 时间：只有有昼夜的场景（街景）才带。其余场景是固定的光线，没有"几点"可言
   */
  time?: {
    /** 场景里现在几点（0..24，太阳时；过渡中就是过渡到的那一刻） */
    hours: number;
    /** 太阳高度角（度）：比钟点更能说明天色（冬天五点就黑了） */
    sunElev: number;
    /** 跟随现实的时钟（"实时"）。这时也带上今天的日期 */
    live: boolean;
    date?: { month: number; day: number; weekday: number };
  };
}
