/**
 * 受保护的模型文件（.vrmx）。
 *
 * QUAPPA-EL 的模型规约要求：在交互内容里分发含模型的二进制数据时，必须采取措施让它无法被再利用。
 * 所以仓库和网站上只放加密后的文件，浏览器里用 WebCrypto 解密后直接交给 GLTFLoader.parse ——
 * 明文 VRM 不落盘、不生成 URL，网络面板里抓到的也只是密文。
 *
 * 前端解密绕不开把密钥带进页面，这一层挡的是「直接下载 / 另存下来拿去别的软件里用」，
 * 不是对抗专门逆向的人。密钥拆成两段异或，免得打包产物里有一整段好搜的字节。
 *
 * 格式：'JVX1'（4 字节）+ IV（12 字节）+ AES-256-GCM 密文（末尾含 16 字节校验）。
 * 加密用 scripts/protect-model.ts（Node 也有 WebCrypto，和这里共用同一份代码）。
 */

const MAGIC = [0x4a, 0x56, 0x58, 0x31];
const K1 = [
  87, 94, 50, 141, 27, 228, 178, 82, 163, 24, 63, 31, 135, 232, 87, 142, 182, 175, 109, 109, 12, 132, 177, 156, 86, 128,
  122, 14, 116, 147, 222, 175,
];
const K2 = [
  119, 14, 70, 218, 68, 242, 73, 103, 203, 70, 220, 55, 147, 103, 164, 149, 55, 135, 24, 108, 147, 229, 186, 18, 49, 210,
  6, 192, 22, 118, 179, 92,
];

export const PROTECTED_EXT = '.vrmx';
export const isProtectedModel = (url: string) => url.split(/[?#]/)[0].endsWith(PROTECTED_EXT);

function key(usage: KeyUsage) {
  const raw = new Uint8Array(K1.map((b, i) => b ^ K2[i]));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
}

export async function encryptModel(plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key('encrypt'), plain));
  const out = new Uint8Array(4 + 12 + body.length);
  out.set(MAGIC, 0);
  out.set(iv, 4);
  out.set(body, 16);
  return out;
}

export async function decryptModel(data: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(data);
  if (bytes.length < 32 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('不是受保护的模型文件');
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(4, 16) }, await key('decrypt'), bytes.subarray(16));
}

/** 带进度的整文件下载（loadAsync 自带进度，parse 前得自己拉） */
export async function fetchBytes(url: string, onProgress?: (ratio: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`模型下载失败：${res.status} ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total || !onProgress) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out.buffer;
}
