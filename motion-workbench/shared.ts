export type Status = 'submitting' | 'WAIT' | 'RUN' | 'DONE' | 'FAIL';
export interface Edits {
  start: number; end: number; speed: number; loop: boolean;
  inPlace: boolean; ground: boolean;
  offsets: Record<string, [number, number, number]>;
}
export const defaultEdits = (): Edits => ({ start: 0, end: 0, speed: 1, loop: true, inPlace: true, ground: true, offsets: {} });
export interface Version {
  id: string; label: string; createdAt: string;
  prompt: string; details?: string; duration: number; rewrite: boolean;
  source: 'generated' | 'imported'; status: Status;
  jobId?: string; asset?: string; error?: string;
  edits: Edits; notes: string; parentId?: string;
}
export interface Motion {
  id: string; name: string; prompt: string; details?: string; duration: number; rewrite: boolean;
  ready: boolean; readyVersionId?: string; createdAt: string; updatedAt: string; deletedAt?: string;
  versions: Version[];
}
export interface Library { motions: Motion[]; configured: boolean; aiConfigured?: boolean }
export interface PromptExpansion { prompt: string; details: string; keyframes: Array<{ time: number; pose: string }> }
