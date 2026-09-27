"""
本地语音服务：Qwen3-TTS（mlx-audio）。预设音色 + 用文字设计的音色。

    tts/.venv/bin/python tts/server.py

一般不用手动启动：`npm run dev` 时 server/ttsProxy.ts 发现它没在跑会自动拉起来。

两个模型，各管一类音色：
  CustomVoice  预设音色（vivian / serena ……），说话人固定，语气由 instruct 控制
  VoiceDesign  设计音色（tts/voices.json 里的 genki / cool ……），音色由一段文字描述"想象"出来，
               语气拼在描述后面。每次生成都会重新采样音色，所以每个设计音色固定一个随机种子，
               让前后几段、前后几轮尽量像同一个人（试听结论见 tts/design_voices.py）
两个模型都加载约 9GB 内存。voices.json 为空时不加载 VoiceDesign。

接口（只监听 127.0.0.1，前端经 Vite 代理 /api/tts/* 访问）：
    GET  /health  {"ready", "speaker": 默认音色, "speakers": 预设音色 id,
                   "designed": [{id, name, desc}], "designed_ready", "model", "error"}
    POST /synth {text, instruct?, speaker?}
                   → audio/wav（24kHz 单声道 16bit）。speaker 可以是预设或设计音色的 id，
                     不认识就用默认音色。响应头 X-Audio-Seconds / X-Gen-Seconds
    POST /synth {..., stream: true}
                   → 原始 PCM（16bit 小端单声道），边生成边写，写完断开连接。
                     响应头 X-Sample-Rate。一句话的第一段用它：首包约 0.25s

按段合成：一句话被切成几段，每段带自己的语气指令（Jev 按段判断的情绪），
所以这里一次只合成一段，不做整句。GPU 只有一块，请求串行处理。

为什么不直接用 mlx_audio.server：它是 OpenAI 兼容接口，没有语气指令（instruct）这个参数，
而按段换语气正是接这个模型的目的。
"""

import io
import json
import os
import sys
import threading
import time
import wave
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

MODEL_ID = os.environ.get("TTS_MODEL", "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16")
DESIGN_MODEL_ID = os.environ.get("TTS_DESIGN_MODEL", "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16")
SPEAKER = os.environ.get("TTS_SPEAKER", "vivian")
PORT = int(os.environ.get("TTS_PORT", "8765"))
VOICES_FILE = Path(__file__).parent / "voices.json"

state: dict = {"model": None, "design": None, "error": None, "design_error": None}
lock = threading.Lock()


def log(msg: str) -> None:
    print(msg, flush=True)


def designed_voices() -> list[dict]:
    """tts/voices.json：[{id, name, desc, prompt}]。改了要重启语音服务"""
    try:
        return [v for v in json.loads(VOICES_FILE.read_text()) if v.get("id") and v.get("prompt")]
    except FileNotFoundError:
        return []
    except Exception as e:  # noqa: BLE001 —— 配置写坏了不能拖垮预设音色
        log(f"voices.json 读不了：{e!r}")
        return []


DESIGNED = {v["id"]: v for v in designed_voices()}


def load() -> None:
    from mlx_audio.tts.utils import load_model

    # 先加载预设音色：它就绪了就能开口，设计音色晚一点没关系
    try:
        t = time.time()
        model = load_model(MODEL_ID)
        # 预热一次：首次调用会编译 Metal kernel，不预热的话第一句话要多等好几秒
        list(model.generate(text="你好。", voice=SPEAKER, lang_code="chinese"))
        state["model"] = model
        log(f"就绪：{MODEL_ID} · 默认 {SPEAKER}（{time.time() - t:.1f}s）")
    except Exception as e:  # noqa: BLE001 —— 任何加载失败都要报给前端，而不是让进程默默死掉
        state["error"] = repr(e)
        log(f"加载失败：{e!r}")
        return

    if not DESIGNED:
        return
    try:
        t = time.time()
        design = load_model(DESIGN_MODEL_ID)
        first = next(iter(DESIGNED.values()))
        list(design.generate(text="你好。", instruct=first["prompt"], lang_code="chinese"))
        state["design"] = design
        log(f"就绪：设计音色 {', '.join(v['name'] for v in DESIGNED.values())}（{time.time() - t:.1f}s）")
    except Exception as e:  # noqa: BLE001
        state["design_error"] = repr(e)
        log(f"设计音色加载失败：{e!r}")


