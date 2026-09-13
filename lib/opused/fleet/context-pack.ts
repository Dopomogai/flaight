// @purpose: buildContextPack — assemble EXACTLY the upstream outputs a node consumes into one prompt-ready pack
// @why: The scoped-context rule (docs/architecture/PLAN-fleet-program-2026-07.md §F0.3): "each agent gets a
//       scoped context pack (its contract + only the upstream outputs it consumes), not the whole world — 500
//       agents sharing one giant context is how fleets produce mush." A node NEVER sees an output it did not
//       consume. A hard char budget (OPUSED_PACK_BUDGET) truncates per-consumed-file with an explicit note —
//       never a silent drop (an operator must be able to see that a file was cut). Char-budgeted (not token)
//       because the pack is read off disk char-by-char; ~4 chars/token (tokens.ts) if you want the token view.
// @role: safety-critical
// @stability: experimental

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FleetPlan, Node, InjectEntry } from './plan';
import { indexPlan, resolveConsumedNodeIds, renderTaskPrompt, injectPath, injectOptional } from './plan';
import { withinRoot } from '../tools/local';

/** Default hard budget for the CONSUMED-OUTPUT block (all `consumes` outputs, split across them). Raised
 *  24k → 240k (2026-07-07 founder directive): 24k was tuned for small-context APIs and starved wide
 *  tree-combines — a 26-way combiner saw each rich upstream review truncated to ~928 chars (the R1 self-bug).
 *  On the 262k-ctx box, consumed deliverables deserve the SAME generosity as injected files (inject is 240k):
 *  a combiner should see its inputs whole, not stubs. ~240k chars ≈ ~60k tokens. Overridable via env. */
export const DEFAULT_PACK_BUDGET_CHARS = 240_000;

/** Default budget for the STAGE-SHARED prefix block (rendered identically for every node in the stage). Raised
 *  12k → 96k to match: a stage that sharedConsumes many upstreams (retro's 162 node.json, wide combines) must
 *  see them substantially, and this block is the cacheable prefix so the cost is paid once per stage. */
export const DEFAULT_SHARED_BUDGET_CHARS = 96_000;

/** Default budget for INJECTED source files (inject/sharedInject), separate from the upstream-output budgets
 *  and deliberately GENEROUS (~240k chars ≈ ~60k tokens): the founder directive is inject-not-search — the
 *  agent should START with the real files rather than spend tool calls re-reading its own target. The box
 *  serves 262k ctx and Gemma E1 proved bundle size is bounded by prefill, not KV. Overridable via env. */
export const DEFAULT_INJECT_BUDGET_CHARS = 240_000;

/** Per-input FLOOR (chars) when a budget is split across many inputs. Without it, a WIDE tree-combine that
 *  fans in K children does `floor(budget/K)` and starves each to near-nothing — the R1 tier-4 combiner saw
 *  each rich per-file review truncated to ~928 chars, so the combine had almost nothing to merge (R1's own
 *  self-bug). With a floor, each input keeps at least this many chars even if the total then exceeds the soft
 *  budget — correctness over a budget tuned for small-context APIs.
 *  DEFAULT 0 (strict even-split, preserving the small-context contract). The fleet runner turns it ON for
 *  self-hosted big-context boxes (fleet.ts sets OPUSED_MIN_INPUT_CHARS when OPUSED_BASE_URL is present — the
 *  262k-ctx box can afford the overrun; an OpenRouter run cannot). Env: OPUSED_MIN_INPUT_CHARS. */
export const DEFAULT_MIN_INPUT_CHARS = 0;

/** Recommended floor for a self-hosted big-context box (~1.5k tokens/input) — enough that a wide combiner
 *  sees each upstream review substantially, not a 900-char stub. fleet.ts applies this on self-hosted runs. */
export const SELF_HOSTED_MIN_INPUT_CHARS = 6_000;

/** The marker that ends the byte-identical shared prefix — everything before it is stage-wide + cacheable. */
export const CONTRACT_MARKER = '===== OUTPUT CONTRACT =====';

