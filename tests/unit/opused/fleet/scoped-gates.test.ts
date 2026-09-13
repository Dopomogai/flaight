// @purpose: Tests for F4c scoped gates — gateScope 'unit' vs 'repo' in plan schema + run.ts gate dispatch
// @why: U4 of the B3+B4 spec: a unit-scoped stage runs a lightweight per-file transpile per node and defers
//       full tsc+tests to the stage barrier; repo scope (default) keeps today's per-node full gates.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan } from '../../../../lib/opused/fleet/plan';
import { runPlan, type RunDeps } from '../../../../lib/opused/fleet/run';
import type { CouncilGenerate } from '../../../../lib/opused/council/types';

let runsRoot: string;
beforeEach(() => { runsRoot = mkdtempSync(join(tmpdir(), 'scoped-gates-')); });
afterEach(() => rmSync(runsRoot, { recursive: true, force: true }));

/** A minimal single-node plan (no schema, no judge) — the node emits plain text and the repair loop runs once. */
function makePlan(gateScope?: 'unit' | 'repo') {
  const stage: Record<string, unknown> = {
    id: 's1',
    title: 'stage one',
    nodes: [{
      id: 'n1',
      agent: { model: 'test-model' },
      taskPrompt: 'produce the deliverable',
      consumes: [],
      contract: { outputPath: 'n1.out' },
    }],
  };
  if (gateScope) stage.gateScope = gateScope;
  return {
    name: 'scoped-gate-test',
    description: 'test plan for scoped gates',
    stages: [stage],
  };
}

function parsePlanOrThrow(json: unknown) {
  const r = parsePlan(json);
  if (!r.ok) throw new Error('fixture plan invalid: ' + r.errors.join('; '));
  return r.plan;
}

/** Zero-spend generate stub: returns a non-empty deliverable so the node reaches the gate dispatch. */
const stubGenerate: CouncilGenerate = async () => ({
  text: 'this is the deliverable output text',
  genId: 'stub',
  finishReason: 'stop',
});

function makeDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    generate: stubGenerate,
    defaultModel: 'test-model',
    runsRoot,
    now: () => '2026-07-09T00:00:00.000Z',
    maxRepairs: 0,
    ...overrides,
  };
}

describe('plan.ts: gateScope schema', () => {
  it('accepts gateScope: "unit" on a stage', () => {
    const result = parsePlan(makePlan('unit'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.stages[0].gateScope).toBe('unit');
    }
  });

  it('defaults gateScope to "repo" when absent', () => {
    const result = parsePlan(makePlan());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.stages[0].gateScope).toBe('repo');
    }
  });
});

describe('run.ts: unit scope gate dispatch', () => {
  it('calls verifyUnitWrite instead of verifyWrite per node', async () => {
    const verifyWrite = vi.fn(async () => ({ ok: true, report: '' }));
    const verifyUnitWrite = vi.fn(async () => ({ ok: true, report: '' }));
    const plan = parsePlanOrThrow(makePlan('unit'));
    const res = await runPlan(plan, 'run-unit-1', makeDeps({ verifyWrite, verifyUnitWrite }));
    expect(res.outcomes).toHaveLength(1);
    expect(verifyUnitWrite).toHaveBeenCalledTimes(1);
    expect(verifyWrite).not.toHaveBeenCalled();
  });

  it('skips per-node verifyTests when gateScope is unit and barrier is wired', async () => {
    const verifyTests = vi.fn(async () => ({ ok: true, report: '', ran: [] }));
    const verifyUnitWrite = vi.fn(async () => ({ ok: true, report: '' }));
    const verifyStageBarrier = vi.fn(async () => ({ ok: true, report: '', testsRan: [] }));
    const plan = parsePlanOrThrow(makePlan('unit'));
    await runPlan(plan, 'run-unit-2', makeDeps({ verifyTests, verifyUnitWrite, verifyStageBarrier }));
    expect(verifyTests).not.toHaveBeenCalled();
  });

  it('calls verifyStageBarrier after stage completes', async () => {
    const verifyUnitWrite = vi.fn(async () => ({ ok: true, report: '' }));
    const verifyStageBarrier = vi.fn(async () => ({ ok: true, report: '', testsRan: ['lib/foo.test.ts'] }));
    const plan = parsePlanOrThrow(makePlan('unit'));
    const res = await runPlan(plan, 'run-unit-3', makeDeps({ verifyUnitWrite, verifyStageBarrier }));
    expect(verifyStageBarrier).toHaveBeenCalledTimes(1);
    // barrier passed with testsRan → done node gets testsOk=true
    expect(res.outcomes[0].testsOk).toBe(true);
  });
});

describe('run.ts: repo scope (default) gate dispatch', () => {
  it('calls verifyWrite + verifyTests per node, no barrier', async () => {
    const verifyWrite = vi.fn(async () => ({ ok: true, report: '' }));
    const verifyTests = vi.fn(async () => ({ ok: true, report: '', ran: ['lib/foo.test.ts'] }));
    const verifyStageBarrier = vi.fn(async () => ({ ok: true, report: '', testsRan: [] }));
    const plan = parsePlanOrThrow(makePlan());
    const res = await runPlan(plan, 'run-repo-1', makeDeps({ verifyWrite, verifyTests, verifyStageBarrier }));
    expect(verifyWrite).toHaveBeenCalledTimes(1);
    expect(verifyTests).toHaveBeenCalledTimes(1);
    expect(verifyStageBarrier).not.toHaveBeenCalled();
    // repo scope: per-node tests ran and passed → testsOk=true from the per-node gate
    expect(res.outcomes[0].testsOk).toBe(true);
  });
});
