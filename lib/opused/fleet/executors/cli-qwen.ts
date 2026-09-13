// @purpose: cli-qwen NodeExecutor — headless Qwen Code (`qwen -p`) as a fleet node backend
// @why: runner-flexibility (founder 2026-08-05): roles are provider-agnostic; qwen joins
//       grok/claude/codex as a first-class runner. Headless contract live-probed 2026-08-05:
//       `-o json` emits a typed event ARRAY (system/init with session_id+model; assistant messages
//       with per-message usage; result{result, usage, stats.tools.totalCalls, permission_denials}).
//       Read-only belt: --approval-mode plan (CLI refuses edits); write nodes: --approval-mode yolo.
// @role: safety-critical
// @stability: experimental

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeExecutor, NodeExecContext, NodeExecResult } from '../executor';
import { resolveNodeCwd } from '../executor';
import { createDefaultCliSpawn, type CliSpawn } from './cli-process';

export type QwenCliSpawn = CliSpawn;

export interface CliQwenExecutorOptions {
  /** Binary name or path (default `qwen` / OPUSED_QWEN_BIN). */
  bin?: string;
  /** Wall clock for one invocation (default 15 min / OPUSED_CLI_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Injectable spawn (tests). */
  spawn?: QwenCliSpawn;
  /** true: --approval-mode yolo (CLI may edit the sandbox). false: plan (refuses edits). */
  writeCapable?: boolean;
  /** Extra argv after the fixed flags (e.g. -m model, --safe-mode). */
  extraArgs?: string[];
}

/** One event from `qwen -p ... -o json` (subset we depend on; additive-tolerant). */
export interface QwenStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  is_error?: boolean;
  result?: string;
  permission_denials?: unknown[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  stats?: { tools?: { totalCalls?: number } };
  message?: { content?: Array<{ type?: string; text?: string }> };
}

export interface QwenParsedOutput {
  ok: boolean;
  error?: string;
  text: string;
  sessionId?: string;
  modelLabel?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** stats.tools.totalCalls when present; undefined = tool channel unavailable. */
  toolCalls?: number;
  permissionDenials: number;
  isError: boolean;
}

/**
 * Parse the qwen headless json event array (or NDJSON fallback) into the deliverable.
 * Deliverable = result.result; fallback = last assistant text block.
 */
export function parseQwenStreamOutput(stdout: string): QwenParsedOutput {
  const trimmed = stdout.trim();
  let events: QwenStreamEvent[] = [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) events = parsed as QwenStreamEvent[];
  } catch {
    events = [];
  }
  if (events.length === 0) {
    for (const line of trimmed.split('\n')) {
      try {
        events.push(JSON.parse(line) as QwenStreamEvent);
      } catch {
        /* skip non-JSON line */
      }
    }
  }
  if (events.length === 0) {
    return { ok: false, error: 'no parseable qwen json events', text: '', permissionDenials: 0, isError: false };
  }

  let sessionId: string | undefined;
  let modelLabel: string | undefined;
  let lastAssistantText = '';
  let resultText = '';
  let usage: QwenParsedOutput['usage'];
  let toolCalls: number | undefined;
  let permissionDenials = 0;
  let isError = false;

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (typeof ev.session_id === 'string' && ev.session_id && !sessionId) sessionId = ev.session_id;
    if (typeof ev.model === 'string' && ev.model && !modelLabel) modelLabel = ev.model;
    if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          lastAssistantText = block.text;
        }
      }
    }
    if (ev.type === 'result') {
      if (typeof ev.result === 'string' && ev.result.trim()) resultText = ev.result;
      if (ev.usage) {
        usage = {
          inputTokens: ev.usage.input_tokens ?? 0,
          outputTokens: ev.usage.output_tokens ?? 0,
          totalTokens: ev.usage.total_tokens ?? 0,
        };
      }
      if (typeof ev.stats?.tools?.totalCalls === 'number') toolCalls = ev.stats.tools.totalCalls;
      if (Array.isArray(ev.permission_denials)) permissionDenials = ev.permission_denials.length;
      if (ev.is_error === true) isError = true;
    }
  }

  const text = (resultText || lastAssistantText).trim();
  if (!text) {
    return { ok: false, error: 'no result text in qwen json output', text: '', sessionId, modelLabel, permissionDenials, isError };
  }
  return { ok: true, text, sessionId, modelLabel, usage, toolCalls, permissionDenials, isError };
}

