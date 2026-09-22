import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { jevProxy } from './server/jevProxy';

export default defineConfig({
  plugins: [react(), jevProxy()],
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
});
