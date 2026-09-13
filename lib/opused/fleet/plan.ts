// @purpose: The fleet PLAN-GRAPH contract — a run's frozen task graph (stages × nodes) as zod schemas + a validator
// @why: F0, the coordination layer the founder named as the precondition before ANY 500-agent box window
//       (docs/architecture/PLAN-fleet-program-2026-07.md §"F0"): "planning before going into action — who will
//       be feeded the response of whom." A plan is the Wave-0-freeze discipline made data — nodes are agent
//       assignments, `consumes` edges are whose output feeds whom, every node carries an output contract, and
//       stage barriers are explicit. parsePlan enforces the invariants the runner then trusts: forward-only
//       references (no cycles, no reading a peer's or a later node's output), and a contract on every node.
//       This graph IS the run-visualization data (§F0) — do not build a second model.
// @role: safety-critical
// @stability: experimental

import { z } from 'zod';
import { isSafeRunRelPath } from '../../flaight/runs/safe-run-rel-path';

/** How hard the box should try on a node — a hint to the seat (maxSteps / output budget), not a hard cap. */
export const EffortHintSchema = z.enum(['low', 'medium', 'high']);
export type EffortHint = z.infer<typeof EffortHintSchema>;

/**
 * How a node executes (dec-040 / OPUSED-CLI-RUNNERS CR-1).
 * Default `api` keeps every pre-CR plan on the existing OpenRouter generate seam.
 * `cli-*` and `conversational` are accepted by parsePlan; run.ts refuses non-api until
 * the matching executor lands (CR-2 cli-claude, CR-3 cli-grok, CR-cli-codex, CR-6 conversational,
 * runner-flexibility 2026-08-05 cli-qwen).
 */
export const NodeRunnerKindSchema = z.enum(['api', 'cli-grok', 'cli-claude', 'cli-codex', 'cli-qwen', 'conversational']);
export type NodeRunnerKind = z.infer<typeof NodeRunnerKindSchema>;

/** CLI session continuation (CR-4 wires refuse-ambiguous). Fresh is the safe default at invoke time. */
export const AgentSessionSchema = z
  .object({
    mode: z.enum(['fresh', 'resume', 'fork']),
    id: z.string().min(1).optional(),
  })
  .strict();
export type AgentSession = z.infer<typeof AgentSessionSchema>;

/** Conversational-node budgets (CR-6). */
export const AgentTurnsSchema = z
  .object({
    max: z.number().int().positive(),
    digestEvery: z.number().int().positive().optional(),
  })
  .strict();
export type AgentTurns = z.infer<typeof AgentTurnsSchema>;

/** Which seat runs a node: a named seat id and/or an explicit model slug. Both optional — the runner
 *  supplies a default model, and `seat` is a label the plan author uses to group like nodes.
 *  `persona` (T1) names a profile in the persona registry (personas.ts) — system framing + default toolset +
 *  model/effort. The runner resolves it; node-level fields (model, tools, effortHint) OVERRIDE the persona. */
export const AgentRefSchema = z
  .object({
    seat: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    persona: z.string().min(1).optional(),
    /** B2: names an AgentPreset in the agent catalog (agents.ts) — mission prompt + scoped tool grant +
     *  effort, resolved with the SAME drop-and-log danger gating as personas. Precedence: preset > persona >
     *  seat-as-profile. The CLI validates the name against the catalog before any spend (unknown = reject). */
    preset: z.string().min(1).optional(),
    /** dec-040: execution backend. Omitted on legacy plans → defaults to `api` (no behavior change). */
    runner: NodeRunnerKindSchema.default('api'),
    /** CLI session continuation (resume/fork need id — enforced at execute, CR-4). */
    session: AgentSessionSchema.optional(),
    /** Conversational turn budgets (CR-6). */
    turns: AgentTurnsSchema.optional(),
    /** Override sandbox cwd for CLI nodes (else run sandboxRoot). */
    cwd: z.string().min(1).optional(),
  })
  .strict();
export type AgentRef = z.infer<typeof AgentRefSchema>;

/** A node's task prompt: either a literal string OR a template + named inputs (interpolated `{{key}}`).
 *  The template form keeps the prompt data-driven so a matrix of nodes can share one skeleton (§P1/P2). */
export const TaskPromptSchema = z.union([
  z.string().min(1),
  z
    .object({
      template: z.string().min(1),
      inputs: z.record(z.string(), z.string()),
    })
    .strict(),
]);
export type TaskPrompt = z.infer<typeof TaskPromptSchema>;

