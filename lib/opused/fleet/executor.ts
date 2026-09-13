// @purpose: NodeExecutor interface + resolveExecutor — API / CLI / conversational node backends
// @why: dec-040 OPUSED-CLI-RUNNERS CR-1: fleet nodes may run via OpenRouter generate OR product CLIs
//       (claude/grok) without re-implementing their tool surface; same plan graph, different executor
// @role: safety-critical
// @stability: experimental

import { isAbsolute, relative, resolve } from 'node:path';
import type { ToolEvent } from '../council/types';
import type { Node, NodeRunnerKind, Stage } from './plan';

/** Canonical runner kinds (mirror plan.NodeRunnerKindSchema). */
export type ExecutorKind = NodeRunnerKind;

/**
 * CR-2b / dec-048 G2 originally required CLI node concurrency to stay LOW (1–4). That requirement is
 * SUPERSEDED as of 2026-08-07 — see the measurement below. The cap still applies per stage containing any
 * cli-* node, because a CLI node is an OS process tree and must never be paced by an API-sized pool.
 *
 * WHY IT IS 4 AND WHY THAT IS NOW A CEILING WE FEEL (2026-08-07): the cap was written in July as a
 * "cost surprise" guard (OPUSED-CLI-RUNNERS-PLAN §risks) when a CLI node meant a METERED claude seat.
 * cli-grok is a SUBSCRIPTION seam, so the risk it guards is no longer per-call money — it is the weekly
 * window, which the ledger now measures directly (lib/opused/grok-budget.ts). Meanwhile the cap is the
 * hard ceiling on "one node per file, 500 nodes if needed": at 4-wide, 500 nodes × ~30 s is over an hour
 * of wall clock no matter what the plan says, and the console prints "concurrency 64" while running 4.
 *
 * RAISED 2026-08-07 on measured evidence. Founder: *"why so little? is there a limit, I dont think so - we
 * could be doing 500 if needed - this mac should have enough RAM I quess (64gb)"*, and: *"these 2 fleets you
 * ran just used 2% of the limits and we are at 36% now ... we need to double downt he usage"*.
 *
 * The measurement, from the two 2026-08-07 fleets (200 executed cli-grok nodes, journal-summed):
 *
 *   200 nodes ≈ 2 % of the weekly window   →  ~100 nodes per 1 %,  ~10,000 nodes per week
 *   7.69 M billed tokens                   →  ~3.8 M tokens per 1 %
 *   at 36 % used                           →  ~6,400 nodes of headroom before the reset
 *
 * So the window is NOT the binding constraint at our current volume — we used 2 % of a week on the two
 * largest fleets we have ever run. The old cap was throttling throughput against a risk (per-call money)
 * that stopped existing when the seam became a subscription.
 *
 * What the real ceiling is, in order: (1) grok's own server-side rate limits, which we have never measured
 * and which will announce themselves as errors rather than slowness; (2) OS process pressure — each CLI node
 * is a real process tree, not a socket, so this can never be unbounded; (3) the weekly window, which is
 * measured and currently slack. 24 is chosen as a default that roughly triples throughput while staying
 * inside a plausible rate limit, and 128 as a ceiling for a deliberate wide run. Both are provisional: the
 * point is to find (1) empirically rather than keep guessing under (2). `EXP-007` owns that measurement.
 */
export const CLI_CONCURRENCY_CAP_DEFAULT = 24;

/**
 * Hard ceiling on the override. Bounded rather than unlimited on purpose: a CLI node is an OS process tree,
 * so an unbounded pool trades a rate-limit error for an unresponsive machine — a much worse failure. Raise it
 * again when EXP-007 has found where grok actually pushes back.
 */
export const CLI_CONCURRENCY_CAP_MAX = 128;

/**
 * The effective cap: `OPUSED_CLI_CONCURRENCY` when set to a sane integer, else the default.
 * Read per call (not module-load) so a test or a single run can set it without process-wide state.
 */
export function cliConcurrencyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.OPUSED_CLI_CONCURRENCY ?? '').trim();
  if (!raw) return CLI_CONCURRENCY_CAP_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return CLI_CONCURRENCY_CAP_DEFAULT;
  return Math.min(CLI_CONCURRENCY_CAP_MAX, n);
}

/** @deprecated Kept so existing callers/tests keep compiling; prefer cliConcurrencyCap(). */
export const CLI_CONCURRENCY_CAP = CLI_CONCURRENCY_CAP_DEFAULT;

/**
 * Claude Code tools blocked when the run is not write-armed (!writeIntent / !writeCapable).
 * Belt on top of --permission-mode dontAsk (sandbox settings.json allowlists can bypass dontAsk alone).
 */
export const CLI_READ_ONLY_DISALLOWED_TOOLS = 'Edit,Write,Bash';

/**
 * Token usage exactly as the product CLI reported it (BENCHMARK-PREP checklist 1 — CLI-seat metering
 * parity). Every field is optional: present only when the envelope carried it — absent = absent,
 * never invented. The runner persists it on the node's CLI turn record; the P0 endpoint folds it
 * into the OpenAI `usage` receipt via collectTurnUsageItems (same aliases, same single helper).
 */
