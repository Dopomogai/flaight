// @purpose: cli-claude NodeExecutor — Claude Code headless print as a fleet node backend
// @why: dec-040 / R-CTO-1 CR-2: product CLI owns tools; Opused drives -p --output-format json
//       CR-2b: process-group kill on timeout, cwd clamp (resolveNodeCwd), --disallowedTools when !write
// @role: safety-critical
// @stability: experimental

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { ToolEvent } from '../../council/types';
import type { CliUsage, NodeExecutor, NodeExecContext, NodeExecResult } from '../executor';
import { CLI_READ_ONLY_DISALLOWED_TOOLS, resolveNodeCwd } from '../executor';
import { countWriteOps } from '../judge-evidence';
import { createDefaultCliSpawn, killProcessTree, type CliSpawn } from './cli-process';

/** @deprecated use CliSpawn — kept as alias for CR-2 import sites */
export type ClaudeCliSpawn = CliSpawn;
export { killProcessTree };

export interface CliClaudeExecutorOptions {
  /** Binary name or path (default `claude`). */
  bin?: string;
  /** Wall clock for one print invocation (default 15 min). */
  timeoutMs?: number;
  /** Injectable spawn (tests). */
  spawn?: ClaudeCliSpawn;
  /**
   * When true, pass --permission-mode acceptEdits (write-capable).
   * CR-5 will tighten; CR-2 uses writeIntent from the run as the arming signal.
   */
  writeCapable?: boolean;
  /** Extra argv (e.g. --model). */
  extraArgs?: string[];
}

/** Claude `-p --output-format json` success envelope (subset we depend on). */
export interface ClaudePrintJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  /** Final-message usage when the product reports it (Anthropic naming: cache tokens are separate). */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Per-model cumulative usage when the product reports it (one entry per model the session touched). */
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
    } | undefined
  >;
}