/** The judge hook for a node. The RUBRIC is just a string here on purpose — the eval rubrics
 *  (lib/eval/*) are wired later; F0's job is to CARRY the assignment, not to own the rubric library.
 *  dec-246: the accept path is binary ACCEPT/RETURN+reason — `threshold` is history-only (recorded,
 *  never compared). Kept optional so the 182 existing plans and journals still parse.
 *  dec-judge-seam: optional runner / requireToolEvidence / onReturn — all additive, all optional. */
export const JudgeSpecSchema = z
  .object({
    rubric: z.string().min(1),
    threshold: z.number().min(0).max(1).optional(),
    /** W4: judge on its OWN model (e.g. a smarter/cheaper slug than the node's). Absent = the node's model.
     *  Composes with OPUSED_MODEL_ROUTES — a `box:`-prefixed judge model routes like any other slug. */
    model: z.string().min(1).optional(),
    /** dec-judge-seam: which generate backend scores this node. Absent → env OPUSED_JUDGE_SEAM / default. */
    runner: z.enum(['cli-grok', 'cli-claude', 'api']).optional(),
    /** When true, ACCEPT requires harness tool evidence (zero/unavailable tools → deterministic RETURN). */
    requireToolEvidence: z.boolean().optional(),
    /**
     * After max repairs + gates green + judge still RETURN:
     * - `dispute` (default) = node done + judgeDisputed (gate-convergence)
     * - `fail-node` = node_fail (`.out` still kept on disk — never deleted)
     */
    onReturn: z.enum(['dispute', 'fail-node']).optional(),
  })
  .strict();
export type JudgeSpec = z.infer<typeof JudgeSpecSchema>;

/**
 * A declared outputPath is checked BEFORE `${var}` substitution too, because a router template
 * (`template-review.ts`: `'${file1}--correctness.out'`) is parsed in its un-substituted form. So a
 * placeholder is neutralised to a benign token and the SHAPE is checked around it — `../${x}.out` and
 * `/${x}.out` are still refused, and the substituted plan is parsed again, which re-checks the real path.
 */
function isSafeOutputPathTemplate(raw: string): boolean {
  return isSafeRunRelPath(raw.replace(/\$\{[A-Za-z0-9_]+\}/g, 'X'));
}

/** Every node MUST declare where its output lands (contract-first). `schema` is an optional
 *  zod-serializable JSON schema the output is expected to satisfy (carried, not enforced by F0). */
export const ContractSchema = z
  .object({
    // RUN-RELATIVE and traversal-refused at PARSE time, so a bad path costs $0 instead of writing outside
    // the run directory 40 nodes into a live fleet. Nested segments ARE allowed (`file-audit/<id>.out`) —
    // a 72-node fan-out needs subdirectories to stay navigable, and run.ts creates the parent on write.
    outputPath: z
      .string()
      .min(1)
      .refine(isSafeOutputPathTemplate, {
        message: 'outputPath must be a run-relative path of slug segments (no leading /, no "..", no drive letter)',
      }),
    schema: z.unknown().optional(),
    judge: JudgeSpecSchema.optional(),
  })
  .strict();
export type Contract = z.infer<typeof ContractSchema>;

/**
 * T3 checkpoint node config (Flaight PLAN §3) — P0 anchor between stages.
 * `mode`: human (control ops), llm (single-turn judge seam), deterministic (built-in predicate).
 * `allowExpand`: when true, an `expand` decision is recorded + GATE-style pending note written;
 *   wave expansion is NEVER auto-executed (operator expand command).
 */
export const CheckpointConfigSchema = z
  .object({
    mode: z.enum(['human', 'llm', 'deterministic']),
    /** Human/llm rubric text, OR deterministic predicate name (`all-upstream-done` v1 only). */
    rubric: z.string().optional(),
    allowExpand: z.boolean().default(false),
  })
  .strict();
export type CheckpointConfig = z.infer<typeof CheckpointConfigSchema>;

/** Node kind — default `agent` keeps all pre-T3 plans valid. */
export const NodeKindSchema = z.enum(['agent', 'checkpoint', 'compute']);
export type NodeKind = z.infer<typeof NodeKindSchema>;

