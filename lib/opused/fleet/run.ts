// @purpose: The STAGED fleet runner — execute a validated plan stage-by-stage, scoped-context, fail-forward
// @why: F0.2 staged execution (docs/architecture/PLAN-fleet-program-2026-07.md): "contract-first → fan-out →
//       judge/gate → integrate; a stage's fan-out never starts until its input contracts exist. No barrier-free
//       500-agent free-for-all." Reuses the ONE model seam Opused already has (CouncilGenerate from
//       council/generate.ts — same ZDR pin, provider, timeout) rather than forking a second client. Every node
//       writes runs/<runId>/<node.id>.out; every lifecycle event (start/finish/fail/skip + judge verdict) is
//       appended to runs/<runId>/run.jsonl. Fail-forward: a node whose consumes failed is SKIPPED with a
//       recorded reason — never a hang. The judge hook RECORDS a pass/fail; a gate never deletes outputs
//       (compose.ts discipline: gate marks, it does not silently drop the artifact).
// @role: safety-critical
// @stability: experimental

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { CouncilGenerate, CallTrace, ToolEvent } from '../council/types';
import type { FleetPlan, Node, Stage, JudgeSpec } from './plan';
import { indexPlan, resolveConsumedNodeIds, renderTaskPrompt } from './plan';
import { executeCompute } from './compute/execute';
import { resolveProfile } from './agents';
import { buildContextPack, missingRequiredInjectPaths } from './context-pack';
import { extractJson, validateAgainstSchema, type SchemaResult } from './schema-check';
import {
  isAwaitingPreapprove,
  isPreapproveRejected,
  PREAPPROVE_GATE,
  readSpawnMeta,
} from './approval';
import {
  effectiveStageConcurrency,
  isApiRunner,
  lookupExecutor,
  resolveExecutorKind,
  resolveNodeCwd,
  unimplementedRunnerMessage,
  type ExecutorRegistry,
  type NodeExecContext,
  type NodeExecResult,
} from './executor';
import { createCliClaudeExecutor } from './executors/cli-claude';
import { createCliGrokExecutor, resolveGrokReadOnlyTools } from './executors/cli-grok';
import { createCliCodexExecutor } from './executors/cli-codex';
import { createCliQwenExecutor } from './executors/cli-qwen';
import {
  createJudgeSeam,
  resolveJudgeSeamKind,
  type JudgeSeam,
  type JudgeSeamKind,
} from './judge-seam';
import type { CliSpawn } from './executors/cli-process';
import {
  acceptNeedsEvidence,
  applyJudgeOverlay,
  claimsWork,
  countWriteOps,
  evidenceWaiver,
  JUDGE_WRITE_TOOL_NAMES,
  parseEvidenceCited,
  resolveToolTraceStatus,
  zeroToolCalls,
  type EvidenceWaiver,
  type JudgeOverlayKind,
  type ToolTraceStatus,
} from './judge-evidence';
import {
  diffTreeSnapshots,
  snapshotTree,
  treeKnownClean,
  treeWorkLanded,
  type FilesChangedFact,
  type TreeSnapshot,
} from './tree-change';
import {
  appendControlMessagesToPack,
  createControlApplier,
  type ControlApplier,
  type ControlOpRecord,
} from './control';

/**
 * Write a node's declared output, creating its parent directory first.
 *
 * A plan may declare a NESTED outputPath (`file-audit/<id>.out`) — a 72-node fan-out is unreadable with 72
 * files loose in the run root. Nothing created that subdirectory, so on 2026-08-07 a 117-node plan-harvest
 * fleet spawned its grok nodes fine and then died on the FIRST completion with
 * `ENOENT: open '.../plan-harvest/doc001.out'` — one missing directory killed all 117. parsePlan already
 * refuses a traversing path, so the mkdir here can only ever create a directory inside the run.
 */
