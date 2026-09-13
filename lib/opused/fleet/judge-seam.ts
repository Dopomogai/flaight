// @purpose: Judge generate seam factory — single-turn CouncilGenerate for rubric scoring (cli-grok / cli-claude / api)
// @why: dec-judge-seam P2 — judges must not ride agentic NodeExecutors; founder grok-everywhere defaults judges to
//       cli-grok while seats keep their own runner; split seat seam vs judge seam (spec §3.1 Option A)
// @role: safety-critical
// @stability: experimental

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CouncilGenerate } from '../council/types';
import { createLiveCouncil } from '../council/generate';
import { createCliSeam, type CliSeamOptions } from './cli-seam';
import { extractGrokEnvelopeUsage, parseGrokPrintOutput } from './executors/cli-grok';
import { createDefaultCliSpawn, type CliSpawn } from './executors/cli-process';

/** Backends a contract.judge / OPUSED_JUDGE_SEAM may select. */
export type JudgeSeamKind = 'cli-grok' | 'cli-claude' | 'api';

export const JUDGE_SEAM_KINDS: readonly JudgeSeamKind[] = ['cli-grok', 'cli-claude', 'api'] as const;

export function isJudgeSeamKind(v: string): v is JudgeSeamKind {
  return (JUDGE_SEAM_KINDS as readonly string[]).includes(v);
}

/**
 * One judge generate backend. Judges stay single-turn (CouncilGenerate); never multi-turn NodeExecutor.
 * `label` is the provenance string recorded on JudgeVerdict.backend (never an OpenRouter slug for CLI seams).
 */
export interface JudgeSeam {
  kind: JudgeSeamKind;
  /** Provenance: "cli-grok" | "cli-grok:<model>" | "cli-claude" | "cli-claude:opus" | "api:z-ai/glm-5.2" */
  label: string;
  generate: CouncilGenerate;
  recordCost: (genId: string) => Promise<{ costUsd: number }>;
}

export interface JudgeSeamOptions {
  /** Binary path override (claude / grok). */
  bin?: string;
  timeoutMs?: number;
  /** Injectable spawn (tests — $0, no real CLI). */
  spawn?: CliSpawn;
  /** CLI model alias (subscription) or OpenRouter slug (api only). Not mixed across kinds. */
  model?: string;
  cwd?: string;
  /** Forwarded to createLiveCouncil when kind=api. */
  relaxZdr?: boolean;
}

/** Inline-prompt budget — same threshold as cli-seam / cli-grok executor (argv under ARG_MAX). */
const INLINE_PROMPT_MAX = 80_000;

/**
 * Resolution order (most specific wins) — §3.1 / §4.3:
 * 1. contract.judge.runner
 * 2. OPUSED_JUDGE_SEAM env
 * 3. If OPUSED_SEAM=api → api; else **cli-grok** (new default for judges only)
 */
export function resolveJudgeSeamKind(opts: {
  runner?: string | null;
  judgeSeamEnv?: string | null;
  seatSeamEnv?: string | null;
}): JudgeSeamKind {
  if (opts.runner && isJudgeSeamKind(opts.runner)) return opts.runner;
  if (opts.judgeSeamEnv && isJudgeSeamKind(opts.judgeSeamEnv)) return opts.judgeSeamEnv;
  if (opts.seatSeamEnv === 'api') return 'api';
  return 'cli-grok';
}

/**
 * Grok subscription single-turn generate for judges.
 * Mirrors createCliSeam: reject tools/messages non-retryably; never --always-approve; max-turns 1; print only.
 * Provenance label is always `cli-grok` / `cli-grok:<alias>` — never an OpenRouter slug.
 */
