// @purpose: Unit tests for F-SIM — makeSimGenerate drives a full run for $0, shaped to pass F3
// @why: The simulation must (1) synthesize outputs that PASS the same schema check the real output would (else
//       the sim proves nothing about the typed data flow), (2) dispatch judge calls, (3) honor a pinned
//       fixture, and (4) actually flow data end-to-end through the real runner (a downstream node sees the
//       upstream sim output). All hermetic — no network, no spend.
// @role: tooling config
// @stability: experimental

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan, type FleetPlan } from '../../../../lib/opused/fleet/plan';
import { makeSimGenerate, synthesizeFromSchema } from '../../../../lib/opused/fleet/sim';
import { validateAgainstSchema } from '../../../../lib/opused/fleet/schema-check';
import { runPlan } from '../../../../lib/opused/fleet/run';

const SCHEMA = {
  type: 'object', required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, severity: { enum: ['low', 'high'] } } } } },
};

function planWithSchemaNode(): FleetPlan {
  const r = parsePlan({
    name: 'sim-plan', description: 'y',
    stages: [{ id: 's1', title: 't', nodes: [{ id: 'a', agent: {}, taskPrompt: 'do a', consumes: [], contract: { outputPath: 'a.out', schema: SCHEMA } }] }],
  });
  if (!r.ok) throw new Error('invalid: ' + r.errors.join('; '));
  return r.plan;
}

describe('synthesizeFromSchema', () => {
  it('produces an instance that satisfies its own schema', () => {
    const v = synthesizeFromSchema(SCHEMA);
    expect(validateAgainstSchema(v, SCHEMA)).toEqual({ ok: true });
    expect((v as { items: unknown[] }).items).toHaveLength(1); // arrays get one element
  });
  it('an enum synthesizes to its first value', () => {
    expect(synthesizeFromSchema({ enum: ['low', 'high'] })).toBe('low');
  });
});

describe('makeSimGenerate', () => {
  it('a node call returns schema-shaped output that passes F3', async () => {
    const gen = makeSimGenerate(planWithSchemaNode());
    const out = await gen({ model: 'sim', system: '', prompt: 'stuff\nWrite your deliverable so it lands at: a.out\nmore', maxOutputTokens: 100 });
    expect(validateAgainstSchema(JSON.parse(out.text), SCHEMA)).toEqual({ ok: true });
  });

  it('a judge call returns a binary VERDICT (dec-246)', async () => {
    const gen = makeSimGenerate(planWithSchemaNode(), { judgeScore: 0.77 });
    const out = await gen({ model: 'sim', system: 'You are a quality REVIEWER.', prompt: 'x', maxOutputTokens: 100 });
    expect(out.text).toMatch(/VERDICT:\s*ACCEPT/);
    const genFail = makeSimGenerate(planWithSchemaNode(), { judgeAccept: false });
    const outFail = await genFail({ model: 'sim', system: 'You are a quality REVIEWER.', prompt: 'x', maxOutputTokens: 100 });
    expect(outFail.text).toMatch(/VERDICT:\s*RETURN/);
    expect(outFail.text).toMatch(/simulated defect/i);
  });

  it('a pinned fixture overrides synthesis for its node', async () => {
    const fixturesDir = mkdtempSync(join(tmpdir(), 'sim-fx-'));
    mkdirSync(join(fixturesDir, 'sim-plan'), { recursive: true });
    writeFileSync(join(fixturesDir, 'sim-plan', 'a.out'), 'PINNED-FIXTURE-BODY', 'utf8');
    const gen = makeSimGenerate(planWithSchemaNode(), { fixturesDir });
    const out = await gen({ model: 'sim', system: '', prompt: 'lands at: a.out', maxOutputTokens: 100 });
    expect(out.text).toBe('PINNED-FIXTURE-BODY');
    rmSync(fixturesDir, { recursive: true, force: true });
  });
});

describe('F-SIM end-to-end — data flows through the real runner', () => {
  let runsRoot: string;
  beforeEach(() => { runsRoot = mkdtempSync(join(tmpdir(), 'sim-run-')); });
  afterEach(() => rmSync(runsRoot, { recursive: true, force: true }));

  it('a 2-stage plan runs fully under sim; the synthesizer consumes stage-1 output', async () => {
    const r = parsePlan({
      name: 'sim-2stage', description: 'y',
      stages: [
        { id: 's1', title: 'gather', nodes: [{ id: 'g', agent: {}, taskPrompt: 'do g', consumes: [], contract: { outputPath: 'g.out', schema: SCHEMA } }] },
        { id: 's2', title: 'build', barrier: true, nodes: [{ id: 'b', agent: {}, taskPrompt: 'do b', consumes: ['g'], contract: { outputPath: 'b.out' } }] },
      ],
    });
    if (!r.ok) throw new Error('invalid: ' + r.errors.join('; '));
    const res = await runPlan(r.plan, 'sim-e2e', { generate: makeSimGenerate(r.plan), defaultModel: 'sim', runsRoot });
    expect(res.done).toBe(2);
    expect(res.failed).toBe(0);
    expect(res.skipped).toBe(0);              // b's consume of g was satisfied → it ran (data flowed)
    expect(existsSync(join(res.runDir, 'g.out'))).toBe(true);
    expect(existsSync(join(res.runDir, 'b.out'))).toBe(true);
    // g's output is schema-valid JSON (F3 passed inside the run).
    expect(validateAgainstSchema(JSON.parse(readFileSync(join(res.runDir, 'g.out'), 'utf8')), SCHEMA)).toEqual({ ok: true });
  });
});