function writeDeclaredOutput(runDir: string, outputPath: string, text: string): void {
  const abs = resolve(runDir, outputPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

/**
 * Durable proof that a node completed its required gate path (schema → tsc/test/judge as wired).
 * Crash-resume (Critical-1) trusts ONLY this marker + a still-valid .out — never bare output existence.
 * Written under nodes/<nodeId>/committed.json only after node_finish with status done.
 */
export const NODE_COMMITTED_FILE = 'committed.json';

function nodeCommittedPath(nodeDir: string): string {
  return resolve(nodeDir, NODE_COMMITTED_FILE);
}

function writeNodeCommitted(nodeDir: string, payload: Record<string, unknown>): void {
  try {
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(nodeCommittedPath(nodeDir), JSON.stringify(payload) + '\n', 'utf8');
  } catch {
    /* a marker write must never fail the node */
  }
}

function isNodeCommitted(nodeDir: string): boolean {
  return existsSync(nodeCommittedPath(nodeDir));
}

/**
 * Epic-6: nodes whose LAST prior `node_finish` shows unverified/disputed work (trust spine).
 * Last-finish wins so a successful re-run clears an older disputed finish (parseRunLog sticks
 * judgeDisputed=true — do not reuse that fold for skip-cache decisions). Defensive: garbled lines
 * skipped; old journals without the fields return empty (resume parity).
 */
export function collectDisputedNodeIds(jsonl: string): Set<string> {
  const lastFinish = new Map<string, { judgeDisputed: boolean; verified?: boolean }>();
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e: { type?: string; nodeId?: string; detail?: Record<string, unknown> };
    try {
      e = JSON.parse(t) as { type?: string; nodeId?: string; detail?: Record<string, unknown> };
    } catch {
      continue;
    }
    if (e.type !== 'node_finish' || typeof e.nodeId !== 'string' || !e.nodeId) continue;
    const d = e.detail ?? {};
    lastFinish.set(e.nodeId, {
      judgeDisputed: d.judgeDisputed === true,
      verified: typeof d.verified === 'boolean' ? d.verified : undefined,
    });
  }
  const disputed = new Set<string>();
  for (const [id, d] of lastFinish) {
    if (d.judgeDisputed || d.verified === false) disputed.add(id);
  }
  return disputed;
}

/** Why a plan node will re-run under `--rerun-failed` pre-flight (CLI report + unit tests). */
export type RerunPreflightReason = 'failed' | 'skipped' | 'ungated' | 'disputed' | 'pending';

export interface RerunPreflight {
  /** Committed + valid-enough to cache (and verified when includeDisputed). */
  cached: string[];
  /** Will re-enter the pipeline (failed / skipped / ungated / disputed / never ran). */
  rerun: { id: string; reason: RerunPreflightReason }[];
}

/**
 * Epic-6 pre-flight: classify every plan node as CACHE vs RE-RUN before spend.
 * Uses the prior journal (status + last-finish dispute flags) and on-disk committed/.out markers.
 * Pure aside from fs reads of `runDir`; never mutates artifacts.
 */
export function buildRerunPreflight(args: {
  plan: FleetPlan;
  runDir: string;
  jsonl: string;
  includeDisputed: boolean;
}): RerunPreflight {
  // Fold status (failed/skipped/done) — dispute flags come from last node_finish only (see above).
  const statusById = new Map<string, 'done' | 'failed' | 'skipped' | 'cached' | 'pending'>();
  for (const line of args.jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e: { type?: string; nodeId?: string };
    try {
      e = JSON.parse(t) as { type?: string; nodeId?: string };
    } catch {
      continue;
    }
    if (!e.nodeId) continue;
    if (e.type === 'node_finish' || e.type === 'node_cached') statusById.set(e.nodeId, e.type === 'node_cached' ? 'cached' : 'done');
    else if (e.type === 'node_fail' || e.type === 'node_schema_fail') statusById.set(e.nodeId, 'failed');
    else if (e.type === 'node_skip') statusById.set(e.nodeId, 'skipped');
  }
  const disputed = args.includeDisputed ? collectDisputedNodeIds(args.jsonl) : new Set<string>();
  const cached: string[] = [];
  const rerun: { id: string; reason: RerunPreflightReason }[] = [];

  for (const stage of args.plan.stages) {
    for (const n of stage.nodes) {
      const outAbs = resolve(args.runDir, n.contract.outputPath);
      const nodeDir = resolve(args.runDir, 'nodes', n.id);
      const hasOut = existsSync(outAbs);
      const committed = isNodeCommitted(nodeDir);
      const priorStatus = statusById.get(n.id);

      if (hasOut && committed) {
        if (args.includeDisputed && disputed.has(n.id)) {
          rerun.push({ id: n.id, reason: 'disputed' });
        } else {
          cached.push(n.id);
        }
        continue;
      }
      if (priorStatus === 'failed') {
        rerun.push({ id: n.id, reason: 'failed' });
        continue;
      }
      if (priorStatus === 'skipped') {
        rerun.push({ id: n.id, reason: 'skipped' });
        continue;
      }
      if (hasOut && !committed) {
        rerun.push({ id: n.id, reason: 'ungated' });
        continue;
      }
      rerun.push({ id: n.id, reason: 'pending' });
    }
  }
  return { cached, rerun };
}

/** One agentic tool bundle a node's seat may call (AI-SDK tools object). Optional — F0's dry/test paths use none. */
export type ToolBundle = Record<string, unknown>;

/** Terminal state of a node. `skipped` = a consume failed (fail-forward); `failed` = the seat itself errored/empty. */
export type NodeStatus = 'done' | 'failed' | 'skipped';

/**
 * A judge verdict, recorded (never enforced destructively).
 * dec-246: the accept path is binary — ACCEPT or RETURN + reason. No score/threshold comparison.
 * `score` / `threshold` remain for observability + old journals; they are never consulted for accept.
 * `pass` is derived from `verdict` so pre-dec-246 readers keep working (ACCEPT→true, RETURN→false).
 * dec-judge-seam: additive evidence fields — optional for old journals; never rename verdict/pass.
 */
export interface JudgeVerdict {
  rubric: string;
  raw: string;
  /** Binary verdict — the only field the accept path consults (dec-246). */
  verdict: 'ACCEPT' | 'RETURN' | null;
  /** Why RETURN — must name a specific defect a repair pass can act on. Null on ACCEPT / unparsed. */
  reason: string | null;
  /** Legacy observability (SCORE: line if the model still emits one). Never used for accept. */
  score: number | null;
  /** Plan-declared threshold, recorded for history only. Never compared. */
  threshold: number | null;
  /** Derived from verdict for old readers: ACCEPT→true, RETURN→false, null→null. */
  pass: boolean | null;
  /** dec-judge-seam: generate backend label (cli-grok | cli-claude | api:…). */
  backend?: string;
  /** true only when tool_trace_status=empty; null when unavailable/lost. */
  zero_tool_calls?: boolean | null;
  tool_event_count?: number | null;
  /**
   * ok | empty | unavailable (legacy) | lost (harness lost the tool channel — degrade, never force).
   * Journal stamps `lost` when resolveToolTraceStatus was unavailable (JUDGE-RECOMMENDATION-2026-08-04).
   */
  tool_trace_status?: ToolTraceStatus;
  evidence_cited?: string[];
  overlay?: JudgeOverlayKind;
  requireToolEvidence?: boolean;
  /**
   * Set when tool evidence could NOT be demanded of this node (it was armed with zero tools). Present so an
   * ACCEPT is never mistaken for evidence-backed: the reader can tell "verified against its tool trace" from
   * "graded on content because there was no trace to have". Omitted whenever evidence WAS demandable.
   */
  evidence_waived?: EvidenceWaiver;
  /**
   * 1 when the judge envelope was re-asked once after an unparseable first reply (fail-closed still
   * RETURN if the retry is also unparseable). Additive journal field — omit when no retry.
   */
  retry?: number;
}

/** The per-node outcome the runner returns + logs. */
export interface NodeOutcome {
  nodeId: string;
  stageId: string;
  status: NodeStatus;
  outputPath: string;      // where the .out was written (relative to the run dir)
  reason?: string;         // set for failed/skipped
  latencyMs: number;
  degradedPack: boolean;   // pack had truncation and/or missing inputs; missing REQUIRED inject fails the node before spend
  judge?: JudgeVerdict;
  contractValid?: boolean; // F3: set iff the node declared a contract.schema — did the output satisfy it?
  testsOk?: boolean;       // test gate: set iff verifyTests ran; false = suite still red after repairs (ground truth)
  writeOps?: number;       // E-1: set iff the node held write tools — how many write-tool calls it actually made
}

/** The whole run's result. */
export interface RunResult {
  runId: string;
  runDir: string;
  outcomes: NodeOutcome[];
  done: number;
  failed: number;
  skipped: number;
  /** Set when the run PAUSED before a human-gated stage (F5) — nothing past this stage ran. */
  stoppedAtGate?: string;
  /**
   * Set when a control-plane `stop` op finished the run (T2), or a checkpoint decided `end` /
   * human-pending timeout (T3). Additive — old readers ignore unknown stoppedBy values.
   */
  stoppedBy?: 'control' | 'checkpoint';
}

/** Checkpoint decision (T3) — continue next stage, end run, or record expand intent (never auto-runs). */
export type CheckpointDecision = 'continue' | 'end' | 'expand' | 'pending';

/** A run.jsonl event. `ts` is caller-stamped ISO (clock injectable → testable). */
export interface RunEvent {
  ts: string;
  /**
   * `run_tests` — harness- or tool-recorded vitest invocation (path + pass/fail).
   * Was wired into the judge in-memory (testRunsFor) but never journalled; 182 historical runs
   * carry zero of these. dec-246 feeds the channel for real.
   * `control` — echo of an applied control.jsonl op (T2 mid-run course correction; additive —
   * old readers ignore unknown types per contract v0.1).
   * `checkpoint` — T3 P0 anchor decision (continue|expand|end|pending); additive event type.
   */
  type: 'run_start' | 'stage_start' | 'node_start' | 'node_finish' | 'node_fail' | 'node_skip' | 'node_schema_fail' | 'node_repair' | 'node_retry' | 'node_cached' | 'node_step' | 'gate_pending' | 'judge' | 'run_tests' | 'run_finish' | 'control' | 'checkpoint';
  runId: string;
  stageId?: string;
  nodeId?: string;
  status?: NodeStatus;
  reason?: string;
  detail?: Record<string, unknown>;
}

export interface RunDeps {
  /** The model seam — reuse createLiveCouncil(env).generate; tests stub it for zero spend. */
  generate: CouncilGenerate;
  /** Per-node tool bundle (agentic seat). Return undefined for a pure-completion node. */
  toolsFor?: (node: Node) => ToolBundle | undefined;
  /** Default model when a node's agent.model is unset. */
  defaultModel: string;
  /** Effective model override (OPUSED_FORCE_MODEL): when the seam force-pins every seat to one model (e.g.
   *  the self-hosted box), the runner must LOG that model, not the plan's declared one — else the run log
   *  (and the /lab/opused viewer) misreport provenance (a glm-5.2-declared run that actually ran 100% on A1). */
  forceModel?: string;
  /** Bounded concurrency (OPUSED_CONCURRENCY). */
  concurrency?: number;
  /** Where run dirs live (default ./runs). */
  runsRoot?: string;
  /** Injected clock (ISO) — defaults to Date.now, overridden in tests. */
  now?: () => string;
  /** Global hard override for tool-loop steps (env OPUSED_MAX_STEPS). When unset, steps scale per-node by
   *  effortHint (low 32 / medium 64 / high 128). */
  maxSteps?: number;
  /** Per-effort output token budget. */
  outputTokensFor?: (node: Node) => number;
  /** Extra fields merged into the run_start event detail. Callers stamp sim / kind / workspace /
   *  task / mode via buildRunMeta (listRunsQuery reads the stamp, not the sim- prefix). Also
   *  { parentRun, sourceManifest } for F2 lineage. */
  runMeta?: Record<string, unknown>;
  /** F4: max REVIEW→FIX retries after a judge fail (env OPUSED_MAX_REPAIRS). Default 1. A judge fail is
   *  advisory — after the last repair the output is still kept (gate marks, never deletes). */
  maxRepairs?: number;
  /** #43 CONTINUATION (founder design): repair rounds CONTINUE the node's own conversation (its message
   *  history, tool calls included) with the gate/judge feedback appended — the node keeps "I went through
   *  this cycle, I have a clear picture" instead of re-orienting from a fresh pack. This is the token budget
   *  (approx, chars/4) the history may weigh before the loop falls back to the fresh-pack repair prompt.
   *  0 disables continuation entirely. Default 60_000. Env: OPUSED_CONTINUE_BUDGET. */
  continueBudgetTokens?: number;
  /** #39 GATE MEDIC (founder mandate: "there should be an agent who resolves the fixes"): when a gate fails
   *  and classifyGateFailure says ENVIRONMENT, the runner invokes this ONCE per node instead of burning a
   *  model repair on an un-repairable env problem. The CLI wires it to the gate-medic catalog agent (terminal
   *  + local.test, NO write tools) — only when --terminal armed it. Return `acted: true` to re-run the gates
   *  immediately; the medic never edits source (env-vs-code discipline lives in its prompt + toolset). */
  medic?: (node: Node, ctx: { gate: 'typecheck' | 'tests'; report: string; classification: 'env' | 'code' }) => Promise<{ acted: boolean; note: string } | undefined>;
  /** Retro B2: the harness-recorded run_tests invocations THIS node made (from the tool audit) — threaded
   *  into the judge's evidence so test-green is never self-reported. Absent = hook unwired (older callers). */
  testRunsFor?: (node: Node) => { path: string; passed: boolean; ms: number }[];
  /** F4b: post-write TYPECHECK gate for auto-write (dogfood finding — a model editing code has no compiler in
   *  its loop, so it ships compile-breaks blindly). Called after a WRITE-enabled node finishes; returns the
   *  typecheck result SCOPED TO THE FILES THAT NODE TOUCHED (so unrelated pre-existing errors never false-fire),
   *  or undefined for a node that didn't (or can't) write. `ok:false` triggers a repair pass with `report`
   *  injected — the seat re-edits via its write tools until it compiles or repairs run out. Unlike the judge
   *  (advisory), this is a CONCRETE, self-correcting signal. The CLI (fleet.ts) provides it only for the
   *  --write implementer seat and runs `tsc --noEmit` in the sandbox root. */
  verifyWrite?: (node: Node) => Promise<{ ok: boolean; report: string; reason?: string } | undefined>;
  /** TEST gate (concrete, self-correcting — the sibling of verifyWrite). After a WRITE node, the HARNESS itself
   *  runs the test files that node touched and returns pass/fail + the failing-output tail — INDEPENDENT of
   *  whether the seat ran run_tests or what its prose claims. This closes the gap a live run exposed
   *  (2026-07-06): a judge scored a change 1.0 while its suite was RED, because the judge reads the register,
   *  not the test result. `ok:false` feeds the failures into the repair loop exactly like the typecheck gate;
   *  `ran` lists the test files executed. undefined = nothing to gate (node touched no test files / gate off). */
  verifyTests?: (node: Node) => Promise<{ ok: boolean; report: string; ran: string[]; reason?: string } | undefined>;
  /** F4c: when stage.gateScope === 'unit', this replaces per-node verifyWrite: a lightweight per-file
   *  transpile/syntax check (e.g. `tsc --noEmit <file>`) — NOT a full repo tsc. Returns undefined when the
   *  node didn't write anything (or can't). `ok:false` triggers a repair pass with `report` injected, exactly
   *  like the per-node verifyWrite gate. */
  verifyUnitWrite?: (node: Node) => Promise<{ ok: boolean; report: string; reason?: string } | undefined>;
  /** F4c: when stage.gateScope === 'unit', runs ONCE at the stage barrier: full `tsc --noEmit` + full
   *  `vitest run` in the sandbox root. Returns failures for all nodes in the stage. `ok:false` records a
   *  barrier repair event (advisory — outputs kept); `reason:'gate-unavailable'` fails the barrier node
   *  loudly (same GAP-A pattern as per-node gates). When a stage has gateScope 'unit' but this dep is absent,
   *  the barrier is skipped (degrade to per-node verifyUnitWrite only). */
  verifyStageBarrier?: (stage: Stage) => Promise<{ ok: boolean; report: string; testsRan?: string[]; reason?: string } | undefined>;
  /** Sandbox root that plan inject/sharedInject file paths resolve against (the CLI's --root; defaults to the
   *  repo root there). Unset = injection degrades to explicit MISSING blocks — never an unsandboxed read. */
  sandboxRoot?: string;
  /** F5: resume an existing run — nodes with a COMMITTED gate marker + valid .out are reused (node_cached).
   *  Bare .out without committed.json is ungated (Critical-1) and re-enters the gate path, never promoted.
   *  Refuses if the plan changed since the original run (planHash guard). */
  resume?: boolean;
  /**
   * Epic-6 `--rerun-failed`: resume semantics, but optionally re-attempt committed-yet-unverified work.
   * When `includeDisputed` is true, a node whose prior journal `node_finish` shows `judgeDisputed=true`
   * or `verified=false` is NOT promoted to `node_cached` — it re-enters the full pipeline. Old `.out`
   * files are never deleted (repair / next write overwrites as usual). Failed/skipped/ungated nodes
   * already re-run under plain resume (no committed marker). Requires `resume: true`.
   */
  rerunFailed?: { includeDisputed?: boolean };
  /** F6a: box-aware admission — awaited by each worker BEFORE it picks up the next node. The CLI wires a
   *  poller that backs off while the box's queue is deep (feed steadily, don't dump). Absent = static pool. */
  admit?: () => Promise<void>;
  /** E-1 v3 (intent guard): does the RUN consider this node a writer (CLI: --write armed AND the node's
   *  persona/seat marks it a writer)? Independent of what toolsFor actually resolved — that independence is
   *  the point: a live run (2026-07-07) had tool resolution drop a writer's tools, so E-1 (keyed off HELD
   *  tools) never armed and a no-write node sailed past the judge. With intent known, an armed writer that
   *  resolves ZERO write tools fails loudly before any model call instead of running as a silent reader. */
  writeIntent?: (node: Node) => boolean;
  /**
   * CR-2+: non-api NodeExecutors (cli-claude, cli-grok, cli-codex, conversational).
   * When unset, run.ts constructs the default createCli*Executor for known CLI kinds
   * (writeCapable from writeIntent). Tests inject stubs here for $0.
   */
  executors?: ExecutorRegistry;
  /**
   * dec-judge-seam P2: optional judge generate backend (createJudgeSeam). When set, judges use this
   * seam's generate + label (not deps.generate). Per-node `contract.judge.runner` may still override
   * by constructing a different seam via judgeSeamEnv. Tests/sim omit this → fall back to deps.generate.
   */
  judgeSeam?: JudgeSeam;
  /**
   * Optional inject of judge generate alone (without a full JudgeSeam). Used when a test wants a
   * distinct judge stub from the seat generate. Prefer judgeSeam in production (fleet.ts).
   */
  judgeGenerate?: CouncilGenerate;
  /** Provenance label when judgeGenerate is set without judgeSeam (default: resolved kind or "generate"). */
  judgeSeamLabel?: string;
  /** Env for resolveJudgeSeamKind / createJudgeSeam on per-node runner overrides (defaults to process.env). */
  judgeSeamEnv?: Record<string, string | undefined>;
  /** Injectable CLI spawn for on-the-fly createJudgeSeam when contract.judge.runner differs (tests). */
  judgeSpawn?: CliSpawn;
  /**
   * T2 human-gate wait: max ms to poll control.jsonl / GATE-*.approved before pausing (F5 exit).
   * Default 0 = check once (legacy pause-and-resume). Set >0 so a live operator can `run_approve`
   * without forcing the process to exit first.
   */
  humanGateWaitMs?: number;
  /** Poll interval while waiting at a human gate (default 50ms). */
  humanGatePollMs?: number;
  /**
   * T5 P0 / watchers: optional live tap of every journaled RunEvent (same object written to run.jsonl).
   * Fire-and-forget — must never throw into the runner (swallowed). Additive; old callers omit.
   */
  onEvent?: (event: RunEvent) => void;
}

// Tool-loop headroom, scaled by effort. 6 was far too low for a multi-file audit (list a dir → read N files
// → synthesize needs many turns); a `high` seat now gets up to 128. Cheap seats stay small so they don't burn
// 128 model calls. OPUSED_MAX_STEPS (via deps.maxSteps) is a global hard override.
const EFFORT_STEPS: Record<string, number> = { low: 32, medium: 64, high: 128 };
// Final-answer token budget, paired with the step ceiling. On a REASONING model (A1/qwen3) the completion
// budget IS the thinking budget — a small cap truncates mid-thought and returns EMPTY (finishReason=length):
// 13/32 low-effort analyzers failed that way at 8k (2026-07-06). So the floor is now 64k — generous room to
// think AND emit; the 6-min per-step watchdog (not a tight token cap) is the real runaway guard. Overridable
// via OPUSED_EFFORT_TOKENS_{LOW,MEDIUM,HIGH}. High stays modest to avoid context overflow on read-heavy loops.
const EFFORT_TOKENS: Record<string, number> = {
  low: Number(process.env.OPUSED_EFFORT_TOKENS_LOW) || 64_000,
  medium: Number(process.env.OPUSED_EFFORT_TOKENS_MEDIUM) || 64_000,
  high: Number(process.env.OPUSED_EFFORT_TOKENS_HIGH) || 96_000,
};

// Judge output token budget: reasoning models need more than 2000; overridable via OPUSED_JUDGE_MAX_TOKENS.
const JUDGE_MAX_TOKENS = Number(process.env.OPUSED_JUDGE_MAX_TOKENS) || 8_000;

/** Effort precedence (#31): node.effortHint (explicit) > the resolved profile's effort (a catalog agent /
 *  persona declares how hard its mission is) > 'medium'. */
function effortForNode(node: Node): 'low' | 'medium' | 'high' {
  return node.effortHint ?? resolveProfile(node.agent)?.effort ?? 'medium';
}

function tokensForNode(node: Node): number {
  return EFFORT_TOKENS[effortForNode(node)] ?? EFFORT_TOKENS.medium;
}

function stepsForNode(node: Node): number {
  return EFFORT_STEPS[effortForNode(node)] ?? EFFORT_STEPS.medium;
}

/** #39: classify a gate failure as ENVIRONMENT (missing dep/toolchain/config — a medic can fix it without
 *  touching source) vs CODE (a real compile/test defect — the writer's repair loop owns it). Heuristic on the
 *  gate report text; ENV patterns are the failure modes we have actually hit (TS2307 after a writer added a
 *  dep, vitest unable to resolve an import pre-install, spawn/ENOENT toolchain gaps). */
export function classifyGateFailure(report: string): 'env' | 'code' {
  const ENV_PATTERNS = [
    /error TS2307/i,                       // Cannot find module (missing dep — the wave-2+3 'ai' case)
    /Cannot find module/i,
    /Cannot find package/i,
    /Failed to resolve import/i,           // vitest/vite pre-install
    /Cannot find type definition file/i,   // missing @types
    /ERR_MODULE_NOT_FOUND/i,
    /command not found|not recognized as an internal/i,
    /spawn .*ENOENT|ENOENT/i,
    /EACCES|EPERM/i,
    /ERR_PNPM|Unmet peer|missing peer/i,
  ];
  return ENV_PATTERNS.some((re) => re.test(report)) ? 'env' : 'code';
}

/** Parse a judge reply into a 0..1 score (observability only — never used for accept after dec-246). */
export function parseJudgeScore(raw: string): number | null {
  const jsonMatch = raw.match(/\{[^{}]*"score"\s*:\s*([0-9.]+)[^{}]*\}/);
  if (jsonMatch) { const n = Number(jsonMatch[1]); if (Number.isFinite(n)) return clamp01(n); }
  const labelled = raw.match(/score\s*[:=]\s*([0-9]*\.?[0-9]+)/i);
  if (labelled) { const n = Number(labelled[1]); if (Number.isFinite(n)) return clamp01(n); }
  const bare = raw.trim().match(/^([0-9]*\.?[0-9]+)$/);
  if (bare) { const n = Number(bare[1]); if (Number.isFinite(n)) return clamp01(n); }
  return null;
}

/**
 * Parse a binary judge reply into ACCEPT | RETURN + reason (dec-246).
 * Accepts: `VERDICT: ACCEPT`, `VERDICT: RETURN — <reason>`, triad-style `VERDICT: PASS|FAIL`,
 * and a bare first-line ACCEPT/RETURN. Empty or generic RETURN reasons yield reason=null so the
 * caller can force a concrete fallback — a reason is the only thing a repair can act on.
 */
export function parseJudgeVerdict(raw: string): { verdict: 'ACCEPT' | 'RETURN' | null; reason: string | null } {
  const text = (raw ?? '').trim();
  if (!text) return { verdict: null, reason: null };

  // VERDICT: ACCEPT | RETURN [— reason]  (preferred); PASS/FAIL kept for triad templates.
  // Tolerate markdown decoration — grok judges emit `**VERDICT:** ACCEPT`, `## VERDICT: …`, or
  // bulleted forms when the judge system prompt is long (live-proven 2026-08-04: undecorated-only
  // parsing forced RETURN on a valid verdict).
  const labelled = text.match(
    /^\s*(?:#{1,6}\s*)?(?:[-*>+]\s*)?(?:\*\*|__)?\s*VERDICT\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(ACCEPT|RETURN|PASS|FAIL)\b(?:\s*(?:\*\*|__)?\s*[—–\-:]\s*(.+))?/im,
  );
  if (labelled) {
    const token = labelled[1].toUpperCase();
    const verdict: 'ACCEPT' | 'RETURN' =
      token === 'ACCEPT' || token === 'PASS' ? 'ACCEPT' : 'RETURN';
    if (verdict === 'ACCEPT') return { verdict, reason: null };
    const reason = (labelled[2] ?? '').trim();
    return { verdict, reason: isSpecificReturnReason(reason) ? reason : null };
  }

  // First non-empty line is ACCEPT / RETURN / PASS / FAIL
  const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const bare = first.match(/^(ACCEPT|RETURN|PASS|FAIL)\b(?:\s*[—–\-:]\s*(.+))?/i);
  if (bare) {
    const token = bare[1].toUpperCase();
    const verdict: 'ACCEPT' | 'RETURN' =
      token === 'ACCEPT' || token === 'PASS' ? 'ACCEPT' : 'RETURN';
    if (verdict === 'ACCEPT') return { verdict, reason: null };
    const reason = (bare[2] ?? '').trim();
    return { verdict, reason: isSpecificReturnReason(reason) ? reason : null };
  }

  return { verdict: null, reason: null };
}

/** A RETURN reason must name something a repair pass can act on — empty/generic fails. */
export function isSpecificReturnReason(reason: string): boolean {
  const t = reason.trim();
  if (t.length < 12) return false;
  const lower = t.toLowerCase();
  if (/^(fail|failed|bad|no|n\/a|none|unspecified|see above|low quality|not good|weak|poor|reject|rejected)\.?$/.test(lower)) return false;
  if (/^(score|threshold|rubric)\b/.test(lower) && t.length < 24) return false;
  return true;
}

/**
 * Parse a checkpoint supervisor reply into continue | end | expand + reason (T3).
 * Tolerates markdown decoration like parseJudgeVerdict (grok emits **DECISION:** …).
 * Unparseable → decision null (caller defaults to continue with a note — never hang).
 */
export function parseCheckpointDecision(raw: string): {
  decision: 'continue' | 'end' | 'expand' | null;
  reason: string | null;
} {
  const text = (raw ?? '').trim();
  if (!text) return { decision: null, reason: null };

  const labelled = text.match(
    /^\s*(?:#{1,6}\s*)?(?:[-*>+]\s*)?(?:\*\*|__)?\s*DECISION\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(continue|end|expand)\b(?:\s*(?:\*\*|__)?\s*[—–\-:]\s*(.+))?/im,
  );
  if (labelled) {
    const decision = labelled[1]!.toLowerCase() as 'continue' | 'end' | 'expand';
    const reason = (labelled[2] ?? '').trim();
    return { decision, reason: reason.length > 0 ? reason : null };
  }

  // Bare first line: continue | end | expand
  const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const bare = first.match(/^(continue|end|expand)\b(?:\s*[—–\-:]\s*(.+))?/i);
  if (bare) {
    const decision = bare[1]!.toLowerCase() as 'continue' | 'end' | 'expand';
    const reason = (bare[2] ?? '').trim();
    return { decision, reason: reason.length > 0 ? reason : null };
  }

  return { decision: null, reason: null };
}

/** v1 deterministic checkpoint predicates (rubric name → pure code). */
export const CHECKPOINT_PREDICATES = ['all-upstream-done'] as const;
export type CheckpointPredicateName = (typeof CHECKPOINT_PREDICATES)[number];

/**
 * Evaluate a deterministic checkpoint predicate. Unknown names → continue with a note
 * (never hang; never invent expand/end).
 */
export function evalCheckpointPredicate(
  name: string | undefined,
  args: { consumes: string[]; succeeded: Set<string>; resolveIds: (ref: string) => string[] },
): { decision: 'continue' | 'end'; reason: string } {
  const pred = (name ?? 'all-upstream-done').trim();
  if (pred === 'all-upstream-done') {
    const ids = [...new Set(args.consumes.flatMap((r) => args.resolveIds(r)))];
    if (ids.length === 0) {
      return { decision: 'continue', reason: 'all-upstream-done: no consumes (vacuous pass)' };
    }
    const missing = ids.filter((id) => !args.succeeded.has(id));
    if (missing.length === 0) {
      return { decision: 'continue', reason: 'all-upstream-done: every consumed upstream succeeded' };
    }
    return {
      decision: 'end',
      reason: `all-upstream-done: missing/failed upstream: ${missing.join(', ')}`,
    };
  }
  return {
    decision: 'continue',
    reason: `unknown deterministic predicate "${pred}" — defaulting to continue`,
  };
}

/** Detect output that is an UNEXECUTED tool call leaked as text — i.e. the serving parser (e.g. vLLM's
 *  qwen3_coder) did NOT capture the call into the structured channel, so the raw markup came back as content
 *  instead of being executed. Such a "deliverable" is garbage and must fail the node, never flow downstream.
 *  Conservative by design: a node fails only when its output STARTS with a tool-call opener, or is DOMINATED
 *  by tool-call markup (little real prose remains) — a legit deliverable that merely quotes <tool_call> in an
 *  example still passes. Model-agnostic: covers the Hermes/Qwen `<tool_call>`/`<function=…>` and `<|tool_call|>`
 *  families, so it guards every seat regardless of which parser sits behind the model seam. */
export function looksLikeLeakedToolCall(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // (a) A deliverable never STARTS with a tool-call opener.
  const openers = [/^<tool_call\b/i, /^<\|tool_call\|>/i, /^<function\s*=/i, /^<\|?function_call\|?>/i, /^<tool▁call\b/i];
  if (openers.some((re) => re.test(t))) return true;
  // (b) Otherwise it must at least CONTAIN tool-call markup to be a candidate…
  if (!/<tool_call\b|<function\s*=|<\|tool_call\|>/i.test(t)) return false;
  // …and be DOMINATED by it: strip the tool-call blocks + any residual tags and see how much prose is left.
  const stripped = t
    .replace(/<tool_call\b[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<function\s*=[\s\S]*?<\/function>/gi, '')
    .replace(/<\|tool_call\|>[\s\S]*?(<\|\/?tool_call\|>|$)/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  return stripped.length < 30;
}

/** E-1 write gate: the model-facing names of the write tools (registry.ts maps local.write→write_file etc.).
 *  A node's tool bundle is keyed by these names, and node_step's `tools` lists them per call — so the runner
 *  can both detect a write-ENABLED node (bundle ∩ names) and count its write CALLS (step feed), per node,
 *  correct even with parallel writers. Coupled to registry.ts modelNames by design (single source: the seam). */
const WRITE_TOOL_NAMES = ['write_file', 'edit_file', 'delete_file', 'move_file'];

/** A fenced code block in a deliverable. For a write-enabled node with ZERO write calls this is the E-1
 *  failure signature (2026-07-06, live): the writer emitted the whole rewrite as a fenced block in its .out
 *  and the worktree diff was EMPTY — judge 1.0, nothing applied. A writer that DID call its tools may freely
 *  quote code in its register (the gate only arms at zero writes). */
export function containsFencedCode(text: string): boolean {
  return /```[\w.+-]*\r?\n[\s\S]*?```/.test(text);
}

/** E-1 v2: prose-EMITTED tool calls — the deliverable contains a JSON blob of edit operations (`"tool_calls"`,
 *  `"old_string"`/`"new_string"` keys) that were never executed. Found live (2026-07-06, l1-full-logs run):
 *  a writer made ONE real edit then emitted the remaining SIX as a fenced tool_calls array — writeOps was 1,
 *  so the zero-writes gate stayed quiet and the node reported done with 5/6 of its contract unapplied. Unlike
 *  quoted snippets, tool-call JSON in a register is never legit — it arms the gate even when writeOps > 0. */
export function containsUnappliedEdits(text: string): boolean {
  return /"(tool_calls|old_string|new_string)"\s*:/.test(text);
}

/**
 * Pure hard write-gate predicate shared by CLI + API loops.
 * Tree is primary when known; attributed dirty suppresses fence-zero and unapplied-only (writeOps===0).
 * Partial-apply scar: unapplied JSON + writeOps>0 still fails even when tree dirty.
 */
export function writeGateShouldFail(args: {
  writeToolNamesLength: number;
  writeOps: number;
  text: string;
  filesChanged?: FilesChangedFact;
  toolEvents?: ToolEvent[];
}): boolean {
  if (args.writeToolNamesLength === 0) return false;
  const text = args.text ?? '';
  const workLanded = treeWorkLanded(args.filesChanged, text, args.toolEvents);
  const clean = treeKnownClean(args.filesChanged);
  const fenced = containsFencedCode(text);
  const claimsOrShows = claimsWork(text) || fenced;

  // Partial apply: real write ops + remaining tool-call JSON in prose.
  if (containsUnappliedEdits(text) && args.writeOps > 0) return true;
  // Unapplied JSON with zero write ops: fail unless attributed tree work already landed (terminal apply + register).
  if (containsUnappliedEdits(text) && args.writeOps === 0 && !workLanded) return true;

  // Fenced prose at zero write ops: fail unless attributed work landed (E4).
  if (args.writeOps === 0 && fenced && !workLanded) return true;

  // False green without a judge: write tools fired, tree known clean, claims/shows applied work.
  if (clean && args.writeOps > 0 && claimsOrShows) return true;

  return false;
}

/** Classify a generate() throw into a legible, actionable reason when it is a context-window overflow.
 *  The reproducible fleet failure (2026-07-05) was NOT a serialization bug — it was an agentic node whose
 *  tool-read results accumulated in the step-loop and blew the box's max-model-len. The raw provider error
 *  ("This model's maximum context length is …") is cryptic in the run log / UI; this turns it into the real
 *  cause + the actual levers. Returns null for any other error (kept as its raw message). */
export function contextOverflowHint(message: string): string | null {
  const m = message.toLowerCase();
  const overflow =
    m.includes('context_length_exceeded') ||
    m.includes('max_model_len') ||
    m.includes('maximum context') ||
    m.includes('context length') ||
    m.includes('context window') ||
    m.includes('longer than the maximum') ||
    m.includes('reduce the length') ||
    (m.includes('context') && m.includes('exceed'));
  if (overflow) {
    return 'context overflow — the node prompt + tool-read history + requested output exceeded the model context window. Raise the box max-model-len (vllm_a1.py) or reduce tool reads / the node effortHint';
  }
  return null;
}

/** Detect a generate() throw that is a TIMEOUT — either the seam's per-call wall-clock cap (withTimeout →
 *  "… timed out after Ns") or the per-step stall watchdog ("no step progress for Ns", surfaced as an abort).
 *  A timeout is often a transient provider slow-spike, so the runner retries the initial generate ONCE on it
 *  (sibling to retry-on-leak). A structurally-too-slow node just times out again and fails — bounded cost. */
export function isCallTimeout(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return m.includes('timed out after') || m.includes('no step progress') || m.includes('aborted');
}

/** Detect a generate() throw that is a response-processing/parse error — the model call SUCCEEDED at the
 *  transport layer (a 200 was received) but the response body could not be processed into a usable result.
 *  Surfaced as 'Failed to process successful response', 'Unexpected token <' (an HTML error page where JSON
 *  was expected), or a generic JSON parse failure. Like a timeout, these are often transient (a serving
 *  hiccup or a malformed intermediate chunk), so the runner retries the FIRST generate ONCE on them —
 *  sibling to the retry-on-timeout path.
 *  EXCLUDES 4xx/auth/abort errors: those are STRUCTURAL (bad request, bad key, user cancel) — not transient —
 *  and must surface immediately rather than waste a retry. 4xx is matched as `status: 4xx` / `status 4xx`
 *  / `4\d\d` following the word "status"; bare numbers like 4000 are NOT matched (avoid false exclusions).
 *  Aborts are already caught by isCallTimeout; excluding them here is defense-in-depth (the predicate's
 *  contract is: it must return false for anything non-transient). */
export function isProcessingError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  // Excludes — structural, not transient: aborts, 4xx status codes, and auth/key errors must NOT retry.
  if (m.includes('abort')) return false;
  if (/status[:\s]*4\d\d/.test(m)) return false;
  if (m.includes('unauthorized') || m.includes('forbidden') || m.includes('authentication') || m.includes('api key')) return false;
  // Includes — the response was received but could not be processed/parsed into a usable result.
  return m.includes('failed to process') || m.includes('unexpected token') || m.includes('json');
}

/** F3 edge check: parse JSON out of the output, then validate against the schema. A non-JSON output is a
 *  schema failure (a schema-bearing contract asks for structured output). */
function checkOutput(text: string, schema: unknown): SchemaResult {
  const parsed = extractJson(text);
  if (parsed === null) return { ok: false, errors: ['output is not valid JSON (a schema-bearing contract requires JSON output)'] };
  return validateAgainstSchema(parsed, schema);
}

function clamp01(n: number): number {
  // Accept a 0..100 style score and normalize, else treat as already 0..1.
  const v = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, v));
}

/**
 * Run a validated plan. Stages execute in array order. Within a stage, nodes fan out with bounded
 * concurrency; a node whose consumed upstream nodes did not all succeed is SKIPPED (fail-forward). A
 * barrier stage completes fully before the next stage starts (always true here — we run stages
 * sequentially, which is the strongest barrier; a non-barrier stage's nodes still only fire once their
 * OWN consumes are ready, which within-stage they always are since consumes point to earlier stages).
 */
export async function runPlan(plan: FleetPlan, runId: string, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const runsRoot = deps.runsRoot ?? resolve(process.cwd(), 'runs');
  const runDir = resolve(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const logPath = resolve(runDir, 'run.jsonl');

  // Record the harness pid so "is this run alive?" can be ANSWERED rather than inferred.
  //
  // Every liveness signal we had was a proxy for this: the journal's mtime (which only moves when a node
  // FINISHES) and, added the same day, the newest write under nodes/. Both are heuristics, and both produced a
  // false DIED on 2026-08-07 — first on `strategy-context-survival` at 7 of 13 while it was writing, then on
  // `strategy-backlog-to-goal` at 16 of 17 whose retro node had legitimately been thinking for six minutes
  // with nothing on disk yet. Its harness process was in the process table the whole time.
  //
  // A pid plus `kill(pid, 0)` is exact: the harness is either there or it is not. The heuristics stay as the
  // fallback for runs that predate this file. Written best-effort — a run must never fail because it could not
  // record its own pid.
  try {
    writeFileSync(
      resolve(runDir, 'harness.json'),
      `${JSON.stringify({ pid: process.pid, startedAt: now(), runId }, null, 2)}\n`,
      'utf8',
    );
  } catch { /* liveness is an aid to the operator, never a precondition for the run */ }

  // dec-045 preapprove: refuse spend while pending; also refuse REJECTED (CTO F1)
  if (isPreapproveRejected(runDir)) {
    throw new Error(
      `run ${runId} was REJECTED at founder preapprove (GATE-${PREAPPROVE_GATE}.rejected). ` +
        `Spawn a new run or re-approve only after clearing the rejection (do not spend on a rejected plan).`,
    );
  }
  if (isAwaitingPreapprove(runDir)) {
    throw new Error(
      `run ${runId} is awaiting founder preapprove (GATE-${PREAPPROVE_GATE}.pending). ` +
        `Approve: pnpm fleet preapprove ${runId} --approve — then re-run.`,
    );
  }

  const idx = indexPlan(plan);
  const emit = (e: Omit<RunEvent, 'ts' | 'runId'>): void => {
    const full: RunEvent = { ts: now(), runId, ...e };
    appendFileSync(logPath, JSON.stringify(full) + '\n', 'utf8');
    try {
      deps.onEvent?.(full);
    } catch {
      /* watcher must never fail the run */
    }
  };

  /** Echo an applied control op into run.jsonl (runner is the only echo-writer). */
  const echoControl = (op: ControlOpRecord, extra?: Record<string, unknown>): void => {
    emit({
      type: 'control',
      nodeId: op.nodeId,
      stageId: op.stageId,
      detail: {
        op: op.op,
        principal: op.principal,
        text: op.text,
        reason: op.reason,
        controlIndex: op.index,
        ...extra,
      },
    });
  };

  const control = createControlApplier(runDir);

  const finishCounts = () => {
    const done = outcomes.filter((o) => o.status === 'done').length;
    const failed = outcomes.filter((o) => o.status === 'failed').length;
    const skipped = outcomes.filter((o) => o.status === 'skipped').length;
    return { done, failed, skipped };
  };

  const finishControlStop = (stopOp: ControlOpRecord): RunResult => {
    echoControl(stopOp, { applied: true });
    const { done, failed, skipped } = finishCounts();
    emit({
      type: 'run_finish',
      detail: { done, failed, skipped, stoppedBy: 'control', reason: stopOp.reason },
    });
    const result: RunResult = {
      runId, runDir, outcomes, done, failed, skipped, stoppedBy: 'control',
    };

    return result;
  };

  /** T3: graceful finish when a checkpoint decided end (or human-pending timeout). */
  const finishCheckpointStop = (args: { nodeId: string; reason: string }): RunResult => {
    const { done, failed, skipped } = finishCounts();
    emit({
      type: 'run_finish',
      detail: {
        done,
        failed,
        skipped,
        stoppedBy: 'checkpoint',
        reason: args.reason,
        checkpointNodeId: args.nodeId,
      },
    });
    const result: RunResult = {
      runId, runDir, outcomes, done, failed, skipped, stoppedBy: 'checkpoint',
    };

    return result;
  };

  // The static-graph invariant made checkable: a run is pinned to its plan's hash. --resume against a mutated
  // plan is refused (a changed plan is a NEW run), so cached outputs are never mixed with a different graph.
  const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16);
  // Epic-6: when --rerun-failed --include-disputed, committed nodes whose last finish was disputed/unverified
  // must re-enter the pipeline. Snapshot once from the prior journal BEFORE we append this run's events.
  let skipCacheNodeIds = new Set<string>();
  if (deps.resume && existsSync(logPath)) {
    const priorLog = readFileSync(logPath, 'utf8');
    const priorStart = priorLog.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as RunEvent; } catch { return null; } })
      .find((e) => e && e.type === 'run_start');
    const priorHash = priorStart?.detail?.planHash;
    if (typeof priorHash === 'string' && priorHash !== planHash) {
      throw new Error(`resume: plan changed since run ${runId} (planHash ${priorHash} → ${planHash}) — a changed plan is a new run`);
    }
    if (deps.rerunFailed?.includeDisputed) {
      skipCacheNodeIds = collectDisputedNodeIds(priorLog);
    }
  }

  emit({
    type: 'run_start',
    detail: {
      name: plan.name,
      stages: plan.stages.length,
      planHash,
      ...(deps.resume ? { resume: true } : {}),
      ...(deps.rerunFailed ? { rerunFailed: true, includeDisputed: deps.rerunFailed.includeDisputed === true } : {}),
      ...(deps.runMeta ?? {}),
    },
  });

  // Track which node ids succeeded — the fail-forward decision reads this.
  const succeeded = new Set<string>();
  const outcomes: NodeOutcome[] = [];
  const concurrency = Math.max(1, deps.concurrency ?? 3);
  /** T3: set by a checkpoint node that decided end / pending — stops after current stage fold. */
  const checkpointStopBox: { current?: { nodeId: string; reason: string } } = {};

  for (const stage of plan.stages) {
    // T2: stop at stage boundary BEFORE starting a later stage (finish in-flight first — we only check
    // between stages, so the prior stage's nodes always complete).
    {
      const stopOp = control.takeStop();
      if (stopOp) return finishControlStop(stopOp);
    }
    if (checkpointStopBox.current) {
      return finishCheckpointStop(checkpointStopBox.current);
    }

    // F5 human gate: pause BEFORE this stage unless approved (GATE file or control approve).
    // T2: control approve is parity with `fleet gate --approve`; optional wait polls control.jsonl.
    if (stage.gate === 'human') {
      const approvedPath = resolve(runDir, `GATE-${stage.id}.approved`);
      const gateDecision = await waitForHumanGate({
        runDir,
        stageId: stage.id,
        approvedPath,
        control,
        echoControl,
        waitMs: deps.humanGateWaitMs ?? 0,
        pollMs: deps.humanGatePollMs ?? 50,
        now,
      });
      if (gateDecision === 'stop') {
        const stopOp = control.takeStop();
        if (stopOp) return finishControlStop(stopOp);
        // stop already consumed inside wait — synthesize finish if takeStop missed
        const { done, failed, skipped } = finishCounts();
        emit({ type: 'run_finish', detail: { done, failed, skipped, stoppedBy: 'control' } });
        const result: RunResult = { runId, runDir, outcomes, done, failed, skipped, stoppedBy: 'control' };

        return result;
      }
      if (gateDecision === 'timeout' && !existsSync(approvedPath)) {
        writeGatePending(runDir, stage, succeeded, outcomes);
        emit({ type: 'gate_pending', stageId: stage.id, detail: { approveWith: `pnpm fleet gate ${runId} ${stage.id} --approve` } });
        const { done: d, failed: f, skipped: s } = finishCounts();
        emit({ type: 'run_finish', detail: { done: d, failed: f, skipped: s, stoppedAtGate: stage.id } });
        const result = { runId, runDir, outcomes, done: d, failed: f, skipped: s, stoppedAtGate: stage.id };

        return result;
      }
    }

    emit({ type: 'stage_start', stageId: stage.id, detail: { title: stage.title, barrier: !!stage.barrier, nodes: stage.nodes.length } });
    const stageOutcomes = await runStage(stage, {
      plan, runId, runDir, deps, now, emit, succeeded, idx, concurrency, skipCacheNodeIds, control, echoControl,
      checkpointStopBox,
    });
    // F4c: when a unit-scoped stage finishes, run the STAGE BARRIER gate (full tsc + full vitest) ONCE
    // rather than N times. The barrier is advisory (outputs kept — gate marks, never deletes) except for
    // a gate-unavailable reason, which fails a synthetic barrier node loudly (GAP-A pattern). When tests
    // ran and failed at the barrier, every done node in this stage gets testsOk=false (ground truth the
    // judge can't see); when they passed, done nodes get testsOk=true. A barrier without the dep wires
    // (verifyStageBarrier absent) is skipped — degrade to per-node verifyUnitWrite only.
    if (stage.gateScope === 'unit' && deps.verifyStageBarrier) {
      const barrier = await deps.verifyStageBarrier(stage);
      if (barrier) {
        if (!barrier.ok) {
          if (barrier.reason === 'gate-unavailable') {
            emit({ type: 'node_fail', stageId: stage.id, nodeId: `${stage.id}-barrier`, status: 'failed', reason: `barrier gate-unavailable: ${barrier.report || 'spawn failed'}` });
          } else {
            emit({ type: 'node_repair', stageId: stage.id, detail: { barrier: 'fail', report: barrier.report, testsRan: barrier.testsRan } });
          }
        } else {
          emit({ type: 'node_finish', stageId: stage.id, detail: { barrier: 'pass' } });
        }
        // Apply barrier test results to every done node in this stage (ground truth the per-node loop
        // couldn't set — tests were deferred to here). Skipped/failed nodes keep their existing status.
        if (barrier.testsRan && barrier.testsRan.length > 0) {
          for (const o of stageOutcomes) {
            if (o.status === 'done') o.testsOk = barrier.ok;
          }
        }
      }
    }
    for (const o of stageOutcomes) {
      // L1: node.json for EVERY outcome (done/failed/skipped/cached) at this single fold seam — a skipped or
      // cached node never entered runNode's log mkdir, so create the dir here. Never fails the run.
      try {
        const n = stage.nodes.find((sn) => sn.id === o.nodeId);
        const dir = resolve(runDir, 'nodes', o.nodeId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'node.json'), JSON.stringify({ ...o, seat: n?.agent.seat, ts: now() }, null, 2), 'utf8');
      } catch { /* a log write must never fail the run */ }
      outcomes.push(o);
      if (o.status === 'done') succeeded.add(o.nodeId);
    }
    control.completeStage(stage.id);
    // T3: checkpoint end/pending stops BEFORE later stages (decision already journaled + .out written).
    if (checkpointStopBox.current) {
      return finishCheckpointStop(checkpointStopBox.current);
    }
    // Stages are sequential → a barrier is inherently honored (we never start stage N+1 mid-stage-N).
  }

  // Final stop check (stop requested during last stage → finish after it).
  {
    const stopOp = control.takeStop();
    if (stopOp) return finishControlStop(stopOp);
  }

  const { done, failed, skipped } = finishCounts();
  emit({ type: 'run_finish', detail: { done, failed, skipped } });

  const result = { runId, runDir, outcomes, done, failed, skipped };

  return result;
}

