// @purpose: cli-seam — a CouncilGenerate backed by the Claude subscription CLI (claude -p), no API spend
// @why: FOUNDER ORDER 2026-07-20: opused fleet runs SUBSCRIPTION-ONLY. The triad runs silently scored
//       every {judge} rubric on z-ai/glm-5.2 through OPENROUTER_API_KEY (metered) because the only seam
//       was createLiveCouncil. This seam rides the flat Claude subscription instead; the metered API
//       seam now requires the explicit OPUSED_SEAM=api opt-in (scripts/fleet.ts).
// @role: safety-critical
// @stability: experimental

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CouncilGenerate } from '../council/types';
import { CLI_READ_ONLY_DISALLOWED_TOOLS } from './executor';
import { extractClaudeEnvelopeUsage, parseClaudePrintJson } from './executors/cli-claude';
import { createDefaultCliSpawn, type CliSpawn } from './executors/cli-process';

export interface CliSeamOptions {
  /** Binary name or path (default env OPUSED_CLAUDE_BIN, then `claude`). */
  bin?: string;
  /** Wall clock for one print invocation (default env OPUSED_CLI_SEAM_TIMEOUT_MS, then 10 min). */
  timeoutMs?: number;
  /** Injectable spawn (tests — $0, no real CLI). */
  spawn?: CliSpawn;
  /** CLI model alias passed as --model (default env OPUSED_CLI_SEAM_MODEL, then the CLI's default).
   *  NOTE: the caller's OpenRouter slug is NOT honored — the subscription CLI serves its own models;
   *  the trace records the seam label so provenance never claims a slug that didn't run. */
  model?: string;
  /** Working directory for the CLI process (default: a fresh temp dir — the judge material is fully
   *  in the prompt; no repo context is needed or wanted for a scoring call). */
  cwd?: string;
}

/** Inline-prompt budget, same threshold the cli-claude executor proved (argv stays under ARG_MAX). */
const INLINE_PROMPT_MAX = 80_000;

/**
 * Build a live generate fn + cost reader riding the Claude SUBSCRIPTION CLI. Single-turn ONLY:
 * agentic calls (tools / continuation messages) throw a NON-retryable error naming the OPUSED_SEAM=api
 * escape hatch — this seam must never silently degrade a tool-loop seat into a text-only call.
 * Judge/rubric scoring and schema retries are single-turn, which is exactly what fleet CLI-runner
 * plans need from the seam.
 */
export function createCliSeam(
  env: Record<string, string | undefined> = process.env,
  opts: CliSeamOptions = {},
): {
  generate: CouncilGenerate;
  recordCost: (genId: string) => Promise<{ costUsd: number }>;
} {
  const bin = opts.bin ?? env.OPUSED_CLAUDE_BIN ?? 'claude';
  const envTimeout = Number(env.OPUSED_CLI_SEAM_TIMEOUT_MS);
  const timeoutMs =
    opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 10 * 60_000);
  const spawnFn = opts.spawn ?? createDefaultCliSpawn('claude-seam');
  const cliModel = opts.model ?? env.OPUSED_CLI_SEAM_MODEL ?? undefined;
  const label = `cli-claude${cliModel ? `:${cliModel}` : ''}`;
  // One work dir per seam instance; per-call pack files get unique names inside it.
  let workDir: string | null = opts.cwd ?? null;
  let callSeq = 0;

  const generate: CouncilGenerate = async ({ model, system, prompt, onCall, tools, messages }) => {
    if (tools && Object.keys(tools).length > 0) {
      throw new Error(
        `cli seam is single-turn: agentic call (tools) requested for model "${model}" — ` +
          'tool-loop seats need the metered API seam (explicit OPUSED_SEAM=api)',
      );
    }
    if (Array.isArray(messages) && messages.length > 0) {
      throw new Error(
        'cli seam is single-turn: conversation continuation (messages) is unsupported — ' +
          'continuation seats need the metered API seam (explicit OPUSED_SEAM=api)',
      );
    }
    if (!workDir) workDir = mkdtempSync(join(tmpdir(), 'opused-cli-seam-'));

    const argv: string[] = [
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--permission-mode',
      'dontAsk',
      // Belt: a scoring call must never mutate anything, whatever the sandbox-local settings say.
      '--disallowedTools',
      CLI_READ_ONLY_DISALLOWED_TOOLS,
    ];
    if (cliModel) argv.push('--model', cliModel);
    if (system.trim()) argv.push('--append-system-prompt', system);
    if (prompt.length <= INLINE_PROMPT_MAX) {
      argv.push(prompt);
    } else {
      const packPath = join(workDir, `pack-${++callSeq}.txt`);
      writeFileSync(packPath, prompt, 'utf8');
      argv.push(
        [
          'Your full instruction is on disk (too large for argv).',
          `Read the file at: ${packPath}`,
          'Then follow it exactly. Your final message is the deliverable.',
        ].join('\n'),
      );
    }

    const started = Date.now();
    const proc = await spawnFn({ bin, argv, cwd: workDir, timeoutMs });
    const elapsedMs = Date.now() - started;
    if (proc.exitCode !== 0) {
      const tail = (proc.stderr || proc.stdout).slice(-800);
      throw new Error(`cli seam (${bin}) exit ${proc.exitCode}: ${tail || 'no output'}`);
    }
    const parsed = parseClaudePrintJson(proc.stdout);
    if (!parsed.ok) throw new Error(`cli seam: ${parsed.error}`);

    // BENCHMARK-PREP checklist 1 (CLI-seat usage metering parity): the claude -p envelope carries
    // usage/modelUsage — harvest what it reported onto the call trace (the metering receipt the
    // orchestrator folds into the endpoint `usage` and run.ts persists as the node turn record).
    // Absent = absent: never invent tokens, so usageCoverage stays honest (full/partial/none).
    const usage = extractClaudeEnvelopeUsage(parsed.data);

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
    return { text: parsed.text, genId: parsed.data.session_id ?? null, finishReason: 'stop', toolCalls: [] };
  };

  // Subscription-flat: there is no per-call bill. Label, never invent (executor.ts costHint rule) —
  // the envelope's total_cost_usd is the CLI's own accounting, not money leaving via an API key.
  const recordCost = async (_genId: string): Promise<{ costUsd: number }> => ({ costUsd: 0 });

  return { generate, recordCost };
}
