"""
用文字造女声（Qwen3-TTS VoiceDesign），测音色能不能保持一致。

    tts/.venv/bin/python tts/design_voices.py      # → tts/out/voices.html

问题在于：VoiceDesign 每次生成都会按描述重新"想象"一个声音。对话里一句话是按段合成的
（每段一个语气），所以同一句话里前后几段、前后两轮对话，都必须听起来是同一个人。

每个设计出来的声音做两件事：
  分段   「诶？真的吗！」「那也太好了吧。」「不过……你可别太累着自己。」各自合成，
         语气分别是惊讶 / 开心 / 担心 —— 和对话里按段换语气完全一样
  两轮   整句不带情绪合成两遍 —— 模拟前后两轮对话

一致性原本想用 MFCC 均值的余弦相似度衡量（VoiceDesign / CustomVoice 的权重里都不带声纹编码器），
并用两个预设音色做参照。实测**校准失败**：预设音色（说话人固定）自己的分段之间相似度只有 0.21~0.28，
反而低于两个不同的人（Vivian × Serena 0.84）—— 分段的文字和语气都不同，MFCC 均值对内容比对说话人
更敏感。所以页面上只保留"两轮整句的音高差"作参考，结论以耳朵为准。
要可靠的数字需要真正的声纹模型（Qwen3-TTS Base 里的说话人编码器，约 2.5GB）。
"""

import base64
import html
import json
import subprocess
import time
import wave
from pathlib import Path

import numpy as np
import mlx.core as mx
from scipy.fft import dct
from mlx_audio.tts.utils import load_model

OUT = Path(__file__).parent / "out" / "voices"
OUT.mkdir(parents=True, exist_ok=True)

DESIGN = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16"
CUSTOM = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16"

VOICES = [
    ("genki", "元气少女", "十七八岁的元气少女，声音清脆明亮、音调偏高，语速偏快，说话充满活力"),
    ("gentle", "温柔姐姐", "二十五岁左右的温柔女性，声音柔和温暖、音调适中，语速不紧不慢，让人安心"),
    ("cool", "清冷御姐", "二十多岁的成熟女性，声音清冷、音调偏低，语速偏慢，说话干练沉稳"),
    ("soft", "软萌少女", "声音软糯甜美的少女，音调偏高，带一点撒娇的感觉，语速稍慢"),
]

SEGMENTS = [
    ("诶？真的吗！", "此刻很惊讶", "用非常惊讶的语气说"),
    ("那也太好了吧。", "此刻特别开心", "用开心、轻快的语气说"),
    ("不过……你可别太累着自己。", "此刻有点担心对方，语气放轻", "用温柔、有点担心的语气说"),
]
WHOLE = "".join(t for t, _, _ in SEGMENTS)
PAUSES = [0.22, 0.32]  # 段与段之间：叹号后、句号后（和 src/speech/voice.ts 一致）

results: dict = {}


def to_np(audio) -> np.ndarray:
    return np.array(audio, dtype=np.float32).reshape(-1)


def save(name: str, audio: np.ndarray, sr: int) -> None:
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())