/**
 * T2 / F5: wait for human-gate release via GATE-*.approved file or control approve op.
 * waitMs=0 → single check (legacy pause-and-resume). stop op returns 'stop'.
 */
async function waitForHumanGate(args: {
  runDir: string;
  stageId: string;
  approvedPath: string;
  control: ControlApplier;
  echoControl: (op: ControlOpRecord, extra?: Record<string, unknown>) => void;
  waitMs: number;
  pollMs: number;
  now: () => string;
}): Promise<'approved' | 'stop' | 'timeout'> {
  const deadline = Date.now() + Math.max(0, args.waitMs);
  let first = true;
  for (;;) {
    if (existsSync(args.approvedPath)) return 'approved';
    const ap = args.control.takeApprove(args.stageId);
    if (ap) {
      try {
        writeFileSync(args.approvedPath, `${args.now()}\nby: control\n`, 'utf8');
      } catch { /* marker best-effort */ }
      args.echoControl(ap, { applied: true, effect: 'approve' });
      return 'approved';
    }
    // Peek stop without consuming via takeStop only when we will exit the wait — takeStop marks applied.
    const pendingStop = args.control.pending().find((o) => o.op === 'stop');
    if (pendingStop) {
      const st = args.control.takeStop();
      if (st) args.echoControl(st, { applied: true, effect: 'stop-at-gate' });
      return 'stop';
    }
    if (!first && Date.now() >= deadline) return 'timeout';
    if (first && args.waitMs <= 0) return 'timeout';
    first = false;
    if (Date.now() >= deadline) return 'timeout';
    await new Promise((r) => setTimeout(r, Math.max(1, args.pollMs)));
  }
}

interface StageCtx {
  plan: FleetPlan;
  runId: string;
  runDir: string;
  deps: RunDeps;
  now: () => string;
  emit: (e: Omit<RunEvent, 'ts' | 'runId'>) => void;
  succeeded: Set<string>;
  idx: ReturnType<typeof indexPlan>;
  concurrency: number;
  /** Epic-6: node ids that must NOT be node_cached even when committed (disputed/unverified prior finish). */
  skipCacheNodeIds: Set<string>;
  /** T2 mid-run control plane (optional — absent only if caller constructs StageCtx outside runPlan). */
  control?: ControlApplier;
  echoControl?: (op: ControlOpRecord, extra?: Record<string, unknown>) => void;
  /** T3: shared box so a checkpoint end stops remaining stage peers + later stages. */
  checkpointStopBox?: { current?: { nodeId: string; reason: string } };
}