export function parseClaudePrintJson(stdout: string): {
  ok: true;
  data: ClaudePrintJson;
  text: string;
} | { ok: false; error: string } {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false, error: 'empty stdout from claude -p' };
  // Prefer last JSON object line (stream noise before final result is rare in json mode but defensive).
  let raw = trimmed;
  if (!raw.startsWith('{')) {
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
    const lastObj = [...lines].reverse().find((l) => l.startsWith('{') && l.endsWith('}'));
    if (!lastObj) return { ok: false, error: 'no JSON object in claude stdout' };
    raw = lastObj;
  }
  try {
    const data = JSON.parse(raw) as ClaudePrintJson;
    if (data.is_error) {
      return { ok: false, error: `claude is_error: ${typeof data.result === 'string' ? data.result : raw.slice(0, 400)}` };
    }
    const text = typeof data.result === 'string' ? data.result : '';
    if (!text.trim()) return { ok: false, error: 'claude json result empty' };
    return { ok: true, data, text };
  } catch (e) {
    return { ok: false, error: `claude json parse: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function finiteOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Harvest token usage from a claude -p JSON envelope (BENCHMARK-PREP checklist 1 — CLI-seat metering
 * parity). Never invents: returns undefined when the envelope carried no usage; each field is present
 * only when reported. Prefers `modelUsage` (cumulative across every model the session touched) over
 * the final-message `usage`. Anthropic accounting keeps cache tokens in separate fields — they ARE
 * processed prompt-side context, so they fold into inputTokens (OpenAI prompt_tokens semantics);
 * subscription seams never price these via PRICES, so no $ distortion follows.
 */
export function extractClaudeEnvelopeUsage(data: ClaudePrintJson): CliUsage | undefined {
  if (data.modelUsage && typeof data.modelUsage === 'object') {
    let input = 0;
    let output = 0;
    let sawInput = false;
    let sawOutput = false;
    for (const entry of Object.values(data.modelUsage)) {
      if (!entry || typeof entry !== 'object') continue;
      const fresh = finiteOrUndefined(entry.inputTokens);
      const cacheCreation = finiteOrUndefined(entry.cacheCreationTokens);
      const cacheRead = finiteOrUndefined(entry.cacheReadTokens);
      const out = finiteOrUndefined(entry.outputTokens);
      if (fresh !== undefined || cacheCreation !== undefined || cacheRead !== undefined) {
        input += (fresh ?? 0) + (cacheCreation ?? 0) + (cacheRead ?? 0);
        sawInput = true;
      }
      if (out !== undefined) {
        output += out;
        sawOutput = true;
      }
    }
    if (sawInput || sawOutput) {
      return {
        ...(sawInput ? { inputTokens: input } : {}),
        ...(sawOutput ? { outputTokens: output } : {}),
        ...(sawInput && sawOutput ? { totalTokens: input + output } : {}),
      };
    }
  }
  const u = data.usage;
  if (!u || typeof u !== 'object') return undefined;
  const fresh = finiteOrUndefined(u.input_tokens);
  const cacheCreation = finiteOrUndefined(u.cache_creation_input_tokens);
  const cacheRead = finiteOrUndefined(u.cache_read_input_tokens);
  const out = finiteOrUndefined(u.output_tokens);
  const sawInput = fresh !== undefined || cacheCreation !== undefined || cacheRead !== undefined;
  if (!sawInput && out === undefined) return undefined;
  const inputTokens = sawInput ? (fresh ?? 0) + (cacheCreation ?? 0) + (cacheRead ?? 0) : undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(out !== undefined ? { outputTokens: out } : {}),
    ...(inputTokens !== undefined && out !== undefined ? { totalTokens: inputTokens + out } : {}),
  };
}

/**
 * Parse Claude Code print / stream-json tool_use blocks into ToolEvent[].
 * Final `type:result` envelopes often omit tools — callers leave toolEvents undefined then (unavailable).
 */
export function parseClaudeToolEvents(stdout: string): ToolEvent[] {
  const events: ToolEvent[] = [];
  const seen = new Set<string>();
  const push = (name: string, arg: string, error?: string) => {
    const n = (name ?? '').trim();
    if (!n) return;
    const a = (arg ?? '').slice(0, 500);
    const key = `${n}\0${a}\0${error ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push(error ? { name: n, arg: a, error } : { name: n, arg: a });
  };

  const ingest = (node: unknown, depth = 0): void => {
    if (depth > 10 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) ingest(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    const type = typeof o.type === 'string' ? o.type : '';

    // Assistant message content blocks: { type: 'tool_use', name, input }
    if (type === 'tool_use' && typeof o.name === 'string') {
      push(o.name, claudeSalientArg(o.input ?? o.arguments), typeof o.error === 'string' ? o.error : undefined);
    }
    // Stream event: { type: 'assistant', message: { content: [...] } }
    if (o.message != null) ingest(o.message, depth + 1);
    if (Array.isArray(o.content)) ingest(o.content, depth + 1);
    for (const key of ['tool_calls', 'toolCalls', 'tool_use', 'tools'] as const) {
      if (Array.isArray(o[key])) ingest(o[key], depth + 1);
    }
    // Some envelopes nest result as structured content
    if (o.result != null && typeof o.result === 'object') ingest(o.result, depth + 1);
  };

  const trimmed = (stdout ?? '').trim();
  if (!trimmed) return events;

  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      ingest(JSON.parse(trimmed));
    }
  } catch {
    /* line scan */
  }

  // stream-json: one JSON object per line
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      ingest(JSON.parse(t));
    } catch {
      /* skip */
    }
  }

  return events;
}

/** Explicit tool channel present in Claude stdout (even if empty). */
export function claudeStdoutHasToolChannel(stdout: string): boolean {
  const trimmed = (stdout ?? '').trim();
  if (!trimmed) return false;
  if (/"type"\s*:\s*"tool_use"/.test(trimmed)) return true;
  if (/"tool_use"\s*:/.test(trimmed) || /"tool_calls"\s*:/.test(trimmed)) return true;
  try {
    if (trimmed.startsWith('{')) {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if ('tool_calls' in o || 'toolCalls' in o || 'tool_use' in o) return true;
    }
  } catch {
    /* */
  }
  return false;
}

