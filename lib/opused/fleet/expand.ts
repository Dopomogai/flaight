// @purpose: expandManifest — turn a work-list manifest × a node template into a fresh validated plan (F2)
// @why: The gather/divide funnel (SPEC-opused-flow §F2): you can't know "one agent per file" until the file
//       map EXISTS, so the graph's width depends on an intermediate output. The right mechanism is NOT a
//       self-mutating running graph — it is: a synthesizer node emits a work-list manifest (its contract.schema
//       enforced by F3), a human/gate ratifies it, then DETERMINISTIC CODE expands it (template × items) into a
//       NEW plan that parsePlan validates before it ever runs. Every executed graph stays static and checkable;
//       the pipeline as a whole still re-widens. Parallel writers must own DISJOINT output paths (the guard),
//       or expansion refuses — for $0, before any spend.
// @role: safety-critical
// @stability: experimental

import { parsePlan, type FleetPlan, type EffortHint } from './plan';

/** One work item. `id` is required (it names the generated node + is available as {{item.id}}); any other
 *  fields are free-form and interpolable as {{item.<key>}} in the template. */
export interface ManifestItem {
  id: string;
  [key: string]: unknown;
}

/** The gather node's output shape (its contract.schema should require this — enforced by F3). */
export interface WorkManifest {
  items: ManifestItem[];
}

/** Optional hierarchical (tree) combine over the fan-out (SPEC: docs/opused/specs/tree-combine.md). When
 *  supplied to expandManifest, the fan-out leaves are reduced through tiers of group-combiners (each seeing at
 *  most `groupSize` inputs) down to ONE final combiner — instead of a single sink over all N (which chokes at
 *  high N). Omit it entirely for today's single-stage behavior (backward compatible). */
export interface CombineSpec {
  /** Max inputs any one combiner consumes. Default 8. */
  groupSize?: number;
  /** Base id for the emitted combiner stages. Default `${template.stageId}-combine`. */
  stageId?: string;
  seat?: string;
  model?: string;
  /** Runner for every emitted combiner. Same reason as NodeTemplate.runner — omit it and the whole tree
   *  is api-only, so a 9-tier combine over cli-grok leaves still cannot run on the subscription seam. */
  runner?: 'cli-grok' | 'cli-claude' | 'api';
  tools?: readonly string[];
  toolsMode?: 'extend' | 'replace';
  /** Group-combiner prompt. Placeholders: {{tier}} (1-based), {{group}} (0-based index), {{memberCount}}. */
  promptTemplate: string;
  /** Optional distinct prompt for the single ROOT combiner (defaults to promptTemplate). */
  finalPromptTemplate?: string;
  /** Combiner output path, must render unique per node. Default `${stageId}-t{{tier}}-g{{group}}.out`
   *  (the final combiner uses `${stageId}-final.out`). */
  outputPathPattern?: string;
  /** Tier combiners default 'medium'; the final combiner defaults 'high'. */
  effortHint?: EffortHint;
  judge?: { rubric: string; threshold?: number };
}

/** The per-item node template. Placeholders {{item.<key>}} (and {{i}} = the item index) interpolate each item. */
export interface NodeTemplate {
  planName?: string;
  planDescription?: string;
  stageId: string;
  stageTitle: string;
  barrier?: boolean;
  seat?: string;
  model?: string;
  /** Which runner every emitted node uses. UNSET MEANS 'api' — the AgentRef default — so an expanded plan
   *  with no runner is refused at dispatch by the subscription-seam preflight ("cannot run api-runner
   *  nodes"). That is how an 84-node and a 117-node grok fan-out both died at startup on 2026-08-07: the
   *  fan-out mechanism had no way to SAY "cli-grok", so the founder's "one node per file" fleets were
   *  structurally impossible on the only free seam. Set this on any manifest fan-out you intend to run. */
  runner?: 'cli-grok' | 'cli-claude' | 'api';
  /** Registry capability ids granted to every emitted node (e.g. ['local.read']). For cli-grok these are
   *  translated to grok's own belt by GROK_REGISTRY_TOOL_EQUIVALENTS; translation can never widen it. */
  tools?: readonly string[];
  toolsMode?: 'extend' | 'replace';
  /** The node's taskPrompt, with {{item.*}} placeholders. */
  taskPromptTemplate: string;
  /** The node's contract.outputPath, with {{item.*}} placeholders — MUST render uniquely per item. */
  outputPathPattern: string;
  effortHint?: EffortHint;
  judge?: { rubric: string; threshold?: number };
  /** Optional output schema (enforced per node by F3 when the expanded plan runs). */
  schema?: unknown;
}

