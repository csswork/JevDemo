import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliveryFor, emotionFor, MINIMAX_VOICES, synthesizeMiniMax, textForMiniMax } from './minimaxTts.ts';
import type { VoiceStyle } from '../src/act/voiceStyle.ts';

const cfg = { apiKey: 'test-key', baseUrl: 'https://example.invalid/' };
const params = { text: '你好呀！', voice: MINIMAX_VOICES[0].id, instructions: '用开心、轻快的语气说' };
const event = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`;

test('独立笑声转为表演标签，普通词语、引用和现有标签不误改', () => {
  assert.equal(textForMiniMax('哈哈哈，这个太好笑了！'), '(laughs)，这个太好笑了！');
  assert.equal(textForMiniMax('真的？嘿嘿，嘻嘻。'), '真的？(chuckle)，(chuckle)。');
  assert.equal(textForMiniMax('看这个哈哈镜。'), '看这个哈哈镜。');
  assert.equal(textForMiniMax('你说的哈哈是什么意思？'), '你说的哈哈是什么意思？');
  assert.equal(textForMiniMax('今天很开心！'), '今天很开心！');
  assert.equal(textForMiniMax('(laughs) 好好笑！'), '(laughs) 好好笑！');
});

function streamResponse(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      // 刻意在 JSON、中文和 CRLF 边界拆开网络包。
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('解码跨网络包的 PCM，结束事件的聚合音频不重复播放', async (t) => {
  const signal = new AbortController().signal;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://example.invalid/v1/t2a_v2');
    assert.equal(init.signal, signal);
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-key');
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, 'speech-2.8-turbo');
    assert.equal(body.voice_setting.voice_id, 'female-shaonv');
    assert.equal(body.voice_setting.emotion, 'happy');
    assert.deepEqual(body.audio_setting, { format: 'pcm', sample_rate: 24000, channel: 1 });
    assert.equal(body.stream_options.exclude_aggregated_audio, true);
    return streamResponse(event({ data: { status: 1, audio: '01000200' } }) + event({ data: { status: 1, audio: '0300' } }) + event({ data: { status: 2, audio: '010002000300' } }));
  });
  const chunks: Buffer[] = [];
  assert.deepEqual(await synthesizeMiniMax(cfg, params, (b) => chunks.push(b), signal), { sampleRate: 24000 });
  assert.equal(Buffer.concat(chunks).toString('hex'), '010002000300');
});

test('HTTP 200 的 JSON 鉴权错误也必须报错', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ base_resp: { status_code: 1004, status_msg: '鉴权失败' } }));
  await assert.rejects(synthesizeMiniMax(cfg, params, () => assert.fail('不应返回音频')), /1004.*鉴权失败/);
});

test('SSE 错误、空音频和截断的音频流均报错', async (t) => {
  for (const [body, error] of [
    [event({ base_resp: { status_code: 1008, status_msg: '余额不足' } }), /1008.*余额不足/],
    [event({ data: { status: 2 } }), /未返回音频/],
    [event({ data: { status: 1, audio: '0100' } }), /提前结束/],
    [event({ data: { status: 1, audio: 'xyz' } }), /无效音频编码/],
  ] as const) {
    const mock = t.mock.method(globalThis, 'fetch', async () => streamResponse(body));
    await assert.rejects(synthesizeMiniMax(cfg, params, () => {}), error);
    mock.mock.restore();
  }
});

test('拒绝未知音色，不发送付费请求', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('不应发请求'));
  await assert.rejects(synthesizeMiniMax(cfg, { ...params, voice: 'minimax:unknown' }, () => {}), /未知 MiniMax 音色/);
});

test('情绪描述按主导情绪映射，未识别描述交给模型自行判断', () => {
  assert.equal(emotionFor('用温柔里带点伤感的语气说'), 'calm');
  assert.equal(emotionFor('用难过里带点温柔的语气说'), 'sad');
  assert.equal(emotionFor('用害羞又开心的语气说'), 'calm');
  assert.equal(emotionFor('用生气、不耐烦的语气说'), 'angry');
  assert.equal(emotionFor(null), undefined);
  assert.equal(emotionFor('用播音腔说'), undefined);
});

const style = (s: Partial<VoiceStyle>): VoiceStyle => ({ emotion: 'neutral', p: 1, intensity: 0.5, onset: true, ...s });

test('叹气、抽泣、咳嗽、噗嗤也换成语气词标签，"唉声叹气"这类词不动', () => {
  assert.equal(textForMiniMax('唉，又下雨了。'), '(sighs)，又下雨了。');
  assert.equal(textForMiniMax('呜呜呜，好疼……'), '(sniffs)，好疼……');
  assert.equal(textForMiniMax('咳咳，那个……'), '(coughs)，那个……');
  assert.equal(textForMiniMax('噗，你认真的？'), '(chuckle)，你认真的？');
  assert.equal(textForMiniMax('别唉声叹气的。'), '别唉声叹气的。');
});

test('情绪刚开始而且很强时，开口前加一声；开心不自动加笑声', () => {
  assert.equal(textForMiniMax('我没事。', style({ emotion: 'sad', p: 0.7, intensity: 0.75 })), '(sighs)我没事。');
  assert.equal(textForMiniMax('我没事。', style({ emotion: 'sad', p: 0.8, intensity: 1 })), '(sniffs)我没事。');
  assert.equal(textForMiniMax('诶？真的吗！', style({ emotion: 'surprised', p: 0.7, intensity: 0.8 })), '(gasps)诶？真的吗！');
  // 不是"诶""啊"这类开头就不倒吸气；不是情绪刚开始、强度不够也不加
  assert.equal(textForMiniMax('真的吗！', style({ emotion: 'surprised', p: 0.7, intensity: 0.8 })), '真的吗！');
  assert.equal(textForMiniMax('我没事。', style({ emotion: 'sad', p: 0.7, intensity: 0.75, onset: false })), '我没事。');
  assert.equal(textForMiniMax('我没事。', style({ emotion: 'sad', p: 0.7, intensity: 0.5 })), '我没事。');
  assert.equal(textForMiniMax('太好了！', style({ emotion: 'happy', p: 0.9, intensity: 1 })), '太好了！');
  // 台词自己已经以标签开头（"唉，……"）就不再叠一个
  assert.equal(textForMiniMax('唉，算了。', style({ emotion: 'sad', p: 0.7, intensity: 0.8 })), '(sighs)，算了。');
});

test('情绪明确才给 emotion，平静 / 放松 / 害羞 / 弱情绪交给模型自己判断', () => {
  assert.equal(deliveryFor(style({ emotion: 'happy', p: 0.7, intensity: 0.5 })).emotion, 'happy');
  assert.equal(deliveryFor(style({ emotion: 'happy', p: 0.7, intensity: 0 })).emotion, undefined);
  assert.equal(deliveryFor(style({ emotion: 'happy', p: 0.3, intensity: 1 })).emotion, undefined);
  for (const emotion of ['neutral', 'relaxed', 'shy'] as const) {
    assert.equal(deliveryFor(style({ emotion, p: 0.9, intensity: 1 })).emotion, undefined);
  }
  assert.equal(deliveryFor(style({ emotion: 'surprised', p: 0.5, second: 'sad', p2: 0.3, intensity: 0.5 })).emotion, 'fearful');
  // 老客户端：只有中文语气描述，calm 不再硬塞
  assert.equal(deliveryFor(null, '用自然、亲切的语气说').emotion, undefined);
  assert.equal(deliveryFor(null, '用生气、不耐烦的语气说').emotion, 'angry');
});

test('韵律按强度微调，幅度都在小范围内', () => {
  const flat = deliveryFor(style({ emotion: 'neutral' }));
  assert.deepEqual(flat, { speed: 1, vol: 1, pitch: 0 });
  const sad = deliveryFor(style({ emotion: 'sad', p: 0.8, intensity: 1 }));
  assert.ok(sad.speed < 1 && sad.speed >= 0.9 && sad.pitch === -1 && sad.vol < 1);
  const happy = deliveryFor(style({ emotion: 'happy', p: 0.8, intensity: 1 }));
  assert.ok(happy.speed > 1 && happy.speed <= 1.06 && happy.pitch === 1);
  const shy = deliveryFor(style({ emotion: 'shy', p: 0.7, intensity: 0.5 }));
  assert.ok(shy.speed < 1 && shy.vol < 1 && shy.pitch === 1 && shy.emotion === undefined);
  for (const e of ['happy', 'sad', 'angry', 'surprised', 'shy', 'relaxed'] as const) {
    const d = deliveryFor(style({ emotion: e, p: 1, intensity: 1 }));
    assert.ok(d.speed >= 0.9 && d.speed <= 1.06 && Math.abs(d.pitch) <= 2 && d.vol >= 0.85 && d.vol <= 1.15, e);
  }
});