/** Fixed argv for a headless qwen node. Prompt inline (packs ≤ ~40KB fit macOS ARG_MAX with margin). */
export function buildQwenArgv(opts: {
  prompt: string;
  writeCapable: boolean;
  extraArgs?: string[];
}): string[] {
  return [
    '-p',
    opts.prompt,
    '-o',
    'json',
    '--approval-mode',
    opts.writeCapable ? 'yolo' : 'plan',
    ...(opts.extraArgs ?? []),
  ];
}

export const defaultQwenSpawn: QwenCliSpawn = createDefaultCliSpawn('qwen');

/**
 * Headless Qwen Code as a fleet node. CR-2b: process-group kill on timeout via shared spawn;
 * cwd clamped via resolveNodeCwd; read-only belt = --approval-mode plan. Raw stdout archived to
 * nodes/<id>/cli-stdout.json for audit + judge evidence (turns/ is owned by run.ts turn records).
 * Tool channel: qwen reports aggregate
 * stats.tools.totalCalls only (no per-call trace in v1) — toolEvents stays [] when truly zero
 * (zero-tools overlay works) and undefined when >0 (never fabricate per-call events).
 */
export function createCliQwenExecutor(opts: CliQwenExecutorOptions = {}): NodeExecutor {
  const spawn = opts.spawn ?? defaultQwenSpawn;
  const bin = opts.bin ?? process.env.OPUSED_QWEN_BIN ?? 'qwen';
  const timeoutMs = opts.timeoutMs ?? Number(process.env.OPUSED_CLI_TIMEOUT_MS ?? 15 * 60_000);
  return {
    kind: 'cli-qwen',
    async run(ctx: NodeExecContext): Promise<NodeExecResult> {
      const cwd = resolveNodeCwd(ctx.node, ctx.sandboxRoot);
      const prompt = `${ctx.system}\n\n${ctx.packText}`;
      const argv = buildQwenArgv({
        prompt,
        writeCapable: !!opts.writeCapable,
        extraArgs: opts.extraArgs,
      });
      const res = await spawn({ bin, argv, cwd, timeoutMs });

      // Raw stdout lives OUTSIDE turns/: run.ts owns turns/NN-cli.json as structured metering
      // turn records (BENCHMARK-PREP checklist 1) — a raw archive inside turns/ would clobber
      // them whenever a schema/gate repair re-spawns the CLI.
      const nodeDir = join(ctx.runDir, 'nodes', ctx.node.id);
      try {
        mkdirSync(nodeDir, { recursive: true });
        writeFileSync(join(nodeDir, 'cli-stdout.json'), res.stdout);
      } catch {
        /* audit best-effort */
      }

      const parsed = parseQwenStreamOutput(res.stdout);
      const events: NodeExecResult['events'] = [];
      if (parsed.usage) {
        events.push({
          type: 'cli_result',
          detail: {
            runner: 'cli-qwen',
            sessionId: parsed.sessionId ?? null,
            inputTokens: parsed.usage.inputTokens,
            outputTokens: parsed.usage.outputTokens,
            totalTokens: parsed.usage.totalTokens,
            toolEventCount: parsed.toolCalls ?? 0,
            permissionDenials: parsed.permissionDenials,
          },
        });
      }
      return {
        text: parsed.text,
        sessionId: parsed.sessionId,
        modelLabel: parsed.modelLabel ?? 'qwen',
        costHint: 'qwen-subscription',
        exitCode: res.exitCode,
        // Metering parity: result.usage from the CLI's own result event (absent = absent — the
        // runner persists it on the node's CLI turn record for the P0 endpoint fold).
        ...(parsed.usage ? { usage: parsed.usage } : {}),
        events,
        toolEvents: parsed.toolCalls === 0 ? [] : undefined,
        writeOps: 0,
      };
    },
  };
}