/** Fan out a stage's nodes with a bounded worker pool (the runPanel pattern, adapted for fail-forward). */
async function runStage(stage: Stage, ctx: StageCtx): Promise<NodeOutcome[]> {
  const results = new Array<NodeOutcome>(stage.nodes.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= stage.nodes.length) return;
      // T3: after a checkpoint ends the run, remaining peers skip (no spend).
      if (ctx.checkpointStopBox?.current) {
        const node = stage.nodes[i]!;
        const reason = `checkpoint stopped run (${ctx.checkpointStopBox.current.nodeId})`;
        ctx.emit({ type: 'node_skip', stageId: stage.id, nodeId: node.id, status: 'skipped', reason });
        results[i] = {
          nodeId: node.id,
          stageId: stage.id,
          status: 'skipped',
          outputPath: node.contract.outputPath,
          reason,
          latencyMs: 0,
          degradedPack: false,
        };
        continue;
      }
      // F6a: box-aware backpressure — wait for admission before spending a slot (feed steadily, don't dump).
      // Admit stays OUTSIDE the isolation catch: a throw from admit is harness/backpressure, not a seat
      // failure. Swallowing it as node_fail invents a failed plan node with no node_start (critics:
      // stress-correctness D3, stress-blast-radius D2).
      if (ctx.deps.admit) await ctx.deps.admit();
      // Fail-forward at the fan-out boundary: any throw that still escapes runNode must fail THIS
      // node only. Without this catch, Promise.all rejects → runPlan never emits run_finish →
      // runs:status DIED, and the stage fold that writes nodes/<id>/node.json never runs
      // (2026-08-07: large-fleet death after `cli-grok exit 1: no output` on residual/repair paths).
      try {
        results[i] = await runNode(stage, stage.nodes[i]!, ctx);
      } catch (e) {
        const node = stage.nodes[i]!;
        const raw = e instanceof Error ? e.message : String(e);
        // Integrity: corrupt plan object (id not in indexPlan) is not a seat failure — fail-closed.
        // buildContextPack throws: `buildContextPack: unknown node "${nodeId}"` (context-pack.ts:120).
        if (/^buildContextPack: unknown node/.test(raw)) throw e;
        const reason = raw.startsWith('escaped:') ? raw : `escaped: ${raw}`;
        // Assignment FIRST so isolation does not depend on journal I/O succeeding (correctness D2).
        results[i] = {
          nodeId: node.id,
          stageId: stage.id,
          status: 'failed',
          outputPath: node.contract.outputPath,
          reason,
          latencyMs: 0,
          degradedPack: false,
        };
        try {
          ctx.emit({
            type: 'node_fail',
            stageId: stage.id,
            nodeId: node.id,
            status: 'failed',
            reason,
            detail: {
              escaped: true,
              source: 'runStage',
              // Pure; already imported at top of run.ts. Matches inner CLI catch's runner field when known.
              runner: resolveExecutorKind(node),
            },
          });
        } catch {
          /* journal write must never re-kill the pool; outcome is already in results[i] */
        }
      }
    }
  };

  // CR-2b / dec-048 G2: clamp CLI-bearing stages to 1–4 concurrent nodes.
  const capped = effectiveStageConcurrency(stage, ctx.concurrency);
  const pool = Math.max(1, Math.min(capped, stage.nodes.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return results;
}

/**
 * CR-2 / Critical-2: non-api node path — resolve executor, produce attempt text, then the SAME
 * schema → tsc → test → judge → repair → commit pipeline as API nodes. Executor choice must not
 * choose the definition of success (GPT-5.6 review Critical-2).
 */
async function runNodeViaExecutor(
  stage: Stage,
  node: Node,
  ctx: StageCtx,
  args: {
    executorKind: ReturnType<typeof resolveExecutorKind>;
    pack: { text: string; totalChars: number; sharedChars: number; degraded: boolean };
    model: string;
    outputPath: string;
    t0: number;
    nodeDir: string;
    /** Critical-1: crash left an .out without committed.json — re-enter gates, do not re-spawn unless repair needs it. */
    resumeUngatedText?: string;
  },
): Promise<NodeOutcome> {
  const { deps, runDir, emit, now } = ctx;
  const { executorKind, pack, model, outputPath, t0, nodeDir, resumeUngatedText } = args;
  const sandboxRoot = deps.sandboxRoot ?? process.cwd();

  let executor = lookupExecutor(executorKind, deps.executors);
  const writeCapable = !!deps.writeIntent?.(node);

  // Tree fact: only for writers; RO nodes skip git spawn (EXP-012).
  let beforeTree: TreeSnapshot | undefined;
  let nodeRootForTree: string | undefined;
  if (writeCapable) {
    try {
      nodeRootForTree = resolveNodeCwd(node, sandboxRoot);
      beforeTree = snapshotTree(nodeRootForTree, { sandboxRoot });
    } catch {
      beforeTree = { ok: false, reason: 'root-unavailable' };
    }
  }

  const refreshFilesChanged = (): FilesChangedFact | undefined => {
    if (!writeCapable) return undefined;
    if (!beforeTree || !nodeRootForTree) {
      return { known: false, reason: 'root-unavailable' };
    }
    const after = snapshotTree(nodeRootForTree, { sandboxRoot });
    return diffTreeSnapshots(beforeTree, after);
  };

  if (!executor && executorKind === 'cli-claude') {
    executor = createCliClaudeExecutor({ writeCapable });
  }
  // NODE-TOOLS-EXTEND: resolve node.tools/toolsMode → Grok --tools allowlist (read-only only).
  // Belt: never widen past GROK_READ_SAFE_TOOLS; drop unsafe names with a journaled warn (not silent).
  let grokToolsAllowlist: string | undefined;
  if (executorKind === 'cli-grok' && !writeCapable) {
    const resolved = resolveGrokReadOnlyTools({
      nodeTools: node.tools,
      toolsMode: node.toolsMode,
    });
    grokToolsAllowlist = resolved.allowedCsv;
    if (resolved.dropped.length) {
      emit({
        type: 'node_step',
        stageId: stage.id,
        nodeId: node.id,
        detail: {
          type: 'tools_warn',
          runner: 'cli-grok',
          dropped: resolved.dropped,
          reason: 'not-in-read-safe-allowlist',
          toolsMode: node.toolsMode ?? 'extend',
          allowed: resolved.allowed,
        },
      });
    }
  }
  if (!executor && executorKind === 'cli-grok') {
    executor = createCliGrokExecutor({
      writeCapable,
      ...(grokToolsAllowlist ? { toolsAllowlist: grokToolsAllowlist } : {}),
    });
  }
  if (!executor && executorKind === 'cli-codex') {
    executor = createCliCodexExecutor({ writeCapable });
  }
  if (!executor && executorKind === 'cli-qwen') {
    executor = createCliQwenExecutor({ writeCapable });
  }
  if (!executor) {
    const reason = unimplementedRunnerMessage(executorKind);
    emit({
      type: 'node_fail',
      stageId: stage.id,
      nodeId: node.id,
      status: 'failed',
      reason,
      detail: { runner: executorKind },
    });
    return {
      nodeId: node.id,
      stageId: stage.id,
      status: 'failed',
      outputPath,
      reason,
      latencyMs: Math.round(performance.now() - t0),
      degradedPack: pack.degraded,
    };
  }

  const baseExecCtx: NodeExecContext = {
    runId: runDir.split(/[/\\]/).pop() ?? 'run',
    runDir,
    node,
    stageId: stage.id,
    packText: pack.text,
    system: nodeSystem(node),
    model,
    sandboxRoot,
    now,
  };

  // dec-judge-seam: accumulate CLI-parsed tool events across the initial spawn + repairs.
  // Shared ref so runPostAttemptGates sees updates from produceRepair closures.
  const evidenceRef: {
    toolEvents: ToolEvent[] | undefined;
    writeOps: number;
    known: boolean;
  } = { toolEvents: undefined, writeOps: 0, known: false };

  const absorbExecResult = (result: { toolEvents?: ToolEvent[]; writeOps?: number }) => {
    if (result.toolEvents !== undefined) {
      evidenceRef.known = true;
      evidenceRef.toolEvents = [...(evidenceRef.toolEvents ?? []), ...result.toolEvents];
      evidenceRef.writeOps =
        typeof result.writeOps === 'number'
          ? evidenceRef.writeOps + result.writeOps
          : countWriteOps(evidenceRef.toolEvents);
    }
  };

  /**
   * L1 parity with the API path: EVERY real CLI invocation (initial, schema retry, gate/judge repair)
   * persists as one turn record — nodes/<id>/turns/<NN>-cli.json — carrying the usage the product CLI
   * reported (BENCHMARK-PREP checklist 1: CLI-seat metering parity; the P0 endpoint folds these via
   * collectTurnUsageItems). Absent = absent: no usage field when the envelope reported none.
   */
  let cliTurnCounter = 0;
  const recordCliTurn = (result: NodeExecResult) => {
    cliTurnCounter += 1;
    try {
      writeFileSync(
        resolve(nodeDir, 'turns', String(cliTurnCounter).padStart(2, '0') + '-cli.json'),
        JSON.stringify(
          {
            turn: cliTurnCounter,
            ts: now(),
            runner: executorKind,
            sessionId: result.sessionId,
            costHint: result.costHint,
            modelLabel: result.modelLabel ?? executorKind,
            exitCode: result.exitCode,
            textChars: (result.text ?? '').trim().length,
            ...(result.usage
              ? {
                  usage: {
                    ...(result.usage.inputTokens !== undefined
                      ? { input_tokens: result.usage.inputTokens }
                      : {}),
                    ...(result.usage.outputTokens !== undefined
                      ? { output_tokens: result.usage.outputTokens }
                      : {}),
                    ...(result.usage.totalTokens !== undefined
                      ? { total_tokens: result.usage.totalTokens }
                      : {}),
                  },
                }
              : {}),
            ...(result.toolEvents !== undefined
              ? { toolEventCount: result.toolEvents.length, writeOps: result.writeOps ?? 0 }
              : { tool_trace: 'unavailable' }),
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch {
      /* log must not fail node */
    }
  };

  /** Re-invoke the CLI with feedback appended (schema/gate/judge repair — CLI owns tools). */
  const produceWithFeedback = async (feedback: string): Promise<string> => {
    const packText = [pack.text, '', feedback].join('\n');
    const result = await executor!.run({ ...baseExecCtx, packText });
    absorbExecResult(result);
    recordCliTurn(result);
    return (result.text ?? '').trim();
  };

  try {
    let text: string;
    let sessionId: string | undefined;
    let costHint: string | undefined;
    let modelLabel: string | undefined;
    let exitCode: number | undefined;

    if (resumeUngatedText !== undefined) {
      // Critical-1: ungated artifact resumes INTO the gate — do not promote, do not re-spawn yet.
      text = resumeUngatedText.trim();
      emit({
        type: 'node_retry',
        stageId: stage.id,
        nodeId: node.id,
        detail: { reason: 'resume-ungated: re-entering gate pipeline (no committed.json)', runner: executorKind },
      });
    } else {
      const result = await executor.run(baseExecCtx);
      text = (result.text ?? '').trim();
      sessionId = result.sessionId;
      costHint = result.costHint;
      modelLabel = result.modelLabel;
      exitCode = result.exitCode;
      absorbExecResult(result);
      for (const ev of result.events ?? []) {
        emit({
          type: 'node_step',
          stageId: stage.id,
          nodeId: node.id,
          detail: { runner: executorKind, ...ev },
        });
      }
      recordCliTurn(result);
    }

    if (!text) {
      const reason = `empty output from ${executorKind}`;
      emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason, detail: { runner: executorKind } });
      return {
        nodeId: node.id,
        stageId: stage.id,
        status: 'failed',
        outputPath,
        reason,
        latencyMs: Math.round(performance.now() - t0),
        degradedPack: pack.degraded,
      };
    }

    // F3 schema — parity with API path: one retry with errors injected, then hard fail (never silent pass).
    let contractValid: boolean | undefined;
    if (node.contract.schema !== undefined) {
      let check = checkOutput(text, node.contract.schema);
      if (!check.ok) {
        const feedback = [
          '===== YOUR PREVIOUS OUTPUT FAILED SCHEMA =====',
          check.errors.join('\n'),
          '',
          '----- your previous output -----',
          text,
          '',
          'Return ONLY the corrected deliverable that satisfies the schema. Output valid JSON, nothing else.',
        ].join('\n');
        emit({
          type: 'node_repair',
          stageId: stage.id,
          nodeId: node.id,
          detail: { schemaRetry: true, runner: executorKind, attempt: 0 },
        });
        try {
          const retryText = await produceWithFeedback(feedback);
          check = retryText ? checkOutput(retryText, node.contract.schema) : { ok: false, errors: ['empty output on schema retry'] };
          if (retryText) text = retryText;
        } catch (e) {
          const reason = `schema repair failed: ${e instanceof Error ? e.message : String(e)}`;
          emit({
            type: 'node_schema_fail',
            stageId: stage.id,
            nodeId: node.id,
            status: 'failed',
            reason,
            detail: { runner: executorKind },
          });
          return {
            nodeId: node.id,
            stageId: stage.id,
            status: 'failed',
            outputPath,
            reason,
            latencyMs: Math.round(performance.now() - t0),
            degradedPack: pack.degraded,
            contractValid: false,
          };
        }
      }
      contractValid = check.ok;
      if (!check.ok) {
        const reason = `schema: ${check.errors.join('; ')}`;
        emit({
          type: 'node_schema_fail',
          stageId: stage.id,
          nodeId: node.id,
          status: 'failed',
          reason,
          detail: { runner: executorKind },
        });
        return {
          nodeId: node.id,
          stageId: stage.id,
          status: 'failed',
          outputPath,
          reason,
          latencyMs: Math.round(performance.now() - t0),
          degradedPack: pack.degraded,
          contractValid: false,
        };
      }
    }

    // Shared post-attempt gate path (schema already green).
    // dec-judge-seam: pass CLI-parsed tool events (never hardcode []) so the judge sees WORK EVIDENCE.
    // Write-armed CLI nodes arm the write-tool name set so E-1 can fire when writeOps stay 0.
    const cliWriteArmed = writeCapable;
    const writeToolNames = cliWriteArmed ? [...JUDGE_WRITE_TOOL_NAMES] : [];
    return await runPostAttemptGates({
      stage,
      node,
      ctx,
      pack,
      model,
      outputPath,
      t0,
      nodeDir,
      text,
      contractValid,
      writeToolNames,
      writeOps: evidenceRef.known ? evidenceRef.writeOps : 0,
      nodeToolEvents: evidenceRef.known ? (evidenceRef.toolEvents ?? []) : undefined,
      evidenceRef,
      filesChanged: refreshFilesChanged(),
      refreshFilesChanged,
      produceRepair: async (feedback) => {
        const rtext = await produceWithFeedback(feedback);
        return rtext || null;
      },
      finishDetail: {
        runner: executorKind,
        sessionId,
        costHint,
        model: modelLabel ?? model,
      },
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    emit({
      type: 'node_fail',
      stageId: stage.id,
      nodeId: node.id,
      status: 'failed',
      reason,
      detail: { runner: executorKind },
    });
    return {
      nodeId: node.id,
      stageId: stage.id,
      status: 'failed',
      outputPath,
      reason,
      latencyMs: Math.round(performance.now() - t0),
      degradedPack: pack.degraded,
    };
  }
}

/**
 * Shared commit/gate pipeline after an attempt text is schema-valid (API or CLI).
 * Order: write → typecheck → tests → judge → repair loop → hard fail if gates still red → committed marker.
 * Critical-2: one definition of done for every backend.
 */
async function runPostAttemptGates(args: {
  stage: Stage;
  node: Node;
  ctx: StageCtx;
  pack: { text: string; totalChars: number; sharedChars: number; degraded: boolean };
  model: string;
  outputPath: string;
  t0: number;
  nodeDir: string;
  text: string;
  contractValid: boolean | undefined;
  writeToolNames: string[];
  writeOps: number;
  /**
   * Tool events for the judge. `undefined` = CLI/API did not produce a tool channel (unavailable).
   * `[]` = channel known and empty.
   */
  nodeToolEvents: ToolEvent[] | undefined;
  /** Live bag updated by CLI produceRepair across repair attempts. */
  evidenceRef?: { toolEvents: ToolEvent[] | undefined; writeOps: number; known: boolean };
  /** Tree-level write evidence under the node root (before/after porcelain). */
  filesChanged?: FilesChangedFact;
  /** Re-snapshot after repairs / tool side-effects. */
  refreshFilesChanged?: () => FilesChangedFact | undefined;
  /** Produce a repair attempt from gate/judge feedback. Return null to stop and keep last text. */
  produceRepair: (feedback: string) => Promise<string | null>;
  /** Extra detail fields merged into node_finish on success. */
  finishDetail?: Record<string, unknown>;
  /** Optional genArgs-style onCall for judge turn logging (API path). */
  onCall?: (trace: CallTrace) => void;
}): Promise<NodeOutcome> {
  const {
    stage,
    node,
    ctx,
    pack,
    model,
    outputPath,
    t0,
    nodeDir,
    writeToolNames,
    produceRepair,
    finishDetail,
    onCall,
    evidenceRef,
  } = args;
  const { deps, runDir, emit } = ctx;
  let text = args.text;
  let contractValid = args.contractValid;
  let writeOps = args.writeOps;
  let nodeToolEvents = args.nodeToolEvents;
  let filesChanged = args.filesChanged;

  const syncEvidenceFromRef = () => {
    if (!evidenceRef?.known) return;
    nodeToolEvents = evidenceRef.toolEvents ?? [];
    writeOps = evidenceRef.writeOps;
  };

  /** Writers always journal a tree fact (theatre D5) — never omit known:true|false. */
  const ensureWriterFilesChanged = (): FilesChangedFact | undefined => {
    const isWriterSeat = writeToolNames.length > 0 || !!deps.writeIntent?.(node);
    if (!isWriterSeat) return filesChanged;
    if (args.refreshFilesChanged) {
      filesChanged = args.refreshFilesChanged() ?? filesChanged;
    }
    if (filesChanged === undefined) {
      filesChanged = { known: false, reason: 'root-unavailable' };
    }
    return filesChanged;
  };

  const maxRepairs = Math.max(0, deps.maxRepairs ?? 6);
  let judge: JudgeVerdict | undefined;
  let lastTests: { ok: boolean; report: string; ran: string[] } | undefined;
  let repairs = 0;
  let writeGateFailed = false;
  let sameGateFails = 0;
  let lastGateReportKey = '';
  let lastVerifyOk: boolean | undefined;
  let medicTried = false;

  for (;;) {
    syncEvidenceFromRef();
    writeDeclaredOutput(runDir, outputPath, text);
    const isUnitScope = stage.gateScope === 'unit';
    const verify = isUnitScope
      ? (deps.verifyUnitWrite ? await deps.verifyUnitWrite(node) : (deps.verifyWrite ? await deps.verifyWrite(node) : undefined))
      : (deps.verifyWrite ? await deps.verifyWrite(node) : undefined);
    const testVerify = (isUnitScope && deps.verifyStageBarrier) ? undefined
      : (deps.verifyTests ? await deps.verifyTests(node) : undefined);

    const gateUnavailable = verify?.reason === 'gate-unavailable' || testVerify?.reason === 'gate-unavailable';
    if (gateUnavailable) {
      const isWriteGate = verify?.reason === 'gate-unavailable';
      const gateName = isWriteGate ? 'typecheck (tsc)' : 'test (vitest)';
      const report = isWriteGate ? verify!.report : testVerify!.report;
      const reason = `gate-unavailable: ${gateName} gate could not run in the sandbox root — ${report || 'spawn failed'}`;
      const fc = ensureWriterFilesChanged();
      emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason, detail: { ...(writeToolNames.length ? { writeOps } : {}), ...(fc ? { filesChanged: fc } : {}), gateUnavailable: gateName, ...finishDetail } });
      return { nodeId: node.id, stageId: stage.id, status: 'failed', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded, judge, contractValid, ...(writeToolNames.length ? { writeOps } : {}) };
    }

    if (verify) emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { typecheck: verify.ok ? 'pass' : 'fail', attempt: repairs, ...(verify.ok ? {} : { report: verify.report.slice(0, 600) }) } });
    if (testVerify) {
      lastTests = testVerify;
      // dec-246: durable run_tests channel — harness result lands in the journal, not only the Map/console.
      for (const p of testVerify.ran) {
        emit({ type: 'run_tests', stageId: stage.id, nodeId: node.id, detail: { path: p, passed: testVerify.ok, source: 'harness', attempt: repairs } });
      }
      emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { tests: testVerify.ok ? 'pass' : 'fail', ran: testVerify.ran, attempt: repairs, ...(testVerify.ok ? {} : { report: testVerify.report.slice(0, 600) }) } });
    }

    if (args.refreshFilesChanged) {
      filesChanged = args.refreshFilesChanged() ?? filesChanged;
    }
    writeGateFailed = writeGateShouldFail({
      writeToolNamesLength: writeToolNames.length,
      writeOps,
      text,
      filesChanged,
      toolEvents: nodeToolEvents,
    });
    // The tree fact rides the gate DECISION, not just the outcome (EXP-013). node_fail already carried it;
    // this frame did not, and this frame is the one a person reads when diagnosing why the gate fired.
    // `null` is deliberate rather than an omitted key: it distinguishes "no snapshot was taken" from
    // known-dirty, known-clean, and snapshot-attempted-and-failed. Measured 2026-08-08T04-01-31-549Z: the
    // one writeGate:fail frame was `{writeGate:'fail',attempt:0}` while node_finish for the same node held
    // the real porcelain — so a false alarm and a real fabrication were the same frame.
    if (writeGateFailed) emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { writeGate: 'fail', attempt: repairs, writeOps, filesChanged: filesChanged ?? null } });

    const verifyFailed = verify ? !verify.ok : false;
    const testsFailed = testVerify ? !testVerify.ok : false;
    lastVerifyOk = verify ? verify.ok : lastVerifyOk;

    if (verifyFailed || testsFailed) {
      const key = `${verify?.report ?? ''}\u0000${testVerify?.report ?? ''}`;
      sameGateFails = key === lastGateReportKey ? sameGateFails + 1 : 1;
      lastGateReportKey = key;
      if (sameGateFails >= 3) {
        const reason = `gate non-convergence: identical ${verifyFailed ? 'typecheck' : 'test'} failure across ${sameGateFails} consecutive repair attempts — aborting instead of burning further repairs`;
        emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason, detail: { repairs, ...(writeToolNames.length ? { writeOps } : {}), ...finishDetail } });
        return { nodeId: node.id, stageId: stage.id, status: 'failed', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded, judge, contractValid, ...(writeToolNames.length ? { writeOps } : {}) };
      }
    } else {
      sameGateFails = 0;
      lastGateReportKey = '';
    }

    if ((verifyFailed || testsFailed) && deps.medic && !medicTried) {
      const gate: 'typecheck' | 'tests' = verifyFailed ? 'typecheck' : 'tests';
      const report = verifyFailed ? verify!.report : testVerify!.report;
      const classification = classifyGateFailure(report);
      if (classification === 'env') {
        medicTried = true;
        emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { medic: 'invoked', gate, classification, attempt: repairs } });
        try {
          const m = await deps.medic(node, { gate, report, classification });
          emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { medic: m?.acted ? 'acted' : 'no-action', ...(m?.note ? { note: m.note.slice(0, 400) } : {}), attempt: repairs } });
          if (m?.acted) continue;
        } catch (e) {
          emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { medic: 'error', note: (e instanceof Error ? e.message : String(e)).slice(0, 300), attempt: repairs } });
        }
      }
    }

    const gatesRed = verifyFailed || testsFailed;
    if (node.contract.judge && !(gatesRed && repairs < maxRepairs)) {
      const isWriter = writeToolNames.length > 0 || !!deps.writeIntent?.(node);
      const eventsForRead = nodeToolEvents ?? [];
      const writtenFiles = isWriter && deps.sandboxRoot ? readWrittenFiles(deps.sandboxRoot, eventsForRead) : undefined;
      const gateLines: string[] = [];
      if (verify) gateLines.push(`typecheck: ${verify.ok ? 'GREEN' : 'RED'}${verify.ok ? '' : `\n${verify.report}`}`);
      if (testVerify) gateLines.push(`tests: ${testVerify.ok ? 'GREEN' : 'RED'} (ran: ${testVerify.ran.join(', ') || 'none'})${testVerify.ok ? '' : `\n${testVerify.report}`}`);
      // Tool-invoked run_tests: emit each harness-recorded invocation into the journal (was Map-only).
      const toolRuns = deps.testRunsFor ? deps.testRunsFor(node) : undefined;
      if (toolRuns?.length) {
        for (const t of toolRuns) {
          emit({ type: 'run_tests', stageId: stage.id, nodeId: node.id, detail: { path: t.path, passed: t.passed, ms: t.ms, source: 'tool', attempt: repairs } });
        }
      }
      const requireToolEvidence =
        node.contract.judge.requireToolEvidence ?? isWriter;
      judge = await runJudge(node.contract.judge, text, node.contract.judge.model ?? model, deps, {
        task: renderTaskPrompt(node.taskPrompt),
        toolEvents: nodeToolEvents,
        writeOps,
        isWriter,
        gatesRed,
        requireToolEvidence,
        repairsRemaining: Math.max(0, maxRepairs - repairs),
        ...(writtenFiles?.length ? { writtenFiles } : {}),
        ...(toolRuns ? { testRuns: toolRuns } : {}),
        ...(gateLines.length ? { gateReport: gateLines.join('\n') } : {}),
        ...(onCall ? { onCall } : {}),
        ...(filesChanged ? { filesChanged } : {}),
      });
      emit({
        type: 'judge',
        stageId: stage.id,
        nodeId: node.id,
        detail: {
          rubric: judge.rubric,
          verdict: judge.verdict,
          reason: judge.reason,
          score: judge.score,
          threshold: judge.threshold,
          pass: judge.pass,
          attempt: repairs,
          ...(judge.backend !== undefined ? { backend: judge.backend } : {}),
          ...(judge.zero_tool_calls !== undefined ? { zero_tool_calls: judge.zero_tool_calls } : {}),
          ...(judge.tool_event_count !== undefined ? { tool_event_count: judge.tool_event_count } : {}),
          ...(judge.tool_trace_status !== undefined ? { tool_trace_status: judge.tool_trace_status } : {}),
          ...(judge.evidence_cited !== undefined ? { evidence_cited: judge.evidence_cited } : {}),
          ...(judge.overlay !== undefined ? { overlay: judge.overlay } : {}),
          ...(judge.requireToolEvidence !== undefined ? { requireToolEvidence: judge.requireToolEvidence } : {}),
          ...(judge.evidence_waived !== undefined ? { evidence_waived: judge.evidence_waived } : {}),
          ...(judge.retry !== undefined ? { retry: judge.retry } : {}),
        },
      });
    }
    const judgeFailed = judge?.verdict === 'RETURN' || judge?.pass === false;
    if ((!judgeFailed && !verifyFailed && !testsFailed && !writeGateFailed) || repairs >= maxRepairs) break;

    writeFileSync(resolve(runDir, `${node.id}.attempt-${repairs + 1}.out`), text, 'utf8');
    const feedback: string[] = [];
    if (judgeFailed) feedback.push('===== JUDGE VERDICT (rubric not met) =====', judge!.raw, '');
    if (verifyFailed) feedback.push('===== TYPECHECK ERRORS (files you edited no longer compile — FIX them) =====', verify!.report, '');
    if (testsFailed) feedback.push('===== TEST FAILURES (the harness ran your tests; they are RED) =====', testVerify!.report, '');
    if (writeGateFailed) feedback.push('===== WRITE GATE (you described changes but called NO write tool — the worktree is UNCHANGED) =====', 'Your fenced code was NOT applied. APPLY every change now by calling your write/edit tools, then re-output your change register.', '');
    feedback.push(verifyFailed || testsFailed || writeGateFailed
      ? 'Use your edit tools to fix the failing code/tests above, then re-output your change register. The tests MUST pass.'
      : 'Revise to satisfy the rubric. Output ONLY the corrected deliverable.');

    const rtext = await produceRepair(feedback.join('\n'));
    if (!rtext || looksLikeLeakedToolCall(rtext)) break;
    if (node.contract.schema !== undefined) {
      const c = checkOutput(rtext, node.contract.schema);
      if (!c.ok) break;
      contractValid = true;
    }
    repairs += 1;
    emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { attempt: repairs, mode: 'backend-repair', ...finishDetail } });
    text = rtext;
  }

  if (args.refreshFilesChanged) {
    filesChanged = args.refreshFilesChanged() ?? filesChanged;
  }
  writeGateFailed = writeGateShouldFail({
    writeToolNamesLength: writeToolNames.length,
    writeOps,
    text,
    filesChanged,
    toolEvents: nodeToolEvents,
  });
  const fcEnd = ensureWriterFilesChanged();
  if (writeGateFailed) {
    const reason = writeOps === 0
      ? `write gate: write-enabled node emitted code as prose but called no write tool after ${repairs} repair(s) — nothing was applied to the worktree`
      : `write gate: node's deliverable still contains unapplied tool-call/edit JSON after ${repairs} repair(s) (${writeOps} write op(s) did land — the rest was prose)`;
    emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason, detail: { writeOps, ...(fcEnd ? { filesChanged: fcEnd } : {}), ...finishDetail } });
    return { nodeId: node.id, stageId: stage.id, status: 'failed', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded, judge, contractValid, writeOps };
  }

  const testsOk = lastTests ? lastTests.ok : undefined;
  const gatesRedAtEnd = lastVerifyOk === false || testsOk === false;
  if (gatesRedAtEnd) {
    const which = [lastVerifyOk === false ? 'typecheck' : null, testsOk === false ? 'tests' : null].filter(Boolean).join(' + ');
    const reason = `gates red after ${repairs} repair(s): ${which} — output kept on disk but the node must not report clean`;
    emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason, detail: { repairs, ...(testsOk === undefined ? {} : { testsOk }), ...(writeToolNames.length ? { writeOps } : {}), ...(fcEnd ? { filesChanged: fcEnd } : {}), ...finishDetail } });
    return { nodeId: node.id, stageId: stage.id, status: 'failed', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded, judge, contractValid, ...(testsOk === undefined ? {} : { testsOk }), ...(writeToolNames.length ? { writeOps } : {}) };
  }

  const judgeDisputed = judge?.verdict === 'RETURN' || judge?.pass === false;
  // dec-judge-seam: opt-in hard fail after repairs (still keeps .out on disk).
  if (judgeDisputed && node.contract.judge?.onReturn === 'fail-node') {
    const reason =
      judge?.reason?.trim() ||
      'judge RETURN after repairs exhausted (onReturn: fail-node) — output kept on disk';
    emit({
      type: 'node_fail',
      stageId: stage.id,
      nodeId: node.id,
      status: 'failed',
      reason,
      detail: {
        repairs,
        onReturn: 'fail-node',
        judgeDisputed: true,
        ...(judge?.zero_tool_calls !== undefined ? { zero_tool_calls: judge.zero_tool_calls } : {}),
        ...(judge?.tool_trace_status !== undefined ? { tool_trace_status: judge.tool_trace_status } : {}),
        ...(testsOk === undefined ? {} : { testsOk }),
        ...(writeToolNames.length ? { writeOps } : {}),
        ...(fcEnd ? { filesChanged: fcEnd } : {}),
        ...finishDetail,
      },
    });
    return {
      nodeId: node.id,
      stageId: stage.id,
      status: 'failed',
      outputPath,
      reason,
      latencyMs: Math.round(performance.now() - t0),
      degradedPack: pack.degraded,
      judge,
      contractValid,
      ...(testsOk === undefined ? {} : { testsOk }),
      ...(writeToolNames.length ? { writeOps } : {}),
    };
  }

  const verified = computeVerified({
    judge,
    testsOk,
    judgeDisputed,
  });
  writeNodeCommitted(nodeDir, {
    nodeId: node.id,
    stageId: stage.id,
    status: 'done',
    outputPath,
    contractValid: contractValid ?? null,
    repairs,
    bytes: Buffer.byteLength(text),
    ...(fcEnd ? { filesChanged: fcEnd } : {}),
    ...(finishDetail ?? {}),
  });
  emit({
    type: 'node_finish',
    stageId: stage.id,
    nodeId: node.id,
    status: 'done',
    detail: {
      bytes: Buffer.byteLength(text),
      degradedPack: pack.degraded,
      contractValid,
      repairs,
      committed: true,
      ...(judgeDisputed ? { passReason: 'gate-convergence', judgeDisputed: true } : {}),
      // evidence_waived rides on node_finish, not only on the judge frame, because the LEDGER reads
      // node_finish. `verified:true` for a waived ACCEPT is correct (the judge did accept, and the
      // disputed-set / --rerun-failed spine keys on it) but incomplete on its own: without this field a
      // sim run of content-only ACCEPTs reads exactly like an evidence-backed one.
      ...(judge ? { verified, ...(judge.evidence_waived ? { evidence_waived: judge.evidence_waived } : {}), ...(judge.zero_tool_calls !== undefined && judge.zero_tool_calls !== null ? { zero_tool_calls: judge.zero_tool_calls } : {}) } : {}),
      ...(testsOk === undefined ? {} : { testsOk }),
      ...(writeToolNames.length ? { writeOps } : {}),
      ...(fcEnd ? { filesChanged: fcEnd } : {}),
      ...finishDetail,
    },
  });
  return {
    nodeId: node.id,
    stageId: stage.id,
    status: 'done',
    outputPath,
    latencyMs: Math.round(performance.now() - t0),
    degradedPack: pack.degraded,
    judge,
    contractValid,
    ...(testsOk === undefined ? {} : { testsOk }),
    ...(writeToolNames.length ? { writeOps } : {}),
  };
}

