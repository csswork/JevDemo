import { useCallback, useEffect, useRef, useState } from 'react';
import { Runtime, type LiveState } from './runtime';
import { MockDecider } from './jev/mockDecider';
import { HttpDecider, probeJev, type JevMeta, type JevStatus } from './jev/httpDecider';
import type { ActDecider } from './jev/decider';
import { EMOTIONS, fallbackAct, GESTURES, type ActScript, type Emotion } from './act/schema';
import { DEFAULT_CEILING } from './vrm/expressions';
import { ACT_SCHEMA_PROMPT } from './jev/actSchemaPrompt';
import './App.css';

const MODEL_URL = `${import.meta.env.BASE_URL}models/Sendagaya_Shino.vrm`;

interface Turn {
  role: 'user' | 'character';
  text: string;
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

  const [slots, setSlots] = useState<string[]>([]);
  const [slotValues, setSlotValues] = useState<Record<string, number>>({});
  const [bodyMotion, setBodyMotion] = useState(0.25);
  const [ceiling, setCeilingState] = useState<Record<string, number>>({ ...DEFAULT_CEILING } as Record<string, number>);
  const [gestures, setGestures] = useState(false);
  const [micro, setMicro] = useState(true);

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
        setSlots(rt.expressionSlots);
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
  useEffect(() => runtimeRef.current?.setBodyMotion(bodyMotion), [bodyMotion]);
  useEffect(() => runtimeRef.current?.setGesturesEnabled(gestures), [gestures]);
  useEffect(() => runtimeRef.current?.setMicroExpressions(micro), [micro]);

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