function claudeSalientArg(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.slice(0, 500);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['file_path', 'path', 'filePath', 'target_file', 'command', 'pattern', 'query', 'notebook_path']) {
      if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).slice(0, 500);
    }
    try {
      return JSON.stringify(v).slice(0, 500);
    } catch {
      return '';
    }
  }
  return String(v).slice(0, 500);
}

/** Default spawn — process-group kill on timeout (CR-2b). */
export const defaultClaudeSpawn: ClaudeCliSpawn = createDefaultCliSpawn('claude');

/**
 * T6 effortHint → Claude model tier (haiku / sonnet / opus).
 *
 * TODO(T6): cli-claude has no existing tier mechanism on this executor path (model is
 * only via executor options.extraArgs / OPUSED_CLI_SEAM_MODEL, not per-node effortHint).
 * Do NOT invent --model flags here until a real tier map lands. Effort still flows as
 * node.effortHint for the API seat path (run.ts EFFORT_STEPS / EFFORT_TOKENS).
 *
 * @returns always undefined today (documented no-op).
 */
export function resolveClaudeEffortTier(
  _effortHint: string | undefined,
): 'haiku' | 'sonnet' | 'opus' | undefined {
  // No-op: no per-effort tier wiring exists on cli-claude yet.
  return undefined;
}

/**
 * Build argv for a fresh single-shot print run (CR-2 / CR-2b).
 * Session: --no-session-persistence (no resume — CR-4).
 * Read-only: --permission-mode dontAsk + --disallowedTools Edit,Write,Bash (belt).
 *
 * T6: effortHint is intentionally NOT mapped to a model flag here (see resolveClaudeEffortTier).
 */
export function buildClaudePrintArgv(opts: {
  system: string;
  /** Absolute path to the mission pack file (keeps argv small). */
  packPath: string;
  writeCapable: boolean;
  extraArgs?: string[];
  /** When pack is small enough, pass inline; else instruct to read packPath. */
  inlinePrompt?: string;
  /** Override disallowed-tools list when !writeCapable (default CLI_READ_ONLY_DISALLOWED_TOOLS). */
  disallowedTools?: string;
  /**
   * T6: accepted for API symmetry with cli-grok; currently a no-op (no tier mechanism).
   * TODO: when a Claude tier map lands, map low→haiku / medium→sonnet / high→opus here.
   */
  effortHint?: 'low' | 'medium' | 'high';
}): string[] {
  // Touch opts.effortHint so call sites can pass it without lint unused, and so the
  // documented no-op stays intentional (resolveClaudeEffortTier always returns undefined today).
  void resolveClaudeEffortTier(opts.effortHint);

  const argv: string[] = [
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--permission-mode',
    opts.writeCapable ? 'acceptEdits' : 'dontAsk',
  ];
  // CR-2b: belt when not write-armed — sandbox-local settings can soften dontAsk alone.
  if (!opts.writeCapable) {
    argv.push('--disallowedTools', opts.disallowedTools ?? CLI_READ_ONLY_DISALLOWED_TOOLS);
  }
  if (opts.system.trim()) {
    argv.push('--append-system-prompt', opts.system);
  }
  if (opts.extraArgs?.length) argv.push(...opts.extraArgs);

  const prompt =
    opts.inlinePrompt && opts.inlinePrompt.length <= 80_000
      ? opts.inlinePrompt
      : [
          'You are running as an Opused fleet node via Claude Code CLI.',
          `Your full mission pack is on disk at: ${opts.packPath}`,
          'Read that file completely (it includes injects, consumes, and the task).',
          'Execute the task. Your FINAL assistant message is the deliverable for the next stage (.out).',
          'Do not ask the operator questions — complete or state blockers in the deliverable.',
        ].join('\n');
  argv.push(prompt);
  return argv;
}