/** One consumed upstream output, as it landed in the pack. `truncatedFrom` is set iff it was cut. */
export interface PackedInput {
  nodeId: string;
  outputPath: string;
  content: string;
  bytes: number;          // chars actually included
  truncatedFrom?: number; // original char count when it was truncated (else undefined)
  missing?: boolean;      // the upstream output file did not exist / could not be read
  /** Inject-only: true when plan marked this path optional:true. Absent/false = required. */
  optional?: boolean;
}

/**
 * True when `relPath` names a file under the harness per-node run tree
 * (`runs/<runId>/nodes/<nodeId>/…`), not a sandbox/context-root source file.
 *
 * Capture writer and L1 logs both use that tree (browser-capture-writer
 * `rel('nodes', nodeId, 'capture')`; run.ts nodes/<id>/pack.txt). Inject
 * packing resolves against sandboxRoot only, so these paths are routinely
 * missing at pack time even when a prior node will (or did) write them under
 * runDir — hard-failing them is a false positive on M1 (d7917e50).
 *
 * Fail closed: only the `nodes/` tree prefix counts. `..`, absolute paths,
 * and every other relative path remain source injects (hard-fail if missing).
 *
 * Residual (accepted): the entire `nodes/**` path class softs when missing,
 * including never-producible shapes (e.g. nodes/lib/config.ts). That is the
 * cost of path-shape classification without a typed artifact flag on PackedInput.
 * Pin it in tests; do not pretend only harvest paths soft.
 */
export function isRunTreeArtifactPath(relPath: string): boolean {
  let normalized = relPath.replace(/\\/g, '/');
  // Stress Defect 3: single /^\.\// strip left '././nodes/…' hard-failing (false red).
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) {
    return false;
  }
  return normalized === 'nodes' || normalized.startsWith('nodes/');
}

/**
 * Paths of REQUIRED injects that are missing (out-of-root, unreadable, or no rootDir).
 * Truncation alone never appears here.
 * Intra-run artifact injects under `nodes/<id>/…` are excluded — soft missing +
 * degraded only (restore pre-d7917e50 degrade reach for same-run harvest paths).
 *
 * Env: OPUSED_ALLOW_MISSING_INJECT=1 silences ONLY mode==='dry' (false-red FR-D2).
 * Live is never silenced by env — use per-inject optional:true for intentional absence.
 */
export function missingRequiredInjectPaths(
  pack: Pick<ContextPack, 'sharedInjected' | 'injected'>,
  env?: Record<string, string | undefined>,
  mode: 'dry' | 'live' = 'dry',
): string[] {
  if (mode === 'dry' && env?.OPUSED_ALLOW_MISSING_INJECT === '1') return [];
  return [...pack.sharedInjected, ...pack.injected]
    .filter(
      (i) =>
        i.missing &&
        !i.optional &&
        !isRunTreeArtifactPath(i.outputPath),
    )
    .map((i) => i.outputPath);
}

/** The assembled pack: the prompt-ready text plus the structured record of what went in (for the run log). */
export interface ContextPack {
  nodeId: string;
  /** The full prompt-ready string. Order (F1): stage-shared prefix (injected files + shared outputs) →
   *  output contract → node-injected files → node-specific inputs → the node's task (unique tail).
   *  Everything before CONTRACT_MARKER is byte-identical across stage-mates. */
  text: string;
  /** Stage-shared inputs (from stage.sharedConsumes) — rendered first, identically for every node in the stage. */
  shared: PackedInput[];
  /** Stage-shared INJECTED source files (stage.sharedInject) — part of the byte-identical prefix. */
  sharedInjected: PackedInput[];
  /** This node's OWN injected source files (node.inject) — the real material, in-context from the start. */
  injected: PackedInput[];
  /** This node's OWN consumed outputs (node.consumes minus anything already stage-shared). */
  inputs: PackedInput[];
  /** True if ANY shared/injected/node input was truncated OR missing (never silent). */
  degraded: boolean;
  totalChars: number;
  /** Length of the byte-identical stage-shared prefix (chars before CONTRACT_MARKER) — the cacheable span. */
  sharedChars: number;
}

