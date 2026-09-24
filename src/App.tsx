import { useCallback, useEffect, useRef, useState } from 'react';
import { Runtime, type LiveState } from './runtime';
import { MockDecider } from './jev/mockDecider';
import { HttpDecider, probeJev, type JevMeta, type JevStatus } from './jev/httpDecider';
import type { ActDecider } from './jev/decider';
import { baselineAct, fallbackAct, type ActScript } from './act/schema';
import { isTestCommand, parseTestCommand } from './jev/testCommand';
import { HAND_GESTURES } from './act/gestureRules';
import { EMOTIONS, type Emotion } from './act/schema';
import './App.css';

const MODEL_URL = `${import.meta.env.BASE_URL}models/Sendagaya_Shino.vrm`;

interface Turn {
  role: 'user' | 'character';
  text: string;
}

/** 概率分布的简写："happy 0.62 + surprised 0.21"（只列 ≥ 0.15 的） */
function topMix(probs: Record<string, number>): string {
  return (
    Object.entries(probs)
      .filter(([, p]) => p >= 0.15)
      .sort((a, b) => b[1] - a[1])
      .map(([k, p]) => `${k} ${p.toFixed(2)}`)
      .join(' + ') || 'neutral'
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const deciderRef = useRef<ActDecider>(new MockDecider());
  const logRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [tts, setTts] = useState(false);
  const [live, setLive] = useState<LiveState | null>(null);
  const [lastAct, setLastAct] = useState<ActScript | null>(null);
  const [subtitle, setSubtitle] = useState('');
  const [useJev, setUseJev] = useState(false);
  const [jev, setJev] = useState<JevStatus>({ configured: false, mode: 'unconfigured' });
  const [jevMeta, setJevMeta] = useState<JevMeta | null>(null);
  const [jevError, setJevError] = useState<string | null>(null);
  // 测试预览（仅 dev）
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previewSpeed, setPreviewSpeed] = useState(0.25);
  const [previewLoop, setPreviewLoop] = useState(true);
  const [previewClock, setPreviewClock] = useState<{
    time: number;
    duration: number;
    phases?: number[];
    paused: boolean;
  } | null>(null);


  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rt = new Runtime();
    runtimeRef.current = rt;
    rt.onState = setLive;
    rt.onSpeechText = setSubtitle;

    let disposed = false;
    rt.mount(canvas, MODEL_URL, setProgress)
      .then(() => {
        if (disposed) return;
        setLoading(false);
        deciderRef.current.decide('你好', { history: [] }).then((act) => {
          setLastAct(act);
          rt.play(act);
          setTurns([{ role: 'character', text: act.speech.replace(/<b:[a-z0-9_]+>/gi, '') }]);
        });
      })
      .catch((e: unknown) => {
        if (disposed) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });

    const onResize = () => rt.resize();
    window.addEventListener('resize', onResize);
    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      rt.dispose();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (runtimeRef.current) runtimeRef.current.ttsEnabled = tts;
  }, [tts]);

  // 探测服务端代理有没有配好。key 在代理那一侧，前端只知道"能不能用"。
  useEffect(() => {
    let alive = true;
    void probeJev().then((s) => {
      if (!alive) return;
      setJev(s);
      // 配好了就默认走 Jev —— 否则每次刷新都要手点一下
      if (s.configured) setUseJev(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (useJev && jev.configured) {
      // 输入层没配 DeepSeek 时，用 MockDecider 的规则模板补台词。
      deciderRef.current = new HttpDecider({
        draftSource: jev.needsDraft ? new MockDecider() : null,
      });
    } else {
      deciderRef.current = new MockDecider();
    }
  }, [useJev, jev.configured, jev.needsDraft]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  const previewGesture = (id: string, pair: Partial<Record<Emotion, number>>) => {
    const rt = runtimeRef.current;
    const ch = rt?.character;
    if (!rt || !ch) return;
    ch.expression.setBlend(pair, 0.2);
    rt.playPreview(id, previewSpeed, previewLoop);
    setPreviewing(id);
  };

  // 预览播放器的时间轴：动画在 React 之外跑，这里 20Hz 拉一次状态就够了
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const timer = setInterval(() => {
      const st = runtimeRef.current?.previewState();
      if (!st?.id) {
        setPreviewClock(null);
        return;
      }
      setPreviewClock((prev) =>
        st.info
          ? { time: st.info.time, duration: st.info.duration, phases: st.info.phases, paused: st.paused }
          : prev && { ...prev, time: prev.duration, paused: true },
      );
    }, 50);
    return () => clearInterval(timer);
  }, []);

  const previewEmotion = (emo: Emotion) => {
    const ch = runtimeRef.current?.character;
    if (!ch) return;
    // 预览要看的是这一个情绪本身，先清掉上一个的惯性
    ch.expression.reset();
    ch.expression.setBlend({ [emo]: 0.9 }, 0.2);
    setPreviewing(emo);
  };

  const resetPreview = () => {
    const rt = runtimeRef.current;
    setPreviewClock(null);
    rt?.releaseGesture();
    rt?.character?.expression.reset();
    setPreviewing(null);
  };

  const send = useCallback(async () => {
    const text = input.trim();
    const rt = runtimeRef.current;
    if (!text || !rt || busy) return;

    setInput('');
    setBusy(true);
    setJevMeta(null);
    setJevError(null);
    const history = turns.slice(-6);
    const ctx = { history };
    setTurns((t) => [...t, { role: 'user', text }]);

    // 测试指令：跳过 DeepSeek 和真实 Jev，用合成答案走同一份 composeAct。
    // 不花钱、不等网络、结果可复现。
    if (isTestCommand(text)) {
      const cmd = parseTestCommand(text);
      if (cmd?.reaction) {
        // 模拟真实链路的节奏：思考 → 第一反应（约 0.9s 后）→ 开口（约 2.2s 后，
        // 大致是 DeepSeek 写台词的耗时）。整句判断直接随台词到，不再模拟延迟
        setLastAct(cmd.act);
        setJevMeta({ ...cmd.meta, reaction: undefined });
        rt.think();
        const mix = cmd.reaction;
        await new Promise((r) => setTimeout(r, 900));
        rt.react(mix);
        await new Promise((r) => setTimeout(r, 1300));
        const compiled = rt.play(cmd.act);
        setTurns((t) => [...t, { role: 'character', text: compiled.text }]);
      } else if (cmd) {
        setLastAct(cmd.act);
        setJevMeta(cmd.meta);
        const compiled = rt.play(cmd.act);
        setTurns((t) => [...t, { role: 'character', text: compiled.text }]);
      } else {
        setTurns((t) => [
          ...t,
          {
            role: 'character',
            text:
              '测试指令没看懂。用法：测试: 开心 90%　·　测试: 难过 40% 放松 30% | 自定义台词　·　' +
              '测试: 惊讶 80% > 开心 70%（一句话里的情绪变化）　·　测试: 反应 惊讶 70%; 开心 80%',
          },
        ]);
      }
      setBusy(false);
      return;
    }

    const decider = deciderRef.current;

    // 渐进式：台词一到就开口，判断层的结果后到再升级还没触发的节拍。
    // 感知延迟因此只剩输入层那一段 —— Jev 是在角色已经开口之后才回来的。
    //
    // 一轮对话的节奏（像人一样）：
    //   发出消息 → 角色"想"（视线移开、抿嘴）
    //            ↘ 同时 Jev 判断第一反应（只看用户那句话），到了就先上脸
    //   台词到了 → 带着第一反应开口
    //   整句判断到了 → 每一段换成 Jev 判断的情绪（一句话里情绪可以变）
    //   说完 → 表情慢慢淡成余韵，不是一下子回到面无表情
    if (decider instanceof HttpDecider && jev.progressive) {
      rt.think();
      let reaction: Array<[Emotion, number]> | null = null;
      let reactionMeta: JevMeta | null = null;
      const reactP = jev.reaction
        ? decider.react(text, ctx).then((r) => {
            if (!r) return;
            reaction = r.mix;
            reactionMeta = r.meta;
            rt.react(r.mix);
          })
        : Promise.resolve();
      try {
        const speech = await decider.speak(text, ctx);
        const compiled = rt.play(baselineAct(speech, reaction));
        setTurns((t) => [...t, { role: 'character', text: compiled.text }]);
        setBusy(false);

        // 不 await：让它在角色说话的同时跑
        void decider
          .judge(text, ctx, speech)
          .then(async (act) => {
            rt.upgrade(act);
            await reactP;
            setJevMeta({ ...decider.lastMeta, reaction: reactionMeta?.reaction });
            setJevError(decider.lastError);
          })
          .catch((e: unknown) => {
            setJevError(e instanceof Error ? e.message : String(e));
          });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const compiled = rt.play(fallbackAct(`输入层出错了：${msg}`));
        setTurns((t) => [...t, { role: 'character', text: compiled.text }]);
        setBusy(false);
      }
      return;
    }

    // 一次性：passthrough 模式和纯 Mock 走这条
    try {
      const act = await decider.decide(text, ctx);
      setLastAct(act);
      setJevMeta(decider instanceof HttpDecider ? decider.lastMeta : null);
      setJevError(decider instanceof HttpDecider ? decider.lastError : null);
      const compiled = rt.play(act);
      setTurns((t) => [...t, { role: 'character', text: compiled.text }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const act = fallbackAct(`决策层出错了：${msg}`);
      setLastAct(act);
      const compiled = rt.play(act);
      setTurns((t) => [...t, { role: 'character', text: compiled.text }]);
    } finally {
      setBusy(false);
    }
  }, [input, busy, turns, jev.progressive, jev.reaction]);



  return (
    <div className="app">
      <div className="stage">
        <canvas ref={canvasRef} />

        {loading && (
          <div className="overlay">
            <div className="loader">
              <div className="bar">
                <div className="fill" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <span>载入模型 {Math.round(progress * 100)}%</span>
            </div>
          </div>
        )}

        {error && (
          <div className="overlay">
            <div className="err">
              <strong>模型载入失败</strong>
              <code>{error}</code>
            </div>
          </div>
        )}

        <div className="hud">
          <div className="pipeline">
            文本 <span className="arrow">→</span>{' '}
            {jev.speechSource === 'deepseek' && useJev ? (
              <>
                <span className="live">{jev.speechModel}</span> <span className="arrow">→</span>{' '}
              </>
            ) : null}
            <span className={useJev && jev.configured ? 'live' : ''}>
              {useJev && jev.configured ? 'Jev' : 'Mock'} 表演判断
            </span>{' '}
            <span className="arrow">→</span> Act IR <span className="arrow">→</span> three-vrm
          </div>
        </div>

        {subtitle && !loading && <div className="subtitle">{subtitle}</div>}

        {jevError && (
          <div className="degraded" title={jevError}>
            判断层降级 · 表演退回基线，台词不受影响
          </div>
        )}

        {live && (
          <div className="tracks">
            <Track
              label="expression"
              value={
                live.expressions.length
                  ? live.expressions.map(([k, v]) => `${k} ${v.toFixed(2)}`).join('   ')
                  : '—'
              }
              active={live.expressions.length > 0}
            />
            <Track label="gaze" value={live.gaze} />
            <Track label="mouth" value={live.speaking ? 'speaking' : 'idle'} active={live.speaking} />
            <Track label="posture" value={live.posture} />
            <Track label="gesture" value={live.gestures.join(' + ') || 'off'} active={live.gestures.length > 0} />
            <div className="fps">{live.fps} fps</div>
          </div>
        )}
      </div>

      <aside className="panel">
        <header>
          <h1>Jev × three-vrm</h1>
          <p>一期：文本驱动的表演管线 · 半身表情</p>
        </header>

        <div className="log" ref={logRef}>
          {turns.map((t, i) => (
            <div key={i} className={`turn ${t.role}`}>
              {t.text}
            </div>
          ))}
          {busy && <div className="turn character thinking">思考中…</div>}
        </div>

        <div className="composer">
          <textarea
            value={input}
            placeholder="说点什么…　调试用「测试: 开心 90%」跳过模型直接看表情"
            onChange={(e) => {
              setInput(e.target.value);
              // 用户在打字：角色看着对方、在听
              runtimeRef.current?.setListening(e.target.value.trim().length > 0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={loading || !!error}
          />
          <button onClick={() => void send()} disabled={busy || loading || !input.trim()}>
            发送
          </button>
        </div>

        {/*
          这里刻意没有任何表演参数的控件。
          情绪、强度、视线、姿态全部由 Jev 判断，前端不提供竞争性的手动通道 ——
          留一个滑块就意味着"到底谁说了算"没有唯一答案。
          调参走 window.__jev（仅 dev），见 README。
          下面两项不是表演参数：语音合成是输出方式，Jev 开关是没配 key 时的回落。
        */}
        <div className="options">
          <label>
            <input type="checkbox" checked={tts} onChange={(e) => setTts(e.target.checked)} />
            语音合成（系统内置）
          </label>
          <label title={jev.endpoint ?? jev.backend ?? '在 .env.local 里配置后重启 dev server'}>
            <input
              type="checkbox"
              checked={useJev}
              disabled={!jev.configured}
              onChange={(e) => {
                setUseJev(e.target.checked);
                setJevMeta(null);
              }}
            />
            接入 Jev
            {!jev.configured
              ? '（未配置 .env.local）'
              : jev.mode === 'jev'
                ? `（${jev.backend}）`
                : '（自有服务）'}
          </label>
        </div>

        {jevError && (
          <details className="section" open>
            <summary>判断层降级原因</summary>
            <pre className="schema">{jevError}</pre>
          </details>
        )}

        {jevMeta && (
          <details className="section" open>
            <summary>
              Jev 的判断
              {jevMeta.backend && <span className="count">{jevMeta.backend}</span>}
              {jevMeta.credits && (
                <span className="count">
                  {jevMeta.credits.charged} credit · 余 {jevMeta.credits.remaining}
                </span>
              )}
              {jevMeta.costUsd && <span className="count">${jevMeta.costUsd}</span>}
            </summary>
            <div className="hint">
              只读。choice 回的是整个概率分布，不只是 top-1 —— 混合表情直接由它驱动。
              一句话按句切成最多 3 段，每段单独判断情绪；标「推导」的项不是 Jev 直接回答的。
            </div>
            <div className="sliders">
              {jevMeta.reaction && (
                <label className="on">
                  <span className="n">第一反应</span>
                  <span className="v-wide">
                    {topMix(jevMeta.reaction.probabilities)}
                  </span>
                  <span className="w">{jevMeta.reaction.confidence.toFixed(2)}</span>
                </label>
              )}
              {jevMeta.segments && jevMeta.segments.length > 1 &&
                jevMeta.segments.map((seg, i) => (
                  <label key={`seg${i}`} className="on">
                    <span className="n">段 {i + 1}</span>
                    <span className="v-wide" title={seg.text}>
                      {topMix(seg.probabilities)} ·{' '}
                      <span className="seg-text">{seg.text}</span>
                    </span>
                    <span className="w">{seg.confidence.toFixed(2)}</span>
                  </label>
                ))}
              {jevMeta.emotion && (
                <>
                  <label className="on">
                    <span className="n">{jevMeta.segments && jevMeta.segments.length > 1 ? '整句' : 'emotion'}</span>
                    <span className="v-wide">{jevMeta.emotion.choice}</span>
                    <span className="w">{jevMeta.emotion.confidence.toFixed(2)}</span>
                  </label>
                  {Object.entries(jevMeta.emotion.probabilities)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, p]) => (
                      <label key={k} className={p >= 0.15 ? 'on' : ''}>
                        <span className="n sub">└ {k}</span>
                        <span className="bar">
                          <i style={{ width: `${Math.round(p * 100)}%` }} />
                        </span>
                        <span className="w">{p.toFixed(2)}</span>
                      </label>
                    ))}
                </>
              )}
              {jevMeta.intensity && (
                <label className="on">
                  <span className="n">intensity</span>
                  <span className="v-wide">score {jevMeta.intensity.score.toFixed(2)}</span>
                  <span className="w">{jevMeta.intensity.confidence.toFixed(2)}</span>
                </label>
              )}
              {jevMeta.gaze && (
                <label className="on">
                  <span className="n">gaze</span>
                  <span className="v-wide">{jevMeta.gaze.choice}</span>
                  <span className="w">{jevMeta.gaze.confidence.toFixed(2)}</span>
                </label>
              )}
              {jevMeta.posture && (
                <label className={jevMeta.posture.derived ? 'on derived' : 'on'}>
                  <span className="n">{jevMeta.posture.derived ? '→ posture' : 'posture'}</span>
                  <span className="v-wide">{jevMeta.posture.choice}</span>
                  <span className="w">{jevMeta.posture.derived ? '推导' : jevMeta.posture.confidence.toFixed(2)}</span>
                </label>
              )}
              {jevMeta.looksAway != null && (
                <label className={`${jevMeta.looksAway > 0.5 ? 'on' : ''} ${jevMeta.looksAwayDerived ? 'derived' : ''}`}>
                  <span className="n">{jevMeta.looksAwayDerived ? '→ looks_away' : 'looks_away'}</span>
                  <span className="bar">
                    <i style={{ width: `${Math.round(jevMeta.looksAway * 100)}%` }} />
                  </span>
                  <span className="w">{jevMeta.looksAway.toFixed(2)}</span>
                </label>
              )}
              <label className={jevMeta.gesture ? 'on derived' : 'derived'}>
                <span className="n">→ 动作</span>
                <span className="v-wide">{jevMeta.gesture ? jevMeta.gesture.label : '不做动作'}</span>
                <span className="w">{jevMeta.gesture ? jevMeta.gesture.score.toFixed(2) : ''}</span>
              </label>
            </div>
          </details>
        )}

        {import.meta.env.DEV && (
          <details className="section preview" open>
            <summary>
              测试预览 <span className="count">dev</span>
              <button
                className="mini"
                onClick={(e) => {
                  e.preventDefault();
                  resetPreview();
                }}
              >
                复位
              </button>
            </summary>
            <div className="hint">
              只在开发环境出现，不进生产构建。手势会自动配上它通常伴随的情绪
              （配对表在 act/gestureRules.ts，Jev 驱动时用的是同一张）。
            </div>

            <div className="preview-row">
              <span className="preview-k">手势 · 从当前姿势开始播</span>
            </div>
            <div className="chips">
              {HAND_GESTURES.map((g) => (
                <button
                  key={g.id}
                  className={previewing === g.id ? 'on' : ''}
                  title={g.id}
                  onClick={() => previewGesture(g.id, g.pair)}
                >
                  {g.label}
                </button>
              ))}
            </div>

            <div className="player">
              <div className="player-bar">
                <button
                  className="mini"
                  disabled={!previewing || !previewClock}
                  onClick={() =>
                    runtimeRef.current?.setPreviewPaused(!(previewClock?.paused ?? true))
                  }
                >
                  {previewClock && !previewClock.paused ? '暂停' : '播放'}
                </button>
                <div className="speeds">
                  {[0.1, 0.25, 0.5, 1].map((v) => (
                    <button
                      key={v}
                      className={previewSpeed === v ? 'on' : ''}
                      onClick={() => {
                        setPreviewSpeed(v);
                        runtimeRef.current?.setPreviewSpeed(v);
                      }}
                    >
                      {v}×
                    </button>
                  ))}
                </div>
                <label className="hold">
                  <input
                    type="checkbox"
                    checked={previewLoop}
                    onChange={(e) => {
                      setPreviewLoop(e.target.checked);
                      runtimeRef.current?.setPreviewLoop(e.target.checked);
                    }}
                  />
                  循环
                </label>
              </div>

              {previewClock && (
                <div className="timeline">
                  <div className="track-wrap">
                    {previewClock.phases && (
                      <PhaseBands phases={previewClock.phases} duration={previewClock.duration} />
                    )}
                    <input
                      type="range"
                      min={0}
                      max={previewClock.duration}
                      step={1 / 120}
                      value={Math.min(previewClock.time, previewClock.duration)}
                      onChange={(e) => runtimeRef.current?.seekPreview(Number(e.target.value))}
                    />
                  </div>
                  <div className="timeline-meta">
                    <span>
                      {previewClock.time.toFixed(2)}s / {previewClock.duration.toFixed(2)}s
                    </span>
                    <span>{phaseName(previewClock.time, previewClock.phases)}</span>
                  </div>
                </div>
              )}
              <div className="hint">
                拖动时间轴会暂停在那一帧；慢速 + 循环适合反复看过渡段。
              </div>
            </div>

            <div className="preview-row">
              <span className="preview-k">表情</span>
            </div>
            <div className="chips">
              {EMOTIONS.map((e) => (
                <button
                  key={e}
                  className={previewing === e ? 'on' : ''}
                  onClick={() => previewEmotion(e)}
                >
                  {e}
                </button>
              ))}
            </div>
          </details>
        )}

        <details className="section">
          <summary>上一次的 Act IR</summary>
          <pre>{lastAct ? JSON.stringify(lastAct, null, 2) : '—'}</pre>
        </details>

      </aside>
    </div>
  );
}

/** IK 手势的四个时刻 → 接近 / 保持 / 撤回 三段，画在时间轴底下 */
function PhaseBands({ phases, duration }: { phases: number[]; duration: number }) {
  const [t0, t1, t2, t3] = phases;
  const pct = (t: number) => `${(t / duration) * 100}%`;
  return (
    <div className="phase-bands">
      <i className="in" style={{ left: pct(t0), width: pct(t1 - t0) }} />
      <i className="hold" style={{ left: pct(t1), width: pct(t2 - t1) }} />
      <i className="out" style={{ left: pct(t2), width: pct(t3 - t2) }} />
    </div>
  );
}

function phaseName(t: number, phases?: number[]) {
  if (!phases) return '';
  const [t0, t1, t2, t3] = phases;
  if (t < t0) return '准备';
  if (t < t1) return '接近';
  if (t <= t2) return '保持';
  if (t < t3) return '撤回';
  return '回到待机';
}

function Track({ label, value, active }: { label: string; value: string; active?: boolean }) {
  return (
    <div className={`track ${active ? 'on' : ''}`}>
      <span className="k">{label}</span>
      <span className="v">{value}</span>
    </div>
  );
}