/** verified=true only when judge ACCEPT (or no judge) and not disputed; testsOk must not be false. */
function computeVerified(args: {
  judge: JudgeVerdict | undefined;
  testsOk: boolean | undefined;
  judgeDisputed: boolean;
}): boolean {
  if (args.testsOk === false) return false;
  if (!args.judge) return true;
  if (args.judgeDisputed) return false;
  if (args.judge.verdict === 'ACCEPT' || args.judge.pass === true) return true;
  if (args.judge.verdict == null && args.judge.pass == null) return true;
  return false;
}

const CHECKPOINT_DIGEST_OUT_CHARS = 4_000;

/**
 * Build a run_progress-style digest for a checkpoint: succeeded ids + truncated consumed .out bodies.
 * Pure reads — never mutates upstream outputs.
 */
export function buildCheckpointDigest(args: {
  plan: FleetPlan;
  runDir: string;
  node: Node;
  stage: Stage;
  succeeded: Set<string>;
  idx: ReturnType<typeof indexPlan>;
}): string {
  const { plan, runDir, node, stage, succeeded, idx } = args;
  const lines: string[] = [
    '===== CHECKPOINT DIGEST =====',
    `checkpointNode: ${node.id}`,
    `stage: ${stage.id} (${stage.title})`,
    `mode: ${node.checkpoint?.mode ?? 'unknown'}`,
    `succeeded: ${[...succeeded].join(', ') || '(none)'}`,
    `consumes: ${node.consumes.join(', ') || '(none)'}`,
    '',
  ];
  const consumedIds = [...new Set(node.consumes.flatMap((r) => resolveConsumedNodeIds(plan, r)))];
  for (const nid of consumedIds) {
    const entry = idx.get(nid);
    const outRel = entry?.node.contract.outputPath ?? `${nid}.out`;
    const abs = resolve(runDir, outRel);
    const ok = succeeded.has(nid);
    if (!existsSync(abs)) {
      lines.push(`----- consumed ${nid} (${outRel}) — MISSING (succeeded=${ok}) -----`, '');
      continue;
    }
    let body = '';
    try {
      body = readFileSync(abs, 'utf8');
    } catch {
      body = '(unreadable)';
    }
    const truncated = body.length > CHECKPOINT_DIGEST_OUT_CHARS;
    const slice = body.slice(0, CHECKPOINT_DIGEST_OUT_CHARS);
    lines.push(
      `----- consumed ${nid} (${outRel}) — ${body.length} chars${truncated ? ' truncated' : ''} (succeeded=${ok}) -----`,
      slice,
      '',
    );
  }
  if (node.checkpoint?.rubric) {
    lines.push('===== RUBRIC =====', node.checkpoint.rubric, '');
  }
  return lines.join('\n');
}

/** System prompt for llm-mode checkpoint (print-only; no tools — same discipline as judges). */
export const CHECKPOINT_SUPERVISOR_SYSTEM = [
  'You are a checkpoint supervisor for a multi-agent fleet run.',
  'You have no tools; all evidence is inline in the prompt (digest + rubric).',
  'Decide whether the run should continue to the next stage, end gracefully, or record an expand intent for a next wave.',
  'Reply with EXACTLY one decision line (markdown decoration is ok):',
  '  DECISION: continue — <short reason>',
  '  DECISION: end — <short reason>',
  '  DECISION: expand — <short reason>',
  'Do not invent tool calls. Do not edit plans. expand never auto-runs a new plan.',
].join('\n');

/**
 * T2/T3: wait for human checkpoint release via control approve (continue) or stop (end).
 * Messages are notes into the decision record (do not alone release).
 * waitMs=0 → single check (tests pre-seed control ops).
 */
async function waitForCheckpointControl(args: {
  control: ControlApplier;
  echoControl?: (op: ControlOpRecord, extra?: Record<string, unknown>) => void;
  nodeId: string;
  stageId: string;
  waitMs: number;
  pollMs: number;
}): Promise<{ decision: 'continue' | 'end' | 'pending'; notes: string[] }> {
  const notes: string[] = [];
  const deadline = Date.now() + Math.max(0, args.waitMs);
  let first = true;
  for (;;) {
    const { texts, ops } = args.control.takeMessages(args.nodeId, args.stageId);
    if (texts.length > 0) {
      notes.push(...texts);
      for (const op of ops) {
        args.echoControl?.(op, { applied: true, effect: 'checkpoint-message' });
      }
    }
    const ap = args.control.takeApprove(args.stageId);
    if (ap) {
      args.echoControl?.(ap, { applied: true, effect: 'checkpoint-continue' });
      return { decision: 'continue', notes };
    }
    const pendingStop = args.control.pending().find((o) => o.op === 'stop');
    if (pendingStop) {
      const st = args.control.takeStop();
      if (st) args.echoControl?.(st, { applied: true, effect: 'checkpoint-end' });
      return { decision: 'end', notes };
    }
    if (!first && Date.now() >= deadline) return { decision: 'pending', notes };
    if (first && args.waitMs <= 0) return { decision: 'pending', notes };
    first = false;
    if (Date.now() >= deadline) return { decision: 'pending', notes };
    await new Promise((r) => setTimeout(r, Math.max(1, args.pollMs)));
  }
}

/**
 * T3 checkpoint node execution: digest → mode decision → journal + .out decision record.
 * Never deletes outputs. expand never auto-executes a new plan.
 */
async function runCheckpointNode(
  stage: Stage,
  node: Node,
  ctx: StageCtx,
  t0: number,
): Promise<NodeOutcome> {
  const { deps, runDir, emit, now } = ctx;
  const outputPath = node.contract.outputPath;
  const cfg = node.checkpoint;
  const mode = cfg?.mode ?? 'deterministic';
  const attempt = 1;
  const nodeDir = resolve(runDir, 'nodes', node.id);

  // Fail-forward: unmet hard consumes → skip (same group rule as agent nodes).
  const resolvedIds = node.consumes.flatMap((ref) => resolveConsumedNodeIds(ctx.plan, ref));
  const groupByStage = new Map<string, string[]>();
  for (const nid of resolvedIds) {
    const stageId = ctx.idx.get(nid)?.stageId;
    if (!stageId) continue;
    const list = groupByStage.get(stageId) ?? [];
    list.push(nid);
    groupByStage.set(stageId, list);
  }
  const unmet: string[] = [];
  for (const [, nids] of groupByStage) {
    const failed = nids.filter((nid) => !ctx.succeeded.has(nid));
    if (failed.length === 0) continue;
    if (nids.length >= 2 && failed.length < nids.length) {
      /* partial fan-out — degraded digest is fine */
    } else {
      unmet.push(...failed);
    }
  }
  if (unmet.length > 0) {
    const reason = `upstream consume(s) not satisfied: ${[...new Set(unmet)].join(', ')}`;
    emit({ type: 'node_skip', stageId: stage.id, nodeId: node.id, status: 'skipped', reason });
    return {
      nodeId: node.id,
      stageId: stage.id,
      status: 'skipped',
      outputPath,
      reason,
      latencyMs: Math.round(performance.now() - t0),
      degradedPack: false,
    };
  }

  const digest = buildCheckpointDigest({
    plan: ctx.plan,
    runDir,
    node,
    stage,
    succeeded: ctx.succeeded,
    idx: ctx.idx,
  });

  try {
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(resolve(nodeDir, 'pack.txt'), digest, 'utf8');
  } catch {
    /* log must not fail node */
  }

  emit({
    type: 'node_start',
    stageId: stage.id,
    nodeId: node.id,
    detail: {
      kind: 'checkpoint',
      mode,
      packChars: digest.length,
      sharedChars: 0,
      consumes: node.consumes,
    },
  });

  let decision: CheckpointDecision = 'continue';
  let reason: string | null = null;
  let notes: string[] = [];
  let raw = '';
  let parseNote: string | undefined;

  if (mode === 'human') {
    // Emit pending first so watchers see the wait; write provisional record.
    emit({
      type: 'checkpoint',
      stageId: stage.id,
      nodeId: node.id,
      detail: { mode, decision: 'pending', reason: 'awaiting control approve/stop', attempt },
    });
    const provisional = {
      kind: 'checkpoint' as const,
      mode,
      decision: 'pending' as const,
      reason: 'awaiting control approve/stop',
      notes: [] as string[],
      attempt,
      digestChars: digest.length,
      ts: now(),
    };
    try {
      writeDeclaredOutput(runDir, outputPath, JSON.stringify(provisional, null, 2) + '\n');
    } catch {
      /* keep going */
    }

    if (!ctx.control) {
      decision = 'pending';
      reason = 'human checkpoint: no control applier (cannot wait)';
    } else {
      const waited = await waitForCheckpointControl({
        control: ctx.control,
        echoControl: ctx.echoControl,
        nodeId: node.id,
        stageId: stage.id,
        waitMs: deps.humanGateWaitMs ?? 0,
        pollMs: deps.humanGatePollMs ?? 50,
      });
      notes = waited.notes;
      decision = waited.decision;
      reason =
        waited.decision === 'continue'
          ? 'human approve → continue'
          : waited.decision === 'end'
            ? 'human stop → end'
            : 'human checkpoint timed out still pending';
      if (notes.length > 0) {
        reason = `${reason}; notes: ${notes.join(' | ')}`;
      }
    }
  } else if (mode === 'llm') {
    // Single-turn via judge seam resolution (same as judges — tests stub judgeGenerate / judgeSeam).
    const fakeSpec: JudgeSpec = { rubric: cfg?.rubric ?? 'checkpoint' };
    const { generate: judgeGenerate, backend } = resolveJudgeGenerate(fakeSpec, deps);
    const model = deps.forceModel ?? deps.defaultModel;
    const prompt = [
      digest,
      '',
      '===== INSTRUCTION =====',
      cfg?.rubric ? `Rubric: ${cfg.rubric}` : 'Rubric: decide if the run is on track.',
      'Reply DECISION: continue | end | expand — <reason>',
    ].join('\n');
    try {
      const out = await judgeGenerate({
        model,
        system: CHECKPOINT_SUPERVISOR_SYSTEM,
        prompt,
        maxOutputTokens: JUDGE_MAX_TOKENS,
      });
      raw = (out.text ?? '').trim();
    } catch (e) {
      raw = `checkpoint llm error: ${e instanceof Error ? e.message : String(e)}`;
    }
    const parsed = parseCheckpointDecision(raw);
    if (parsed.decision === null) {
      decision = 'continue';
      reason = 'unparseable checkpoint reply — defaulting to continue';
      parseNote = reason;
    } else {
      decision = parsed.decision;
      reason = parsed.reason;
    }
    if (!reason) reason = `llm decision via ${backend}`;
  } else {
    // deterministic
    const pred = evalCheckpointPredicate(cfg?.rubric, {
      consumes: node.consumes,
      succeeded: ctx.succeeded,
      resolveIds: (ref) => resolveConsumedNodeIds(ctx.plan, ref),
    });
    decision = pred.decision;
    reason = pred.reason;
    raw = `DECISION: ${pred.decision} — ${pred.reason}`;
  }

  // expand requires allowExpand:true — otherwise demote to continue with a note (never auto-run).
  if (decision === 'expand' && !cfg?.allowExpand) {
    parseNote = [
      parseNote,
      'expand requested but allowExpand is false — treating as continue',
    ]
      .filter(Boolean)
      .join('; ');
    decision = 'continue';
    reason = `${reason ?? 'expand'} (expand not allowed — continue)`;
  }

  // expand + allowExpand: write GATE-style pending note (operator runs expand — never auto-execute).
  if (decision === 'expand' && cfg?.allowExpand) {
    const body = [
      `CHECKPOINT EXPAND: node ${node.id} (stage ${stage.id})`,
      `Decision: expand — wave expansion is NOT auto-run.`,
      `Operator: ratify a next-wave manifest and run the expand command (F2).`,
      `Reason: ${reason ?? '(none)'}`,
      `Digest chars: ${digest.length}`,
      '',
    ].join('\n');
    try {
      writeFileSync(resolve(runDir, `GATE-expand-${node.id}.pending`), body, 'utf8');
    } catch {
      /* best-effort */
    }
  }

  const record = {
    kind: 'checkpoint' as const,
    mode,
    decision,
    reason,
    notes,
    attempt,
    digestChars: digest.length,
    ...(raw ? { raw } : {}),
    ...(parseNote ? { parseNote } : {}),
    ts: now(),
  };
  try {
    writeDeclaredOutput(runDir, outputPath, JSON.stringify(record, null, 2) + '\n');
  } catch (e) {
    const failReason = `checkpoint write failed: ${e instanceof Error ? e.message : String(e)}`;
    emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason: failReason });
    return {
      nodeId: node.id,
      stageId: stage.id,
      status: 'failed',
      outputPath,
      reason: failReason,
      latencyMs: Math.round(performance.now() - t0),
      degradedPack: false,
    };
  }

  emit({
    type: 'checkpoint',
    stageId: stage.id,
    nodeId: node.id,
    detail: {
      mode,
      decision,
      reason,
      attempt,
      ...(notes.length ? { notes } : {}),
      ...(parseNote ? { parseNote } : {}),
    },
  });

  const bytes = Buffer.byteLength(JSON.stringify(record));
  emit({
    type: 'node_finish',
    stageId: stage.id,
    nodeId: node.id,
    status: 'done',
    detail: {
      kind: 'checkpoint',
      mode,
      decision,
      reason,
      bytes,
      committed: true,
      verified: decision !== 'pending',
    },
  });

  // Commit marker so resume can cache a finished checkpoint (gate marks, never deletes).
  writeNodeCommitted(nodeDir, {
    nodeId: node.id,
    kind: 'checkpoint',
    decision,
    mode,
    ts: now(),
  });

  if (decision === 'end' || decision === 'pending') {
    if (ctx.checkpointStopBox) {
      ctx.checkpointStopBox.current = {
        nodeId: node.id,
        reason: reason ?? `checkpoint ${decision}`,
      };
    }
  }

  return {
    nodeId: node.id,
    stageId: stage.id,
    status: 'done',
    outputPath,
    latencyMs: Math.round(performance.now() - t0),
    degradedPack: false,
    reason: reason ?? undefined,
  };
}