export function createGrokSeam(
  env: Record<string, string | undefined> = process.env,
  opts: JudgeSeamOptions = {},
): {
  generate: CouncilGenerate;
  recordCost: (genId: string) => Promise<{ costUsd: number }>;
  label: string;
} {
  const bin = opts.bin ?? env.OPUSED_GROK_BIN ?? 'grok';
  const envTimeout = Number(env.OPUSED_JUDGE_SEAM_TIMEOUT_MS ?? env.OPUSED_CLI_SEAM_TIMEOUT_MS);
  const timeoutMs =
    opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 10 * 60_000);
  const spawnFn = opts.spawn ?? createDefaultCliSpawn('grok-judge-seam');
  // CLI alias only — caller's OpenRouter slug is NOT honored (same rule as createCliSeam).
  const cliModel = opts.model ?? env.OPUSED_GROK_SEAM_MODEL ?? env.OPUSED_JUDGE_MODEL ?? undefined;
  // Refuse OpenRouter-style slugs as "model" so provenance never claims a metered route.
  const safeModel =
    cliModel && !cliModel.includes('/') ? cliModel : undefined;
  const label = `cli-grok${safeModel ? `:${safeModel}` : ''}`;
  let workDir: string | null = opts.cwd ?? null;
  let callSeq = 0;

  const generate: CouncilGenerate = async ({ model, system, prompt, onCall, tools, messages }) => {
    if (tools && Object.keys(tools).length > 0) {
      throw new Error(
        `cli-grok judge seam is single-turn: agentic call (tools) requested for model "${model}" — ` +
          'tool-loop seats need the metered API seam (explicit OPUSED_SEAM=api) or a cli-* NodeExecutor, not the judge seam',
      );
    }
    if (Array.isArray(messages) && messages.length > 0) {
      throw new Error(
        'cli-grok judge seam is single-turn: conversation continuation (messages) is unsupported — ' +
          'continuation seats need the metered API seam (explicit OPUSED_SEAM=api) or a cli-* NodeExecutor',
      );
    }
    if (!workDir) workDir = mkdtempSync(join(tmpdir(), 'opused-grok-judge-seam-'));

    // Print-only judge: NO --always-approve (write/shell attempts die on closed-stdin approval) and a
    // small turn budget. grok 0.2.111 constraints (all live-proven 2026-08-04): --disallowed-tools is
    // unenforced, an EMPTY --tools string is IGNORED (default toolset stays), and --max-turns 1 dies
    // with "max turns reached" whenever the judge tries to verify a claim by reading a file. Budget 3:
    // the judge MAY read (read-only tools auto-approve — verification is a feature), it may not mutate.
    const argv: string[] = [
      '--max-turns',
      '3',
      '--output-format',
      'json',
    ];
    if (safeModel) argv.push('--model', safeModel);
    if (system.trim()) argv.push('--rules', system);

    if (prompt.length <= INLINE_PROMPT_MAX) {
      argv.push('-p', prompt);
    } else {
      const packPath = join(workDir, `pack-${++callSeq}.txt`);
      writeFileSync(packPath, prompt, 'utf8');
      argv.push('--prompt-file', packPath);
    }

    const started = Date.now();
    const proc = await spawnFn({ bin, argv, cwd: workDir, timeoutMs });
    const elapsedMs = Date.now() - started;
    if (proc.exitCode !== 0) {
      const tail = (proc.stderr || proc.stdout).slice(-800);
      throw new Error(`cli-grok judge seam (${bin}) exit ${proc.exitCode}: ${tail || 'no output'}`);
    }
    const parsed = parseGrokPrintOutput(proc.stdout, 'json');
    if (!parsed.ok) throw new Error(`cli-grok judge seam: ${parsed.error}`);

    // BENCHMARK-PREP checklist 1 (CLI-seat usage metering parity): the grok -p envelope carries
    // usage — harvest what it reported onto the call trace (the metering receipt the orchestrator
    // folds into the endpoint `usage`). Absent = absent: never invent tokens.
    const usage = extractGrokEnvelopeUsage(parsed.data);

    onCall?.({
      model: label,
      system,
      prompt,
      response: parsed.text,
      finishReason: 'stop',
      toolCalls: [],
      toolEvents: [],
      elapsedMs,
      ...(usage?.inputTokens !== undefined ? { promptTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { completionTokens: usage.outputTokens } : {}),
      ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    });
    const sessionId =
      typeof parsed.data.session_id === 'string'
        ? parsed.data.session_id
        : typeof parsed.data.sessionId === 'string'
          ? parsed.data.sessionId
          : null;
    return { text: parsed.text, genId: sessionId, finishReason: 'stop', toolCalls: [] };
  };

  // Subscription-flat: label, never invent (executor.ts costHint rule).
  const recordCost = async (_genId: string): Promise<{ costUsd: number }> => ({ costUsd: 0 });

  return { generate, recordCost, label };
}

/**
 * Build a JudgeSeam for the given kind.
 * - cli-claude → createCliSeam (existing single-turn subscription scorer)
 * - cli-grok → createGrokSeam (new; default for judges)
 * - api → createLiveCouncil (metered; explicit opt-in only — never the silent default)
 */
export function createJudgeSeam(
  kind: JudgeSeamKind,
  env: Record<string, string | undefined> = process.env,
  opts: JudgeSeamOptions = {},
): JudgeSeam {
  if (kind === 'cli-claude') {
    const cliOpts: CliSeamOptions = {
      ...(opts.bin ? { bin: opts.bin } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.spawn ? { spawn: opts.spawn } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    };
    const { generate, recordCost } = createCliSeam(env, cliOpts);
    const cliModel = opts.model ?? env.OPUSED_CLI_SEAM_MODEL ?? undefined;
    const label = `cli-claude${cliModel ? `:${cliModel}` : ''}`;
    return { kind, label, generate, recordCost };
  }

  if (kind === 'cli-grok') {
    const { generate, recordCost, label } = createGrokSeam(env, opts);
    return { kind, label, generate, recordCost };
  }

  // api — metered; createLiveCouncil. recordCost is real for this path (not forced to 0).
  const relaxZdr = opts.relaxZdr ?? env.OPUSED_RELAX_ZDR === 'true';
  const { generate, recordCost } = createLiveCouncil(env, { relaxZdr });
  const apiModel =
    opts.model ?? env.OPUSED_FORCE_MODEL ?? env.OPUSED_BATCH_MODEL ?? 'z-ai/glm-5.2';
  return {
    kind: 'api',
    label: `api:${apiModel}`,
    generate,
    recordCost,
  };
}
