import type { Plugin } from 'vite';
interface Assets {
  manifest: Record<string, string>;
  report: Array<{ source: string; original: number; optimized: number; key: string; file: string }>;
  treeImages: Map<string, string>;
}
export function prepareAssets(): Promise<Assets>;
export function optimizedAssetsPlugin(assets: Assets): Plugin;