async function runComputeNode(
  stage: Stage,
  node: Node,
  ctx: StageCtx,
  t0: number,
): Promise<NodeOutcome> {
  const { runDir, emit } = ctx;
  const outputPath = node.contract.outputPath;
  const computeId = node.compute?.id ?? '';
  const args = node.compute?.args ?? {};
  const nodeDir = resolve(runDir, 'nodes', node.id);

  const resolvedIds = node.consumes.flatMap((ref) => resolveConsumedNodeIds(ctx.plan, ref));
  const unmet = resolvedIds.filter((nid) => !ctx.succeeded.has(nid));
  if (unmet.length > 0) {
    const reason = `upstream consume(s) not satisfied: ${[...new Set(unmet)].join(', ')}`;
    emit({ type: 'node_skip', stageId: stage.id, nodeId: node.id, status: 'skipped', reason });
    return {
      nodeId: node.id,
      stageId: stage.id,
      status: 'skipped',
      outputPath,
      reason,
      latencyMs: Math.round(performance.now() - t0),
      degradedPack: false,
    };
  }

  const consumed = resolvedIds.map((nid) => {
    const entry = ctx.idx.get(nid);
    const rel = entry?.node.contract.outputPath ?? `${nid}.out`;
    const abs = resolve(runDir, rel);
    const text = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    return { nodeId: nid, text };
  });

  emit({
    type: 'node_start',
    stageId: stage.id,
    nodeId: node.id,
    detail: {
      kind: 'compute',
      computeId,
      consumes: node.consumes,
    },
  });

  let result;
  try {
    result = await executeCompute({
      computeId,
      args,
      consumed,
      env: process.env,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    emit({
      type: 'node_fail',
      stageId: stage.id,
      nodeId: node.id,
      status: 'failed',
      reason: `compute threw: ${reason}`,
    });
    return {
      nodeId: node.id,
      stageId: stage.id,
      status: 'failed',
      outputPath,
      reason,
      latencyMs: Math.round(performance.now() - t0),
      degradedPack: false,
    };
  }

  mkdirSync(nodeDir, { recursive: true });
  if (result.ok) {
    writeDeclaredOutput(runDir, outputPath, result.text);
    writeNodeCommitted(nodeDir, { computeId, ok: true, at: new Date().toISOString() });
    emit({
      type: 'node_finish',
      stageId: stage.id,
      nodeId: node.id,
      status: 'done',
      detail: { kind: 'compute', computeId, bytes: result.text.length },
    });
    return {
      nodeId: node.id,
      stageId: stage.id,
      status: 'done',
      outputPath,
      latencyMs: Math.round(performance.now() - t0),
      degradedPack: false,
    };
  }

  writeDeclaredOutput(runDir, outputPath, `COMPUTE_REJECT ${computeId}: ${result.reason}\n`);
  emit({
    type: 'node_fail',
    stageId: stage.id,
    nodeId: node.id,
    status: 'failed',
    reason: result.reason,
  });
  return {
    nodeId: node.id,
    stageId: stage.id,
    status: 'failed',
    outputPath,
    reason: result.reason,
    latencyMs: Math.round(performance.now() - t0),
    degradedPack: false,
  };
}

async function runNode(stage: Stage, node: Node, ctx: StageCtx): Promise<NodeOutcome> {
  const { deps, runDir, emit, now } = ctx;
  const outputPath = node.contract.outputPath;
  const t0 = performance.now();

  // T2: control skip before any spend / cache (operator course-correction).
  if (ctx.control) {
    const skipOp = ctx.control.takeSkip(node.id);
    if (skipOp) {
      const reason = `control: ${skipOp.reason ?? 'skipped'}`;
      ctx.echoControl?.(skipOp, { applied: true, effect: 'skip' });
      emit({ type: 'node_skip', stageId: stage.id, nodeId: node.id, status: 'skipped', reason });
      return { nodeId: node.id, stageId: stage.id, status: 'skipped', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: false };
    }
  }

  // T3: checkpoint node — decision record only (no agent seat, no tools, never deletes outputs).
  // Missing kind is treated as agent (parsePlan defaults; manual fixtures may omit).
  if ((node.kind ?? 'agent') === 'checkpoint') {
    return runCheckpointNode(stage, node, ctx, t0);
  }
  if (node.kind === 'compute') {
    return runComputeNode(stage, node, ctx, t0);
  }

  // Fail-forward with group survivability: resolve consumed ids, partition by owning stage.
  // A group of size >= 2 is survivable (only unmet if ALL members failed).
  // A group of size 1 is a hard dependency (unmet if failed).
  const resolvedIds = node.consumes.flatMap(ref => resolveConsumedNodeIds(ctx.plan, ref));
  const idx = ctx.idx; // PlanNodeIndex map from indexPlan(plan)
  const groupByStage = new Map<string, string[]>();
  for (const nid of resolvedIds) {
    const stageId = idx.get(nid)?.stageId;
    if (!stageId) {
      // id not indexed? should not happen for a validated plan — skip silently.
      continue;
    }
    const list = groupByStage.get(stageId) ?? [];
    list.push(nid);
    groupByStage.set(stageId, list);
  }
  const unmet: string[] = [];
  let partialConsume = false;
  for (const [, nids] of groupByStage) {
    const failed = nids.filter(nid => !ctx.succeeded.has(nid));
    if (failed.length === 0) continue;
    if (nids.length >= 2 && failed.length < nids.length) {
      // group of size >= 2 with some survivors => degraded, not unmet
      partialConsume = true;
    } else {
      // size 1 and failed, or size >= 2 but all failed => hard dependency
      unmet.push(...failed);
    }
  }
  if (unmet.length > 0) {
    const reason = `upstream consume(s) not satisfied: ${[...new Set(unmet)].join(', ')}`;
    emit({ type: 'node_skip', stageId: stage.id, nodeId: node.id, status: 'skipped', reason });
    return { nodeId: node.id, stageId: stage.id, status: 'skipped', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: false };
  }
  if (partialConsume) emit({ type: 'node_retry', stageId: stage.id, nodeId: node.id, detail: { reason: 'running on partial fan-out (some upstream nodes failed — combining survivors)' } });

  // L1 node dir early — resume commit check + pack logs share this path.
  const nodeDir = resolve(runDir, 'nodes', node.id);

  // F5 resume / Critical-1: promote ONLY when committed.json proves the gate path finished.
  // Bare .out (written mid-gate before crash) is NOT enough — that path re-enters the gate below.
  // Epic-6: --rerun-failed --include-disputed refuses cache for committed-but-disputed/unverified nodes
  // (trust spine: journal done ≠ verified work). Old .out stays on disk; never deleted here.
  if (deps.resume) {
    const outAbs = resolve(runDir, outputPath);
    const forceRerunDisputed = ctx.skipCacheNodeIds.has(node.id);
    if (existsSync(outAbs) && isNodeCommitted(nodeDir) && !forceRerunDisputed) {
      // T2: messages targeting an already-done (cached) node are recorded no-ops, never errors.
      if (ctx.control) {
        const { ops } = ctx.control.takeMessages(node.id, stage.id);
        for (const op of ops) {
          ctx.echoControl?.(op, { applied: true, effect: 'no-op', note: 'node already finished (cached)' });
        }
      }
      const cached = readFileSync(outAbs, 'utf8');
      const valid = node.contract.schema === undefined || checkOutput(cached, node.contract.schema).ok;
      if (valid) {
        emit({ type: 'node_cached', stageId: stage.id, nodeId: node.id, status: 'done', detail: { bytes: Buffer.byteLength(cached), committed: true } });
        return { nodeId: node.id, stageId: stage.id, status: 'done', outputPath, latencyMs: Math.round(performance.now() - t0), degradedPack: false, contractValid: node.contract.schema === undefined ? undefined : true };
      }
    }
  }

  // Scoped context pack: this node's stage-shared prefix (incl. sharedInject files) + contract + node-injected
  // files + ONLY its own consumed upstream outputs (inject-not-search: targets ride IN the pack).
  const basePack = buildContextPack(ctx.plan, node.id, runDir, { env: process.env, rootDir: deps.sandboxRoot, run: { runId: ctx.runId, runDir } });
  // T2: inject pending control messages once into the pack (consumed — not re-applied on repair).
  let pack = basePack;
  if (ctx.control) {
    const { texts, ops } = ctx.control.takeMessages(node.id, stage.id);
    if (texts.length > 0) {
      const text = appendControlMessagesToPack(basePack.text, texts);
      pack = { ...basePack, text, totalChars: text.length };
      for (const op of ops) {
        ctx.echoControl?.(op, { applied: true, effect: 'message' });
      }
    }
  }
  // L1: the per-node log home — runs/<runId>/nodes/<nodeId>/{pack.txt, turns/<NN>.json, node.json}. Full
  // reconstructability (retro/debug): the EXACT prompt that ran + every model call. Log writes never fail a node.
  try {
    mkdirSync(resolve(nodeDir, 'turns'), { recursive: true });
    writeFileSync(resolve(nodeDir, 'pack.txt'), pack.text, 'utf8');
  } catch { /* a log write must never fail the node */ }
  // M1: hard-fail missing REQUIRED injects before any model spend (mirror write-intent fail-before-spend).
  // Truncation-only degraded packs still run; missing consumes keep their existing skip policy.
  const missingInject = missingRequiredInjectPaths(pack, process.env, 'live');
  if (missingInject.length > 0) {
    const reason = `missing required inject: ${missingInject.join(', ')}`;
    emit({
      type: 'node_fail',
      stageId: stage.id,
      nodeId: node.id,
      status: 'failed',
      reason,
      detail: { missingInject, degradedPack: pack.degraded },
    });
    return {
      nodeId: node.id,
      stageId: stage.id,
      status: 'failed',
      outputPath,
      reason,
      latencyMs: Math.round(performance.now() - t0),
      degradedPack: true,
    };
  }
  // forceModel wins: when the seam force-pins the model, that is what actually ran — log it truthfully.
  const model = deps.forceModel ?? node.agent.model ?? deps.defaultModel;
  const consumedRefs = [...new Set(node.consumes.flatMap((r) => resolveConsumedNodeIds(ctx.plan, r)))];
  const injectedChars = [...pack.sharedInjected, ...pack.injected].reduce((n, f) => n + f.bytes, 0);
  // CR-1: resolve executor kind; non-api must not silently spend on the OpenRouter generate path.
  const executorKind = resolveExecutorKind(node);
  // Critical-1: ungated .out (exists, no committed.json) re-enters the gate — never promoted as done.
  let resumeUngatedText: string | undefined;
  if (deps.resume) {
    const outAbs = resolve(runDir, outputPath);
    if (existsSync(outAbs) && !isNodeCommitted(nodeDir)) {
      resumeUngatedText = readFileSync(outAbs, 'utf8');
    }
  }
  emit({
    type: 'node_start', stageId: stage.id, nodeId: node.id,
    detail: {
      model,
      runner: executorKind,
      packChars: pack.totalChars,
      sharedChars: pack.sharedChars,
      injectedChars,
      consumes: consumedRefs,
      degradedPack: pack.degraded,
      ...(resumeUngatedText !== undefined ? { resumeUngated: true } : {}),
    },
  });
  if (!isApiRunner(executorKind)) {
    return await runNodeViaExecutor(stage, node, ctx, {
      executorKind,
      pack,
      model,
      outputPath,
      t0,
      nodeDir,
      resumeUngatedText,
    });
  }

  const tools = deps.toolsFor?.(node);
  const maxOutputTokens = deps.outputTokensFor?.(node) ?? tokensForNode(node);
  // Tool-loop headroom: a global env override (deps.maxSteps) else scaled by the node's effort (32/64/128).
  const maxSteps = deps.maxSteps ?? stepsForNode(node);
  // E-1: which write tools this node actually holds (bundle keys are the model-facing names), and how many
  // write CALLS its generation made — counted from the step feed, so attribution stays per-node even when
  // several writers run in parallel. Repair generates reuse genArgs → repairs keep accumulating the count.
  const writeToolNames = tools ? WRITE_TOOL_NAMES.filter((n) => n in tools) : [];
  // Snapshot only on write intent (not tool-name length) — RO / EXP-012 seats never pay git spawn.
  const writeCapable = !!deps.writeIntent?.(node);
  const sandboxRoot = deps.sandboxRoot ?? process.cwd();
  let beforeTree: TreeSnapshot | undefined;
  let nodeRootForTree: string | undefined;
  if (writeCapable) {
    try {
      nodeRootForTree = resolveNodeCwd(node, sandboxRoot);
      beforeTree = snapshotTree(nodeRootForTree, { sandboxRoot });
    } catch {
      beforeTree = { ok: false, reason: 'root-unavailable' };
    }
  }
  const refreshFilesChanged = (): FilesChangedFact | undefined => {
    if (!writeCapable) return undefined;
    if (!beforeTree || !nodeRootForTree) {
      return { known: false, reason: 'root-unavailable' };
    }
    const after = snapshotTree(nodeRootForTree, { sandboxRoot });
    return diffTreeSnapshots(beforeTree, after);
  };
  let filesChanged: FilesChangedFact | undefined = writeCapable ? refreshFilesChanged() : undefined;
  const ensureWriterFilesChangedApi = (): FilesChangedFact | undefined => {
    const isWriterSeat = writeToolNames.length > 0 || writeCapable;
    if (!isWriterSeat) return filesChanged;
    filesChanged = refreshFilesChanged() ?? filesChanged;
    if (filesChanged === undefined) filesChanged = { known: false, reason: 'root-unavailable' };
    return filesChanged;
  };
  // E-1 v3: an ARMED writer (deps.writeIntent — persona/seat says writer, CLI says --write) holding ZERO
  // write tools is a tool-resolution failure, not a readonly node. Fail loudly BEFORE spending tokens —
  // running it would reproduce the 2026-07-07 silent pass (prose "fix", empty diff, judge 1.0).
  if (deps.writeIntent?.(node) && writeToolNames.length === 0) {
    const reason = 'write gate: node has write INTENT (armed writer persona/seat) but resolved zero write tools — tool resolution dropped them; refusing to run as a silent reader';
    const fc = ensureWriterFilesChangedApi();
    emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason, detail: { writeOps: 0, ...(fc ? { filesChanged: fc } : {}) } });
    return { nodeId: node.id, stageId: stage.id, status: 'failed', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded, writeOps: 0 };
  }
  let writeOps = 0;
  // Judge ground-truth: accumulate every tool event this node made (across all its turns) so the judge can be
  // shown WHAT the node actually did — not just its self-report. This is the evidence the judge cross-checks
  // the register against (a register claiming writes with zero write events = fabrication).
  const nodeToolEvents: ToolEvent[] = [];
  // L1: every REAL model call (initial, schema retry, repairs, forced synthesis) persists as one turn record.
  let turnCounter = 0;
  // #43: the node's RESUMABLE conversation (AI-SDK messages, tool calls included) — updated after every call,
  // persisted to nodes/<id>/messages.json so a later stage (or run) can continue this node's session.
  let history: unknown[] | undefined;
  const persistHistory = () => {
    if (!history) return;
    try {
      const j = JSON.stringify(history);
      if (j.length <= 8_000_000) writeFileSync(resolve(nodeDir, 'messages.json'), j, 'utf8');
    } catch { /* a log write must never fail the node */ }
  };

  const genArgs = {
    model,
    system: nodeSystem(node),
    prompt: pack.text,
    maxOutputTokens,
    // W3: surface each agentic step as a node_step event in run.jsonl → the cockpit SSE streams a node's live
    // progress (which tool it called, tokens, elapsed step index). Small lines; only tool-loop nodes emit steps.
    onStep: (info: { index: number; tools: string[]; tokens?: number; finishReason?: string }) => {
      writeOps += info.tools.filter((t) => writeToolNames.includes(t)).length;
      emit({ type: 'node_step', stageId: stage.id, nodeId: node.id, detail: { ...info } });
    },
    // L1: per-call trace → nodes/<id>/turns/<NN>.json. Repair/retry generates reuse genArgs, so their calls
    // land as turns 02, 03… automatically. try/catch: a log write must never fail the node.
    onCall: (trace: CallTrace) => {
      turnCounter += 1;
      if (trace.toolEvents?.length) nodeToolEvents.push(...trace.toolEvents);
      try {
        writeFileSync(
          resolve(nodeDir, 'turns', String(turnCounter).padStart(2, '0') + '.json'),
          JSON.stringify({ turn: turnCounter, ts: now(), ...trace }, null, 2), 'utf8',
        );
      } catch { /* never fail the node on a log write */ }
    },
    ...(tools ? { tools, maxSteps } : {}),
  };

  /** Transient-tolerant generate for the LATER calls in a node's life (the schema retry and the judge-repair
   *  cycles). The initial call has its own inline retry below; these later calls were UNPROTECTED — and all
   *  three build0 C15 deaths ('Failed to process successful response') happened exactly here, on repair-cycle
   *  calls AFTER real work was on disk. Retries ONCE on a call timeout or a processing error; a repair call
   *  carries `messages` history, so the retry re-sends an identical conversation — a cache-friendly resume,
   *  not a from-scratch rebuild. Structural errors (4xx/auth/abort) rethrow immediately (isProcessingError). */
  const generateTransient = async (args: Parameters<typeof deps.generate>[0], label: string) => {
    try {
      return await deps.generate(args);
    } catch (e) {
      if (!isCallTimeout(e) && !isProcessingError(e)) throw e;
      emit({ type: 'node_retry', stageId: stage.id, nodeId: node.id, detail: { reason: `${label}: ${isCallTimeout(e) ? 'call timed out' : 'response processing error'} — retrying once` } });
      return await deps.generate(args);
    }
  };

  try {
    let text: string;
    if (resumeUngatedText !== undefined) {
      // Critical-1: crash left a candidate .out without committed.json — re-enter schema+gates, no model re-call yet.
      text = resumeUngatedText.trim();
      emit({
        type: 'node_retry',
        stageId: stage.id,
        nodeId: node.id,
        detail: { reason: 'resume-ungated: re-entering gate pipeline (no committed.json)', runner: 'api' },
      });
      if (!text) {
        const reason = 'empty ungated resume output';
        emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason });
        return { nodeId: node.id, stageId: stage.id, status: 'failed', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded };
      }
    } else {
    // Retry-on-timeout (sibling to retry-on-leak below): a call that trips the seam's timeout — the blunt
    // per-call cap OR the per-step stall watchdog — is often a transient provider slow-spike, so retry the
    // FIRST generate ONCE. Only the initial generate retries; schema/repair generates keep single-shot.
    // Extended (2026-07): a response-processing error (200 received but the body could not be parsed —
    // 'Failed to process successful response', 'Unexpected token', JSON parse failures) is ALSO often
    // transient, so it retries once too — a serving hiccup must not cost a node in a wide fan-out.
    // 4xx/auth/abort errors are explicitly excluded by isProcessingError (structural, not transient).
    let out: Awaited<ReturnType<typeof deps.generate>>;
    try {
      out = await deps.generate(genArgs);
    } catch (e) {
      if (isCallTimeout(e)) {
        emit({ type: 'node_retry', stageId: stage.id, nodeId: node.id, detail: { reason: 'call timed out — retrying once' } });
        out = await deps.generate(genArgs);
      } else if (isProcessingError(e)) {
        emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { retry: 'processing-error', reason: 'response processing error — retrying once' } });
        out = await deps.generate(genArgs);
      } else {
        throw e;
      }
    }
    text = (out.text ?? '').trim();
    history = out.messages ?? history;
    persistHistory();
    // Retry-on-leak: an unexecuted tool call returned as text is PROVEN transient (a serving / early-boot
    // hiccup, not an AI-SDK request-shape defect — the 2026-07-05 investigation disproved the "seam bug":
    // request-body bisect + 10× single-turn + a full re-run all parsed clean; the one leak hit before the box
    // was CUDA-graph-warm). A single retry recovers it, so a warm-up flake never costs a node in a wide
    // fan-out. Retry ONCE, then the guard below treats a still-leaked output as a real failure.
    if (text && looksLikeLeakedToolCall(text)) {
      emit({ type: 'node_retry', stageId: stage.id, nodeId: node.id, detail: { reason: 'leaked tool-call — retrying once' } });
      out = await deps.generate(genArgs);
      text = (out.text ?? '').trim();
      history = out.messages ?? history;
      persistHistory();
    }
    if (!text) {
      const reason = `empty output (finishReason=${out.finishReason})`;
      emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason });
      return { nodeId: node.id, stageId: stage.id, status: 'failed', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded };
    }
    // Leaked tool-call guard: after the single retry above, an unexecuted tool call returned as text is not a
    // deliverable — fail the node (never write it, never let it flow downstream). The fleet must be robust to a
    // parser miss regardless of which model/parser sits behind the seam.
    if (looksLikeLeakedToolCall(text)) {
      const reason = `leaked tool-call in output (finishReason=${out.finishReason}) — the tool call was not executed after a retry (serving parser did not capture it); no deliverable produced`;
      emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason });
      return { nodeId: node.id, stageId: stage.id, status: 'failed', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded };
    }
    } // end !resumeUngatedText

    // F3: enforce the edge contract. If the node declares a schema, validate the output; on failure retry ONCE
    // with the errors injected; still-bad → hard fail and DO NOT write (a consumer never receives malformed
    // input). A node with no schema skips this entirely (contractValid stays undefined).
    let contractValid: boolean | undefined;
    if (node.contract.schema !== undefined) {
      let check = checkOutput(text, node.contract.schema);
      if (!check.ok) {
        const retryPrompt = [
          pack.text, '',
          '===== YOUR PREVIOUS OUTPUT FAILED SCHEMA =====',
          check.errors.join('\n'), '',
          '----- your previous output -----', text, '',
          'Return ONLY the corrected deliverable that satisfies the schema. Output valid JSON, nothing else.',
        ].join('\n');
        const retry = await generateTransient({ ...genArgs, prompt: retryPrompt }, 'schema-retry');
        history = retry.messages ?? history;
        persistHistory();
        const retryText = (retry.text ?? '').trim();
        check = retryText ? checkOutput(retryText, node.contract.schema) : { ok: false, errors: ['empty output on schema retry'] };
        if (retryText) text = retryText;
      }
      contractValid = check.ok;
      if (!check.ok) {
        const reason = `schema: ${check.errors.join('; ')}`;
        emit({ type: 'node_schema_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason });
        return { nodeId: node.id, stageId: stage.id, status: 'failed', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded, contractValid: false };
      }
    }

    // F4: write → judge → (if judge FAILED and repairs remain) re-generate with the verdict injected, loop.
    // A judge fail is ADVISORY: after the last repair the output is STILL kept (gate marks, never deletes);
    // a hard stop lives at the F5 human gate. Every attempt is preserved as <node>.attempt-<n>.out; the last
    // attempt's text is the written <outputPath>.
    // Default 6 (was 1): a net-new-file write node needs several tsc-repair passes to reach 0 errors — A5 went
    // 11→2 errors and was still improving when it ran out (2026-07-06). Repairs are cheap on a warm GPU.
    const maxRepairs = Math.max(0, deps.maxRepairs ?? 6);
    let judge: JudgeVerdict | undefined;
    let lastTests: { ok: boolean; report: string; ran: string[] } | undefined;
    let repairs = 0;
    let writeGateFailed = false;
    // C6 (retro -154Z): non-convergence detector — N consecutive gate failures with an UNCHANGED report means
    // the repair loop is not converging (u4 burned 54min/269K tokens this way). Detected below; aborts the loop.
    let sameGateFails = 0;
    let lastGateReportKey = '';
    let lastVerifyOk: boolean | undefined;
    // #39: the medic gets ONE shot per node — it either fixes the environment (gates re-run) or the normal
    // repair loop proceeds; a second invocation on the same node would just loop on an unfixable env.
    let medicTried = false;
    for (;;) {
      writeDeclaredOutput(runDir, outputPath, text);
      // ORDER (#40/C8, retro -154Z): concrete gates run FIRST; the judge runs SECOND and SEES their output
      // (ground truth in its pack). When the gate failed and repairs remain, the judge is SKIPPED entirely —
      // the compiler already said what to fix; a rubric verdict on non-compiling code is spend without signal.
      // F4b typecheck gate (concrete) — for a WRITE node, verify the files it just edited still compile.
      // F4c: when stage.gateScope === 'unit', the per-node write check is a LIGHTWEIGHT per-file transpile
      // (verifyUnitWrite) and the test gate is DEFERRED to the stage barrier (verifyStageBarrier) — a wide
      // fan-out shouldn't pay N full tsc+vitest cycles. 'repo' (default) = today's full per-node gates.
      const isUnitScope = stage.gateScope === 'unit';
      // F4c + security: when isUnitScope, prefer verifyUnitWrite (lightweight per-file). If it's absent
      // (deps not wired), FALL BACK to verifyWrite — never silently drop the write gate. Same for tests:
      // only defer to the stage barrier when verifyStageBarrier IS wired; otherwise run per-node verifyTests
      // so a unit-scoped stage never runs with zero gates (defense-in-depth against missing dep wiring).
      const verify = isUnitScope
        ? (deps.verifyUnitWrite ? await deps.verifyUnitWrite(node) : (deps.verifyWrite ? await deps.verifyWrite(node) : undefined))
        : (deps.verifyWrite ? await deps.verifyWrite(node) : undefined);
      const testVerify = (isUnitScope && deps.verifyStageBarrier) ? undefined  // tests deferred to the stage barrier
        : (deps.verifyTests ? await deps.verifyTests(node) : undefined);
      // GAP A: an un-runnable gate (reason 'gate-unavailable' — toolchain missing, spawn error) is NOT a
      // repairable failure (re-running won't install vitest/tsc). Fail the node LOUDLY with that reason in
      // run.jsonl instead of silently passing ({ ok: true }) or churning through useless repairs to timeout.
      // The operator must see the tooling gap, not a false "done" or a confused "tests=RED" that hides the
      // real cause (the suite never ran — the harness couldn't even spawn the runner). Checked BEFORE the
      // repair-event emits so no misleading "typecheck: fail" repair event is logged for an un-runnable gate.
      const gateUnavailable = verify?.reason === 'gate-unavailable' || testVerify?.reason === 'gate-unavailable';
      if (gateUnavailable) {
        const isWriteGate = verify?.reason === 'gate-unavailable';
        const gateName = isWriteGate ? 'typecheck (tsc)' : 'test (vitest)';
        const report = isWriteGate ? verify!.report : testVerify!.report;
        const reason = `gate-unavailable: ${gateName} gate could not run in the sandbox root — ${report || 'spawn failed'}`;
        emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason, detail: { ...(writeToolNames.length ? { writeOps } : {}), gateUnavailable: gateName } });
        return { nodeId: node.id, stageId: stage.id, status: 'failed', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded, judge, contractValid, ...(writeToolNames.length ? { writeOps } : {}) };
      }
      // C4 (retro -154Z B6): the EVENT carries the error head too — run.jsonl readers (cockpit, retros, the
      // entry agent) must see WHAT failed, not just that it failed. The full report still rides the repair prompt.
      if (verify) emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { typecheck: verify.ok ? 'pass' : 'fail', attempt: repairs, ...(verify.ok ? {} : { report: verify.report.slice(0, 600) }) } });
      if (testVerify) {
      lastTests = testVerify;
      // dec-246: durable run_tests channel — harness result lands in the journal, not only the Map/console.
      for (const p of testVerify.ran) {
        emit({ type: 'run_tests', stageId: stage.id, nodeId: node.id, detail: { path: p, passed: testVerify.ok, source: 'harness', attempt: repairs } });
      }
      emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { tests: testVerify.ok ? 'pass' : 'fail', ran: testVerify.ran, attempt: repairs, ...(testVerify.ok ? {} : { report: testVerify.report.slice(0, 600) }) } });
    }
      // E-1 WRITE gate — tree fact primary when known; writeOps secondary when tree unknown.
      filesChanged = refreshFilesChanged() ?? filesChanged;
      writeGateFailed = writeGateShouldFail({
        writeToolNamesLength: writeToolNames.length,
        writeOps,
        text,
        filesChanged,
        toolEvents: nodeToolEvents,
      });
      // Same as the cli path above: the gate decision carries the tree fact, `null` = no snapshot taken (EXP-013).
      if (writeGateFailed) emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { writeGate: 'fail', attempt: repairs, writeOps, filesChanged: filesChanged ?? null } });

      const verifyFailed = verify ? !verify.ok : false;
      const testsFailed = testVerify ? !testVerify.ok : false;
      lastVerifyOk = verify ? verify.ok : lastVerifyOk;

      // C6 non-convergence: identical gate-failure report N times in a row → repairing is not working; abort.
      if (verifyFailed || testsFailed) {
        const key = `${verify?.report ?? ''}\u0000${testVerify?.report ?? ''}`;
        sameGateFails = key === lastGateReportKey ? sameGateFails + 1 : 1;
        lastGateReportKey = key;
        if (sameGateFails >= 3) {
          const reason = `gate non-convergence: identical ${verifyFailed ? 'typecheck' : 'test'} failure across ${sameGateFails} consecutive repair attempts — aborting instead of burning further repairs`;
          const fc = ensureWriterFilesChangedApi();
          emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason, detail: { repairs, ...(writeToolNames.length ? { writeOps } : {}), ...(fc ? { filesChanged: fc } : {}) } });
          return { nodeId: node.id, stageId: stage.id, status: 'failed', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded, judge, contractValid, ...(writeToolNames.length ? { writeOps } : {}) };
        }
      } else {
        sameGateFails = 0;
        lastGateReportKey = '';
      }

      // #39: a RED gate classified as ENVIRONMENT routes to the medic (once) BEFORE any model repair — a
      // missing dep is not a code defect; re-prompting the writer about it burns tokens on the wrong problem.
      if ((verifyFailed || testsFailed) && deps.medic && !medicTried) {
        const gate: 'typecheck' | 'tests' = verifyFailed ? 'typecheck' : 'tests';
        const report = verifyFailed ? verify!.report : testVerify!.report;
        const classification = classifyGateFailure(report);
        if (classification === 'env') {
          medicTried = true;
          emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { medic: 'invoked', gate, classification, attempt: repairs } });
          try {
            const m = await deps.medic(node, { gate, report, classification });
            emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { medic: m?.acted ? 'acted' : 'no-action', ...(m?.note ? { note: m.note.slice(0, 400) } : {}), attempt: repairs } });
            if (m?.acted) continue; // environment touched → re-run the gates without burning a model repair
          } catch (e) {
            emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { medic: 'error', note: (e instanceof Error ? e.message : String(e)).slice(0, 300), attempt: repairs } });
          }
        }
      }

      // Judge (advisory REVIEW, #40) — runs AFTER the gates and sees their output as ground truth. Skipped
      // when a concrete gate failed and repairs remain: fix the compiler error first, judge the result later.
      const gatesRed = verifyFailed || testsFailed;
      if (node.contract.judge && !(gatesRed && repairs < maxRepairs)) {
        const isWriter = writeToolNames.length > 0 || !!deps.writeIntent?.(node);
        const writtenFiles = isWriter && deps.sandboxRoot ? readWrittenFiles(deps.sandboxRoot, nodeToolEvents) : undefined;
        const gateLines: string[] = [];
        if (verify) gateLines.push(`typecheck: ${verify.ok ? 'GREEN' : 'RED'}${verify.ok ? '' : `\n${verify.report}`}`);
        if (testVerify) gateLines.push(`tests: ${testVerify.ok ? 'GREEN' : 'RED'} (ran: ${testVerify.ran.join(', ') || 'none'})${testVerify.ok ? '' : `\n${testVerify.report}`}`);
        // Tool-invoked run_tests: emit each harness-recorded invocation into the journal (was Map-only).
        const toolRuns = deps.testRunsFor ? deps.testRunsFor(node) : undefined;
        if (toolRuns?.length) {
          for (const t of toolRuns) {
            emit({ type: 'run_tests', stageId: stage.id, nodeId: node.id, detail: { path: t.path, passed: t.passed, ms: t.ms, source: 'tool', attempt: repairs } });
          }
        }
        const requireToolEvidence = node.contract.judge.requireToolEvidence ?? isWriter;
        judge = await runJudge(node.contract.judge, text, node.contract.judge.model ?? model, deps, {
          task: renderTaskPrompt(node.taskPrompt),
          toolEvents: nodeToolEvents,
          writeOps,
          isWriter,
          gatesRed,
          requireToolEvidence,
          repairsRemaining: Math.max(0, maxRepairs - repairs),
          // The api path knows its own belt as a bundle, so it can say 0 honestly. `tools` is undefined
          // whenever the caller passes no `toolsFor` at all — which is exactly the sim seam
          // (`scripts/fleet.ts:1229`) and the orchestrator's read-only fleets (`p0/orchestrator.ts:1043`).
          toolsArmed: tools ? Object.keys(tools).length : 0,
          ...(writtenFiles?.length ? { writtenFiles } : {}),
          ...(toolRuns ? { testRuns: toolRuns } : {}),
          ...(gateLines.length ? { gateReport: gateLines.join('\n') } : {}),
          ...(genArgs.onCall ? { onCall: genArgs.onCall } : {}),
          ...(filesChanged ? { filesChanged } : {}),
        });
        emit({
          type: 'judge',
          stageId: stage.id,
          nodeId: node.id,
          detail: {
            rubric: judge.rubric,
            verdict: judge.verdict,
            reason: judge.reason,
            score: judge.score,
            threshold: judge.threshold,
            pass: judge.pass,
            attempt: repairs,
            ...(judge.backend !== undefined ? { backend: judge.backend } : {}),
            ...(judge.zero_tool_calls !== undefined ? { zero_tool_calls: judge.zero_tool_calls } : {}),
            ...(judge.tool_event_count !== undefined ? { tool_event_count: judge.tool_event_count } : {}),
            ...(judge.tool_trace_status !== undefined ? { tool_trace_status: judge.tool_trace_status } : {}),
            ...(judge.evidence_cited !== undefined ? { evidence_cited: judge.evidence_cited } : {}),
            ...(judge.overlay !== undefined ? { overlay: judge.overlay } : {}),
            ...(judge.requireToolEvidence !== undefined ? { requireToolEvidence: judge.requireToolEvidence } : {}),
            ...(judge.evidence_waived !== undefined ? { evidence_waived: judge.evidence_waived } : {}),
            ...(judge.retry !== undefined ? { retry: judge.retry } : {}),
          },
        });
      }
      const judgeFailed = judge?.verdict === 'RETURN' || judge?.pass === false;
      if ((!judgeFailed && !verifyFailed && !testsFailed && !writeGateFailed) || repairs >= maxRepairs) break;

      // Preserve the failed attempt, then repair. The FEEDBACK sections (gate/judge output + instruction) are
      // shared by both repair modes below.
      writeFileSync(resolve(runDir, `${node.id}.attempt-${repairs + 1}.out`), text, 'utf8');
      const feedback: string[] = [];
      if (judgeFailed) feedback.push('===== JUDGE VERDICT (rubric not met) =====', judge!.raw, '');
      if (verifyFailed) feedback.push('===== TYPECHECK ERRORS (files you edited no longer compile — FIX them with your edit/write tools) =====', verify!.report, '');
      if (testsFailed) feedback.push('===== TEST FAILURES (the harness ran your tests; they are RED — a judge PASS does not count while tests fail) =====', testVerify!.report, '');
      if (writeGateFailed) feedback.push('===== WRITE GATE (you described changes but called NO write tool — the worktree is UNCHANGED) =====', 'Your fenced code was NOT applied. Nothing you write as prose lands on disk. APPLY every change now by calling your write/edit tools (write_file / edit_file) for each file, then re-output your change register (what changed per file — do not paste the full file bodies).', '');
      // A concrete gate (compile/test/write) takes priority in the instruction: fix the code, don't just re-word prose.
      feedback.push(verifyFailed || testsFailed || writeGateFailed
        ? 'Use your edit tools to fix the failing code/tests above (read the file first, then make a minimal edit), then re-output your change register. Do not introduce new files or change any exported interface. The tests MUST pass — do not claim success while they are red.'
        : 'Revise to satisfy the rubric. Output ONLY the corrected deliverable.');
      // #43 CONTINUATION (founder design): prefer continuing the node's OWN conversation — it already holds the
      // pack, everything it read, and every tool call, so only the NEW feedback is sent. Falls back to the
      // fresh-pack repair prompt when the history outweighs the budget (or continuation is disabled/unavailable).
      const continueBudget = deps.continueBudgetTokens ?? 60_000;
      const historyTokens = history ? Math.ceil(JSON.stringify(history).length / 4) : Infinity;
      const canContinue = continueBudget > 0 && !!history && historyTokens <= continueBudget;
      const rgen = canContinue
        ? await generateTransient({ ...genArgs, prompt: feedback.join('\n'), messages: history }, 'repair')
        : await generateTransient({ ...genArgs, prompt: [pack.text, '', '===== YOUR PREVIOUS OUTPUT =====', text, '', ...feedback].join('\n') }, 'repair');
      history = rgen.messages ?? history;
      persistHistory();
      const rtext = (rgen.text ?? '').trim();
      if (!rtext || looksLikeLeakedToolCall(rtext)) break; // empty/leaked repair → keep the last good text, stop
      if (node.contract.schema !== undefined) {
        const c = checkOutput(rtext, node.contract.schema);
        if (!c.ok) break; // the repair broke the schema → keep the last schema-valid text, stop (advisory)
        contractValid = true;
      }
      repairs += 1;
      emit({ type: 'node_repair', stageId: stage.id, nodeId: node.id, detail: { attempt: repairs, mode: canContinue ? 'continue' : 'fresh-pack', historyTokens: history ? Math.ceil(JSON.stringify(history).length / 4) : undefined } });
      text = rtext;
    }

    // E-1: unlike the advisory gates, a write node whose deliverable STILL signals unapplied changes after
    // repairs fails HONESTLY — "done" with an empty/partial worktree diff is exactly the silent failure this
    // gate exists to kill. The .out is kept on disk (harvestable), but the node must never report clean.
    filesChanged = refreshFilesChanged() ?? filesChanged;
    writeGateFailed = writeGateShouldFail({
      writeToolNamesLength: writeToolNames.length,
      writeOps,
      text,
      filesChanged,
      toolEvents: nodeToolEvents,
    });
    const fcApiEnd = ensureWriterFilesChangedApi();
    if (writeGateFailed) {
      const reason = writeOps === 0
        ? `write gate: write-enabled node emitted code as prose but called no write tool after ${repairs} repair(s) — nothing was applied to the worktree`
        : `write gate: node's deliverable still contains unapplied tool-call/edit JSON after ${repairs} repair(s) (${writeOps} write op(s) did land — the rest was prose)`;
      emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason, detail: { writeOps, ...(fcApiEnd ? { filesChanged: fcApiEnd } : {}) } });
      return { nodeId: node.id, stageId: stage.id, status: 'failed', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded, judge, contractValid, writeOps };
    }

    // C2 (retro -154Z B2): concrete gates are HARD at completion — a node whose typecheck or tests are still
    // RED after repairs ran out is FAILED, never 'done' (the -154Z run reported done:3 with a broken tree; any
    // downstream consumer trusted broken code). The .out stays on disk — harvestable — but the status is honest.
    const testsOk = lastTests ? lastTests.ok : undefined;
    const gatesRedAtEnd = lastVerifyOk === false || testsOk === false;
    if (gatesRedAtEnd) {
      const which = [lastVerifyOk === false ? 'typecheck' : null, testsOk === false ? 'tests' : null].filter(Boolean).join(' + ');
      const reason = `gates red after ${repairs} repair(s): ${which} — output kept on disk but the node must not report clean`;
      emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason, detail: { repairs, ...(testsOk === undefined ? {} : { testsOk }), ...(writeToolNames.length ? { writeOps } : {}), ...(fcApiEnd ? { filesChanged: fcApiEnd } : {}) } });
      return { nodeId: node.id, stageId: stage.id, status: 'failed', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded, judge, contractValid, ...(testsOk === undefined ? {} : { testsOk }), ...(writeToolNames.length ? { writeOps } : {}) };
    }
    // C14 (#40 authority order): gates GREEN + judge still disputing = DONE — the compiler outranks the rubric.
    // The dispute is logged (pass_reason) so a human/retro can audit it; the judge's review stays advisory.
    const judgeDisputed = judge?.verdict === 'RETURN' || judge?.pass === false;
    if (judgeDisputed && node.contract.judge?.onReturn === 'fail-node') {
      const reason =
        judge?.reason?.trim() ||
        'judge RETURN after repairs exhausted (onReturn: fail-node) — output kept on disk';
      emit({
        type: 'node_fail',
        stageId: stage.id,
        nodeId: node.id,
        status: 'failed',
        reason,
        detail: {
          repairs,
          onReturn: 'fail-node',
          judgeDisputed: true,
          ...(judge?.zero_tool_calls !== undefined ? { zero_tool_calls: judge.zero_tool_calls } : {}),
          ...(judge?.tool_trace_status !== undefined ? { tool_trace_status: judge.tool_trace_status } : {}),
          ...(testsOk === undefined ? {} : { testsOk }),
          ...(writeToolNames.length ? { writeOps } : {}),
          ...(fcApiEnd ? { filesChanged: fcApiEnd } : {}),
        },
      });
      return {
        nodeId: node.id,
        stageId: stage.id,
        status: 'failed',
        outputPath,
        reason,
        latencyMs: Math.round(performance.now() - t0),
        degradedPack: pack.degraded,
        judge,
        contractValid,
        ...(testsOk === undefined ? {} : { testsOk }),
        ...(writeToolNames.length ? { writeOps } : {}),
      };
    }
    const verified = computeVerified({ judge, testsOk, judgeDisputed });
    // Critical-1: durable commit only after the gate path finished green — resume trusts this, not bare .out.
    writeNodeCommitted(nodeDir, {
      nodeId: node.id,
      stageId: stage.id,
      status: 'done',
      outputPath,
      contractValid: contractValid ?? null,
      repairs,
      bytes: Buffer.byteLength(text),
      runner: 'api',
      ...(fcApiEnd ? { filesChanged: fcApiEnd } : {}),
    });
    emit({
      type: 'node_finish',
      stageId: stage.id,
      nodeId: node.id,
      status: 'done',
      detail: {
        bytes: Buffer.byteLength(text),
        degradedPack: pack.degraded,
        contractValid,
        repairs,
        committed: true,
        ...(judgeDisputed ? { passReason: 'gate-convergence', judgeDisputed: true } : {}),
        ...(judge
          ? {
              verified,
              ...(judge.evidence_waived ? { evidence_waived: judge.evidence_waived } : {}),
              ...(judge.zero_tool_calls !== undefined && judge.zero_tool_calls !== null
                ? { zero_tool_calls: judge.zero_tool_calls }
                : {}),
            }
          : {}),
        ...(testsOk === undefined ? {} : { testsOk }),
        ...(writeToolNames.length ? { writeOps } : {}),
        ...(fcApiEnd ? { filesChanged: fcApiEnd } : {}),
      },
    });
    return { nodeId: node.id, stageId: stage.id, status: 'done', outputPath, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded, judge, contractValid, ...(testsOk === undefined ? {} : { testsOk }), ...(writeToolNames.length ? { writeOps } : {}) };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // Make a context-window overflow legible: it was the real reproducible failure (not the mythical seam
    // bug), and the raw provider error is cryptic. Prefix the actual cause + levers; keep the raw for detail.
    const hint = contextOverflowHint(raw);
    const reason = hint ? `${hint} (provider: ${raw})` : raw;
    emit({ type: 'node_fail', stageId: stage.id, nodeId: node.id, status: 'failed', reason });
    return { nodeId: node.id, stageId: stage.id, status: 'failed', outputPath, reason, latencyMs: Math.round(performance.now() - t0), degradedPack: pack.degraded };
  }
}

