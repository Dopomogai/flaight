// @purpose: cli-codex NodeExecutor — Codex headless `codex exec` as a fleet node backend
// @why: opused Phase A CLI gating — product CLI owns tools; Opused drives exec --json + last-message capture
//       CR-2b safety: process-group kill, cwd clamp (resolveNodeCwd), sandbox read-only when !write
//       Multi-turn audit (2026-07-20, same triad dry-run as cli-grok): `codex exec` is inherently a multi-step
//       agent loop — there is no --max-turns / step-budget flag on current codex (see `codex exec --help`).
//       Turn caps are not mirrored here; wall-clock timeoutMs is the runaway bound. Approvals/sandbox stay
//       on --sandbox workspace-write|read-only (seat-run uses --profile unattended separately).
//       Argv-conflict audit (2026-07-20, paired with cli-grok --permission-mode bug): codex exec uses a
//       single --sandbox mode flag only — no dual approval pair (--ask-for-approval + bypass, etc.).
//       Keep it that way; do not stack conflicting approval policies on this path.
// @role: safety-critical
// @stability: experimental

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { NodeExecutor, NodeExecContext, NodeExecResult } from '../executor';
import { resolveNodeCwd } from '../executor';
import { createDefaultCliSpawn, type CliSpawn } from './cli-process';

export type CodexCliSpawn = CliSpawn;

export interface CliCodexExecutorOptions {
  /** Binary name or path (default `codex` / OPUSED_CODEX_BIN). */
  bin?: string;
  /** Wall clock for one exec invocation (default 15 min / OPUSED_CLI_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Injectable spawn (tests). */
  spawn?: CodexCliSpawn;
  /**
   * When true: --sandbox workspace-write (CLI may edit the tree).
   * When false: --sandbox read-only (default — mirrors CLI_READ_ONLY belt on other CLIs).
   */
  writeCapable?: boolean;
  /** Extra argv after the fixed exec flags (e.g. -m model). */
  extraArgs?: string[];
}

/** One JSONL event line from `codex exec --json` (subset we depend on). */
export interface CodexExecJsonEvent {
  type?: string;
  item?: {
    type?: string;
    text?: string;
    content?: string;
    id?: string;
  };
  message?: string | { content?: string; text?: string };
  text?: string;
  content?: string;
  session_id?: string;
  sessionId?: string;
  thread_id?: string;
  id?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Parse `codex exec --json` stdout (JSONL) into the final agent deliverable.
 * Prefers last agent_message / agent-message item; falls back to last non-empty text-ish field.
 */
export function parseCodexExecJson(
  stdout: string,
  lastMessageFile?: string,
): { ok: true; data: CodexExecJsonEvent; text: string; sessionId?: string } | { ok: false; error: string } {
  // Preferred path: --output-last-message file (reliable when the CLI writes it).
  if (lastMessageFile && existsSync(lastMessageFile)) {
    try {
      const text = readFileSync(lastMessageFile, 'utf8').trim();
      if (text) {
        return {
          ok: true,
          data: { type: 'output_last_message', text },
          text,
        };
      }
    } catch {
      /* fall through to JSONL */
    }
  }

  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false, error: 'empty stdout from codex exec' };

  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  let sessionId: string | undefined;
  let lastText = '';
  let lastEvent: CodexExecJsonEvent = {};

  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const ev = JSON.parse(line) as CodexExecJsonEvent;
      lastEvent = ev;
      const sid =
        (typeof ev.session_id === 'string' && ev.session_id) ||
        (typeof ev.sessionId === 'string' && ev.sessionId) ||
        (typeof ev.thread_id === 'string' && ev.thread_id) ||
        (typeof ev.id === 'string' && ev.id) ||
        undefined;
      if (sid) sessionId = sid;

      const itemType = (ev.item?.type ?? '').toLowerCase();
      const evType = (ev.type ?? '').toLowerCase();
      const isAgentMsg =
        itemType.includes('agent_message') ||
        itemType.includes('agent-message') ||
        itemType === 'message' ||
        evType.includes('agent_message') ||
        evType.includes('last_agent_message') ||
        evType === 'message';

      const candidates: string[] = [];
      if (typeof ev.item?.text === 'string') candidates.push(ev.item.text);
      if (typeof ev.item?.content === 'string') candidates.push(ev.item.content);
      if (typeof ev.text === 'string') candidates.push(ev.text);
      if (typeof ev.content === 'string') candidates.push(ev.content);
      if (typeof ev.message === 'string') candidates.push(ev.message);
      if (ev.message && typeof ev.message === 'object') {
        if (typeof ev.message.text === 'string') candidates.push(ev.message.text);
        if (typeof ev.message.content === 'string') candidates.push(ev.message.content);
      }

      for (const c of candidates) {
        if (c.trim() && (isAgentMsg || !lastText)) {
          // Prefer agent messages; otherwise keep last non-empty text as weak fallback.
          if (isAgentMsg || !lastText) lastText = c;
        }
      }
    } catch {
      /* skip non-JSON line */
    }
  }

  if (lastText.trim()) {
    return { ok: true, data: lastEvent, text: lastText.trim(), sessionId };
  }

  // Plain-text fallback (some builds print the final message without JSONL framing).
  if (!lines.some((l) => l.startsWith('{'))) {
    return { ok: true, data: { text: trimmed }, text: trimmed, sessionId };
  }

  return { ok: false, error: 'no agent message in codex exec --json output' };
}

