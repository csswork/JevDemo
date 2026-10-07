export type Status = 'submitting' | 'WAIT' | 'RUN' | 'DONE' | 'FAIL';
export interface Edits {
  start: number; end: number; speed: number; loop: boolean;
  inPlace: boolean; ground: boolean;
  /** Local bone translation offsets in meters. Optional for existing saved versions. */
  positions?: Record<string, [number, number, number]>;
  offsets: Record<string, [number, number, number]>;
}
export const defaultEdits = (): Edits => ({ start: 0, end: 0, speed: 1, loop: true, inPlace: true, ground: true, offsets: {} });
export interface Version {
  id: string; label: string; createdAt: string;
  prompt: string; details?: string; duration: number; rewrite: boolean;
  source: 'generated' | 'imported'; status: Status;
  jobId?: string; asset?: string; error?: string;
  edits: Edits; notes: string; parentId?: string;
  /** Review feedback on the parent that this regeneration answers. Only on iteration versions. */
  feedback?: string;
}
export interface Motion {
  id: string; name: string; prompt: string; details?: string; duration: number; rewrite: boolean;
  ready: boolean; readyVersionId?: string; createdAt: string; updatedAt: string; deletedAt?: string;
  versions: Version[];
}
export interface Library { motions: Motion[]; configured: boolean; aiConfigured?: boolean }
export interface PromptExpansion { prompt: string; details: string; keyframes: Array<{ time: number; pose: string }> }
/** AI rewrite of the previous version's description that answers review feedback. */
export interface PromptRevision extends PromptExpansion { changes: string }
/** One generation round, oldest first, for the AI to avoid undoing earlier fixes. */
export interface IterationStep { label: string; prompt: string; feedback?: string; notes?: string }
