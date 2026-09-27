"""
Qwen3-TTS（mlx-audio）效果与速度测试。

    tts/.venv/bin/python tts/bench.py            # 全部
    tts/.venv/bin/python tts/bench.py styles     # 只跑某一组

输出到 tts/out/：每段一个 wav，外加 results.json（速度、时长、音高 / 能量统计）。
listen.py 再把它们拼成一个可以直接试听的页面。

四组测试：
  styles   同一句话、同一个音色，换不同的语气指令 —— 看"风格"到底有没有被控制住
  arc      一句话按段换语气（就是 Jev 按段判断情绪之后要做的事），和整句一个语气对比
  design   用文字描述造一个角色声音（VoiceDesign），看多次生成音色是否一致
  speed    流式首包延迟、实时率
"""

import json
import sys
import time
import wave
from pathlib import Path

import numpy as np
import mlx.core as mx
from mlx_audio.tts.utils import load_model

OUT = Path(__file__).parent / "out"
OUT.mkdir(exist_ok=True)

CUSTOM = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16"
DESIGN = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16"

LINE = "今天终于把这件事做完了，你要不要一起去吃个饭？"

# 语气指令：对应 Jev 的六种情绪，外加两种复合的
STYLES = [
    ("plain", None),
    ("happy", "用开心、轻快的语气说"),
    ("surprised", "用惊讶的语气说，好像完全没想到"),
    ("sad", "用难过、失落的语气说"),
    ("angry", "用生气、不耐烦的语气说"),
    ("relaxed", "用温柔、放松的语气说"),
    ("shy", "用害羞、有点不好意思的语气小声说"),
    ("thinking", "边想边说，语速慢一点，有点犹豫"),
]

# 上一轮真实对话里 DeepSeek 写的台词，Jev 按段判断为 happy 0.91 → neutral 0.76 → neutral 0.87
ARC = [
    ("哎哟恭喜啊！薪水这事儿吧……", "用开心、替对方高兴的语气说"),
    ("低一点是多少？", "用认真、关心的语气问"),
    ("差得太离谱就别急着答应。", "用认真、有点担心的语气劝"),
]
ARC2 = [
    ("诶？", "用非常惊讶的语气"),
    ("真的吗！", "用惊讶又开心的语气"),
    ("那也太好了吧。", "用开心、替对方高兴的语气说"),
]

CHARACTER = "二十岁左右的年轻女生，声音清亮甜美，带一点二次元少女感，语速稍快，说话活泼自然"

results: dict = {}


def to_np(audio) -> np.ndarray:
    return np.array(audio, dtype=np.float32).reshape(-1)