export const defaultCodexSpawn: CodexCliSpawn = createDefaultCliSpawn('codex');

/**
 * Build argv for a fresh `codex exec` (headless multi-step agent loop).
 * --json for audit stream; --output-last-message for reliable deliverable capture;
 * sandbox + cwd clamp via flags.
 *
 * AUDIT (cli-grok multiturn fix, 2026-07-20): unlike Grok's -p path (default ~2 turns without
 * --max-turns), Codex `exec` has no turn/step budget CLI flag — multi-turn tool use is the default.
 * Do not invent a fake --max-turns; keep timeoutMs as the wall-clock runaway bound.
 */
export function buildCodexExecArgv(opts: {
  packPath: string;
  cwd: string;
  writeCapable: boolean;
  lastMessagePath: string;
  extraArgs?: string[];
  /** When pack is small enough, pass inline as the prompt positional; else instruct to read packPath. */
  inlinePrompt?: string;
}): string[] {
  const sandbox = opts.writeCapable ? 'workspace-write' : 'read-only';
  const argv: string[] = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    sandbox,
    '-C',
    opts.cwd,
    '--output-last-message',
    opts.lastMessagePath,
  ];
  if (opts.extraArgs?.length) argv.push(...opts.extraArgs);

  const prompt =
    opts.inlinePrompt && opts.inlinePrompt.length <= 80_000
      ? opts.inlinePrompt
      : [
          'You are running as an Opused fleet node via Codex CLI.',
          `Your full mission pack is on disk at: ${opts.packPath}`,
          'Read that file completely (it includes injects, consumes, and the task).',
          'Execute the task. Your FINAL assistant message is the deliverable for the next stage (.out).',
          'Do not ask the operator questions — complete or state blockers in the deliverable.',
        ].join('\n');
  argv.push(prompt);
  return argv;
}

export function createCliCodexExecutor(options: CliCodexExecutorOptions = {}): NodeExecutor {
  const bin = options.bin ?? process.env.OPUSED_CODEX_BIN ?? 'codex';
  const envTimeout = Number(process.env.OPUSED_CLI_TIMEOUT_MS);
  const timeoutMs =
    options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 15 * 60_000);
  const spawnFn = options.spawn ?? defaultCodexSpawn;

  return {
    kind: 'cli-codex',
    async run(ctx: NodeExecContext): Promise<NodeExecResult> {
      const cwd = resolveNodeCwd(ctx.node, ctx.sandboxRoot);
      const nodeLogDir = join(ctx.runDir, 'nodes', ctx.node.id);
      try {
        mkdirSync(nodeLogDir, { recursive: true });
      } catch {
        /* ok */
      }
      const packPath = resolve(nodeLogDir, 'cli-pack.txt');
      const lastMessagePath = resolve(nodeLogDir, 'cli-last-message.txt');
      const fullPrompt = [
        ctx.system ? `===== SYSTEM =====\n${ctx.system}\n` : '',
        '===== MISSION PACK =====',
        ctx.packText,
        '',
        'You are running as an Opused fleet node via Codex CLI.',
        'Execute the task. Your FINAL assistant message is the deliverable for the next stage (.out).',
        'Do not ask the operator questions — complete or state blockers in the deliverable.',
      ]
        .filter(Boolean)
        .join('\n');
      writeFileSync(packPath, fullPrompt, 'utf8');

      const writeCapable = options.writeCapable === true;
      const argv = buildCodexExecArgv({
        packPath,
        cwd,
        writeCapable,
        lastMessagePath,
        extraArgs: options.extraArgs,
        inlinePrompt: fullPrompt.length <= 80_000 ? fullPrompt : undefined,
      });

      writeFileSync(
        resolve(nodeLogDir, 'cli-invoke.json'),
        JSON.stringify(
          {
            bin,
            argv: argv.map((a, i) =>
              i === argv.length - 1 && a.length > 500 ? `${a.slice(0, 500)}…(${a.length} chars)` : a,
            ),
            cwd,
            timeoutMs,
            writeCapable,
            runner: 'cli-codex',
            ts: ctx.now(),
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );

      if (!existsSync(cwd)) {
        throw new Error(`cli-codex cwd does not exist: ${cwd}`);
      }

      const proc = await spawnFn({ bin, argv, cwd, timeoutMs });
      writeFileSync(resolve(nodeLogDir, 'cli-stdout.txt'), proc.stdout, 'utf8');
      if (proc.stderr) writeFileSync(resolve(nodeLogDir, 'cli-stderr.txt'), proc.stderr, 'utf8');

      if (proc.exitCode !== 0) {
        const tail = (proc.stderr || proc.stdout).slice(-800);
        throw new Error(`cli-codex exit ${proc.exitCode}: ${tail || 'no output'}`);
      }

      const parsed = parseCodexExecJson(proc.stdout, lastMessagePath);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }

      // Best-effort tool trace: codex exec JSONL tool frames are product-shaped and unstable.
      // Leave toolEvents undefined → judge tool_trace_status=unavailable (never pretend zero tools).
      return {
        text: parsed.text,
        sessionId: parsed.sessionId,
        modelLabel: 'cli-codex',
        exitCode: proc.exitCode,
        events: [
          {
            type: 'cli_result',
            detail: {
              sessionId: parsed.sessionId,
              runner: 'cli-codex',
              tool_trace: 'unavailable',
            },
          },
        ],
      };
    },
  };
}
