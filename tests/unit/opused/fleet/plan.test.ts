// @purpose: Unit tests for the fleet plan-graph contract (parsePlan) + its enforced invariants
// @why: parsePlan is the safety gate the staged runner trusts — if it lets a cycle, a forward reference, or a
//       contract-less node through, the box runs a graph with no ordering guarantee. Adversarial cases here
//       (cycle, self-ref, forward ref, same-stage peer, missing contract, id collisions) prove it fails closed.
// @role: safety-critical test
// @stability: experimental

import { describe, it, expect } from 'vitest';
import { parsePlan, indexPlan, resolveConsumedNodeIds, renderTaskPrompt } from '../../../../lib/opused/fleet/plan';

/** A minimal valid node (contract required). */
function node(id: string, consumes: string[] = [], extra: Record<string, unknown> = {}) {
  return { id, agent: {}, taskPrompt: `do ${id}`, consumes, contract: { outputPath: `${id}.out` }, ...extra };
}

describe('parsePlan — happy path', () => {
  it('accepts a 2-stage plan with a barrier synthesizer consuming an earlier stage', () => {
    const r = parsePlan({
      name: 'x', description: 'y',
      stages: [
        { id: 's1', title: 'analyze', nodes: [node('a'), node('b')] },
        { id: 's2', title: 'synth', barrier: true, nodes: [node('c', ['s1'])] },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.stages).toHaveLength(2);
  });

  it('accepts a node consuming a specific earlier NODE id', () => {
    const r = parsePlan({
      name: 'x', description: 'y',
      stages: [
        { id: 's1', title: 't', nodes: [node('a')] },
        { id: 's2', title: 't', nodes: [node('b', ['a'])] },
      ],
    });
    expect(r.ok).toBe(true);
  });
});

describe('parsePlan — agent.runner (CR-1 / dec-040)', () => {
  it('defaults omitted runner to api (legacy plans unchanged)', () => {
    const r = parsePlan({
      name: 'legacy',
      description: 'pre-CR plan',
      stages: [{ id: 's1', title: 't', nodes: [node('a')] }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.stages[0].nodes[0].agent.runner).toBe('api');
  });

  it('accepts explicit api / cli-claude / cli-grok / cli-codex / conversational', () => {
    for (const runner of ['api', 'cli-claude', 'cli-grok', 'cli-codex', 'conversational'] as const) {
      const r = parsePlan({
        name: 'r',
        description: 'd',
        stages: [
          {
            id: 's1',
            title: 't',
            nodes: [node('a', [], { agent: { seat: 'impl', runner } })],
          },
        ],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.plan.stages[0].nodes[0].agent.runner).toBe(runner);
    }
  });

  it('rejects unknown runner kind', () => {
    const r = parsePlan({
      name: 'x',
      description: 'y',
      stages: [
        {
          id: 's1',
          title: 't',
          nodes: [node('a', [], { agent: { runner: 'cli-unknown-backend' } })],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/runner|Invalid/i);
  });

  it('accepts session + turns + cwd on agent', () => {
    const r = parsePlan({
      name: 'x',
      description: 'y',
      stages: [
        {
          id: 's1',
          title: 't',
          nodes: [
            node('a', [], {
              agent: {
                runner: 'cli-claude',
                session: { mode: 'resume', id: 'sess-1' },
                turns: { max: 8, digestEvery: 2 },
                cwd: '/tmp/sandbox',
              },
            }),
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.plan.stages[0].nodes[0].agent;
    expect(a.session).toEqual({ mode: 'resume', id: 'sess-1' });
    expect(a.turns).toEqual({ max: 8, digestEvery: 2 });
    expect(a.cwd).toBe('/tmp/sandbox');
  });

  it('rejects bad session.mode', () => {
    const r = parsePlan({
      name: 'x',
      description: 'y',
      stages: [
        {
          id: 's1',
          title: 't',
          nodes: [node('a', [], { agent: { session: { mode: 'teleport' } } })],
        },
      ],
    });
    expect(r.ok).toBe(false);
  });
});

describe('parsePlan — shape rejections (zod)', () => {
  it('rejects a node with no contract', () => {
    const r = parsePlan({
      name: 'x', description: 'y',
      stages: [{ id: 's1', title: 't', nodes: [{ id: 'a', agent: {}, taskPrompt: 'do a', consumes: [] }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/contract/i);
  });

  it('rejects an empty stages array', () => {
    const r = parsePlan({ name: 'x', description: 'y', stages: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects a stage with no nodes', () => {
    const r = parsePlan({ name: 'x', description: 'y', stages: [{ id: 's1', title: 't', nodes: [] }] });
    expect(r.ok).toBe(false);
  });
});

describe('parsePlan — graph invariant rejections', () => {
  it('rejects a self-referencing node', () => {
    const r = parsePlan({
      name: 'x', description: 'y',
      stages: [{ id: 's1', title: 't', nodes: [node('a', ['a'])] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/consumes itself/);
  });

  it('rejects a forward reference (consuming a LATER stage)', () => {
    const r = parsePlan({
      name: 'x', description: 'y',
      stages: [
        { id: 's1', title: 't', nodes: [node('a', ['s2'])] },
        { id: 's2', title: 't', nodes: [node('b')] },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/earlier stages only/);
  });

  it('rejects a same-stage peer reference (no ordering guarantee within a stage)', () => {
    const r = parsePlan({
      name: 'x', description: 'y',
      stages: [{ id: 's1', title: 't', nodes: [node('a'), node('b', ['a'])] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/earlier stages only/);
  });

  it('rejects a 2-node cycle across stages (b←a in s2, but s2 is later so a←b would be forward)', () => {
    // A cycle is impossible once forward-refs are banned; prove the canonical attempt fails.
    const r = parsePlan({
      name: 'x', description: 'y',
      stages: [
        { id: 's1', title: 't', nodes: [node('a', ['b'])] },  // a consumes b (in s2 — forward)
        { id: 's2', title: 't', nodes: [node('b')] },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown consume reference', () => {
    const r = parsePlan({
      name: 'x', description: 'y',
      stages: [
        { id: 's1', title: 't', nodes: [node('a')] },
        { id: 's2', title: 't', nodes: [node('b', ['does-not-exist'])] },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/unknown id/);
  });

  it('rejects duplicate node ids', () => {
    const r = parsePlan({
      name: 'x', description: 'y',
      stages: [
        { id: 's1', title: 't', nodes: [node('a')] },
        { id: 's2', title: 't', nodes: [node('a')] },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/duplicate node id/);
  });

  it('rejects a node id colliding with a stage id', () => {
    const r = parsePlan({
      name: 'x', description: 'y',
      stages: [
        { id: 's1', title: 't', nodes: [node('a')] },
        { id: 's2', title: 't', nodes: [node('s1')] },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/collides with a stage id/);
  });

  it('reports MULTIPLE errors in one pass (not just the first)', () => {
    const r = parsePlan({
      name: 'x', description: 'y',
      stages: [{ id: 's1', title: 't', nodes: [node('a', ['a']), node('b', ['nope'])] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('helpers', () => {
  const plan = {
    name: 'x', description: 'y',
    stages: [
      { id: 's1', title: 't', nodes: [node('a'), node('b')] },
      { id: 's2', title: 't', barrier: true, nodes: [node('c', ['s1'])] },
    ],
  };

  it('indexPlan maps every node id with its stage', () => {
    const parsed = parsePlan(plan);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const idx = indexPlan(parsed.plan);
    expect(idx.get('a')?.stageIndex).toBe(0);
    expect(idx.get('c')?.stageIndex).toBe(1);
  });

  it('resolveConsumedNodeIds expands a stage-id ref to all its node ids', () => {
    const parsed = parsePlan(plan);
    if (!parsed.ok) throw new Error('plan invalid');
    expect(resolveConsumedNodeIds(parsed.plan, 's1').sort()).toEqual(['a', 'b']);
    expect(resolveConsumedNodeIds(parsed.plan, 'a')).toEqual(['a']);
  });

  it('renderTaskPrompt interpolates the template form', () => {
    expect(renderTaskPrompt('plain')).toBe('plain');
    expect(renderTaskPrompt({ template: 'hi {{name}} in {{place}}', inputs: { name: 'a', place: 'b' } }))
      .toBe('hi a in b');
    // an unfilled key is left literal (no silent blank)
    expect(renderTaskPrompt({ template: 'x {{missing}}', inputs: {} })).toBe('x {{missing}}');
  });
});

// ── F1: stage sharedConsumes validation ──
describe('sharedConsumes (F1)', () => {
  const mk = (sharedConsumes: string[], s1nodes: unknown[]) => parsePlan({
    name: 'x', description: 'y',
    stages: [
      { id: 's0', title: 't', nodes: [{ id: 'ctx', agent: {}, taskPrompt: 'p', consumes: [], contract: { outputPath: 'ctx.out' } }] },
      { id: 's1', title: 't', sharedConsumes, nodes: s1nodes },
    ],
  });
  const plainNode = (id: string, consumes: string[] = []) => ({ id, agent: {}, taskPrompt: 'p', consumes, contract: { outputPath: `${id}.out` } });

  it('accepts a shared ref to an earlier stage/node', () => {
    const r = mk(['ctx'], [plainNode('p')]);
    expect(r.ok).toBe(true);
  });

  it('rejects a shared ref to an unknown id', () => {
    const r = mk(['nope'], [plainNode('p')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/sharedConsumes unknown id "nope"/);
  });

  it('rejects a shared ref that is not in an earlier stage (same-stage node)', () => {
    const r = mk(['p'], [plainNode('p'), plainNode('q')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/sharedConsumes .* not in an earlier stage/);
  });

  it('rejects a node that ALSO lists a shared ref in its own consumes (no double-render)', () => {
    const r = mk(['ctx'], [plainNode('p', ['ctx'])]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/already stage-shared/);
  });

  it('defaults sharedConsumes to [] when omitted (backward-compat)', () => {
    const r = parsePlan({
      name: 'x', description: 'y',
      stages: [{ id: 's1', title: 't', nodes: [plainNode('a')] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.stages[0].sharedConsumes).toEqual([]);
  });
});

describe('JudgeSpecSchema — dec-judge-seam additive keys', () => {
  it('accepts runner / requireToolEvidence / onReturn', () => {
    const r = parsePlan({
      name: 'j',
      description: 'd',
      stages: [
        {
          id: 's1',
          title: 't',
          nodes: [
            node('a', [], {
              contract: {
                outputPath: 'a.out',
                judge: {
                  rubric: 'is it good',
                  runner: 'cli-grok',
                  requireToolEvidence: true,
                  onReturn: 'fail-node',
                },
              },
            }),
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const j = r.plan.stages[0].nodes[0].contract.judge!;
    expect(j.runner).toBe('cli-grok');
    expect(j.requireToolEvidence).toBe(true);
    expect(j.onReturn).toBe('fail-node');
  });

  it('legacy judge {rubric, threshold} still parses (182 plans)', () => {
    const r = parsePlan({
      name: 'legacy-j',
      description: 'd',
      stages: [
        {
          id: 's1',
          title: 't',
          nodes: [node('a', [], { contract: { outputPath: 'a.out', judge: { rubric: 'r', threshold: 0.7 } } })],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects unknown judge keys (strict)', () => {
    const r = parsePlan({
      name: 'bad-j',
      description: 'd',
      stages: [
        {
          id: 's1',
          title: 't',
          nodes: [
            node('a', [], {
              contract: {
                outputPath: 'a.out',
                judge: { rubric: 'r', oracleMode: true },
              },
            }),
          ],
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects invalid runner / onReturn enums', () => {
    const badRunner = parsePlan({
      name: 'x',
      description: 'y',
      stages: [
        {
          id: 's1',
          title: 't',
          nodes: [
            node('a', [], {
              contract: { outputPath: 'a.out', judge: { rubric: 'r', runner: 'cli-codex' } },
            }),
          ],
        },
      ],
    });
    expect(badRunner.ok).toBe(false);
    const badRet = parsePlan({
      name: 'x',
      description: 'y',
      stages: [
        {
          id: 's1',
          title: 't',
          nodes: [
            node('a', [], {
              contract: { outputPath: 'a.out', judge: { rubric: 'r', onReturn: 'delete-out' } },
            }),
          ],
        },
      ],
    });
    expect(badRet.ok).toBe(false);
  });
});

describe('parsePlan — outputPath path language (placeholder + refuse)', () => {
  const base = (outputPath: string) => ({
    name: 'x',
    description: 'y',
    stages: [
      {
        id: 's1',
        title: 't',
        nodes: [
          {
            id: 'a',
            agent: {},
            taskPrompt: 'do a',
            consumes: [],
            contract: { outputPath },
          },
        ],
      },
    ],
  });

  it('accepts template ${var} form after placeholder neutralisation', () => {
    const r = parsePlan(base('${file1}--correctness.out'));
    expect(r.ok).toBe(true);
  });

  it('refuses traversal/absolute even when wrapped in ${var}', () => {
    expect(parsePlan(base('../${file1}.out')).ok).toBe(false);
    expect(parsePlan(base('/${file1}.out')).ok).toBe(false);
  });
});
