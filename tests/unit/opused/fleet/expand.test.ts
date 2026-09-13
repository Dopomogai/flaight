// @purpose: Unit tests for F2 — expandManifest turns a work-list × a template into a validated build plan
// @why: The divide half of gather/divide is where a bad manifest must fail LOUDLY and for $0: a produced plan
//       is only accepted if parsePlan validates it, and parallel writers must own disjoint output paths or
//       expansion refuses. These pin: a well-formed manifest expands to a valid N-node plan; duplicate target
//       paths throw; a malformed manifest throws with a clear message; interpolation lands item fields in the
//       right node slots.
// @role: safety-critical test
// @stability: experimental

import { describe, it, expect } from 'vitest';
import { expandManifest, type NodeTemplate } from '../../../../lib/opused/fleet/expand';
import { parsePlan } from '../../../../lib/opused/fleet/plan';

const TEMPLATE: NodeTemplate = {
  stageId: 'build',
  stageTitle: 'Per-file fixes',
  seat: 'fixer',
  taskPromptTemplate: 'Fix {{item.path}}: {{item.instruction}}',
  outputPathPattern: 'build-{{item.id}}.out',
  effortHint: 'medium',
};

const manifest = (n: number) => ({
  items: Array.from({ length: n }, (_, i) => ({ id: `f${i}`, path: `lib/x/f${i}.ts`, instruction: `add tests to f${i}` })),
});

describe('expandManifest (F2)', () => {
  it('expands an N-item manifest into a valid N-node single-stage plan', () => {
    const plan = expandManifest(manifest(5), TEMPLATE);
    expect(plan.stages).toHaveLength(1);
    expect(plan.stages[0].nodes).toHaveLength(5);
    // The produced plan re-validates (expandManifest already ran parsePlan, but assert independently).
    expect(parsePlan(plan).ok).toBe(true);
    expect(plan.stages[0].nodes[0].id).toBe('build-f0');
    expect(plan.stages[0].nodes[0].agent.seat).toBe('fixer');
  });

  it('interpolates {{item.*}} into the taskPrompt and outputPath', () => {
    const plan = expandManifest(manifest(2), TEMPLATE);
    const n1 = plan.stages[0].nodes[1];
    expect(n1.taskPrompt).toBe('Fix lib/x/f1.ts: add tests to f1');
    expect(n1.contract.outputPath).toBe('build-f1.out');
  });

  it('refuses when items map to duplicate output paths (disjoint-writer guard)', () => {
    const constPath: NodeTemplate = { ...TEMPLATE, outputPathPattern: 'same.out' };
    expect(() => expandManifest(manifest(3), constPath)).toThrow(/duplicate output path "same\.out"/);
  });

  it('throws a clear error when the manifest has no items[]', () => {
    expect(() => expandManifest({ nope: true }, TEMPLATE)).toThrow(/no items\[\]/);
  });

  it('throws when the manifest is empty', () => {
    expect(() => expandManifest({ items: [] }, TEMPLATE)).toThrow(/empty/);
  });

  it('throws when an item lacks a string id', () => {
    expect(() => expandManifest({ items: [{ path: 'x' }] }, TEMPLATE)).toThrow(/item 0 has no string "id"/);
  });

  it('carries an optional schema + judge from the template into every node contract', () => {
    const withContract: NodeTemplate = {
      ...TEMPLATE,
      schema: { type: 'object', required: ['done'] },
      judge: { rubric: 'is the fix real', threshold: 0.7 },
    };
    const plan = expandManifest(manifest(2), withContract);
    for (const node of plan.stages[0].nodes) {
      expect(node.contract.schema).toEqual({ type: 'object', required: ['done'] });
      expect(node.contract.judge?.threshold).toBe(0.7);
    }
  });
});
