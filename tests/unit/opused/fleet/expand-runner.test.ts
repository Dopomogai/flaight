// @purpose: CONTRACT tests — an expanded manifest fan-out can declare its runner and its tool grants
// @why: 2026-08-07: an 84-node per-file audit and a 117-node plan-harvest were both dispatched at the
//       subscription seam and BOTH died at the startup preflight — "cannot run api-runner nodes: <every
//       node>". Cause was not the manifests: expandManifest simply had no field for a runner, so every
//       plan it produced inherited AgentRef's `runner: 'api'` default. The founder's "one node per file,
//       500 nodes if needed" fan-out was structurally impossible on the only free seam, and the failure
//       surfaced as two silent non-starts rather than as a missing feature.
//       These tests pin the field on BOTH halves of the tree — leaves AND every combiner tier — because a
//       cli-grok leaf stage under api combiners fails the same preflight for the same reason.
// @role: safety-critical test
// @stability: experimental

import { describe, expect, it } from 'vitest';
import { expandManifest, type CombineSpec, type NodeTemplate } from '@/lib/opused/fleet/expand';
import type { FleetPlan } from '@/lib/opused/fleet/plan';

const manifest = (n: number) => ({ items: Array.from({ length: n }, (_, i) => ({ id: `f${i}`, path: `a/b${i}.ts` })) });

const template = (over: Partial<NodeTemplate> = {}): NodeTemplate => ({
  stageId: 'audit',
  stageTitle: 'audit one file',
  seat: 'analyst',
  taskPromptTemplate: 'read {{item.path}}',
  outputPathPattern: 'audit/{{item.id}}.out',
  ...over,
});

const combine = (over: Partial<CombineSpec> = {}): CombineSpec => ({
  groupSize: 8,
  stageId: 'audit-combine',
  seat: 'architect',
  promptTemplate: 'merge {{memberCount}}',
  ...over,
});

/** Every node in the plan, leaves and combiners alike — the preflight looks at all of them. */
function allNodes(plan: FleetPlan) {
  return plan.stages.flatMap((s) => s.nodes);
}

describe('expandManifest — runner', () => {
  it('propagates the declared runner to every leaf node', () => {
    const plan = expandManifest(manifest(5), template({ runner: 'cli-grok' }));
    expect(allNodes(plan)).toHaveLength(5);
    for (const n of allNodes(plan)) expect(n.agent.runner).toBe('cli-grok');
  });

  it('propagates the combine runner to every tier AND the root — not just the leaves', () => {
    // 20 leaves / groupSize 8 → 3 tier-1 combiners → 1 root. All 24 nodes must be cli-grok.
    const plan = expandManifest(manifest(20), template({ runner: 'cli-grok' }), combine({ runner: 'cli-grok' }));
    const nodes = allNodes(plan);
    expect(nodes).toHaveLength(24);
    expect(nodes.filter((n) => n.agent.runner === 'cli-grok')).toHaveLength(24);
  });

  it('THE 2026-08-07 REGRESSION: with no runner declared, every node is api — which the subscription seam refuses', () => {
    const plan = expandManifest(manifest(20), template(), combine());
    const apiNodes = allNodes(plan).filter((n) => n.agent.runner === 'api');
    // This is the pre-fix behaviour, pinned deliberately: the default is api, so a fan-out intended for
    // grok MUST say so. The bug was that it COULD not; the default itself is correct and stays.
    expect(apiNodes).toHaveLength(24);
  });

  it('a cli leaf stage under api combiners is still refused — so the combine runner is not optional in practice', () => {
    const plan = expandManifest(manifest(20), template({ runner: 'cli-grok' }), combine());
    const apiNodes = allNodes(plan).filter((n) => n.agent.runner === 'api');
    expect(apiNodes.map((n) => n.id)).toEqual([
      'audit-combine-t1-g0',
      'audit-combine-t1-g1',
      'audit-combine-t1-g2',
      'audit-combine-final-node',
    ]);
  });
});

describe('nested and unsafe outputPath', () => {
  it('accepts a nested outputPath — a 72-node fan-out needs subdirectories to stay navigable', () => {
    const plan = expandManifest(manifest(3), template({ runner: 'cli-grok', outputPathPattern: 'audit/{{item.id}}.out' }));
    expect(allNodes(plan).map((n) => n.contract.outputPath)).toEqual(['audit/f0.out', 'audit/f1.out', 'audit/f2.out']);
  });

  it('refuses a traversing outputPath at PARSE time, not at write time 40 nodes into a live fleet', () => {
    for (const bad of ['../escape.out', '/etc/passwd', 'a/../../b.out', 'C:\\x.out']) {
      expect(() => expandManifest(manifest(1), template({ runner: 'cli-grok', outputPathPattern: bad }))).toThrow(
        /invalid plan|run-relative/i,
      );
    }
  });
});

describe('expandManifest — tool grants', () => {
  it('grants the declared tools to every leaf, and copies rather than aliases the array', () => {
    const tools = ['local.read', 'local.grep'] as const;
    const plan = expandManifest(manifest(3), template({ runner: 'cli-grok', tools }));
    for (const n of allNodes(plan)) expect(n.tools).toEqual(['local.read', 'local.grep']);
    // A shared array reference across 500 nodes would let one node's mutation widen every other node's belt.
    const [a, b] = allNodes(plan);
    expect(a.tools).not.toBe(b.tools);
  });

  it('grants tools to the combiners too, and carries toolsMode through', () => {
    const plan = expandManifest(
      manifest(20),
      template({ runner: 'cli-grok', tools: ['local.read'] }),
      combine({ runner: 'cli-grok', tools: ['local.read'], toolsMode: 'replace' }),
    );
    const combiners = allNodes(plan).filter((n) => n.id.startsWith('audit-combine'));
    expect(combiners).toHaveLength(4);
    for (const n of combiners) {
      expect(n.tools).toEqual(['local.read']);
      expect(n.toolsMode).toBe('replace');
    }
  });

  it('omits tools entirely when none are declared, so the persona preset still decides', () => {
    const plan = expandManifest(manifest(2), template({ runner: 'cli-grok' }));
    for (const n of allNodes(plan)) expect(n.tools).toBeUndefined();
  });
});
