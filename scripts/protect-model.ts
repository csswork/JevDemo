/**
 * 把 VRM 加密成 .vrmx（格式见 src/vrm/protect.ts）。
 *
 *   node scripts/protect-model.ts <输入.vrm> <输出.vrmx>
 *
 * 明文 VRM 只留在本机（转换产物在仓库外），仓库里只提交加密后的文件。
 * 写完会解密一遍比对，确认能还原。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decryptModel, encryptModel, PROTECTED_EXT } from '../src/vrm/protect.ts';

const [src, dst] = process.argv.slice(2);
if (!src || !dst || !dst.endsWith(PROTECTED_EXT)) {
  console.error(`用法：node scripts/protect-model.ts <输入.vrm> <输出${PROTECTED_EXT}>`);
  process.exit(1);
}

const plain = new Uint8Array(readFileSync(src));
if (new TextDecoder().decode(plain.subarray(0, 4)) !== 'glTF') {
  console.error('输入不是 GLB / VRM');
  process.exit(1);
}
const enc = await encryptModel(plain);
writeFileSync(dst, enc);

const back = new Uint8Array(await decryptModel(enc.buffer as ArrayBuffer));
const same = back.length === plain.length && back.every((b, i) => b === plain[i]);
if (!same) {
  console.error('自检失败：解密结果和原文件不一致');
  process.exit(1);
}
console.log(`${dst}：${(enc.length / 1e6).toFixed(1)}MB，解密自检通过`);