/** Named in-box / connection step. Plan requests an id from the compute registry — never inline code. */
export const ComputeConfigSchema = z
  .object({
    id: z.string().min(1),
    args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();
export type ComputeConfig = z.infer<typeof ComputeConfigSchema>;

/** One inject entry: a path string (required) or { path, optional?: true }.
 *  Optional injects may be missing without hard-failing dry/live (default remains required). */
export const InjectEntrySchema = z.union([
  z.string().min(1),
  z
    .object({
      path: z.string().min(1),
      optional: z.boolean().optional(),
    })
    .strict(),
]);
export type InjectEntry = z.infer<typeof InjectEntrySchema>;

export function injectPath(entry: InjectEntry): string {
  return typeof entry === 'string' ? entry : entry.path;
}

export function injectOptional(entry: InjectEntry): boolean {
  return typeof entry === 'string' ? false : entry.optional === true;
}

/** One node = one agent assignment (or a checkpoint decision). `consumes` names EARLIER node-or-stage
 *  ids whose OUTPUT files feed this node's context pack (the scoped-context rule — a node sees ONLY
 *  what it consumes). Checkpoint nodes still consume stage-mates for the digest; their contract.outputPath
 *  receives the decision record. */
export const NodeSchema = z
  .object({
    id: z.string().min(1),
    /** T3: `checkpoint` = P0 decision; `compute` = named registry fn; default `agent` = seat. */
    kind: NodeKindSchema.default('agent'),
    /** Required iff kind=checkpoint; forbidden on agent/compute (see superRefine). */
    checkpoint: CheckpointConfigSchema.optional(),
    /** Required iff kind=compute; forbidden otherwise. */
    compute: ComputeConfigSchema.optional(),
    /** Agent seat ref — required for agent nodes; checkpoint nodes pass `{}` (unused at runtime). */
    agent: AgentRefSchema,
    /**
     * Task prompt — required for agent nodes. Checkpoint nodes may use a placeholder (runtime builds
     * its own digest pack and does not call the seat). Kept required so pre-T3 Node object literals
     * and z.infer consumers stay type-stable.
     */
    taskPrompt: TaskPromptSchema,
    consumes: z.array(z.string().min(1)).default([]),
    /** INJECT-not-search (founder directive + Gemma E1): source files (paths relative to the sandbox root)
     *  rendered WHOLE into this node's pack, so the agent starts with the real material instead of spending
     *  tool calls re-reading its own target. Tool-read (local.read) is for discovery BEYOND this bundle.
     *  Each entry is a path string (required) or { path, optional?: true }. */
    inject: z.array(InjectEntrySchema).default([]),
    /** T1: per-node tool grant — registry ids (e.g. 'local.read','local.write','terminal'). Overrides the
     *  persona/seat default. DANGER-tiered tools (write/test/terminal/browser.act) still require the matching
     *  CLI opt-in (--write/--test/…) to actually arm — a plan can REQUEST but never self-GRANT a dangerous tool. */
    tools: z.array(z.string().min(1)).optional(),
    // How node.tools compose with the persona/seat preset: 'extend' (default) adds, 'replace' overrides.
    // Extend-by-default means a plan can never silently narrow an agent below its preset toolset.
    toolsMode: z.enum(['extend', 'replace']).optional(),
    contract: ContractSchema,
    effortHint: EffortHintSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.kind === 'checkpoint') {
      if (!val.checkpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'checkpoint node requires checkpoint config',
          path: ['checkpoint'],
        });
      }
      if (val.compute !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'checkpoint node must not carry compute config',
          path: ['compute'],
        });
      }
      if (val.contract.judge !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'checkpoint node must not carry contract.judge',
          path: ['contract', 'judge'],
        });
      }
      if (val.tools !== undefined && val.tools.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'checkpoint node must not carry tools',
          path: ['tools'],
        });
      }
    } else if (val.kind === 'compute') {
      if (!val.compute) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'compute node requires compute config',
          path: ['compute'],
        });
      }
      if (val.checkpoint !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'compute node must not carry checkpoint config',
          path: ['checkpoint'],
        });
      }
      if (val.tools !== undefined && val.tools.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'compute node must not carry tools',
          path: ['tools'],
        });
      }
    } else {
      // agent (default)
      if (val.checkpoint !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'agent node must not carry checkpoint config',
          path: ['checkpoint'],
        });
      }
      if (val.compute !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'agent node must not carry compute config',
          path: ['compute'],
        });
      }
    }
  });
/**
 * Parsed node. `kind` is optional on the TS type so pre-T3 object literals (tests/executors) stay
 * assignable; parsePlan always applies default `agent`. Runtime treats missing kind as agent.
 */
