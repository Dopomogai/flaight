// @purpose: makeSimGenerate — a stubbed CouncilGenerate that drives a FULL fleet run with $0 spend (F-SIM)
// @why: The founder's ask — "simulated runs with stubbed agent responses, check how data will be flowing."
//       Because deps.generate is the ONLY model seam (run.ts), a simulation is just a different generate: the
//       REAL runner still assembles every pack, writes + consumes every .out, enforces F3, and records judges —
//       nothing about run.ts changes. The stub dispatches on the two stable anchors run.ts always emits: the
//       judge's system ("strict quality judge") and the pack's contract line ("lands at: <outputPath>"). Node
//       output resolves as: a pinned fixture file → a SCHEMA-SYNTHESIZED instance (so it PASSES the same F3
//       check the real output would) → a plain placeholder. This is why F3 lands before F-SIM: a sim that
//       pumped placeholder prose through typed edges would prove nothing about the data flow.
// @role: tooling
// @stability: experimental

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CouncilGenerate } from '../council/types';
import type { FleetPlan, Node } from './plan';

export interface SimOpts {
  /** Directory holding pinned outputs: <fixturesDir>/<planName>/<nodeId>.out overrides synthesis for that node. */
  fixturesDir?: string;
  /** @deprecated dec-246 — prefer judgeAccept. Kept so old callers still compile. */
  judgeScore?: number;
  /** Binary sim verdict (default ACCEPT). false → RETURN with a concrete reason. */
  judgeAccept?: boolean;
}

/** Build a CouncilGenerate that simulates the fleet. Pure w.r.t. the model (no network); only reads fixtures. */
export function makeSimGenerate(plan: FleetPlan, opts: SimOpts = {}): CouncilGenerate {
  // dec-246: binary sim verdict. Legacy judgeScore still accepted: >=0.5 → ACCEPT.
  const judgeAccept = opts.judgeAccept ?? ((opts.judgeScore ?? 0.9) >= 0.5);
  // Map every node's outputPath → node, so a pack prompt ("lands at: <path>") resolves back to its node.
  const byOutputPath = new Map<string, Node>();
  for (const stage of plan.stages) for (const n of stage.nodes) byOutputPath.set(n.contract.outputPath, n);

  return async ({ system, prompt }) => {
    // 1) Judge call — run.ts's judge system always contains "quality REVIEWER" (legacy: "strict quality judge").
    if (system.includes('quality REVIEWER') || system.includes('strict quality judge')) {
      const text = judgeAccept
        ? 'REVIEW:\n- sim deliverable meets the rubric\nVERDICT: ACCEPT'
        : 'REVIEW:\n- sim deliverable fails the rubric\nVERDICT: RETURN — simulated defect: deliverable does not satisfy the contract rubric';
      return { text, genId: 'sim-judge', finishReason: 'stop', toolCalls: [] };
    }

    // 2) Node call — resolve the node from the contract line the pack always renders.
    const m = prompt.match(/lands at:\s*(\S+)/);
    const node = m ? byOutputPath.get(m[1]) : undefined;
    if (!node) {
      return { text: '[sim output — node unresolved]', genId: 'sim', finishReason: 'stop', toolCalls: [] };
    }

    // 2a) A pinned fixture wins (lets a human anchor a realistic output for a specific node).
    if (opts.fixturesDir) {
      const fx = resolve(opts.fixturesDir, plan.name, `${node.id}.out`);
      if (existsSync(fx)) {
        return { text: readFileSync(fx, 'utf8'), genId: 'sim-fixture', finishReason: 'stop', toolCalls: [] };
      }
    }

    // 2b) Schema-shaped synthesis (passes F3) if the node declares one; else a plain placeholder.
    const text = node.contract.schema !== undefined
      ? JSON.stringify(synthesizeFromSchema(node.contract.schema), null, 2)
      : `[sim output for ${node.id}]`;
    return { text, genId: 'sim', finishReason: 'stop', toolCalls: [] };
  };
}

/** Build a MINIMAL value satisfying a JSON-Schema-ish node (the same subset schema-check.ts validates). Arrays
 *  get one element so downstream expand/consume logic has something to work with; enums take their first value. */
export function synthesizeFromSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return 'sim';
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = typeof schema.type === 'string' ? schema.type : undefined;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = isRecord(schema.properties) ? schema.properties : {};
      // Include every declared property (a superset of `required`) so required keys are always present + valid.
      for (const [key, sub] of Object.entries(props)) out[key] = synthesizeFromSchema(sub);
      // Any required key without a property definition still needs to exist.
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) if (typeof key === 'string' && !(key in out)) out[key] = 'sim';
      }
      return out;
    }
    case 'array':
      return isRecord(schema.items) ? [synthesizeFromSchema(schema.items)] : [];
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'string':
      return 'sim';
    default:
      return 'sim';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