/** Read a node's output file relative to outputsDir. Never throws — a missing/unreadable file is reported. */
function readOutput(outputsDir: string, outputPath: string): { content: string; missing: boolean } {
  try {
    return { content: readFileSync(resolve(outputsDir, outputPath), 'utf8'), missing: false };
  } catch {
    return { content: '', missing: true };
  }
}

/**
 * Assemble the context pack for one node: its task prompt + output contract, then ONLY the outputs it
 * consumes (each fenced, in consume order). The budget is split evenly across the consumed files; a file
 * over its slice is truncated with an inline note stating how much was cut (no silent drops). A consumed
 * output whose file is missing is recorded (missing:true) and noted in the text — the caller decides
 * whether that is a fatal skip (run.ts treats a missing REQUIRED consume as a fail-forward skip).
 */
export function buildContextPack(
  plan: FleetPlan,
  nodeId: string,
  outputsDir: string,
  opts: {
    budgetChars?: number;
    sharedBudgetChars?: number;
    injectBudgetChars?: number;
    /** Sandbox root that inject/sharedInject paths resolve against (the runner's --root). Injection without
     *  a root records every injected file as missing — never a silent skip, never an unsandboxed read. */
    rootDir?: string;
    env?: Record<string, string | undefined>;
    /** The run this node belongs to. Rendered at the top of the pack so a node that reads the run directory
     *  off disk knows WHICH directory is its own — see the RUN IDENTITY note in renderPackText. Optional so
     *  every existing caller and test keeps working; absent simply omits the section. */
    run?: { runId: string; runDir: string };
  } = {},
): ContextPack {
  const idx = indexPlan(plan);
  const found = idx.get(nodeId);
  if (!found) throw new Error(`buildContextPack: unknown node "${nodeId}"`);
  const node: Node = found.node;
  const stage = plan.stages[found.stageIndex];

  const budget =
    opts.budgetChars ?? (Number(opts.env?.OPUSED_PACK_BUDGET) || DEFAULT_PACK_BUDGET_CHARS);
  const sharedBudget =
    opts.sharedBudgetChars ?? (Number(opts.env?.OPUSED_SHARED_BUDGET) || DEFAULT_SHARED_BUDGET_CHARS);
  const injectBudget =
    opts.injectBudgetChars ?? (Number(opts.env?.OPUSED_INJECT_BUDGET) || DEFAULT_INJECT_BUDGET_CHARS);
  // Per-input floor so a wide fan-in never starves each input (the R1 combiner self-bug). `?? ` not `||` so
  // an explicit 0 (strict even-split) is honored; only unset falls back to the default.
  const minInputChars = opts.env?.OPUSED_MIN_INPUT_CHARS != null
    ? Number(opts.env.OPUSED_MIN_INPUT_CHARS) : DEFAULT_MIN_INPUT_CHARS;

  // Stage-shared ids (rendered FIRST, identically for every node in the stage → the cacheable prefix).
  const sharedNodeIds = expandRefs(plan, stage.sharedConsumes ?? []);
  const sharedSet = new Set(sharedNodeIds);

  // Node-specific ids = this node's own consumes MINUS anything already stage-shared (no double-render;
  // parsePlan also rejects a node that lists a shared ref, so this is belt-and-suspenders).
  const consumedNodeIds = expandRefs(plan, node.consumes).filter((nid) => !sharedSet.has(nid));

  // Each block splits ITS OWN budget evenly across its files. The shared block is budgeted at the STAGE level
  // (fixed sharedBudget, same file set) → every node in the stage renders byte-identical shared bytes.
  const shared = packInputs(idx, outputsDir, sharedNodeIds, sharedBudget, minInputChars);
  const inputs = packInputs(idx, outputsDir, consumedNodeIds, budget, minInputChars);

  // INJECT-not-search: real source files rendered whole. Stage-shared injects live in the cacheable prefix
  // (byte-identical across stage-mates); node injects come right after the contract. Each block splits the
  // inject budget across its own files. No double-render: a node inject already stage-injected is dropped.
  const sharedEntries: InjectEntry[] = stage.sharedInject ?? [];
  const sharedPaths = sharedEntries.map(injectPath);
  const sharedInjectSet = new Set(sharedPaths);
  const optionalByPath = new Map<string, boolean>();
  for (const e of sharedEntries) optionalByPath.set(injectPath(e), injectOptional(e));
  for (const e of node.inject ?? []) {
    const p = injectPath(e);
    if (!sharedInjectSet.has(p)) {
      optionalByPath.set(p, injectOptional(e) || optionalByPath.get(p) === true);
    }
  }
  const nodePaths = (node.inject ?? [])
    .map(injectPath)
    .filter((p) => !sharedInjectSet.has(p));

  // NOTE: no per-input floor on INJECTS. The floor protects wide CONSUMES (a combiner's ~26 inputs) from
  // even-split starvation, but a wide INJECT (retro sharedInjects 171 node.json) × a 6k floor = ~1M chars =
  // context overflow. Injects even-split their already-generous 240k budget instead. (Found by the 3-run retro.)
  const sharedInjected = packFiles(opts.rootDir, sharedPaths, injectBudget).map((inp) => ({
    ...inp,
    optional: optionalByPath.get(inp.outputPath) === true,
  }));
  const injected = packFiles(opts.rootDir, nodePaths, injectBudget).map((inp) => ({
    ...inp,
    optional: optionalByPath.get(inp.outputPath) === true,
  }));

  const degraded = [...shared, ...sharedInjected, ...injected, ...inputs].some(
    (i) => i.truncatedFrom !== undefined || i.missing,
  );
  const text = renderPackText(node, shared, sharedInjected, injected, inputs, opts.run);
  const contractAt = text.indexOf(CONTRACT_MARKER);
  return {
    nodeId, text, shared, sharedInjected, injected, inputs, degraded,
    totalChars: text.length, sharedChars: contractAt < 0 ? 0 : contractAt,
  };
}

