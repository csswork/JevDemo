import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workbenchApi } from './server/api.ts';
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root, publicDir: false,
  plugins: [react(), workbenchApi(path.resolve(root, '..'))],
  server: { host: '127.0.0.1', port: 5680, strictPort: true },
  build: { outDir: '../dist-motion', emptyOutDir: true },
});