/**
 * Expand a work-list manifest into a fresh single-stage plan: one node per item, the template interpolated
 * with the item's fields. The result is validated by parsePlan (a bad manifest → a bad graph → throws HERE,
 * for $0). Parallel writers must own disjoint output paths, or expansion refuses. This is "divide" — the
 * counterpart to the "gather" synthesizer node that produced the manifest.
 */
export function expandManifest(manifest: unknown, template: NodeTemplate, combine?: CombineSpec): FleetPlan {
  if (!isRecord(manifest) || !Array.isArray(manifest.items)) {
    throw new Error('expand: manifest has no items[] array');
  }
  // TREE-COMBINE (SPEC: docs/opused/specs/tree-combine.md) — implemented with tree reduction for wide fan-outs.
  const items = manifest.items as unknown[];
  if (items.length === 0) throw new Error('expand: manifest.items is empty');

  // Build leaf fan-out nodes and ensure unique output paths.
  const allOutputPaths = new Set<string>();
  const leafNodes = items.map((raw, i) => {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) {
      throw new Error(`expand: item ${i} has no string "id"`);
    }
    const item = raw as ManifestItem;
    const taskPrompt = interpolate(template.taskPromptTemplate, item, i);
    const outputPath = interpolate(template.outputPathPattern, item, i);
    if (allOutputPaths.has(outputPath)) {
      throw new Error(`expand: duplicate output path "${outputPath}" (items must map to disjoint files)`);
    }
    allOutputPaths.add(outputPath);
    return {
      id: `${template.stageId}-${item.id}`,
      agent: {
        ...(template.seat ? { seat: template.seat } : {}),
        ...(template.model ? { model: template.model } : {}),
        ...(template.runner ? { runner: template.runner } : {}),
      },
      taskPrompt,
      consumes: [] as string[],
      contract: {
        outputPath,
        ...(template.schema !== undefined ? { schema: template.schema } : {}),
        ...(template.judge ? { judge: template.judge } : {}),
      },
      ...(template.effortHint ? { effortHint: template.effortHint } : {}),
      ...(template.tools ? { tools: [...template.tools] } : {}),
      ...(template.toolsMode ? { toolsMode: template.toolsMode } : {}),
    };
  });

  // Default values for combine. groupSize MUST be ≥2: at 1 the tree never shrinks
  // (numGroups === inputs.length → each tier reproduces its input count → infinite loop, no timeout);
  // at ≤0 the ceil/slice math is nonsense. A plan typo shouldn't hang the whole expansion. (R1 finding.)
  const rawGroupSize = combine?.groupSize ?? 8;
  if (combine && (!Number.isInteger(rawGroupSize) || rawGroupSize < 2)) {
    throw new Error(`expand: combine.groupSize must be an integer ≥ 2 (got ${rawGroupSize}) — a tree combiner cannot fan in by ${rawGroupSize}`);
  }
  const groupSize = rawGroupSize;
  const stageIdBase = combine?.stageId ?? `${template.stageId}-combine`;

  // Build stages
  const stages: { id: string; title: string; barrier?: boolean; nodes: any[] }[] = [];

  // Leaf stage
  const leafStage = {
    id: template.stageId,
    title: template.stageTitle,
    ...(template.barrier ? { barrier: true } : {}),
    nodes: leafNodes,
  };
  stages.push(leafStage);

  // Build tree combiner stages if combine is provided
  if (combine) {
    let inputs: string[] = leafNodes.map(n => n.id);
    let tier = 1;

    // Emit intermediate tiers
    while (inputs.length > groupSize) {
      const numGroups = Math.ceil(inputs.length / groupSize);
      const tierNodes: any[] = [];

      for (let g = 0; g < numGroups; g++) {
        const startIdx = g * groupSize;
        const groupMembers = inputs.slice(startIdx, startIdx + groupSize);
        const memberCount = groupMembers.length;

        const combinerId = `${stageIdBase}-t${tier}-g${g}`;
        const taskPrompt = interpolateCombineVariables(combine.promptTemplate, { tier, group: g, memberCount });
        const outputPathPattern = combine.outputPathPattern ?? `${stageIdBase}-t{{tier}}-g{{group}}.out`;
        const outputPath = interpolateCombineVariables(outputPathPattern, { tier, group: g, memberCount });

        // Ensure unique output path
        if (allOutputPaths.has(outputPath)) {
          throw new Error(`expand: duplicate output path "${outputPath}" (combiner nodes must have unique paths)`);
        }
        allOutputPaths.add(outputPath);

        const agent: any = {
          ...(combine.seat ? { seat: combine.seat } : {}),
          ...(combine.model ? { model: combine.model } : {}),
          ...(combine.runner ? { runner: combine.runner } : {}),
        };

        const contract: any = {
          outputPath,
          ...(combine.judge ? { judge: combine.judge } : {}),
        };

        const node: any = {
          id: combinerId,
          agent,
          taskPrompt,
          consumes: groupMembers,
          contract,
          effortHint: combine.effortHint ?? 'medium',
          ...(combine.tools ? { tools: [...combine.tools] } : {}),
          ...(combine.toolsMode ? { toolsMode: combine.toolsMode } : {}),
        };
        tierNodes.push(node);
      }

      const tierStage = {
        id: `${stageIdBase}-t${tier}`,
        title: `Combine tier ${tier}`,
        nodes: tierNodes,
      };
      stages.push(tierStage);

      // Inputs for next tier are the ids of the newly created combiner nodes
      inputs = tierNodes.map(n => n.id);
      tier++;
    }

    // Final stage
    const finalStageId = `${stageIdBase}-final`;
    const finalPrompt = combine.finalPromptTemplate ?? combine.promptTemplate;
    const finalTaskPrompt = interpolateCombineVariables(finalPrompt, { tier: 0, group: 0, memberCount: inputs.length });
    const finalOutputPath = `${stageIdBase}-final.out`;
    if (allOutputPaths.has(finalOutputPath)) {
      throw new Error(`expand: duplicate output path "${finalOutputPath}" (final combiner must have unique path)`);
    }
    allOutputPaths.add(finalOutputPath);

    const finalNode = {
      id: `${finalStageId}-node`, // node id must NOT collide with the stage id (parsePlan: shared namespace)
      agent: {
        ...(combine.seat ? { seat: combine.seat } : {}),
        ...(combine.model ? { model: combine.model } : {}),
        ...(combine.runner ? { runner: combine.runner } : {}),
      },
      taskPrompt: finalTaskPrompt,
      consumes: inputs,
      contract: {
        outputPath: finalOutputPath,
        ...(combine.judge ? { judge: combine.judge } : {}),
      },
      effortHint: 'high',
      ...(combine.tools ? { tools: [...combine.tools] } : {}),
      ...(combine.toolsMode ? { toolsMode: combine.toolsMode } : {}),
    };

    const finalStage = {
      id: finalStageId,
      title: 'Final combine',
      nodes: [finalNode],
    };
    stages.push(finalStage);
  }

  // Build the final plan JSON
  const planJson = {
    name: template.planName ?? `expanded-${template.stageId}`,
    description: template.planDescription ?? `Expanded ${leafNodes.length}-node build stage from a work-list manifest (F2).`,
    stages,
  };

  const parsed = parsePlan(planJson);
  if (!parsed.ok) throw new Error(`expand produced an invalid plan: ${parsed.errors.join('; ')}`);
  return parsed.plan;
}

/** Interpolate {{item.<key>}} (one level, values coerced to string) and {{i}} (the item index). An unknown
 *  key is left literal (no silent blank), matching renderTaskPrompt's discipline. */
function interpolate(tpl: string, item: ManifestItem, i: number): string {
  return tpl
    .replace(/\{\{\s*item\.(\w+)\s*\}\}/g, (whole, key: string) =>
      Object.prototype.hasOwnProperty.call(item, key) ? String(item[key]) : whole)
    .replace(/\{\{\s*i\s*\}\}/g, String(i));
}

/** Interpolate combiner-specific placeholders: {{tier}}, {{group}}, {{memberCount}}. */
function interpolateCombineVariables(tpl: string, context: { tier: number; group: number; memberCount: number }): string {
  return tpl
    .replace(new RegExp("\\{\\{\\s*tier\\s*\\}\\}", "g"), String(context.tier))
    .replace(new RegExp("\\{\\{\\s*group\\s*\\}\\}", "g"), String(context.group))
    .replace(new RegExp("\\{\\{\\s*memberCount\\s*\\}\\}", "g"), String(context.memberCount));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