def mfcc_mean(audio: np.ndarray, sr: int) -> np.ndarray:
    """有声帧的 MFCC（第 1~19 维）均值。倒谱均值反映的是声道 / 音色，和说了什么关系不大"""
    frame, hop, nfft = int(0.025 * sr), int(0.01 * sr), 1024
    window = np.hamming(frame)
    frames = np.stack([audio[i : i + frame] * window for i in range(0, len(audio) - frame, hop)])
    power = np.abs(np.fft.rfft(frames, n=nfft)) ** 2
    # 梅尔滤波器组：60Hz ~ 7600Hz，40 个
    mel = lambda f: 2595 * np.log10(1 + f / 700)  # noqa: E731
    imel = lambda m: 700 * (10 ** (m / 2595) - 1)  # noqa: E731
    pts = imel(np.linspace(mel(60), mel(7600), 42))
    bins = np.floor((nfft + 1) * pts / sr).astype(int)
    fb = np.zeros((40, nfft // 2 + 1))
    for m in range(1, 41):
        l, c, r = bins[m - 1], bins[m], bins[m + 1]
        fb[m - 1, l:c] = (np.arange(l, c) - l) / max(1, c - l)
        fb[m - 1, c:r] = (r - np.arange(c, r)) / max(1, r - c)
    logmel = np.log(power @ fb.T + 1e-10)
    ceps = dct(logmel, type=2, norm="ortho", axis=1)[:, 1:20]
    energy = (frames**2).mean(axis=1)
    voiced = energy > np.percentile(energy, 40)  # 只取能量高的 60% 帧，去掉静音和气口
    return ceps[voiced].mean(axis=0)


def f0_median(audio: np.ndarray, sr: int) -> float:
    frame, hop = int(sr * 0.04), int(sr * 0.01)
    lo, hi = int(sr / 500), int(sr / 70)
    f0s = []
    for start in range(0, len(audio) - frame, hop):
        x = audio[start : start + frame]
        if np.sqrt(np.mean(x * x)) < 0.02:
            continue
        x = x - x.mean()
        ac = np.correlate(x, x, mode="full")[frame - 1 :]
        seg = ac[lo:hi]
        if ac[0] > 0 and seg.max() / ac[0] > 0.45:
            f0s.append(sr / (int(np.argmax(seg)) + lo))
    return float(np.median(f0s)) if f0s else 0.0


def cos(a: np.ndarray, b: np.ndarray) -> float:
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def gen(model, name: str, text: str, **kw) -> tuple[np.ndarray, int]:
    t = time.time()
    chunks = list(model.generate(text=text, lang_code="chinese", **kw))
    sr = chunks[0].sample_rate
    audio = np.concatenate([to_np(c.audio) for c in chunks])
    save(name, audio, sr)
    results[name] = {
        "text": text,
        "instruct": kw.get("instruct"),
        "voice": kw.get("voice"),
        "seconds": round(len(audio) / sr, 2),
        "gen_seconds": round(time.time() - t, 2),
        "f0": round(f0_median(audio, sr), 1),
        "mfcc": mfcc_mean(audio, sr).tolist(),
    }
    print(f"{name:22s} {results[name]['seconds']:5.2f}s  F0 {results[name]['f0']:6.1f}Hz  「{text}」", flush=True)
    return audio, sr


def run_set(model, key: str, make_kw) -> None:
    """一个声音：三段分别合成 + 拼接，再整句合成两遍"""
    pieces, sr = [], 24000
    for i, (text, feeling, tone) in enumerate(SEGMENTS):
        audio, sr = gen(model, f"{key}_seg{i + 1}", text, **make_kw(feeling, tone))
        pieces.append(audio)
        if i < len(PAUSES):
            pieces.append(np.zeros(int(sr * PAUSES[i]), dtype=np.float32))
    save(f"{key}_arc", np.concatenate(pieces), sr)
    for take in (1, 2):
        gen(model, f"{key}_take{take}", WHOLE, **make_kw(None, None))


def main() -> None:
    model = load_model(DESIGN)
    list(model.generate(text="你好。", instruct=VOICES[0][2], lang_code="chinese"))  # 预热
    for key, _, desc in VOICES:
        print(f"\n== {key}：{desc}")
        run_set(model, key, lambda feeling, _tone, d=desc: {"instruct": f"{d}，{feeling}" if feeling else d})
    del model
    mx.clear_cache()

    model = load_model(CUSTOM)
    list(model.generate(text="你好。", voice="vivian", lang_code="chinese"))
    for sp in ["vivian", "serena"]:
        print(f"\n== 预设 {sp}（参照）")
        run_set(model, sp, lambda _feeling, tone, s=sp: {"voice": s, "instruct": tone})

    (OUT / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    report()


def report() -> None:
    res = json.loads((OUT / "results.json").read_text())
    v = {k: np.array(r["mfcc"]) for k, r in res.items()}

    def within(key: str) -> dict:
        segs = [f"{key}_seg{i}" for i in (1, 2, 3)]
        seg_sims = [cos(v[a], v[b]) for i, a in enumerate(segs) for b in segs[i + 1 :]]
        return {
            "segments": round(float(np.mean(seg_sims)), 3),
            "segments_min": round(float(np.min(seg_sims)), 3),
            "takes": round(cos(v[f"{key}_take1"], v[f"{key}_take2"]), 3),
            "f0_segments": [res[s]["f0"] for s in segs],
            "f0_takes": [res[f"{key}_take{t}"]["f0"] for t in (1, 2)],
        }

    keys = [k for k, _, _ in VOICES] + ["vivian", "serena"]
    stats = {k: within(k) for k in keys}
    # 不同的人：两两比较 take1
    between = {
        f"{a}×{b}": round(cos(v[f"{a}_take1"], v[f"{b}_take1"]), 3)
        for i, a in enumerate(keys)
        for b in keys[i + 1 :]
    }
    ref_same = min(stats["vivian"]["segments_min"], stats["serena"]["segments_min"])
    ref_diff = between["vivian×serena"]

    print("\n== 一致性（MFCC 余弦相似度，越接近 1 越像同一个人）")
    print(f"参照：同一个人（预设音色分段间最低）{ref_same:.3f} · 不同的人（Vivian × Serena）{ref_diff:.3f}")
    for k in keys:
        s = stats[k]
        print(
            f"{k:8s} 分段间 平均 {s['segments']:.3f} 最低 {s['segments_min']:.3f} · 两轮 {s['takes']:.3f}"
            f" · 音高 分段 {s['f0_segments']} 两轮 {s['f0_takes']}"
        )
    print("不同声音之间：", ", ".join(f"{k} {x:.3f}" for k, x in sorted(between.items(), key=lambda kv: -kv[1])[:6]), "…")
    (OUT / "stats.json").write_text(
        json.dumps({"stats": stats, "between": between, "ref_same": ref_same, "ref_diff": ref_diff}, ensure_ascii=False, indent=2)
    )
    page(res, stats, ref_same, ref_diff)


def uri(name: str) -> str:
    wav, m4a = OUT / f"{name}.wav", OUT / f"{name}.m4a"
    subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "64000", str(wav), str(m4a)], check=True)
    return "data:audio/mp4;base64," + base64.b64encode(m4a.read_bytes()).decode()


def page(res: dict, stats: dict, ref_same: float, ref_diff: float) -> None:
    def clip(name: str, title: str) -> str:
        return (
            f"<div class='clip'><span class='t'>{html.escape(title)}</span>"
            f"<audio controls preload='none' src='{uri(name)}'></audio></div>"
        )

    blocks = []
    labels = {k: (label, desc) for k, label, desc in VOICES}
    labels["vivian"] = ("预设 Vivian（参照）", "CustomVoice 预设音色，说话人固定")
    labels["serena"] = ("预设 Serena（参照）", "CustomVoice 预设音色，说话人固定")
    for key, (label, desc) in labels.items():
        s = stats[key]
        a, b = s["f0_takes"]
        drift = abs(a - b) / max(1.0, min(a, b)) * 100
        blocks.append(
            f"<section><h2>{html.escape(label)}</h2><p class='desc'>{html.escape(desc)}</p>"
            f"<p class='num'>两轮整句（同一段文字、同一个描述）的音高：{a} / {b} Hz，差 <b>{drift:.0f}%</b>"
            f" · 两轮的 MFCC 相似度 {s['takes']}</p>"
            + clip(f"{key}_arc", "一句话分三段合成（惊讶 → 开心 → 担心），拼起来 —— 听前后是不是同一个人")
            + clip(f"{key}_take1", "整句 · 第一轮")
            + clip(f"{key}_take2", "整句 · 第二轮 —— 和第一轮是不是同一个人")
            + "</section>"
        )

    doc = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>女声设计试听</title>
<style>
:root{{--bg:#f7f6f3;--card:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e3de}}
@media (prefers-color-scheme:dark){{:root{{--bg:#141416;--card:#1d1d20;--fg:#ececef;--muted:#9a9aa2;--line:#2c2c31}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"PingFang SC",sans-serif}}
main{{max-width:820px;margin:0 auto;padding:32px 16px 64px}}
h1{{font-size:24px;margin:0 0 6px}} h2{{font-size:17px;margin:0 0 2px}}
section{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:14px 0}}
.desc,.lead,.num{{color:var(--muted);font-size:13.5px;margin:2px 0 8px}}
.clip{{margin:8px 0}} .t{{font-size:13px;display:block}} audio{{width:100%}}
</style></head><body><main>
<h1>女声设计试听</h1>
<p class="lead">每个声音：一句话分三段合成（每段一个语气，和对话里一样），再整句合成两遍（模拟前后两轮）。<br>
<b>请以耳朵为准。</b>客观指标（MFCC 音色指纹）没有通过校准：预设音色（说话人固定）自己的分段之间
相似度最低只有 {ref_same:.2f}，反而低于两个不同的人 Vivian × Serena 的 {ref_diff:.2f} ——
分段的文字和语气都不一样，这个指标对内容比对"是谁在说"更敏感，所以分段之间的数字没有意义。<br>
比较有参考价值的是两轮整句的音高差：同一个预设音色两轮之间差 4~8%。</p>
{''.join(blocks)}
</main></body></html>"""
    (OUT.parent / "voices.html").write_text(doc)
    print(f"\n写入 {OUT.parent / 'voices.html'}（{(OUT.parent / 'voices.html').stat().st_size / 1e6:.1f} MB）")


if __name__ == "__main__":
    main()
