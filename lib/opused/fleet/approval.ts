// Local approval markers retained from the workflow engine; no Tower task or notification access.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export const PREAPPROVE_GATE = 'preapprove';

export interface SpawnMeta {
  taskId: string;
  workspaceId?: string;
  templateId: string;
  lead: string;
  status: 'awaiting_preapprove' | 'approved' | 'rejected' | 'running';
  createdAt: string;
  params: Record<string, string | string[]>;
  planName: string;
  /** Relative path under plans/ for graph widget. */
  planFile: string;
}

export function preapprovePendingPath(runDir: string): string {
  return join(runDir, `GATE-${PREAPPROVE_GATE}.pending`);
}
export function preapproveApprovedPath(runDir: string): string {
  return join(runDir, `GATE-${PREAPPROVE_GATE}.approved`);
}
export function preapproveRejectedPath(runDir: string): string {
  return join(runDir, `GATE-${PREAPPROVE_GATE}.rejected`);
}
export function spawnMetaPath(runDir: string): string {
  return join(runDir, 'spawn-meta.json');
}

/** True if run must not start spending (pending without approve). */
export function isAwaitingPreapprove(runDir: string): boolean {
  return (
    existsSync(preapprovePendingPath(runDir)) &&
    !existsSync(preapproveApprovedPath(runDir)) &&
    !existsSync(preapproveRejectedPath(runDir))
  );
}

/** True if founder rejected preapprove — runPlan must refuse (CTO F1). */
export function isPreapproveRejected(runDir: string): boolean {
  return existsSync(preapproveRejectedPath(runDir));
}

/** True if founder approved (approved marker present, not rejected). */
export function isPreapproveApproved(runDir: string): boolean {
  return existsSync(preapproveApprovedPath(runDir)) && !existsSync(preapproveRejectedPath(runDir));
}

export function readSpawnMeta(runDir: string): SpawnMeta | null {
  const p = spawnMetaPath(runDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SpawnMeta;
  } catch {
    return null;
  }
}
