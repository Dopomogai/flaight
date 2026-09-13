// @purpose: Epic-6 --rerun-failed: re-run failed/skipped/ungated + optionally disputed (trust spine)
// @why: Plain --resume caches committed done nodes even when judgeDisputed/verified=false; the trust
//       spine says that is NOT verified work. These tests pin includeDisputed ON vs OFF, failed/skipped
//       re-run parity, old-journal resume parity, and pre-flight CACHE vs RE-RUN sets — all $0 stubs.
// @role: safety-critical test
// @stability: experimental

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan, type FleetPlan } from '../../../../lib/opused/fleet/plan';
import {
  runPlan,
  collectDisputedNodeIds,
  buildRerunPreflight,
  NODE_COMMITTED_FILE,
  type RunEvent,
} from '../../../../lib/opused/fleet/run';
import type { CouncilGenerate } from '../../../../lib/opused/council/types';

let runsRoot: string;
beforeEach(() => {
  runsRoot = mkdtempSync(join(tmpdir(), 'fleet-rerun-'));
});
afterEach(() => rmSync(runsRoot, { recursive: true, force: true }));

function node(id: string, consumes: string[] = [], extra: Record<string, unknown> = {}) {
  return {
    id,
    agent: {},
    taskPrompt: `do ${id}`,
    consumes,
    contract: { outputPath: `${id}.out`, ...(extra.contract as object ?? {}) },
  };
}

function plan(stages: unknown[]): FleetPlan {
  const r = parsePlan({ name: 'x', description: 'y', stages });
  if (!r.ok) throw new Error('fixture plan invalid: ' + r.errors.join('; '));
  return r.plan;
}

function echoStub(seen: { model: string; prompt: string }[]): CouncilGenerate {
  return async ({ model, prompt }) => {
    seen.push({ model, prompt });
    const m = prompt.match(/do ([\w-]+)/);
    return { text: `OUTPUT[${m?.[1] ?? 'unknown'}]`, genId: 'g', finishReason: 'stop', toolCalls: [] };
  };
}

const readLog = (runDir: string): RunEvent[] =>
  readFileSync(join(runDir, 'run.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** Seed a committed node whose journal last finish is disputed (gate-convergence). */
function seedDisputedCommitted(runDir: string, nodeId: string, stageId = 's1'): void {
  mkdirSync(join(runDir, 'nodes', nodeId), { recursive: true });
  writeFileSync(join(runDir, `${nodeId}.out`), `STALE[${nodeId}]`, 'utf8');
  writeFileSync(
    join(runDir, 'nodes', nodeId, NODE_COMMITTED_FILE),
    JSON.stringify({ nodeId, stageId, status: 'done', outputPath: `${nodeId}.out` }) + '\n',
    'utf8',
  );
}

function appendJournal(runDir: string, events: object[]): void {
  const path = join(runDir, 'run.jsonl');
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : '') + lines, 'utf8');
}

describe('Epic-6 — collectDisputedNodeIds', () => {
  it('last node_finish wins (clears an older disputed finish)', () => {
    const jsonl = [
      JSON.stringify({ type: 'node_finish', nodeId: 'a', detail: { judgeDisputed: true, verified: false } }),
      JSON.stringify({ type: 'node_finish', nodeId: 'a', detail: { verified: true } }),
      JSON.stringify({ type: 'node_finish', nodeId: 'b', detail: { verified: false } }),
      'not-json',
      JSON.stringify({ type: 'node_finish', nodeId: 'c', detail: { judgeDisputed: true } }),
    ].join('\n');
    const set = collectDisputedNodeIds(jsonl);
    expect(set.has('a')).toBe(false);
    expect(set.has('b')).toBe(true);
    expect(set.has('c')).toBe(true);
  });

  it('old journals without verified/judgeDisputed return empty (resume parity)', () => {
    const jsonl = [
      JSON.stringify({ type: 'node_finish', nodeId: 'a', detail: { bytes: 10 } }),
      JSON.stringify({ type: 'node_cached', nodeId: 'b', detail: { bytes: 5 } }),
    ].join('\n');
    expect(collectDisputedNodeIds(jsonl).size).toBe(0);
  });
});