export interface CliUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Result of one node execution (API generate, CLI print, or conversational turn budget). */
export interface NodeExecResult {
  /** Final assistant text written to contract.outputPath (or synthesized from CLI stdout). */
  text: string;
  /** Optional sidecar artifacts (paths relative to runDir or absolute under sandbox). */
  artifacts?: string[];
  /** CLI / conversational session id for resume (CR-4). */
  sessionId?: string;
  /** Soft cost label — subscription CLIs may not have true $ (plan: label, not invent). */
  costHint?: string;
  /** Token usage the CLI envelope reported (never invented; absent when the product emitted none). */
  usage?: CliUsage;
  /** Best-effort stream/timeline events for run.jsonl node_step. */
  events?: Array<{ type: string; detail?: Record<string, unknown> }>;
  /** Model slug or CLI binary label for provenance logs. */
  modelLabel?: string;
  /** Raw CLI exit code when kind is cli-*. */
  exitCode?: number;
  /**
   * dec-judge-seam: parsed tool invocations for judge WORK EVIDENCE (CLI stdout / product JSON).
   * `undefined` = tool channel unavailable/unparsed (do not pretend zero tools).
   * `[]` = channel present and truly empty.
   */
  toolEvents?: ToolEvent[];
  /** Count of write-tool invocations among toolEvents (when known). */
  writeOps?: number;
}

/**
 * Per-node execution context assembled by run.ts before dispatching.
 * CR-1 defines the contract; CR-2+ fill fields executors need (pack, timeouts, spawn).
 */
export interface NodeExecContext {
  runId: string;
  runDir: string;
  node: Node;
  stageId: string;
  /** Assembled inject+consumes pack text (same buildContextPack as API path). */
  packText: string;
  /** Resolved system framing (persona/preset/seat). */
  system: string;
  /** Effective model slug (forceModel / agent.model / default) — API path. */
  model: string;
  /** Sandbox root for tools / CLI cwd (agent.cwd overrides when set). */
  sandboxRoot: string;
  /** Wall-clock ISO injector. */
  now: () => string;
  /** Optional AI-SDK tools — ONLY for kind=api. CLI runners must leave unused (CLI owns tools). */
  tools?: Record<string, unknown>;
  maxSteps?: number;
  maxOutputTokens?: number;
}

/**
 * Pluggable node backend. run.ts: resolveExecutor(node) → executor.run(ctx) → write .out.
 * CR-1: interface + kind resolution. CR-2+: concrete cli-claude / cli-grok / conversational.
 */
export interface NodeExecutor {
  kind: ExecutorKind;
  run(ctx: NodeExecContext): Promise<NodeExecResult>;
}

/** Normalize agent.runner after parsePlan (always present; default api). */
export function runnerOf(node: Node): ExecutorKind {
  return node.agent.runner ?? 'api';
}

export function isCliRunner(kind: ExecutorKind): boolean {
  return kind === 'cli-grok' || kind === 'cli-claude' || kind === 'cli-codex' || kind === 'cli-qwen';
}

export function isApiRunner(kind: ExecutorKind): boolean {
  return kind === 'api';
}

/**
 * Resolve which backend runs this node.
 * CR-1: returns a descriptor; only `api` is executable via the existing runNode generate loop.
 * Non-api kinds are accepted by the plan schema but must not silently fall through to API spend.
 */
export function resolveExecutorKind(node: Node): ExecutorKind {
  return runnerOf(node);
}

/** Human-readable refuse reason when a plan asks for a runner that is not wired yet. */
export function unimplementedRunnerMessage(kind: ExecutorKind): string {
  switch (kind) {
    case 'cli-claude':
      return 'runner cli-claude requires createCliClaudeExecutor (CR-2) — wire RunDeps.executors';
    case 'cli-grok':
      return 'runner cli-grok requires createCliGrokExecutor (CR-3) — wire RunDeps.executors';
    case 'cli-codex':
      return 'runner cli-codex requires createCliCodexExecutor — wire RunDeps.executors';
    case 'cli-qwen':
      return 'runner cli-qwen requires createCliQwenExecutor — wire RunDeps.executors';
    case 'conversational':
      return 'runner conversational not implemented yet (CR-6)';
    case 'api':
      return 'api runner is the default generate path';
    default: {
      const _x: never = kind;
      return `unknown runner ${String(_x)}`;
    }
  }
}

/** Optional executor registry on RunDeps (CR-2+). */
export type ExecutorRegistry = Partial<Record<Exclude<ExecutorKind, 'api'>, NodeExecutor>>;

/**
 * Look up a non-api executor. Returns null when kind is api or not registered.
 * run.ts fails the node if a non-api kind has no registered executor.
 */
export function lookupExecutor(
  kind: ExecutorKind,
  registry: ExecutorRegistry | undefined,
): NodeExecutor | null {
  if (kind === 'api') return null;
  const ex = registry?.[kind];
  return ex ?? null;
}

/**
 * Effective CLI working directory: agent.cwd if set, else sandboxRoot.
 * CR-2b: reject paths that escape sandboxRoot (absolute or relative ..).
 * Existence is still checked at execute-time by the executor.
 */
export function resolveNodeCwd(node: Node, sandboxRoot: string): string {
  const root = resolve(sandboxRoot);
  const raw = node.agent.cwd?.trim();
  if (!raw) return root;
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const rel = relative(root, abs);
  // Outside sandbox: relative starts with .. OR is absolute (cross-drive / different root on Windows).
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `agent.cwd escapes sandboxRoot: ${JSON.stringify(raw)} (resolved ${abs}, sandbox ${root})`,
    );
  }
  return abs;
}

/** True when any node in the stage uses a CLI runner. */
export function stageHasCliRunner(stage: Stage): boolean {
  return stage.nodes.some((n) => isCliRunner(runnerOf(n)));
}

/**
 * Stage worker-pool size after CR-2b CLI cap.
 * API-only stages keep full concurrency; stages with any cli-* node clamp to [1, CLI_CONCURRENCY_CAP].
 */
export function effectiveStageConcurrency(
  stage: Stage,
  baseConcurrency: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const base = Math.max(1, baseConcurrency);
  if (!stageHasCliRunner(stage)) return base;
  return Math.max(1, Math.min(cliConcurrencyCap(env), base));
}