def save(name: str, audio: np.ndarray, sr: int) -> Path:
    path = OUT / f"{name}.wav"
    pcm = np.clip(audio, -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((pcm * 32767).astype(np.int16).tobytes())
    return path


def prosody(audio: np.ndarray, sr: int) -> dict:
    """
    很粗的韵律统计，只用来做横向比较（不同语气之间有没有差别）：
      f0_median / f0_range  音高（Hz），自相关法，只统计有声帧
      rms_db                平均能量
      voiced_ratio          有声帧占比（停顿多的语气会低）
    """
    frame = int(sr * 0.04)
    hop = int(sr * 0.01)
    f0s, energies = [], []
    lo, hi = int(sr / 500), int(sr / 70)  # 70~500Hz
    for start in range(0, len(audio) - frame, hop):
        x = audio[start : start + frame]
        e = float(np.sqrt(np.mean(x * x)) + 1e-9)
        energies.append(e)
        if e < 0.02:
            continue
        x = x - x.mean()
        ac = np.correlate(x, x, mode="full")[frame - 1 :]
        if ac[0] <= 0:
            continue
        seg = ac[lo:hi]
        lag = int(np.argmax(seg)) + lo
        if seg.max() / ac[0] > 0.45:
            f0s.append(sr / lag)
    f0 = np.array(f0s) if f0s else np.array([0.0])
    return {
        "f0_median": round(float(np.median(f0)), 1),
        "f0_range": round(float(np.percentile(f0, 90) - np.percentile(f0, 10)), 1),
        "rms_db": round(float(20 * np.log10(np.mean(energies) + 1e-9)), 1),
        "voiced_ratio": round(len(f0s) / max(1, len(energies)), 2),
    }


def synth(model, name: str, text: str, **kw) -> tuple[np.ndarray, int]:
    t = time.time()
    chunks = list(model.generate(text=text, lang_code="chinese", **kw))
    elapsed = time.time() - t
    sr = chunks[0].sample_rate
    audio = np.concatenate([to_np(c.audio) for c in chunks])
    dur = len(audio) / sr
    save(name, audio, sr)
    results[name] = {
        "text": text,
        "voice": kw.get("voice"),
        "instruct": kw.get("instruct"),
        "seconds": round(dur, 2),
        "gen_seconds": round(elapsed, 2),
        "rtf": round(elapsed / dur, 2),
        "chars_per_sec": round(len(text) / dur, 2),
        **prosody(audio, sr),
    }
    r = results[name]
    print(
        f"{name:28s} {r['seconds']:5.2f}s  生成 {r['gen_seconds']:5.2f}s  RTF {r['rtf']:4.2f}  "
        f"F0 {r['f0_median']:6.1f}Hz ±{r['f0_range']:5.1f}  {r['rms_db']:6.1f}dB  {r['chars_per_sec']:4.1f}字/s",
        flush=True,
    )
    return audio, sr


def pause_for(text: str, sr: int) -> np.ndarray:
    """段与段之间的停顿：句末标点长一点，省略号更长"""
    end = text.rstrip()[-1:] if text.strip() else ""
    secs = 0.32 if end in "…" else 0.22 if end in "。！？!?" else 0.12
    return np.zeros(int(sr * secs), dtype=np.float32)


def run_styles(model):
    print("\n== styles：同一句话、同一个音色，换语气 ==")
    for voice in ["vivian", "serena"]:
        for key, instruct in STYLES:
            synth(model, f"style_{voice}_{key}", LINE, voice=voice, instruct=instruct)


def run_arc(model):
    print("\n== arc：一句话按段换语气 vs 整句一个语气 ==")
    for tag, arc in [("salary", ARC), ("surprise", ARC2)]:
        pieces = []
        sr = 24000
        for i, (text, instruct) in enumerate(arc):
            audio, sr = synth(model, f"arc_{tag}_seg{i + 1}", text, voice="vivian", instruct=instruct)
            pieces.append(audio)
            if i < len(arc) - 1:
                pieces.append(pause_for(text, sr))
        joined = np.concatenate(pieces)
        save(f"arc_{tag}_segmented", joined, sr)
        results[f"arc_{tag}_segmented"] = {
            "text": "".join(t for t, _ in arc),
            "voice": "vivian",
            "instruct": " → ".join(i for _, i in arc),
            "seconds": round(len(joined) / sr, 2),
            "segments": [results[f"arc_{tag}_seg{i + 1}"]["seconds"] for i in range(len(arc))],
            **prosody(joined, sr),
        }
        synth(model, f"arc_{tag}_whole", "".join(t for t, _ in arc), voice="vivian", instruct=arc[0][1])


def run_design(model):
    print("\n== design：用文字造角色声音 ==")
    # 同一个描述生成三次，看音色是否稳定；再加上情绪
    for i in range(3):
        synth(model, f"design_take{i + 1}", LINE, instruct=CHARACTER)
    for key, extra in [("happy", "，此刻特别开心"), ("sad", "，此刻很难过、有点委屈"), ("surprised", "，此刻非常惊讶")]:
        synth(model, f"design_{key}", LINE, instruct=CHARACTER + extra)


def run_speed(model):
    print("\n== speed：流式首包延迟 ==")
    for interval in [0.5, 1.0]:
        t = time.time()
        first = None
        total = 0.0
        sr = 24000
        for chunk in model.generate(
            text=LINE, voice="vivian", instruct="用开心、轻快的语气说", lang_code="chinese",
            stream=True, streaming_interval=interval,
        ):
            if first is None:
                first = time.time() - t
            sr = chunk.sample_rate
            total += to_np(chunk.audio).size / sr
        elapsed = time.time() - t
        results[f"stream_{interval}"] = {
            "first_chunk_seconds": round(first or 0, 2),
            "total_gen_seconds": round(elapsed, 2),
            "audio_seconds": round(total, 2),
        }
        print(f"streaming_interval={interval}: 首包 {first:.2f}s，共 {elapsed:.2f}s 生成 {total:.2f}s 音频", flush=True)


def main():
    groups = sys.argv[1:] or ["styles", "arc", "speed", "design"]
    if any(g in groups for g in ["styles", "arc", "speed"]):
        t = time.time()
        model = load_model(CUSTOM)
        print(f"CustomVoice 加载 {time.time() - t:.1f}s，speakers={model.supported_speakers}", flush=True)
        # 预热一次（首次调用会编译 Metal kernel，不计入）
        list(model.generate(text="你好。", voice="vivian", lang_code="chinese"))
        if "styles" in groups:
            run_styles(model)
        if "arc" in groups:
            run_arc(model)
        if "speed" in groups:
            run_speed(model)
        del model
        mx.clear_cache()
    if "design" in groups:
        t = time.time()
        model = load_model(DESIGN)
        print(f"VoiceDesign 加载 {time.time() - t:.1f}s", flush=True)
        list(model.generate(text="你好。", instruct=CHARACTER, lang_code="chinese"))
        run_design(model)

    old = {}
    rp = OUT / "results.json"
    if rp.exists():
        old = json.loads(rp.read_text())
    old.update(results)
    rp.write_text(json.dumps(old, ensure_ascii=False, indent=2))
    print(f"\n写入 {rp}（{len(old)} 条）")


if __name__ == "__main__":
    main()