describe('Epic-6 — rerunFailed includeDisputed cache skip', () => {
  it('(a) includeDisputed ON re-runs a committed-but-disputed node (no cache)', async () => {
    const p = plan([{ id: 's1', title: 't', nodes: [node('a')] }]);
    // First live run seeds planHash + committed verified path.
    await runPlan(p, 'disp-on', { generate: echoStub([]), defaultModel: 'm', runsRoot });
    const runDir = join(runsRoot, 'disp-on');
    // Overwrite journal finish to disputed (keep committed + .out — the trust-spine case).
    appendJournal(runDir, [
      {
        type: 'node_finish',
        stageId: 's1',
        nodeId: 'a',
        status: 'done',
        detail: { bytes: 9, judgeDisputed: true, verified: false, passReason: 'gate-convergence' },
      },
    ]);
    // Keep the committed marker from the first run (already present).
    expect(existsSync(join(runDir, 'nodes', 'a', NODE_COMMITTED_FILE))).toBe(true);
    const priorOut = readFileSync(join(runDir, 'a.out'), 'utf8');

    const seen: { model: string; prompt: string }[] = [];
    const res = await runPlan(p, 'disp-on', {
      generate: echoStub(seen),
      defaultModel: 'm',
      runsRoot,
      resume: true,
      rerunFailed: { includeDisputed: true },
    });

    expect(seen.length).toBeGreaterThan(0); // model re-called
    expect(readLog(res.runDir).filter((e) => e.type === 'node_cached' && e.nodeId === 'a')).toHaveLength(0);
    expect(res.outcomes.find((o) => o.nodeId === 'a')!.status).toBe('done');
    // Never deleted the path — may be overwritten with new output, but file still exists.
    expect(existsSync(join(runDir, 'a.out'))).toBe(true);
    // Prior stale content is not required to remain after a successful re-write, but the path was never unlinked mid-run.
    expect(priorOut).toBeTruthy();
  });

  it('(b) includeDisputed OFF caches committed-but-disputed (= resume parity)', async () => {
    const p = plan([{ id: 's1', title: 't', nodes: [node('a')] }]);
    await runPlan(p, 'disp-off', { generate: echoStub([]), defaultModel: 'm', runsRoot });
    const runDir = join(runsRoot, 'disp-off');
    appendJournal(runDir, [
      {
        type: 'node_finish',
        stageId: 's1',
        nodeId: 'a',
        status: 'done',
        detail: { bytes: 9, judgeDisputed: true, verified: false },
      },
    ]);

    const seen: { model: string; prompt: string }[] = [];
    const res = await runPlan(p, 'disp-off', {
      generate: echoStub(seen),
      defaultModel: 'm',
      runsRoot,
      resume: true,
      rerunFailed: { includeDisputed: false },
    });

    expect(seen).toHaveLength(0);
    expect(readLog(res.runDir).some((e) => e.type === 'node_cached' && e.nodeId === 'a')).toBe(true);
    expect(res.outcomes.find((o) => o.nodeId === 'a')!.status).toBe('done');
  });

  it('(c) failed + skipped nodes re-run under includeDisputed ON and OFF', async () => {
    const p = plan([
      { id: 's1', title: 't', nodes: [node('a'), node('b')] },
      { id: 's2', title: 't', barrier: true, nodes: [node('c', ['a'])] },
    ]);
    // a fails (empty), b succeeds, c skips (upstream a failed).
    const failA: CouncilGenerate = async ({ prompt }) =>
      prompt.includes('do a')
        ? { text: '', genId: null, finishReason: 'stop' }
        : { text: 'OUTPUT[ok]', genId: 'g', finishReason: 'stop' };

    for (const includeDisputed of [true, false]) {
      const runId = `fs-${includeDisputed ? 'on' : 'off'}`;
      await runPlan(p, runId, { generate: failA, defaultModel: 'm', runsRoot });
      const runDir = join(runsRoot, runId);
      expect(existsSync(join(runDir, 'nodes', 'a', NODE_COMMITTED_FILE))).toBe(false);
      expect(existsSync(join(runDir, 'nodes', 'b', NODE_COMMITTED_FILE))).toBe(true);

      const seen: { model: string; prompt: string }[] = [];
      // Make a succeed this time so c can run.
      const fixA: CouncilGenerate = async ({ model, prompt }) => {
        seen.push({ model, prompt });
        const m = prompt.match(/do ([\w-]+)/);
        return { text: `OUTPUT[${m?.[1] ?? 'x'}]`, genId: 'g', finishReason: 'stop' };
      };
      const res = await runPlan(p, runId, {
        generate: fixA,
        defaultModel: 'm',
        runsRoot,
        resume: true,
        rerunFailed: { includeDisputed },
      });
      // a re-ran (failed, no commit); b cached; c re-ran (was skipped).
      expect(seen.some((s) => s.prompt.includes('do a'))).toBe(true);
      expect(seen.some((s) => s.prompt.includes('do b'))).toBe(false);
      expect(seen.some((s) => s.prompt.includes('do c'))).toBe(true);
      expect(res.outcomes.find((o) => o.nodeId === 'b')!.status).toBe('done');
      expect(readLog(res.runDir).some((e) => e.type === 'node_cached' && e.nodeId === 'b')).toBe(true);
    }
  });

  it('(d) old journals without verified/judgeDisputed fields behave as plain resume (cache)', async () => {
    const p = plan([{ id: 's1', title: 't', nodes: [node('a')] }]);
    await runPlan(p, 'legacy', { generate: echoStub([]), defaultModel: 'm', runsRoot });
    // Strip any verified/judgeDisputed from the journal by rewriting finishes without those fields.
    const runDir = join(runsRoot, 'legacy');
    const lines = readFileSync(join(runDir, 'run.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const e = JSON.parse(l) as RunEvent;
        if (e.type === 'node_finish' && e.detail) {
          const d = { ...e.detail } as Record<string, unknown>;
          delete d.verified;
          delete d.judgeDisputed;
          delete d.passReason;
          return JSON.stringify({ ...e, detail: d });
        }
        return l;
      });
    writeFileSync(join(runDir, 'run.jsonl'), lines.join('\n') + '\n', 'utf8');

    const seen: { model: string; prompt: string }[] = [];
    const res = await runPlan(p, 'legacy', {
      generate: echoStub(seen),
      defaultModel: 'm',
      runsRoot,
      resume: true,
      rerunFailed: { includeDisputed: true },
    });
    expect(seen).toHaveLength(0);
    expect(readLog(res.runDir).some((e) => e.type === 'node_cached')).toBe(true);
    expect(res.outcomes.find((o) => o.nodeId === 'a')!.status).toBe('done');
  });

  it('verified=false alone (without judgeDisputed) forces re-run when includeDisputed', async () => {
    const p = plan([{ id: 's1', title: 't', nodes: [node('a')] }]);
    await runPlan(p, 'vfalse', { generate: echoStub([]), defaultModel: 'm', runsRoot });
    appendJournal(join(runsRoot, 'vfalse'), [
      { type: 'node_finish', stageId: 's1', nodeId: 'a', status: 'done', detail: { bytes: 3, verified: false } },
    ]);
    const seen: { model: string; prompt: string }[] = [];
    await runPlan(p, 'vfalse', {
      generate: echoStub(seen),
      defaultModel: 'm',
      runsRoot,
      resume: true,
      rerunFailed: { includeDisputed: true },
    });
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe('Epic-6 — buildRerunPreflight', () => {
  it('(e) lists CACHED vs RE-RUN sets correctly', () => {
    const p = plan([
      { id: 's1', title: 't', nodes: [node('ok'), node('disp'), node('fail'), node('skip'), node('ungated'), node('never')] },
    ]);
    const runDir = join(runsRoot, 'preflight');
    mkdirSync(runDir, { recursive: true });

    // ok: committed + verified finish
    seedDisputedCommitted(runDir, 'ok');
    // disp: committed + disputed finish
    seedDisputedCommitted(runDir, 'disp');
    // ungated: .out without committed
    writeFileSync(join(runDir, 'ungated.out'), 'mid-crash', 'utf8');

    const jsonl = [
      { type: 'run_start', detail: { planHash: 'x' } },
      { type: 'node_finish', nodeId: 'ok', detail: { verified: true } },
      { type: 'node_finish', nodeId: 'disp', detail: { judgeDisputed: true, verified: false } },
      { type: 'node_fail', nodeId: 'fail', reason: 'empty' },
      { type: 'node_skip', nodeId: 'skip', reason: 'upstream' },
      { type: 'node_start', nodeId: 'ungated', stageId: 's1' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');

    const withDisp = buildRerunPreflight({ plan: p, runDir, jsonl, includeDisputed: true });
    expect(withDisp.cached).toEqual(['ok']);
    expect(withDisp.rerun).toEqual(
      expect.arrayContaining([
        { id: 'disp', reason: 'disputed' },
        { id: 'fail', reason: 'failed' },
        { id: 'skip', reason: 'skipped' },
        { id: 'ungated', reason: 'ungated' },
        { id: 'never', reason: 'pending' },
      ]),
    );
    expect(withDisp.rerun).toHaveLength(5);

    const noDisp = buildRerunPreflight({ plan: p, runDir, jsonl, includeDisputed: false });
    expect(noDisp.cached.sort()).toEqual(['disp', 'ok'].sort());
    expect(noDisp.rerun.map((r) => r.id).sort()).toEqual(['fail', 'never', 'skip', 'ungated'].sort());
  });

  it('does not mutate .out or committed markers', () => {
    const p = plan([{ id: 's1', title: 't', nodes: [node('a')] }]);
    const runDir = join(runsRoot, 'preflight-immutable');
    mkdirSync(runDir, { recursive: true });
    seedDisputedCommitted(runDir, 'a');
    const outBefore = readFileSync(join(runDir, 'a.out'), 'utf8');
    const commitBefore = readFileSync(join(runDir, 'nodes', 'a', NODE_COMMITTED_FILE), 'utf8');
    buildRerunPreflight({
      plan: p,
      runDir,
      jsonl: JSON.stringify({ type: 'node_finish', nodeId: 'a', detail: { judgeDisputed: true } }),
      includeDisputed: true,
    });
    expect(readFileSync(join(runDir, 'a.out'), 'utf8')).toBe(outBefore);
    expect(readFileSync(join(runDir, 'nodes', 'a', NODE_COMMITTED_FILE), 'utf8')).toBe(commitBefore);
  });
});

describe('Epic-6 — live disputed seed via judge RETURN', () => {
  it('includeDisputed re-runs a node that finished done-but-disputed from a real judge path', async () => {
    let judgeCalls = 0;
    const stub: CouncilGenerate = async ({ system, prompt }) => {
      if (system.includes('quality REVIEWER')) {
        judgeCalls++;
        return { text: 'REVIEW:\n- weak\nVERDICT: RETURN\nREASON: incomplete deliverable', genId: 'j', finishReason: 'stop' };
      }
      return { text: `OUTPUT for ${prompt.slice(0, 20)}`, genId: 'g', finishReason: 'stop' };
    };
    const p = plan([
      {
        id: 's1',
        title: 't',
        nodes: [
          {
            id: 'impl',
            agent: {},
            taskPrompt: 'do impl',
            consumes: [],
            contract: {
              outputPath: 'impl.out',
              judge: { rubric: 'complete?', onReturn: 'dispute' },
            },
          },
        ],
      },
    ]);
    const first = await runPlan(p, 'live-disp', {
      generate: stub,
      defaultModel: 'm',
      runsRoot,
      maxRepairs: 0,
    });
    expect(first.outcomes[0].status).toBe('done');
    expect(first.outcomes[0].judge?.verdict).toBe('RETURN');
    const finish = readLog(first.runDir).find((e) => e.type === 'node_finish');
    expect(finish?.detail).toMatchObject({ judgeDisputed: true, verified: false });
    expect(existsSync(join(first.runDir, 'nodes', 'impl', NODE_COMMITTED_FILE))).toBe(true);

    const seen: { model: string; prompt: string }[] = [];
    const seatCalls: CouncilGenerate = async (args) => {
      if (args.system?.includes('quality REVIEWER')) {
        return { text: 'VERDICT: ACCEPT', genId: 'j2', finishReason: 'stop' };
      }
      seen.push({ model: args.model, prompt: args.prompt });
      return { text: 'FIXED OUTPUT', genId: 'g2', finishReason: 'stop' };
    };
    const res = await runPlan(p, 'live-disp', {
      generate: seatCalls,
      defaultModel: 'm',
      runsRoot,
      resume: true,
      rerunFailed: { includeDisputed: true },
      maxRepairs: 0,
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(readLog(res.runDir).filter((e) => e.type === 'node_cached' && e.nodeId === 'impl')).toHaveLength(0);
    // .out path preserved (rewritten, not deleted)
    expect(existsSync(join(first.runDir, 'impl.out'))).toBe(true);
  });
});