/** F6a: build an admission gate that backs off while the box's queue is deep. `poll` returns the box's
 *  num_requests_waiting (or null if metrics are unreachable → DEGRADE: admit immediately, static behavior).
 *  Bounded by maxPolls so it never hangs. Injectable sleep keeps it unit-testable. This is E4's "feed
 *  steadily, don't dump": 120 simultaneous arrivals queue; a steadily-fed stage never does. */
export function makeAdmit(opts: {
  poll: () => Promise<number | null>;
  waitingMax: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
  sleepMs?: number;
}): () => Promise<void> {
  const maxPolls = opts.maxPolls ?? 20;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sleepMs = opts.sleepMs ?? 500;
  return async () => {
    for (let i = 0; i < maxPolls; i++) {
      const waiting = await opts.poll();
      if (waiting === null) return;            // metrics unreachable → degrade to the static pool
      if (waiting <= opts.waitingMax) return;  // queue has room → admit
      await sleep(sleepMs);                    // queue is deep → back off, then re-check
    }
    // Bounded: after maxPolls we admit anyway rather than stall the whole run indefinitely.
  };
}

/** F5: write the human-gate review file. Lists the run's succeeded outputs so far (what the operator reviews
 *  before approving the gated stage) — never blocks on the model; it is just a checkpoint artifact. */