/** Expand a list of consumes/sharedConsumes refs → concrete upstream node ids, de-duped in first-seen order. */
function expandRefs(plan: FleetPlan, refs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    for (const nid of resolveConsumedNodeIds(plan, ref)) {
      if (!seen.has(nid)) { seen.add(nid); out.push(nid); }
    }
  }
  return out;
}

/** Read + budget-truncate INJECTED source files (paths relative to rootDir) into PackedInputs. Budget splits
 *  evenly across the files. Sandbox rule mirrors the local tools: a path escaping rootDir is recorded missing
 *  (never read); no rootDir at all → every file missing (explicit, so --dry surfaces the wiring gap). */
/** Even-split of `budget` across `count` inputs, but never below `floor` chars each (wide fan-in must not
 *  starve its inputs — see DEFAULT_MIN_INPUT_CHARS). count<=0 → whole budget. */
function perInputChars(budget: number, count: number, floor: number): number {
  if (count <= 0) return budget;
  return Math.max(floor, Math.floor(budget / count));
}

function packFiles(rootDir: string | undefined, paths: string[], budget: number, floor = 0): PackedInput[] {
  const perFile = perInputChars(budget, paths.length, floor);
  const out: PackedInput[] = [];
  for (const path of paths) {
    if (!rootDir) {
      out.push({ nodeId: 'inject', outputPath: path, content: '', bytes: 0, missing: true });
      continue;
    }
    const root = resolve(rootDir);
    const abs = resolve(root, path);
    if (!withinRoot(root, abs)) {
      out.push({ nodeId: 'inject', outputPath: path, content: '', bytes: 0, missing: true });
      continue;
    }
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      out.push({ nodeId: 'inject', outputPath: path, content: '', bytes: 0, missing: true });
      continue;
    }
    if (content.length > perFile) {
      out.push({ nodeId: 'inject', outputPath: path, content: content.slice(0, perFile), bytes: perFile, truncatedFrom: content.length });
    } else {
      out.push({ nodeId: 'inject', outputPath: path, content, bytes: content.length });
    }
  }
  return out;
}