export type Node = Omit<z.infer<typeof NodeSchema>, 'kind' | 'checkpoint' | 'compute'> & {
  kind?: 'agent' | 'checkpoint' | 'compute';
  checkpoint?: CheckpointConfig;
  compute?: ComputeConfig;
};

/** A stage groups nodes. `barrier:true` = the runner waits for ALL nodes in this stage before any later
 *  stage starts; a non-barrier stage may pipeline (a node fires as soon as ITS consumes are ready). */
export const StageSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    barrier: z.boolean().optional(),
    /** F5: 'human' pauses the run BEFORE this stage — the runner writes GATE-<id>.pending and exits; an
     *  operator reviews the upstream outputs, approves (`fleet gate <runId> <id> --approve`), then
     *  `fleet run <plan> --resume <runId>` continues. 'auto' (default) never pauses. */
    gate: z.enum(['human', 'auto']).default('auto'),
    /** F4c: scoped gates — 'repo' (default) runs full tsc+tests per node (today's behavior); 'unit' runs a
     *  lightweight per-file transpile check per node and defers full tsc+tests to the stage barrier
     *  (verifyStageBarrier in run.ts), so a wide fan-out doesn't pay N full tsc+vitest cycles when a single
     *  barrier pass at the end suffices. */
    gateScope: z.enum(['unit', 'repo']).default('repo'),
    /** Inputs EVERY node in this stage receives — rendered FIRST, byte-identical across stage-mates, so the
     *  shared prefix caches once instead of N times (F1). Same reference rule as node `consumes`: earlier-stage
     *  ids only. A node must NOT also list a sharedConsumes ref in its own `consumes` (no double-render). */
    sharedConsumes: z.array(z.string().min(1)).default([]),
    /** Source files (paths relative to the sandbox root) injected identically for EVERY node in this stage —
     *  rendered inside the byte-identical shared prefix, so a stage-wide bundle prefills once (F1) and each
     *  agent still starts with the full material in-context (inject-not-search).
     *  Each entry is a path string (required) or { path, optional?: true }. */
    sharedInject: z.array(InjectEntrySchema).default([]),
    nodes: z.array(NodeSchema).min(1),
  })
  .strict();
/** Stage with Node type that keeps `kind` optional for pre-T3 object literals. */
export type Stage = Omit<z.infer<typeof StageSchema>, 'nodes'> & { nodes: Node[] };

/** A whole fleet run's frozen plan. Stages run in array order. */
export const FleetPlanSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    stages: z.array(StageSchema).min(1),
  })
  .strict();
/** Plan graph; stages use the TS-friendly Node type (kind optional until parse defaults). */
export type FleetPlan = Omit<z.infer<typeof FleetPlanSchema>, 'stages'> & { stages: Stage[] };

/** parsePlan's discriminated result: a valid, invariant-checked plan OR a list of human-readable errors. */
export type ParseResult =
  | { ok: true; plan: FleetPlan }
  | { ok: false; errors: string[] };

/** A resolved node with its owning stage — the flat view the runner and context-pack builder index on. */
export interface PlanNodeIndex {
  node: Node;
  stageId: string;
  stageIndex: number;
  /** Ids this node/stage-id may be referenced by (itself + its stage) — for reference resolution. */
}

/**
 * Parse + validate a fleet plan from raw JSON. Two layers:
 *  1. zod shape (types, required fields, non-empty).
 *  2. GRAPH invariants enforced in code (these are what make staged execution safe):
 *     - unique node ids AND unique stage ids (a `consumes` ref must resolve unambiguously);
 *     - a node id must not collide with a stage id (the reference space is shared);
 *     - every `consumes` ref must EXIST and point to an EARLIER stage/node only — this simultaneously
 *       rejects cycles, self-references, forward references, and same-stage peer references
 *       (a node consuming a peer in its own stage has no ordering guarantee → rejected);
 *     - stage barriers are explicit (already in the shape) — a downstream stage always starts after an
 *       upstream one, so cross-stage consumes are always safe.
 * Returns every error found (not just the first) so a plan author fixes them in one pass.
 */