function writeGatePending(runDir: string, stage: Stage, succeeded: Set<string>, outcomes: NodeOutcome[]): void {
  const upstream = outcomes
    .filter((o) => o.status === 'done' && succeeded.has(o.nodeId))
    .map((o) => `  - ${o.nodeId} → ${o.outputPath}`);
  const body = [
    `GATE: ${stage.id} — ${stage.title}`,
    `This stage is human-gated. Review the upstream outputs below, then approve:`,
    `  pnpm fleet gate <runId> ${stage.id} --approve`,
    `and continue with:  pnpm fleet run <plan> --resume <runId>`,
    `  (or re-attempt failures/disputes:  pnpm fleet run <plan> --rerun-failed <runId>)`,
    ``,
    `Upstream outputs produced so far (in ${runDir}):`,
    ...(upstream.length ? upstream : ['  (none)']),
    ``,
  ].join('\n');
  writeFileSync(resolve(runDir, `GATE-${stage.id}.pending`), body, 'utf8');
}

/** The node's system prompt: the frozen fleet framing PLUS the persona's expert framing. The base is kept
 *  byte-identical (the cacheable prefix head, F1); the persona `systemAppend` rides AFTER it, so nodes sharing
 *  a persona still share the whole system prefix and only differ across personas (a small, worthwhile cache
 *  cost for real role specialization). Until 2026-07-07 the persona append was DEAD — every node, reviewer or
 *  implementer alike, got only the generic base; wiring it is what makes a "security-auditor" actually hunt
 *  exploits and a "reviewer" actually look for symbol-grounded fixes. */
function nodeSystem(node: Node): string {
  const base = [
    'You are one node in a staged fleet run. Complete YOUR task using ONLY the upstream inputs provided',
    'in the context (do not assume access to anything not shown). Produce the complete deliverable as your',
    'full response, shaped to the output contract. Be concrete and usable — not a plan to do it.',
  ].join('\n');
  // Resolve the profile from agent.preset / agent.persona / agent.seat — the catalog and the persona
  // registry share one lookup (resolveProfile), so a named catalog agent gets its mission prompt here too.
  const profile = resolveProfile(node.agent);
  return profile?.systemAppend ? `${base}\n\nYOUR ROLE (${profile.id}): ${profile.systemAppend}` : base;
}

/** Ground-truth context the judge sees ALONGSIDE the deliverable, so it verifies claims instead of grading a
 *  self-report. Until 2026-07-07 the judge got ONLY rubric + output — a node's own marketing copy — which is
 *  why it kept passing empty synthesis and no-write nodes at 1.0 (the founder caught this in the OpenRouter
 *  activity view: a 452-token judge prompt with no task, no evidence, no files). */
export interface JudgeContext {
  /** The task this node was assigned — the judge needs it to know what "good" means here. */
  task?: string;
  /**
   * Every tool event the node made — the evidence a "I wrote X" claim is cross-checked against.
   * `undefined` = tool channel unavailable (CLI product JSON had no tool frames).
   * `[]` = known empty.
   */
  toolEvents?: ToolEvent[];
  /** How many write-tool calls landed (0 for a claimed-writer = fabrication signal). */
  writeOps?: number;
  /** Did this node HOLD write tools (a writer)? Distinguishes "0 writes, was supposed to" from "read-only". */
  isWriter?: boolean;
  /** Current on-disk content of the files the node wrote — the true ground truth for a write-run's judge. */
  writtenFiles?: Array<{ path: string; content: string; truncated: boolean }>;
  /** Gate results (tsc/tests report text) — GROUND TRUTH shown to the judge so it never grades blind (#40). */
  gateReport?: string;
  /** Retro-of-wave-4 B2: the node's OWN run_tests invocations, harness-recorded (path + pass/fail + ms).
   *  Without this the judge only sees SELF-REPORTED test results for unit-scoped stages (test gate deferred
   *  to the barrier) — a node that saw red and claimed green would pass. Empty array = the hook is wired and
   *  the node ran nothing (itself a signal for a test-porting writer). */
  testRuns?: { path: string; passed: boolean; ms: number }[];
  onCall?: (trace: CallTrace) => void;
  /** dec-judge-seam: gates currently RED (forces overlay RETURN). */
  gatesRed?: boolean;
  /** dec-judge-seam: when true, ACCEPT needs tool evidence / EVIDENCE cites. */
  requireToolEvidence?: boolean;
  /** Remaining repair budget after this attempt — overlay RETURN skips the model when > 0. */
  repairsRemaining?: number;
  /** Provenance label for the judge generate backend. */
  backend?: string;
  /**
   * How many tools this node was ARMED with. `0` waives the tool-evidence demand (see `evidenceWaiver` —
   * the sim path arms none, so demanding a tool call is unsatisfiable); `undefined` means the caller does
   * not know its own belt and waives nothing.
   */
  toolsArmed?: number;
  /** Tree-level write evidence under the node root (before/after porcelain). */
  filesChanged?: FilesChangedFact;
}

/** Compact human-readable summary of the tool calls a node made, grouped by tool with the salient args. */
export function summarizeToolEvents(events: ToolEvent[]): string {
  if (!events.length) return '(no tool calls were made)';
  const byName = new Map<string, string[]>();
  for (const e of events) {
    const args = byName.get(e.name) ?? [];
    if (e.arg && !args.includes(e.arg)) args.push(e.arg);
    byName.set(e.name, args);
  }
  return [...byName.entries()]
    .map(([name, args]) => {
      const count = events.filter((e) => e.name === name).length;
      // C9 (retro -154Z B3): the old cap of 8 made the judge treat 8 of 29 paths as the exhaustive set and
      // fail honest work as "fabricated". List up to 50; past that, say EXPLICITLY that the list is truncated.
      const shown = args.slice(0, 50);
      const more = args.length - shown.length;
      const argList = shown.map((a) => `"${a}"`).join(', ');
      const tail = more > 0 ? ` … +${more} more distinct args (list truncated — the ×${count} count is authoritative)` : '';
      return `  • ${name} ×${count}${argList ? ` → ${argList}` : ''}${tail}`;
    })
    .join('\n');
}

/** Read the current on-disk content of the distinct files a node wrote (bounded — cost-aware). Ground truth
 *  for a write-run's judge: the ACTUAL change, not the node's description of it. */
export function readWrittenFiles(
  sandboxRoot: string,
  events: ToolEvent[],
  opts: { maxFiles?: number; maxChars?: number } = {},
): Array<{ path: string; content: string; truncated: boolean }> {
  const maxFiles = opts.maxFiles ?? 4;
  const maxChars = opts.maxChars ?? 8_000;
  const paths: string[] = [];
  for (const e of events) {
    if (WRITE_TOOL_NAMES.includes(e.name) && e.arg && !paths.includes(e.arg)) paths.push(e.arg);
  }
  const out: Array<{ path: string; content: string; truncated: boolean }> = [];
  for (const p of paths.slice(0, maxFiles)) {
    try {
      const abs = resolve(sandboxRoot, p);
      const rel = relative(resolve(sandboxRoot), abs);
      if (rel.startsWith('..') || isAbsolute(rel)) continue; // never escape the sandbox to read
      const raw = readFileSync(abs, 'utf8');
      out.push({ path: p, content: raw.slice(0, maxChars), truncated: raw.length > maxChars });
    } catch { /* a file that can't be read (deleted/moved) is simply omitted — the evidence list still shows the op */ }
  }
  return out;
}

/**
 * Resolve which generate fn + provenance label scores this judge call.
 * Order: injected judgeSeam/judgeGenerate (with per-node runner override) → deps.generate fallback (tests/sim).
 * Does NOT spawn a CLI when no judge seam was injected — keeps unit tests $0 and hermetic.
 */
export function resolveJudgeGenerate(
  spec: JudgeSpec,
  deps: RunDeps,
): { generate: CouncilGenerate; backend: string; kind: JudgeSeamKind | 'generate' } {
  const env = deps.judgeSeamEnv ?? process.env;
  const kind = resolveJudgeSeamKind({
    runner: spec.runner,
    judgeSeamEnv: env.OPUSED_JUDGE_SEAM,
    seatSeamEnv: env.OPUSED_SEAM,
  });

  // Per-node runner override against an injected default seam → build a different seam when kinds differ.
  if (deps.judgeSeam) {
    if (!spec.runner || spec.runner === deps.judgeSeam.kind) {
      return { generate: deps.judgeSeam.generate, backend: deps.judgeSeam.label, kind: deps.judgeSeam.kind };
    }
    const seam = createJudgeSeam(spec.runner as JudgeSeamKind, env, {
      ...(deps.judgeSpawn ? { spawn: deps.judgeSpawn } : {}),
      ...(spec.model ? { model: spec.model } : {}),
    });
    return { generate: seam.generate, backend: seam.label, kind: seam.kind };
  }

  if (deps.judgeGenerate) {
    const backend = deps.judgeSeamLabel ?? kind;
    return { generate: deps.judgeGenerate, backend, kind };
  }

  // Tests / sim / older callers: seat generate doubles as judge generate.
  return { generate: deps.generate, backend: 'generate', kind: 'generate' };
}

/** Tightened re-ask when the first judge reply has no parseable VERDICT line (retry-once, fail-closed). */
const JUDGE_RETRY_PARSE_INSTRUCTION = [
  'Your previous reply had no parseable VERDICT line. Reply again with EXACTLY one final line, verbatim,',
  'on its own line, with NO markdown decoration (no bold, no headings, no bullets):',
  '  VERDICT: ACCEPT',
  '  VERDICT: RETURN — <one specific defect a repair pass can act on>',
  'That VERDICT line is mandatory. No SCORE. No other decoration on the verdict line.',
].join('\n');

/** Run the judge through the model seam and RECORD a binary verdict (dec-246: ACCEPT or RETURN + reason).
 *  Gate marks, never deletes. The judge sees GROUND TRUTH (task + tool evidence + written files + tests),
 *  not just the deliverable. Accept path uses `verdict` only — score/threshold are never compared.
 *  dec-judge-seam: deterministic overlay runs BEFORE the model; overlay RETURN + repairs remaining skips the model.
 *  L1: `ctx.onCall` threads the node's turn sink so judge calls land as turn records too.
 *  JUDGE-RECOMMENDATION-2026-08-04: retry-once on unparseable envelope; harness-lost tool trace degrades
 *  (tool_trace_status:'lost', overlay:'degraded-trace-lost') — never forces RETURN. */
async function runJudge(spec: JudgeSpec, output: string, model: string, deps: RunDeps, ctx: JudgeContext = {}): Promise<JudgeVerdict> {
  const isWriter = ctx.isWriter === true;
  const requireToolEvidence = ctx.requireToolEvidence ?? isWriter;
  const resolvedTrace = resolveToolTraceStatus(ctx.toolEvents);
  // Harness lost the channel → journal `lost` (degrade stamp); internal resolve stays `unavailable`.
  const traceLost = resolvedTrace === 'unavailable';
  const toolTraceStatus: ToolTraceStatus = traceLost ? 'lost' : resolvedTrace;
  const toolEventCount = ctx.toolEvents === undefined ? null : ctx.toolEvents.length;
  const zeroTools = zeroToolCalls(resolvedTrace, toolEventCount);
  const writeOps = ctx.writeOps ?? countWriteOps(ctx.toolEvents);
  const { generate: judgeGenerate, backend: resolvedBackend } = resolveJudgeGenerate(spec, deps);
  // ctx.backend is a rare test override; live path records the seam label.
  const backend = ctx.backend ?? resolvedBackend;

  // A node armed with zero tools cannot be asked for a tool call — see evidenceWaiver() for the sim scar.
  const evidence_waived = evidenceWaiver(ctx.toolsArmed);

  const baseFields = {
    rubric: spec.rubric,
    threshold: spec.threshold ?? null,
    backend,
    zero_tool_calls: zeroTools,
    tool_event_count: toolEventCount,
    tool_trace_status: toolTraceStatus,
    requireToolEvidence,
    ...(evidence_waived ? { evidence_waived } : {}),
  } as const;

  // Overlay uses resolvedTrace (unavailable) so write-fabrication skips when channel is lost.
  const overlayHit = applyJudgeOverlay({
    toolTraceStatus: resolvedTrace,
    toolEventCount,
    writeOps,
    isWriter,
    gatesRed: ctx.gatesRed === true,
    requireToolEvidence,
    text: output,
    evidenceWaived: evidence_waived,
    ...(ctx.filesChanged ? { filesChanged: ctx.filesChanged } : {}),
    ...(ctx.toolEvents ? { toolEvents: ctx.toolEvents } : {}),
  });

  const repairsRemaining = ctx.repairsRemaining ?? 0;
  // Overlay RETURN with repairs left → deterministic feedback only (save spend).
  if (overlayHit && repairsRemaining > 0) {
    const raw = `VERDICT: RETURN — ${overlayHit.forceReturn}`;
    return {
      ...baseFields,
      raw,
      verdict: 'RETURN',
      reason: overlayHit.forceReturn,
      score: null,
      pass: false,
      evidence_cited: [],
      overlay: overlayHit.overlay,
    };
  }

  const system = [
    'You are a quality REVIEWER. Assess the CANDIDATE OUTPUT against the RUBRIC — for the TASK given.',
    'You have NO tools and must NOT attempt any tool call — every fact you may cite is already inline in',
    'this prompt (TASK, RUBRIC, WORK EVIDENCE, WRITTEN FILES, GATE RESULTS, CANDIDATE OUTPUT). Answer',
    'immediately from this material; a tool attempt burns the review budget and is a judge failure.',
    'CRITICAL: the CANDIDATE OUTPUT is the node\'s OWN self-report. Treat its claims as UNVERIFIED. Cross-check',
    'them against THE TASK, the WORK EVIDENCE (the tool calls it actually made), and any WRITTEN FILES shown.',
    'If the output claims changes/writes/findings that the evidence does NOT corroborate, RETURN it — a confident',
    'register with no supporting evidence is not acceptable.',
    'AUTHORITY ORDER: if GATE RESULTS (compiler/tests — ground truth) are shown and GREEN, judge the OUTCOME —',
    'do NOT RETURN the node on purely procedural grounds (which tool it used, report formatting). If gates are',
    'RED, that outranks any claim of success — RETURN naming the red gate. In the WORK EVIDENCE, ×N counts are',
    'authoritative; arg lists may be truncated — never treat a truncated list as proof that work beyond it did not happen.',
    'BINDING: a truncated arg list is a LOGGING artifact, never a finding. When on-disk content, gate results,',
    'or the ×N counts corroborate a claim, you MUST NOT RETURN for truncation or call the claim "unverifiable".',
    'RETURN only for defects in the WORK itself.',
    'Reply with: "REVIEW:" then 2-6 short bullets — what is RIGHT, then what CAN BE IMPROVED (each grounded in',
    'evidence you can see). Then optional "EVIDENCE:" with short cites (tool names, file:line, gate). Then EXACTLY',
    'one final line, one of:',
    '  VERDICT: ACCEPT',
    '  VERDICT: RETURN — <one specific defect a repair pass can act on>',
    'No SCORE. No numbers. A RETURN without a concrete named defect is invalid.',
  ].join('\n');
  const parts: string[] = [];
  if (ctx.task) parts.push('===== THE TASK THIS NODE WAS ASSIGNED =====', ctx.task, '');
  parts.push('===== RUBRIC =====', spec.rubric, '');
  // Work evidence: what the node actually DID (the anti-fabrication signal).
  const ev: string[] = [];
  ev.push(`tool_trace_status: ${toolTraceStatus}`);
  ev.push(`zero_tool_calls: ${zeroTools === null ? 'unknown' : zeroTools ? 'true' : 'false'}`);
  // Without this line the model judge simply re-derives the RETURN the overlay just stopped forcing —
  // it would read "zero tool calls" as fabrication with no way to know the node held nothing to call.
  if (evidence_waived === 'no-tools-armed') {
    ev.push(
      'This node was armed with ZERO tools, so zero tool calls is EXPECTED and is NOT a defect. Judge the',
      'CONTENT against the rubric. Do NOT RETURN it for missing tool evidence, missing EVIDENCE cites, or',
      'unverifiable claims-in-principle; DO still RETURN it if the content itself contradicts its inputs.',
    );
  }
  if (ctx.isWriter) {
    ev.push(`This node HELD write tools. Write-tool calls that landed: ${writeOps}.`);
    if (ctx.filesChanged) {
      if (ctx.filesChanged.known) {
        const paths = ctx.filesChanged.filesChanged.length
          ? ctx.filesChanged.filesChanged.join(', ')
          : '(none — node root porcelain unchanged)';
        ev.push(`filesChanged (tree): ${paths}`);
      } else {
        ev.push(
          `filesChanged (tree): UNKNOWN (${ctx.filesChanged.reason}) — do not treat writeOps as proof of landing`,
        );
      }
    }
    if (
      writeOps === 0 &&
      !traceLost &&
      !treeWorkLanded(ctx.filesChanged, output, ctx.toolEvents)
    ) {
      ev.push('⚠ ZERO writes — if the output claims it changed files, that claim is UNSUPPORTED.');
    }
    if (traceLost) {
      ev.push('⚠ Tool trace LOST (harness) — do not invent zero-tool fabrication; judge on content + gates only.');
    }
  }
  if (traceLost) {
    ev.push('Tool calls made: (tool trace lost — product stdout had no parseable tool channel; judge on content alone)');
  } else {
    ev.push('Tool calls made:', summarizeToolEvents(ctx.toolEvents ?? []));
  }
  parts.push('===== WORK EVIDENCE (what the node actually did) =====', ev.join('\n'), '');
  if (ctx.writtenFiles?.length) {
    parts.push('===== WRITTEN FILES (current on-disk content — the real change) =====');
    for (const f of ctx.writtenFiles) {
      parts.push(`--- ${f.path}${f.truncated ? ' (truncated)' : ''} ---`, f.content, '');
    }
  }
  if (ctx.testRuns) {
    const lines = ctx.testRuns.length
      ? ctx.testRuns.map((t) => `${t.passed ? 'PASS' : 'FAIL'} ${t.path} (${t.ms}ms)`)
      : [ctx.isWriter
          ? 'This node invoked run_tests ZERO times — any "tests green/passing" claim in its output is SELF-REPORTED and UNSUPPORTED.'
          : '(no run_tests invocations)'];
    parts.push('===== NODE-INVOKED run_tests RESULTS (harness-recorded — GROUND TRUTH for test claims) =====', lines.join('\n'), '');
  }
  if (ctx.gateReport) {
    parts.push('===== GATE RESULTS (compiler/tests — GROUND TRUTH, outranks all prose) =====', ctx.gateReport, '');
  }
  parts.push('===== CANDIDATE OUTPUT (the node\'s self-report — verify against the above) =====', output);
  const prompt = parts.join('\n');
  const genOpts = {
    model,
    maxOutputTokens: JUDGE_MAX_TOKENS,
    ...(ctx.onCall ? { onCall: ctx.onCall } : {}),
  };

  let raw = '';
  let retry: number | undefined;
  try {
    const out = await judgeGenerate({ ...genOpts, system, prompt });
    raw = (out.text ?? '').trim();
  } catch (e) {
    raw = `judge error: ${e instanceof Error ? e.message : String(e)}`;
  }
  let parsed = parseJudgeVerdict(raw);

  // Retry-once on unparseable envelope (empty/no VERDICT line) before fail-closed RETURN.
  if (parsed.verdict === null) {
    retry = 1;
    const retrySystem = [system, '', JUDGE_RETRY_PARSE_INSTRUCTION].join('\n');
    const retryPrompt = [
      prompt,
      '',
      '===== PARSE RETRY (previous reply unparseable) =====',
      JUDGE_RETRY_PARSE_INSTRUCTION,
    ].join('\n');
    try {
      const out = await judgeGenerate({ ...genOpts, system: retrySystem, prompt: retryPrompt });
      raw = (out.text ?? '').trim();
    } catch (e) {
      raw = `judge error: ${e instanceof Error ? e.message : String(e)}`;
    }
    parsed = parseJudgeVerdict(raw);
  }

  let verdict = parsed.verdict;
  let reason = parsed.reason;
  // Default overlay: none, or degrade stamp when harness lost the tool channel.
  let overlay: JudgeOverlayKind = overlayHit?.overlay ?? (traceLost ? 'degraded-trace-lost' : 'none');
  // RETURN without a usable reason is not a valid repair signal — force a concrete fallback naming the gap.
  if (verdict === 'RETURN' && !reason) {
    reason = 'judge emitted RETURN without naming a specific defect a repair pass can act on';
  }
  // Still unparseable after retry — force RETURN so a repair (or a human) can act (fail-closed).
  if (verdict === null) {
    verdict = 'RETURN';
    reason = 'judge reply had no VERDICT: ACCEPT/RETURN line — unparseable as a binary verdict';
  }
  // Overlay wins over a soft model ACCEPT (zero-tools / gates-red / write-fabrication only).
  if (overlayHit && verdict === 'ACCEPT') {
    verdict = 'RETURN';
    reason = overlayHit.forceReturn;
    overlay = overlayHit.overlay;
  }
  // requireToolEvidence: model ACCEPT must include EVIDENCE cites.
  const missingEv = acceptNeedsEvidence({ requireToolEvidence, verdict, raw, evidenceWaived: evidence_waived });
  if (missingEv) {
    verdict = 'RETURN';
    reason = missingEv;
    overlay = 'missing-evidence';
  }
  // Observability only — never compared for accept (dec-246).
  const score = parseJudgeScore(raw);
  const threshold = spec.threshold ?? null;
  const pass: boolean = verdict === 'ACCEPT';
  const evidence_cited = parseEvidenceCited(raw);
  return {
    ...baseFields,
    raw,
    verdict,
    reason: verdict === 'RETURN' ? reason : null,
    score,
    pass,
    evidence_cited,
    overlay,
    ...(retry !== undefined ? { retry } : {}),
  };
}