  const send = useCallback(async () => {
    const text = input.trim();
    const rt = runtimeRef.current;
    if (!text || !rt || busy) return;

    setInput('');
    setBusy(true);
    setJevMeta(null);
    const history = turns.slice(-6);
    setTurns((t) => [...t, { role: 'user', text }]);

    try {
      const decider = deciderRef.current;
      const act = await decider.decide(text, { history });
      setLastAct(act);
      setJevMeta(decider instanceof HttpDecider ? decider.lastMeta : null);
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
  }, [input, busy, turns]);

  const setSlot = (name: string, v: number) => {
    setSlotValues((s) => ({ ...s, [name]: v }));
    runtimeRef.current?.overrideExpression(name, v === 0 ? null : v);
  };

  const resetSlots = () => {
    setSlotValues({});
    runtimeRef.current?.clearExpressionOverrides();
  };

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
            <Track
              label="gesture"
              value={gestures ? live.gestures.join(' + ') || '—' : 'off'}
              active={gestures && live.gestures.length > 0}
            />
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
          {busy && <div className="turn character thinking">决策中…</div>}
        </div>

        <div className="composer">
          <textarea
            value={input}
            placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
            onChange={(e) => setInput(e.target.value)}
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

        <details className="section" open>
          <summary>情绪试演</summary>
          <div className="hint">走完整表情层：交叉淡入、换表情时补眨眼、叠加微表情</div>
          <div className="chips">
            {EMOTIONS.map((e) => (
              <button key={e} onClick={() => runtimeRef.current?.testEmotion(e as Emotion)}>
                {e}
              </button>
            ))}
            <button onClick={() => runtimeRef.current?.character?.expression.wink('left')}>
              wink
            </button>
          </div>
          <div className="hint" style={{ paddingTop: 4 }}>
            标定上限：Jev 给的是语义强度，这里换算成该模型实际能用的 blendshape 权重。
            这个模型 happy 超过 0.6 就会闭眼。
          </div>
          <div className="sliders">
            {EMOTIONS.filter((e) => e !== 'neutral').map((e) => (
              <label key={e} className="on">
                <span className="n">{e}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={ceiling[e] ?? 1}
                  onChange={(ev) => {
                    const v = Number(ev.target.value);
                    setCeilingState((c) => ({ ...c, [e]: v }));
                    runtimeRef.current?.setCeiling(e as Emotion, v);
                  }}
                />
                <span className="w">{(ceiling[e] ?? 1).toFixed(2)}</span>
              </label>
            ))}
          </div>
        </details>

        <details className="section" open>
          <summary>
            表情槽 <span className="count">{slots.length}</span>
            <button
              className="mini"
              onClick={(e) => {
                e.preventDefault();
                resetSlots();
              }}
            >
              复位
            </button>
          </summary>
          <div className="hint">
            模型上真实存在的 blendshape。拨动即钉死该槽，归零则交还给自动系统。
          </div>
          <div className="sliders">
            {slots.map((name) => (
              <label key={name} className={slotValues[name] ? 'on' : ''}>
                <span className="n">{name}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={slotValues[name] ?? 0}
                  onChange={(e) => setSlot(name, Number(e.target.value))}
                />
                <span className="w">{(slotValues[name] ?? 0).toFixed(2)}</span>
              </label>
            ))}
          </div>
        </details>

        <details className="section">
          <summary>运行选项</summary>
          <div className="options">
            <label>
              <input type="checkbox" checked={micro} onChange={(e) => setMicro(e.target.checked)} />
              微表情
            </label>
            <label>
              <input type="checkbox" checked={tts} onChange={(e) => setTts(e.target.checked)} />
              语音合成（系统内置）
            </label>
            <label>
              <input
                type="checkbox"
                checked={gestures}
                onChange={(e) => setGestures(e.target.checked)}
              />
              手势（半身景别下默认关）
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
                  ? `（${jev.backend} · 台词来自 ${
                      jev.speechSource === 'deepseek' ? jev.speechModel : '规则模板'
                    }）`
                  : '（自有服务）'}
            </label>
            <label className="slider-row">
              <span>肢体动作</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={bodyMotion}
                onChange={(e) => setBodyMotion(Number(e.target.value))}
              />
              <span className="w">{bodyMotion.toFixed(2)}</span>
            </label>
          </div>
          {gestures && (
            <div className="chips">
              {GESTURES.map((g) => (
                <button key={g} onClick={() => runtimeRef.current?.testGesture(g)}>
                  {g}
                </button>
              ))}
            </div>
          )}
        </details>

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
              choice 回的是整个概率分布，不只是 top-1 —— 混合表情直接由它驱动。
              confidence 低时表演幅度会自动收着来。
            </div>
            <div className="sliders">
              {jevMeta.emotion && (
                <>
                  <label className="on">
                    <span className="n">emotion</span>
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
                <label className="on">
                  <span className="n">posture</span>
                  <span className="v-wide">{jevMeta.posture.choice}</span>
                  <span className="w">{jevMeta.posture.confidence.toFixed(2)}</span>
                </label>
              )}
              {jevMeta.looksAway != null && (
                <label className={jevMeta.looksAway > 0.5 ? 'on' : ''}>
                  <span className="n">looks_away</span>
                  <span className="bar">
                    <i style={{ width: `${Math.round(jevMeta.looksAway * 100)}%` }} />
                  </span>
                  <span className="w">{jevMeta.looksAway.toFixed(2)}</span>
                </label>
              )}
            </div>
          </details>
        )}

        <details className="section">
          <summary>上一次的 Act IR</summary>
          <pre>{lastAct ? JSON.stringify(lastAct, null, 2) : '—'}</pre>
        </details>

        <details className="section">
          <summary>Act IR 契约（自建服务实现参考）</summary>
          <pre className="schema">{ACT_SCHEMA_PROMPT}</pre>
        </details>
      </aside>
    </div>
  );
}

function Track({ label, value, active }: { label: string; value: string; active?: boolean }) {
  return (
    <div className={`track ${active ? 'on' : ''}`}>
      <span className="k">{label}</span>
      <span className="v">{value}</span>
    </div>
  );
}
