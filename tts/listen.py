"""
把 bench.py 的结果拼成一个自包含的试听页（音频内嵌，单文件，直接双击打开）。

    tts/.venv/bin/python tts/listen.py      # → tts/out/listen.html

wav 先用 macOS 自带的 afconvert 转成 AAC（64kbps；24kHz 单声道下 96kbps 会被拒绝），页面才不会几十 MB。
"""

import base64
import html
import json
import subprocess
from pathlib import Path

OUT = Path(__file__).parent / "out"
results = json.loads((OUT / "results.json").read_text())

LABEL = {
    "plain": "无指令",
    "happy": "开心",
    "surprised": "惊讶",
    "sad": "难过",
    "angry": "生气",
    "relaxed": "温柔放松",
    "shy": "害羞",
    "thinking": "边想边说",
}


def audio_uri(name: str) -> str:
    wav = OUT / f"{name}.wav"
    m4a = OUT / f"{name}.m4a"
    if not m4a.exists() or m4a.stat().st_mtime < wav.stat().st_mtime:
        subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "64000", str(wav), str(m4a)], check=True)
    return "data:audio/mp4;base64," + base64.b64encode(m4a.read_bytes()).decode()


def row(name: str, title: str, note: str = "") -> str:
    r = results[name]
    stats = []
    if "rtf" in r:
        stats.append(f"生成 {r['gen_seconds']}s / 音频 {r['seconds']}s（RTF {r['rtf']}）")
    else:
        stats.append(f"音频 {r['seconds']}s")
    stats.append(f"音高 {r['f0_median']}Hz，起伏 {r['f0_range']}Hz，{r['rms_db']}dB")
    if "chars_per_sec" in r:
        stats.append(f"{r['chars_per_sec']} 字/秒")
    instruct = html.escape(r.get("instruct") or "（无）")
    return f"""
    <div class="clip">
      <div class="head"><span class="title">{html.escape(title)}</span><span class="note">{html.escape(note)}</span></div>
      <audio controls preload="none" src="{audio_uri(name)}"></audio>
      <div class="meta">指令：{instruct}</div>
      <div class="meta">{' · '.join(stats)}</div>
    </div>"""


sections = []

for voice in ["vivian", "serena"]:
    rows = [row(f"style_{voice}_{k}", LABEL[k]) for k in LABEL if f"style_{voice}_{k}" in results]
    if rows:
        sections.append(
            f"<h2>同一句话换语气 · {voice.capitalize()}</h2>"
            f"<p class='lead'>「{html.escape(results[f'style_{voice}_plain']['text'])}」—— 听语气有没有被指令控制住。</p>"
            + "".join(rows)
        )

for tag, title in [("salary", "真实对话那句"), ("surprise", "惊讶 → 开心")]:
    if f"arc_{tag}_segmented" in results:
        seg = results[f"arc_{tag}_segmented"]
        sections.append(
            f"<h2>一句话里换语气 · {title}</h2>"
            f"<p class='lead'>按段合成（每段一个语气，Jev 按段判断情绪后就是这样用）vs 整句一个语气。"
            f"注意段与段的接缝是否自然、音色是否一致。各段时长：{seg['segments']} 秒。</p>"
            + row(f"arc_{tag}_segmented", "按段合成", "每段各自的语气")
            + row(f"arc_{tag}_whole", "整句一次", "只用第一段的语气")
        )

design = [n for n in ["design_take1", "design_take2", "design_take3"] if n in results]
if design:
    sections.append(
        "<h2>用文字造角色声音 · VoiceDesign</h2>"
        f"<p class='lead'>描述：{html.escape(results['design_take1']['instruct'])}。"
        "同一个描述生成三次 —— 听音色是否每次都一样（不一样的话就不能直接拿来当固定角色声音）。</p>"
        + "".join(row(n, f"第 {i + 1} 次") for i, n in enumerate(design))
        + "".join(
            row(f"design_{k}", f"+ {LABEL[k]}")
            for k in ["happy", "sad", "surprised"]
            if f"design_{k}" in results
        )
    )

speed = [(k, v) for k, v in results.items() if k.startswith("stream_")]
if speed:
    items = "".join(
        f"<li>流式间隔 {k.split('_')[1]}s：首包 <b>{v['first_chunk_seconds']}s</b>，"
        f"{v['total_gen_seconds']}s 生成了 {v['audio_seconds']}s 音频</li>"
        for k, v in speed
    )
    sections.append(f"<h2>速度</h2><ul class='speed'>{items}</ul>")

page = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Qwen3-TTS 试听</title>
<style>
  :root {{ --bg:#f7f6f3; --card:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#e5e3de; --accent:#3b6fd8; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#141416; --card:#1d1d20; --fg:#ececef; --muted:#9a9aa2; --line:#2c2c31; --accent:#7ea2f0; }}
  }}
  body {{ margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 -apple-system, "PingFang SC", sans-serif; }}
  main {{ max-width:860px; margin:0 auto; padding:32px 16px 64px; }}
  h1 {{ font-size:24px; margin:0 0 4px; }}
  h2 {{ font-size:17px; margin:36px 0 6px; }}
  .lead {{ color:var(--muted); margin:0 0 12px; font-size:14px; }}
  .clip {{ background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin:8px 0; }}
  .head {{ display:flex; gap:10px; align-items:baseline; }}
  .title {{ font-weight:600; }}
  .note {{ color:var(--muted); font-size:13px; }}
  audio {{ width:100%; margin:8px 0 4px; }}
  .meta {{ color:var(--muted); font-size:12.5px; }}
  .speed li {{ margin:4px 0; }}
</style>
</head>
<body><main>
<h1>Qwen3-TTS 试听</h1>
<p class="lead">本机 Apple M2 Max · mlx-audio · 1.7B bf16。RTF = 生成耗时 / 音频时长，小于 1 才能边生成边播。
音高、能量是粗略统计，只用来横向对比不同语气。</p>
{''.join(sections)}
</main></body></html>"""

(OUT / "listen.html").write_text(page)
print(f"写入 {OUT / 'listen.html'}（{(OUT / 'listen.html').stat().st_size / 1e6:.1f} MB）")