export function createCliClaudeExecutor(options: CliClaudeExecutorOptions = {}): NodeExecutor {
  const bin = options.bin ?? process.env.OPUSED_CLAUDE_BIN ?? 'claude';
  const envTimeout = Number(process.env.OPUSED_CLI_TIMEOUT_MS);
  const timeoutMs =
    options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 15 * 60_000);
  const spawnFn = options.spawn ?? defaultClaudeSpawn;

  return {
    kind: 'cli-claude',
    async run(ctx: NodeExecContext): Promise<NodeExecResult> {
      const cwd = resolveNodeCwd(ctx.node, ctx.sandboxRoot);
      const nodeLogDir = join(ctx.runDir, 'nodes', ctx.node.id);
      try {
        mkdirSync(nodeLogDir, { recursive: true });
      } catch {
        /* ok */
      }
      const packPath = resolve(nodeLogDir, 'cli-pack.txt');
      const fullPrompt = [
        ctx.system ? `===== SYSTEM =====\n${ctx.system}\n` : '',
        '===== MISSION PACK =====',
        ctx.packText,
      ]
        .filter(Boolean)
        .join('\n');
      writeFileSync(packPath, fullPrompt, 'utf8');

      const writeCapable = options.writeCapable === true;
      const argv = buildClaudePrintArgv({
        system: ctx.system,
        packPath,
        writeCapable,
        extraArgs: options.extraArgs,
        // Prefer full pack inline when small so CLI need not re-read (still written for audit).
        inlinePrompt: fullPrompt.length <= 80_000 ? fullPrompt : undefined,
        // T6: thread effortHint through; currently a documented no-op on argv (no tier map).
        effortHint: ctx.node.effortHint,
      });

      writeFileSync(
        resolve(nodeLogDir, 'cli-invoke.json'),
        JSON.stringify(
          {
            bin,
            argv: argv.map((a, i) => (i === argv.length - 1 && a.length > 500 ? `${a.slice(0, 500)}…(${a.length} chars)` : a)),
            cwd,
            timeoutMs,
            writeCapable,
            ts: ctx.now(),
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );

      if (!existsSync(cwd)) {
        throw new Error(`cli-claude cwd does not exist: ${cwd}`);
      }

      const proc = await spawnFn({ bin, argv, cwd, timeoutMs });
      writeFileSync(resolve(nodeLogDir, 'cli-stdout.txt'), proc.stdout, 'utf8');
      if (proc.stderr) writeFileSync(resolve(nodeLogDir, 'cli-stderr.txt'), proc.stderr, 'utf8');

      if (proc.exitCode !== 0) {
        const tail = (proc.stderr || proc.stdout).slice(-800);
        throw new Error(`cli-claude exit ${proc.exitCode}: ${tail || 'no output'}`);
      }

      const parsed = parseClaudePrintJson(proc.stdout);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }

      // dec-judge-seam: tool_use blocks when present; else leave toolEvents undefined (unavailable).
      const parsedTools = parseClaudeToolEvents(proc.stdout);
      const hasChannel = claudeStdoutHasToolChannel(proc.stdout);
      const toolEvents = parsedTools.length > 0 || hasChannel ? parsedTools : undefined;
      const writeOps = toolEvents ? countWriteOps(toolEvents) : undefined;
      // Metering parity: real tokens when the envelope reports them (absent = absent, never invented).
      const usage = extractClaudeEnvelopeUsage(parsed.data);

      return {
        text: parsed.text,
        sessionId: parsed.data.session_id,
        costHint:
          typeof parsed.data.total_cost_usd === 'number'
            ? `$${parsed.data.total_cost_usd.toFixed(4)}`
            : undefined,
        modelLabel: 'cli-claude',
        exitCode: proc.exitCode,
        ...(usage ? { usage } : {}),
        ...(toolEvents !== undefined ? { toolEvents, writeOps: writeOps ?? 0 } : {}),
        events: [
          {
            type: 'cli_result',
            detail: {
              sessionId: parsed.data.session_id,
              durationMs: parsed.data.duration_ms,
              costUsd: parsed.data.total_cost_usd,
              ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
              ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
              ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
              ...(toolEvents !== undefined
                ? { toolEventCount: toolEvents.length, writeOps: writeOps ?? 0 }
                : { tool_trace: 'unavailable' }),
            },
          },
        ],
      };
    },
  };
}