def to_wav(audio: np.ndarray, sr: int) -> bytes:
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def pcm16(audio) -> bytes:
    return (np.clip(np.array(audio, dtype=np.float32).reshape(-1), -1, 1) * 32767).astype("<i2").tobytes()


def speakers() -> list[str]:
    model = state["model"]
    return list(getattr(model, "supported_speakers", None) or []) if model else []


def resolve(requested, instruct: str | None) -> tuple[object, dict, str]:
    """
    音色 id → (模型, generate 参数, 日志里的名字)。
    不认识的 id、或者设计音色的模型还没就绪，都退回默认预设音色 —— 前端存的旧选项不该让角色说不出话。
    """
    name = str(requested or "").strip().lower()
    voice = DESIGNED.get(name)
    if voice and state["design"] is not None:
        # 音色描述在前，这一段的语气在后，拼成一条指令
        prompt = f"{voice['prompt']}。{instruct}" if instruct else voice["prompt"]
        return state["design"], {"instruct": prompt, "seed": voice["id"]}, voice["name"]
    speaker = name if name in speakers() else SPEAKER
    return state["model"], {"voice": speaker, "instruct": instruct or None}, speaker


def run(model, kw: dict, text: str, **extra):
    """生成。设计音色固定随机种子（按音色 id），每次调用都从同一个起点采样"""
    seed = kw.pop("seed", None)
    if seed is not None:
        import mlx.core as mx

        mx.random.seed(zlib.crc32(seed.encode()))
    return model.generate(text=text, lang_code="chinese", **kw, **extra)


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path.startswith("/health"):
            self._json(
                200,
                {
                    "ready": state["model"] is not None,
                    "speaker": SPEAKER,
                    "speakers": speakers(),
                    "designed": [{"id": v["id"], "name": v["name"], "desc": v.get("desc", "")} for v in DESIGNED.values()],
                    "designed_ready": state["design"] is not None,
                    "model": MODEL_ID,
                    "error": state["error"],
                    "design_error": state["design_error"],
                },
            )
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if not self.path.startswith("/synth"):
            self._json(404, {"error": "not found"})
            return
        if state["model"] is None:
            self._json(503, {"error": state["error"] or "模型还在加载"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            text = str(body.get("text") or "").strip()
            if not text:
                self._json(400, {"error": "缺少 text"})
                return
            model, kw, who = resolve(body.get("speaker"), body.get("instruct"))
            if body.get("stream"):
                self.stream(model, kw, who, text, body.get("instruct"))
                return
            t = time.time()
            with lock:
                chunks = list(run(model, kw, text))
            gen = time.time() - t
            sr = chunks[0].sample_rate
            audio = np.concatenate([np.array(c.audio, dtype=np.float32).reshape(-1) for c in chunks])
            seconds = len(audio) / sr
            wav = to_wav(audio, sr)
            log(f"{gen:5.2f}s → {seconds:5.2f}s  [{who}] 「{text}」 {body.get('instruct') or ''}")
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(wav)))
            self.send_header("x-audio-seconds", f"{seconds:.3f}")
            self.send_header("x-gen-seconds", f"{gen:.3f}")
            self.end_headers()
            self.wfile.write(wav)
        except Exception as e:  # noqa: BLE001
            log(f"合成失败：{e!r}")
            self._json(500, {"error": repr(e)})

    def stream(self, model, kw: dict, who: str, text: str, instruct: str | None) -> None:
        self.send_response(200)
        self.send_header("content-type", "application/octet-stream")
        self.send_header("x-sample-rate", str(model.sample_rate))
        # HTTP/1.0：不写 content-length，写完关连接，客户端读到 EOF 就是结束
        self.end_headers()
        t = time.time()
        first = None
        total = 0
        with lock:
            for chunk in run(model, kw, text, stream=True, streaming_interval=0.4):
                data = pcm16(chunk.audio)
                if first is None:
                    first = time.time() - t
                total += len(data) // 2
                self.wfile.write(data)
                self.wfile.flush()
        seconds = total / model.sample_rate
        log(f"{time.time() - t:5.2f}s → {seconds:5.2f}s  首包 {first or 0:.2f}s（流式） [{who}] 「{text}」 {instruct or ''}")

    def log_message(self, *args) -> None:  # 默认的逐请求日志太吵，上面自己打
        pass


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"监听 127.0.0.1:{PORT}，加载模型中……")
    threading.Thread(target=load, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
