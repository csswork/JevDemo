/**
 * 腾讯混元生 3D（ai3d.tencentcloudapi.com）的服务端调用。
 *
 * 目前只用文生动作：HY-Motion 1.0，一句描述 → 带骨骼动画的 FBX（1~12 秒）。
 * 异步任务：Submit 拿 JobId → Describe 轮询到 DONE → 下载 ResultFile3Ds 里的 FBX（链接有效期 1 天）。
 *
 * 鉴权是腾讯云 API 签名 v3（TC3-HMAC-SHA256），要 SecretId + SecretKey（云 API 密钥），
 * 放在 .env.local 的 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY，只在 Node 侧用，不进浏览器。
 * 每个任务都扣积分；默认只有 1 个并发，上一个跑完才会开始下一个。
 */
import { createHash, createHmac } from 'node:crypto';

const HOST = 'ai3d.tencentcloudapi.com';
const SERVICE = 'ai3d';
const VERSION = '2025-05-13';

export interface TencentCreds {
  secretId: string;
  secretKey: string;
  /** 默认广州 */
  region?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s).digest();

/** 调一个 ai3d 接口。出错（包括业务错误 Response.Error）直接抛出 */
export async function callAi3d<T>(creds: TencentCreds, action: string, payload: Record<string, unknown>): Promise<T> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';

  // 签名 v3：规范请求 → 待签字符串 → 派生密钥签名（文档"签名方法 v3"）
  const canonical = [
    'POST',
    '/',
    '',
    `content-type:${contentType}\nhost:${HOST}\nx-tc-action:${action.toLowerCase()}\n`,
    'content-type;host;x-tc-action',
    sha256(body),
  ].join('\n');
  const scope = `${date}/${SERVICE}/tc3_request`;
  const toSign = ['TC3-HMAC-SHA256', String(timestamp), scope, sha256(canonical)].join('\n');
  const signing = hmac(hmac(hmac(`TC3${creds.secretKey}`, date), SERVICE), 'tc3_request');
  const signature = createHmac('sha256', signing).update(toSign).digest('hex');

  const r = await fetch(`https://${HOST}/`, {
    method: 'POST',
    headers: {
      Authorization: `TC3-HMAC-SHA256 Credential=${creds.secretId}/${scope}, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`,
      'Content-Type': contentType,
      Host: HOST,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': VERSION,
      'X-TC-Region': creds.region ?? 'ap-guangzhou',
    },
    body,
    signal: AbortSignal.timeout(60000),
  });
  const json = (await r.json().catch(() => null)) as {
    Response?: T & { Error?: { Code: string; Message: string }; RequestId?: string };
  } | null;
  const res = json?.Response;
  if (!r.ok || !res) throw new Error(`腾讯云 ${action} 返回 ${r.status}`);
  if (res.Error) throw new Error(`腾讯云 ${action}：${res.Error.Code} — ${res.Error.Message}`);
  return res;
}

export interface MotionJobResult {
  status: 'WAIT' | 'RUN' | 'FAIL' | 'DONE';
  error?: string;
  files: Array<{ type: string; url: string }>;
}

/**
 * 提交文生动作。
 * prompt 最多 128 字；duration 1~12 秒。rewrite = 让服务端先扩写描述（中文描述建议开）。
 * mesh = FBX 里带不带蒙皮网格 —— 我们只要骨骼动画，默认不带，文件小很多
 */
export async function submitMotion(
  creds: TencentCreds,
  opts: { prompt: string; duration?: number; rewrite?: boolean; mesh?: boolean },
): Promise<string> {
  if ([...opts.prompt].length > 128) throw new Error('动作描述最多 128 个字');
  const res = await callAi3d<{ JobId: string }>(creds, 'SubmitHunyuanTo3DMotionJob', {
    Prompt: opts.prompt,
    Model: 'HY-Motion-1.0',
    Duration: Math.max(1, Math.min(12, Math.round(opts.duration ?? 5))),
    EnableRewrite: opts.rewrite ?? true,
    EnableMesh: opts.mesh ?? true,
  });
  return res.JobId;
}

export async function describeMotion(creds: TencentCreds, jobId: string): Promise<MotionJobResult> {
  const res = await callAi3d<{
    Status: MotionJobResult['status'];
    ErrorCode?: string;
    ErrorMessage?: string;
    ResultFile3Ds?: Array<{ Type: string; Url: string }>;
  }>(creds, 'DescribeHunyuanTo3DMotionJob', { JobId: jobId });
  return {
    status: res.Status,
    error: res.ErrorCode ? `${res.ErrorCode}：${res.ErrorMessage ?? ''}` : undefined,
    files: (res.ResultFile3Ds ?? []).map((f) => ({ type: f.Type, url: f.Url })),
  };
}

/** 提交并等到完成（每 5 秒查一次，最多等 maxWait 秒）。返回结果文件列表 */
export async function generateMotion(
  creds: TencentCreds,
  opts: Parameters<typeof submitMotion>[1],
  onStatus?: (s: string) => void,
  maxWait = 600,
): Promise<{ jobId: string; files: MotionJobResult['files'] }> {
  const jobId = await submitMotion(creds, opts);
  onStatus?.(`已提交 ${jobId}`);
  const start = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await describeMotion(creds, jobId);
    onStatus?.(`${res.status}（${Math.round((Date.now() - start) / 1000)}s）`);
    if (res.status === 'DONE') return { jobId, files: res.files };
    if (res.status === 'FAIL') throw new Error(`生成失败：${res.error ?? '未知原因'}`);
    if (Date.now() - start > maxWait * 1000) throw new Error(`等了 ${maxWait}s 还没好，JobId ${jobId}（24 小时内可以再查）`);
  }
}
