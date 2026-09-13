// @purpose: Mid-run control journal — append-only control.jsonl for message/skip/stop/approve ops
// @why: Flaight T2 (PLAN-flaight-orchestration-2026-08-04 §2): a supervising P0 can course-correct a
//       live run without killing the process; runner reads at node/stage boundaries; journal is truth.
// @role: logic
// @stability: experimental

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Single path-segment ids (node/stage/run) — charset matches opused-mcp jail SAFE_ID. */
export const CONTROL_SAFE_ID = /^[A-Za-z0-9._-]+$/;

/**
 * True iff `id` is a safe single path segment.
 * Charset allows `.`, so bare `..` / `.` and any separator / `..` substring are banned
 * (same plan-name jail discipline as P0).
 */
export function isControlSafeId(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (!CONTROL_SAFE_ID.test(id)) return false;
  if (id === '.' || id === '..') return false;
  if (id.includes('..') || id.includes('/') || id.includes('\\')) return false;
  return true;
}

/** message target: a node id, `stage:<id>`, or `all`. */
export function isMessageTarget(t: string): boolean {
  if (t === 'all') return true;
  if (t.startsWith('stage:')) return isControlSafeId(t.slice('stage:'.length));
  return isControlSafeId(t);
}

const baseFields = {
  ts: z.string().min(1),
  principal: z.string().min(1),
  nodeId: z.string().optional(),
  stageId: z.string().optional(),
  text: z.string().optional(),
  reason: z.string().optional(),
};

/**
 * Strict op schema. Required fields depend on `op`; ids must be SAFE single-segment
 * (message nodeId may also be `all` or `stage:<SAFE_ID>`).
 */
export const ControlOpSchema = z
  .object({
    ...baseFields,
    op: z.enum(['message', 'skip', 'stop', 'approve']),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.op === 'message') {
      if (val.nodeId === undefined || val.nodeId === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'message requires nodeId (node id | stage:<id> | all)', path: ['nodeId'] });
      } else if (!isMessageTarget(val.nodeId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid message nodeId target: ${val.nodeId}`, path: ['nodeId'] });
      }
      if (typeof val.text !== 'string' || val.text.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'message requires non-empty text', path: ['text'] });
      }
    }
    if (val.op === 'skip') {
      if (val.nodeId === undefined || !isControlSafeId(val.nodeId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'skip requires SAFE nodeId', path: ['nodeId'] });
      }
      if (typeof val.reason !== 'string' || val.reason.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'skip requires non-empty reason', path: ['reason'] });
      }
    }
    if (val.op === 'stop') {
      if (typeof val.reason !== 'string' || val.reason.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'stop requires non-empty reason', path: ['reason'] });
      }
    }
    if (val.op === 'approve') {
      if (val.stageId === undefined || !isControlSafeId(val.stageId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'approve requires SAFE stageId', path: ['stageId'] });
      }
    }
    if (val.stageId !== undefined && val.op !== 'approve' && !isControlSafeId(val.stageId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid stageId: ${val.stageId}`, path: ['stageId'] });
    }
    if (val.nodeId !== undefined && val.op === 'skip' && !isControlSafeId(val.nodeId)) {
      // already reported above
    }
  });

export type ControlOp = z.infer<typeof ControlOpSchema>;

export type ControlOpInput = {
  op: ControlOp['op'];
  principal: string;
  ts?: string;
  nodeId?: string;
  stageId?: string;
  text?: string;
  reason?: string;
};

export const CONTROL_JOURNAL = 'control.jsonl';

export function controlJournalPath(runDir: string): string {
  return resolve(runDir, CONTROL_JOURNAL);
}

export type ParseControlOpResult =
  | { ok: true; op: ControlOp }
  | { ok: false; error: string };

/** Validate a raw op object (does not write). */
export function parseControlOp(raw: unknown): ParseControlOpResult {
  const r = ControlOpSchema.safeParse(raw);
  if (!r.success) {
    return { ok: false, error: r.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, op: r.data };
}

/**
 * Append one op to runs/<id>/control.jsonl.
 * True concurrent-safe line append: single appendFileSync(JSON+'\n') under O_APPEND so
 * multi-process writers (in-process P0 + MCP/CLI) never lose ops via read-modify-write races.
 * Runner already skips garbled lines — jsonl-line granularity is the contract.
 */
export function appendControlOp(runDir: string, input: ControlOpInput): ControlOp {
  const candidate = {
    ts: input.ts ?? new Date().toISOString(),
    op: input.op,
    principal: input.principal,
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
  const parsed = parseControlOp(candidate);
  if (!parsed.ok) {
    throw new Error(`invalid control op: ${parsed.error}`);
  }
  const op = parsed.op;
  mkdirSync(runDir, { recursive: true });
  const path = controlJournalPath(runDir);
  appendFileSync(path, `${JSON.stringify(op)}\n`, 'utf8');
  return op;
}

export interface ControlOpRecord extends ControlOp {
  /** 0-based line index in control.jsonl (stable apply cursor). */
  index: number;
}

/**
 * Read control ops from the journal. Defensive: garbled lines skipped.
 * `cursor` = line index to start from (number of lines already consumed); default 0.
 * Returns ops with absolute line indices and the next cursor (total lines seen, including bad ones).
 */
export function readControlOps(
  runDir: string,
  cursor = 0,
): { ops: ControlOpRecord[]; nextCursor: number } {
  const path = controlJournalPath(runDir);
  if (!existsSync(path)) {
    return { ops: [], nextCursor: 0 };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ops: [], nextCursor: 0 };
  }
  const lines = text.split('\n');
  // trailing empty from final newline — keep line indices stable by iterating all non-final empties carefully
  const ops: ControlOpRecord[] = [];
  let lineCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === '' && i === lines.length - 1) break; // trailing newline
    if (t === '') {
      lineCount++;
      continue;
    }
    const idx = lineCount;
    lineCount++;
    if (idx < cursor) continue;
    try {
      const raw = JSON.parse(t) as unknown;
      const parsed = parseControlOp(raw);
      if (parsed.ok) ops.push({ ...parsed.op, index: idx });
    } catch {
      /* skip garbled */
    }
  }
  return { ops, nextCursor: lineCount };
}