/** Read + budget-truncate each node id's output into PackedInputs. Budget is split evenly across the files. */
function packInputs(
  idx: ReturnType<typeof indexPlan>,
  outputsDir: string,
  nodeIds: string[],
  budget: number,
  floor = 0,
): PackedInput[] {
  const perFile = perInputChars(budget, nodeIds.length, floor);
  const inputs: PackedInput[] = [];
  for (const nid of nodeIds) {
    const upstream = idx.get(nid);
    if (!upstream) {
      // Should not happen post-parsePlan, but never trust — record as missing rather than throw.
      inputs.push({ nodeId: nid, outputPath: '(unknown)', content: '', bytes: 0, missing: true });
      continue;
    }
    const outputPath = upstream.node.contract.outputPath;
    const { content, missing } = readOutput(outputsDir, outputPath);
    if (missing) {
      inputs.push({ nodeId: nid, outputPath, content: '', bytes: 0, missing: true });
      continue;
    }
    if (content.length > perFile) {
      inputs.push({ nodeId: nid, outputPath, content: content.slice(0, perFile), bytes: perFile, truncatedFrom: content.length });
    } else {
      inputs.push({ nodeId: nid, outputPath, content, bytes: content.length });
    }
  }
  return inputs;
}

/**
 * Render the pack to the final prompt string. Order matters for prefix caching (F1): the STAGE-SHARED block
 * comes FIRST and is byte-identical across every node in the stage, so vLLM caches it once; the divergence
 * begins at CONTRACT_MARKER (outputPath differs per node), then node-specific inputs, then the unique task
 * tail. The node's system prompt (run.ts) is kept stage-invariant too, so the cacheable prefix = system +
 * this shared block.
 */
function renderPackText(
  node: Node,
  shared: PackedInput[],
  sharedInjected: PackedInput[],
  injected: PackedInput[],
  inputs: PackedInput[],
  runIdentity?: { runId: string; runDir: string },
): string {
  const parts: string[] = [];

  // ── RUN IDENTITY — which run this node is inside. Constant for the whole run, so it sits ABOVE the shared
  //    block without breaking F1 prefix caching (still byte-identical across every stage-mate).
  //
  //    2026-08-07: a `run-retro` node is told "the run directory on disk IS your primary input", and until now
  //    the pack never named it. With SEVEN fleets live it globbed `runs/`, landed on a SIBLING run first
  //    (04-23-45-057Z instead of its own 04-23-43-405Z), noticed its injected backlog did not match that
  //    journal, and re-derived its identity by cross-checking. It recovered — but it spent turns on it and,
  //    had the two runs been more alike, it would have retro'd the wrong fleet and nothing downstream would
  //    have known. Any node that reads its own run off disk needs this; a node cannot verify it is looking at
  //    itself if it was never told who it is.
  if (runIdentity) {
    parts.push('===== RUN IDENTITY =====');
    parts.push(`runId: ${runIdentity.runId}`);
    parts.push(`runDir: ${runIdentity.runDir}`);
    parts.push(
      'If you read this run off disk, read THIS directory. Other runs may be executing concurrently, and a ' +
        'sibling run directory can look plausible — never infer your identity by globbing.',
    );
    parts.push('');
  }

  // ── SHARED PREFIX (stage-wide, byte-identical across stage-mates): injected files first (the raw
  //    material), then shared upstream outputs ──
  parts.push('===== SHARED CONTEXT (stage-wide) =====');
  if (shared.length === 0 && sharedInjected.length === 0) {
    parts.push('(none — this stage shares no upstream context)');
  } else {
    for (const inp of sharedInjected) pushFileBlock(parts, inp);
    for (const inp of shared) pushInputBlock(parts, inp);
  }
  parts.push('');

  // ── first divergence point ──
  parts.push(CONTRACT_MARKER);
  // Harness-capture contract: do NOT say "write a file" — read-only grok nodes obeyed that literally
  // (2026-08-03 belt defect). sim.ts parses /lands at:\s*(\S+)/ — path MUST be a bare \S+ token
  // (no trailing paren/punct glued on; put the path last so the capture is clean).
  parts.push(
    `Do NOT write any files yourself. Your FINAL assistant message is the deliverable — the harness captures it and writes it for you. lands at: ${node.contract.outputPath}`,
  );
  if (node.contract.schema !== undefined) {
    parts.push('It must satisfy this schema (JSON):');
    parts.push('```json');
    parts.push(JSON.stringify(node.contract.schema, null, 2));
    parts.push('```');
  }
  if (node.contract.judge) {
    parts.push(`A judge will assess it against the rubric: "${node.contract.judge.rubric}".`);
  }
  parts.push('');

  // ── node-injected source files (inject-not-search: the agent starts WITH the material) ──
  if (injected.length > 0) {
    parts.push('===== INJECTED FILES (current contents — you already have these; do NOT re-read them) =====');
    for (const inp of injected) pushFileBlock(parts, inp);
    parts.push('');
  }

  // ── node-specific inputs ──
  parts.push('===== UPSTREAM INPUTS (node-specific) =====');
  if (inputs.length === 0) {
    parts.push('(none — this node consumes no node-specific upstream outputs)');
  } else {
    for (const inp of inputs) pushInputBlock(parts, inp);
  }
  parts.push('');

  // ── the unique tail: the node's task, and its seat (kept OUT of the system prompt so system stays
  //    stage-invariant and cacheable — see run.ts nodeSystem). ──
  parts.push('===== YOUR TASK =====');
  parts.push(renderTaskPrompt(node.taskPrompt));
  if (node.agent.seat) parts.push(`Seat: ${node.agent.seat}.`);

  return parts.join('\n');
}