export function parsePlan(json: unknown): ParseResult {
  const shape = FleetPlanSchema.safeParse(json);
  if (!shape.success) {
    return { ok: false, errors: shape.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const plan = shape.data;
  const errors: string[] = [];

  // Build the id spaces. A stage id and a node id share ONE reference namespace (consumes may name either),
  // so a collision between them is ambiguous and rejected.
  const stageIdToIndex = new Map<string, number>();
  const nodeIdToStageIndex = new Map<string, number>();
  const nodeIds = new Set<string>();

  plan.stages.forEach((stage, si) => {
    if (stageIdToIndex.has(stage.id)) errors.push(`duplicate stage id "${stage.id}"`);
    else stageIdToIndex.set(stage.id, si);
  });

  plan.stages.forEach((stage, si) => {
    stage.nodes.forEach((node) => {
      if (nodeIds.has(node.id)) errors.push(`duplicate node id "${node.id}"`);
      else nodeIds.add(node.id);
      if (stageIdToIndex.has(node.id)) errors.push(`node id "${node.id}" collides with a stage id`);
      nodeIdToStageIndex.set(node.id, si);
    });
  });

  // consumes references: must exist and point to an EARLIER stage index only.
  plan.stages.forEach((stage, si) => {
    stage.nodes.forEach((node) => {
      for (const ref of node.consumes) {
        if (ref === node.id) {
          errors.push(`node "${node.id}" consumes itself`);
          continue;
        }
        const refStageIdx = stageIdToIndex.get(ref) ?? nodeIdToStageIndex.get(ref);
        if (refStageIdx === undefined) {
          errors.push(`node "${node.id}" consumes unknown id "${ref}"`);
          continue;
        }
        // A stage-id ref resolves to that stage's index; a node-id ref to its stage's index. EARLIER only:
        // strictly-less stage index. Same-stage (including a peer node) has no ordering guarantee → reject.
        if (refStageIdx >= si) {
          const kind = stageIdToIndex.has(ref) ? 'stage' : 'node';
          errors.push(
            `node "${node.id}" (stage ${si}) consumes ${kind} "${ref}" which is not in an earlier stage ` +
              `(found at stage ${refStageIdx}) — consumes must reference earlier stages only`,
          );
        }
      }
    });
  });

  // stage sharedConsumes: same reference rule as node consumes (exist + earlier-stage-only). Plus: a node must
  // not ALSO list a shared ref in its own consumes (the shared block already renders it — no double-render).
  plan.stages.forEach((stage, si) => {
    const sharedSet = new Set(stage.sharedConsumes);
    for (const ref of stage.sharedConsumes) {
      const refStageIdx = stageIdToIndex.get(ref) ?? nodeIdToStageIndex.get(ref);
      if (refStageIdx === undefined) {
        errors.push(`stage "${stage.id}" sharedConsumes unknown id "${ref}"`);
        continue;
      }
      if (refStageIdx >= si) {
        const kind = stageIdToIndex.has(ref) ? 'stage' : 'node';
        errors.push(
          `stage "${stage.id}" (index ${si}) sharedConsumes ${kind} "${ref}" which is not in an earlier stage ` +
            `(found at stage ${refStageIdx}) — sharedConsumes must reference earlier stages only`,
        );
      }
    }
    if (sharedSet.size > 0) {
      for (const node of stage.nodes) {
        for (const ref of node.consumes) {
          if (sharedSet.has(ref)) {
            errors.push(`node "${node.id}" consumes "${ref}" which is already stage-shared (drop it from the node)`);
          }
        }
      }
    }
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, plan };
}

/** Flatten a validated plan into an id→node index the runner + context-pack builder share. */
export function indexPlan(plan: FleetPlan): Map<string, PlanNodeIndex> {
  const idx = new Map<string, PlanNodeIndex>();
  plan.stages.forEach((stage, stageIndex) => {
    for (const node of stage.nodes) idx.set(node.id, { node, stageId: stage.id, stageIndex });
  });
  return idx;
}

/** All node ids that a `consumes` ref expands to: a node id → itself; a stage id → every node in it. */
export function resolveConsumedNodeIds(plan: FleetPlan, ref: string): string[] {
  const stage = plan.stages.find((s) => s.id === ref);
  if (stage) return stage.nodes.map((n) => n.id);
  return [ref]; // a node-id ref (validated to exist by parsePlan)
}

/** Render a node's taskPrompt to a string (interpolating `{{key}}` for the template form). */
export function renderTaskPrompt(taskPrompt: TaskPrompt): string {
  if (typeof taskPrompt === 'string') return taskPrompt;
  return taskPrompt.template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(taskPrompt.inputs, key) ? taskPrompt.inputs[key] : whole,
  );
}