/** True if a message op targets this node (specific id, stage:<id>, or all). */
export function messageTargetsNode(op: ControlOp, nodeId: string, stageId: string): boolean {
  if (op.op !== 'message' || !op.nodeId) return false;
  if (op.nodeId === 'all') return true;
  if (op.nodeId === `stage:${stageId}`) return true;
  return op.nodeId === nodeId;
}

/**
 * In-memory apply tracker for one runner process. Cursor advances only for ops that were
 * fully consumed (skip/stop/approve after apply; specific-node messages after deliver).
 * Broadcast messages track per-node delivery separately.
 */
export function createControlApplier(runDir: string) {
  /** Line indices fully consumed (will not re-apply). */
  const applied = new Set<number>();
  /** message op index → node ids already injected. */
  const messageDelivered = new Map<number, Set<string>>();
  /** Pending stop reason once a stop op is observed. */
  let stopReason: string | null = null;
  /** Highest line index exclusive we've scanned (for discovering new appends). */
  let scanCursor = 0;

  function refresh(): ControlOpRecord[] {
    const { ops, nextCursor } = readControlOps(runDir, 0);
    scanCursor = nextCursor;
    return ops.filter((o) => !applied.has(o.index));
  }

  return {
    get stopReason() {
      return stopReason;
    },
    get scanCursor() {
      return scanCursor;
    },
    /** Mark a line index applied (consumed). */
    markApplied(index: number) {
      applied.add(index);
    },
    /** All not-yet-applied ops (re-reads journal so mid-run appends appear). */
    pending(): ControlOpRecord[] {
      return refresh();
    },
    /** First unapplied stop, if any — records intent; caller echoes + finishes stages. */
    takeStop(): ControlOpRecord | null {
      const pending = refresh();
      const stop = pending.find((o) => o.op === 'stop');
      if (!stop) return null;
      stopReason = stop.reason ?? 'control stop';
      applied.add(stop.index);
      return stop;
    },
    /** First unapplied approve for stageId. */
    takeApprove(stageId: string): ControlOpRecord | null {
      const pending = refresh();
      const ap = pending.find((o) => o.op === 'approve' && o.stageId === stageId);
      if (!ap) return null;
      applied.add(ap.index);
      return ap;
    },
    /** First unapplied skip for nodeId. */
    takeSkip(nodeId: string): ControlOpRecord | null {
      const pending = refresh();
      const sk = pending.find((o) => o.op === 'skip' && o.nodeId === nodeId);
      if (!sk) return null;
      applied.add(sk.index);
      return sk;
    },
    /**
     * Collect message texts for this node and mark specific-target ops applied.
     * Broadcast (all / stage:*) deliver once per node id.
     */
    takeMessages(nodeId: string, stageId: string): { texts: string[]; ops: ControlOpRecord[] } {
      const pending = refresh();
      const texts: string[] = [];
      const used: ControlOpRecord[] = [];
      for (const op of pending) {
        if (op.op !== 'message' || !messageTargetsNode(op, nodeId, stageId)) continue;
        const delivered = messageDelivered.get(op.index) ?? new Set<string>();
        if (delivered.has(nodeId)) continue;
        delivered.add(nodeId);
        messageDelivered.set(op.index, delivered);
        if (op.text) texts.push(op.text);
        used.push(op);
        // Specific node target → fully consumed after one delivery.
        if (op.nodeId && op.nodeId !== 'all' && !op.nodeId.startsWith('stage:')) {
          applied.add(op.index);
        }
      }
      return { texts, ops: used };
    },
    /** After a stage ends, consume stage-scoped messages for that stage. */
    completeStage(stageId: string) {
      const pending = refresh();
      for (const op of pending) {
        if (op.op === 'message' && op.nodeId === `stage:${stageId}`) {
          applied.add(op.index);
        }
      }
    },
  };
}

export type ControlApplier = ReturnType<typeof createControlApplier>;

/** Section header injected into a node's context pack when a control message applies. */
export const CONTROL_MESSAGE_SECTION = '===== CONTROL MESSAGE (operator) =====';

export function appendControlMessagesToPack(packText: string, messages: string[]): string {
  if (messages.length === 0) return packText;
  const body = messages.join('\n\n');
  return `${packText}\n\n${CONTROL_MESSAGE_SECTION}\n${body}\n`;
}