/** Append one INJECTED source file's fenced block (missing/truncated surfaced inline — never a silent drop). */
function pushFileBlock(parts: string[], inp: PackedInput): void {
  parts.push('');
  if (inp.missing) {
    parts.push(`----- FILE ${inp.outputPath} — MISSING: could not be injected (read it with local.read instead) -----`);
    return;
  }
  const trunc =
    inp.truncatedFrom !== undefined
      ? ` — TRUNCATED to ${inp.bytes} of ${inp.truncatedFrom} chars (use local.read with offset for the rest)`
      : '';
  parts.push(`----- FILE ${inp.outputPath}${trunc} -----`);
  parts.push(inp.content);
}

/**
 * Annotate consumed upstream text with stable section markers so combiners can CITE a section
 * (e.g. "[ctx §3]") instead of restating its content — the W2 directive (M0 plan). A new section
 * starts at every markdown heading line (/^#{1,6}\s/) and additionally at every 40-line boundary
 * within a long section. The marker `[<sourceId> §<n>]` (n = 1,2,3… in order) is inserted on its
 * OWN line immediately BEFORE each section's first line. Original lines are never altered — stripping
 * every marker line reproduces the input byte-for-byte. Empty text returns empty text unchanged.
 * Pure + deterministic. Applied ONLY to consumed upstream outputs, never to injected files.
 */
export function annotateSections(sourceId: string, text: string): string {
  if (text === '') return '';

  const lines = text.split('\n');

  // Phase 1 — split into sections: a new section starts at every markdown heading line.
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      if (current.length > 0) sections.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current);

  // Phase 2 — split any section longer than 40 lines into 40-line chunks.
  const chunks: string[][] = [];
  for (const section of sections) {
    for (let i = 0; i < section.length; i += 40) {
      chunks.push(section.slice(i, i + 40));
    }
  }

  // Phase 3 — insert a marker line before each chunk's first line.
  const out: string[] = [];
  for (let n = 0; n < chunks.length; n++) {
    out.push(`[${sourceId} §${n + 1}]`);
    out.push(...chunks[n]);
  }
  return out.join('\n');
}

/** Append one consumed input's fenced block (missing/truncated surfaced inline — never a silent drop). */
function pushInputBlock(parts: string[], inp: PackedInput): void {
  parts.push('');
  if (inp.missing) {
    parts.push(`----- from ${inp.nodeId} (${inp.outputPath}) — MISSING: upstream output unavailable -----`);
    return;
  }
  const trunc =
    inp.truncatedFrom !== undefined
      ? ` — TRUNCATED to ${inp.bytes} of ${inp.truncatedFrom} chars (upstream output was cut to fit the budget)`
      : '';
  parts.push(`----- from ${inp.nodeId} (${inp.outputPath})${trunc} -----`);
  parts.push(annotateSections(inp.nodeId, inp.content));
}
