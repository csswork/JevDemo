import type { SceneContext } from '../src/jev/scene.ts';

/**
 * 场景感知：把前端发来的"在哪、几点"（src/jev/scene.ts）写成输入层 system prompt 的一段。
 *
 * 每一轮都按当前的场景重写这一段，所以换了背景、拖了时间，下一句话就知道。
 * 另外记着每个 session 上一轮在哪、天色怎样（只在内存里，重启就忘）：变了的那一轮多一句
 * "你们刚从咖啡店来到这里"，让她有机会自然地提一句 —— 只提醒这一轮，下一轮就当已经在这里了。
 *
 * 地点的描述照着 src/vrm/scenes/ 里实际搭的东西写，别写场景里没有的。
 * 只写"有什么"，不写"在谁的哪边"：试过"你身后是吧台""我背靠着吧台"几种写法，flash 档的模型还是有一半
 * 说成"你（对方）身后是吧台""你回头看看"，方向全反。方位对聊天没什么用，干脆不给，再明说别讲前后
 */

const PLACES: Record<string, { name: string; desc: string } | null> = {
  cafe: {
    name: '咖啡店',
    desc:
      '一家小咖啡店的店里，就在吧台边上。吧台上有意式咖啡机和蛋糕罩，上方两盏暖光吊灯；' +
      '墙上有放杯子瓶罐的置物架和黑板菜单。店里有两扇大窗、窗台上摆着绿植，砖墙上挂着画和挂钟，还有几张小圆桌和木椅。' +
      '店里放着轻轻的人声和杯碟声。',
  },
  animeCafe: {
    name: '潮汐咖啡馆',
    desc:
      '一家叫"潮汐"的海边咖啡馆里。店里有收银台和玻璃甜点柜，墙上挂着菜单和植物装饰画，有拱门，' +
      '窗边有靠窗的座位，往里还有一片座位区。门窗是磨砂玻璃，透进柔和的光，隐约看得见外面的树和海边的房子。',
  },
  park: {
    name: '公园',
    desc:
      '城市公园里的木平台上，一条木栈道弯弯曲曲伸向远处。四周是草坪、大树和灌木，路边开着白色、蓝色、黄色的小花，' +
      '有欧式路灯、长凳和树桩凳，地上有落叶和长青苔的石头。阳光从树冠的缝隙里斜着漏下来，能听到鸟叫。',
  },
  street: {
    name: '海边小镇的街上',
    desc:
      '海边小镇的一条街上，就站在路边。街的一侧是一排两三层的日式小楼，一楼是咖啡店、陶器店、土特产店、居酒屋这些店面，' +
      '咖啡店门口有深蓝的遮阳篷、立式小黑板和长凳，路边有自动售货机、电线杆和行道树。' +
      '另一侧是石头矮墙和铁栏杆，栏杆外面就是海：远处有灯塔、防波堤、跨海大桥，对岸是另一个小镇和山。',
  },
  none: null,
};

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function clock(h: number) {
  const m = Math.round((((h % 24) + 24) % 24) * 60) % 1440;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** 天色：按太阳高度分（比钟点准，冬天五点就黑了） */
function phaseOf(t: NonNullable<SceneContext['time']>): { key: string; text: string } {
  const morning = t.hours < 12;
  if (t.sunElev < -6) {
    return t.hours >= 4 && t.hours < 12
      ? { key: 'night', text: '天还没亮，路灯、灯塔和对岸的灯都还亮着，街上很安静' }
      : { key: 'night', text: '天已经黑了，路灯、店门口和窗里的灯都亮着，灯塔在闪，海上是对岸小镇的灯光' };
  }
  if (t.sunElev < 0) {
    return morning
      ? { key: 'dawn', text: '天刚蒙蒙亮，天边泛白，路灯快要熄了' }
      : { key: 'dusk', text: '太阳刚落下去，天边还有一点橙红，路灯和店里的灯陆续亮起来' };
  }
  if (t.sunElev < 12) {
    return morning
      ? { key: 'morning', text: '清晨，太阳刚升起来不久，光线斜斜的、有点凉' }
      : { key: 'evening', text: '傍晚，太阳很低了，整条街和海面都被染成暖橙色' };
  }
  return { key: 'day', text: t.hours < 11 ? '上午，阳光很好，海面亮晶晶的' : t.hours < 14 ? '中午，太阳很高，阳光很好' : '下午，阳光很好，海面亮晶晶的' };
}

/** 前端发来的东西不一定可信：认得的才用 */
export function validScene(v: unknown): SceneContext | null {
  const s = v as SceneContext | null;
  if (!s || typeof s !== 'object' || typeof s.id !== 'string') return null;
  const t = s.time;
  if (t && (typeof t.hours !== 'number' || !Number.isFinite(t.hours) || typeof t.sunElev !== 'number')) return { id: s.id };
  return s;
}

/** session → 上一轮的 地点 + 天色 */
const lastSeen = new Map<string, { id: SceneContext['id']; phase: string | null }>();

/**
 * 这一轮的场景段落（放进 system prompt）。没带场景就是 null（不加这一段，和以前一样）
 */
export function scenePrompt(session: string | null, raw: unknown): string | null {
  const scene = validScene(raw);
  if (!scene) return null;
  // 新加的背景还没写描述：至少别说成"没有地点"
  const place = scene.id in PLACES ? PLACES[scene.id] : { name: '这里', desc: '一个新的地方（具体的样子还没告诉你，别编细节）。' };
  const phase = scene.time ? phaseOf(scene.time) : null;

  const lines: string[] = ['【你们现在所在的地方】'];
  lines.push(place ? `你们在${place.desc}` : '没有特定的地点（四周只是一片纯色的背景），不用提你在哪。');

  if (scene.time) {
    const t = scene.time;
    let when = `现在是 ${clock(t.hours)}，${phase!.text}。`;
    if (t.live && t.date) {
      when = `今天是 ${t.date.month} 月 ${t.date.day} 日，星期${WEEKDAYS[t.date.weekday] ?? ''}。${when}`;
    }
    lines.push(when);
  }

  // 和上一轮比：换了地方、或者天色变了
  if (session) {
    const prev = lastSeen.get(session);
    if (prev && prev.id !== scene.id) {
      const from = prev.id in PLACES ? PLACES[prev.id]?.name : null;
      lines.push(from && place ? `（你们刚从${from}来到了这里。）` : place ? '（你们刚来到这里。）' : '');
    } else if (prev && phase && prev.phase && prev.phase !== phase.key) {
      lines.push('（不知不觉天色变了。）');
    }
    lastSeen.set(session, { id: scene.id, phase: phase?.key ?? null });
  }

  lines.push(
    '这是你此刻眼前真实的环境。对方问起时间、天气、周围有什么，就照这里回答；聊天时可以自然地带到一两句' +
      '（比如天黑了灯亮了、窗外的阳光）。对方就面对着你；提到周围的东西就说"这儿""那边"，' +
      '不要说"你身后""你回头看""你背后"这种（对方没有背对着这些东西）。但不要每句都描述环境，也不要像报幕一样把上面的内容念出来。' +
      (scene.time ? '' : '这里没有可以确认的钟点，别编具体的时间。'),
  );
  return lines.filter(Boolean).join('\n');
}
