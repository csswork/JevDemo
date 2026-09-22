/**
 * 注意：本文件**以及它 import 到的一切**（server/*、被 server 引用的 src/act/*）
 * 必须写显式的 .ts 后缀。
 *
 * Vite 未来会把 configLoader 默认切到 'native'，届时无后缀的相对 import 会失效。
 * 这几个文件跨在 Node 侧的配置链上，和浏览器侧的模块解析规则不同 ——
 * src/ 下其余文件不受影响，保持无后缀即可，不要为了"统一风格"把这里改回去。
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { jevProxy } from './server/jevProxy.ts';

export default defineConfig({
  plugins: [react(), jevProxy()],
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
});
