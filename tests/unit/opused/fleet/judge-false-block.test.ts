// @purpose: Adversarial coverage for judge false-block fixes (retry-once + trace-lost degrade)
// @why: JUDGE-RECOMMENDATION-2026-08-04 — empty-envelope flake + harness-lost tool trace forced RETURN on honest work
// @role: safety-critical test
// @stability: experimental

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan, type FleetPlan } from '../../../../lib/opused/fleet/plan';
import { runPlan, type RunEvent } from '../../../../lib/opused/fleet/run';
import type { CouncilGenerate } from '../../../../lib/opused/council/types';
import type { NodeExecutor } from '../../../../lib/opused/fleet/executor';

let runsRoot: string;
beforeEach(() => {
  runsRoot = mkdtempSync(join(tmpdir(), 'fleet-judge-fb-'));
});
afterEach(() => rmSync(runsRoot, { recursive: true, force: true }));

function plan(stages: unknown[]): FleetPlan {
  const r = parsePlan({ name: 'x', description: 'y', stages });
  if (!r.ok) throw new Error('fixture plan invalid: ' + r.errors.join('; '));
  return r.plan;
}

const readLog = (runDir: string): RunEvent[] =>
  readFileSync(join(runDir, 'run.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunEvent);

/** Injected CLI seat that never reports toolEvents → tool_trace_status lost (unavailable harvest). */
function lostTraceExecutor(text: string): NodeExecutor {
  return {
    kind: 'cli-grok',
    run: async () => ({
      text,
      // Omit toolEvents entirely — absorbExecResult leaves known=false → undefined channel.
      modelLabel: 'cli-grok',
      exitCode: 0,
    }),
  };
}

describe('judge false-block fixes (JUDGE-RECOMMENDATION-2026-08-04)', () => {
  it('(a) unparseable-then-parseable retry yields ACCEPT and records retry:1', async () => {
    let judgeCalls = 0;
    const stub: CouncilGenerate = async ({ system }) => {
      if (system.includes('quality REVIEWER') || system.includes('PARSE RETRY') || system.includes('no parseable VERDICT')) {
        judgeCalls++;
        if (judgeCalls === 1) {
          // Empty envelope / no VERDICT line (the 41-event flake class).
          return { text: 'Looks solid overall; score roughly high.', genId: 'j1', finishReason: 'stop' };
        }
        return {
          text: 'REVIEW:\n- ok\nEVIDENCE:\n- content review of deliverable\nVERDICT: ACCEPT',
          genId: 'j2',
          finishReason: 'stop',
        };
      }
      return { text: 'OUTPUT[a] honest synthesis', genId: 'g', finishReason: 'stop' };
    };
    const p = plan([
      {
        id: 's1',
        title: 't',
        nodes: [
          {
            id: 'a',
            agent: { seat: 'reviewer' },
            taskPrompt: 'do a',
            consumes: [],
            contract: {
              outputPath: 'a.out',
              judge: { rubric: 'is it good', requireToolEvidence: false },
            },
          },
        ],
      },
    ]);
    const res = await runPlan(p, 'fb-retry-ok', {
      generate: stub,
      defaultModel: 'm',
      runsRoot,
      maxRepairs: 0,
    });
    const a = res.outcomes.find((o) => o.nodeId === 'a')!;
    expect(a.status).toBe('done');
    expect(a.judge?.verdict).toBe('ACCEPT');
    expect(a.judge?.pass).toBe(true);
    expect(a.judge?.retry).toBe(1);
    expect(judgeCalls).toBe(2);
    const j = readLog(res.runDir).find((e) => e.type === 'judge');
    expect(j?.detail).toMatchObject({ verdict: 'ACCEPT', retry: 1 });
  });

  it('(b) unparseable-twice still forced RETURN (fail-closed)', async () => {
    let judgeCalls = 0;
    const stub: CouncilGenerate = async ({ system }) => {
      if (system.includes('quality REVIEWER') || system.includes('no parseable VERDICT')) {
        judgeCalls++;
        return { text: 'I have thoughts but no structured verdict.', genId: 'j', finishReason: 'stop' };
      }
      return { text: 'OUTPUT[a]', genId: 'g', finishReason: 'stop' };
    };
    const p = plan([
      {
        id: 's1',
        title: 't',
        nodes: [
          {
            id: 'a',
            agent: { seat: 'reviewer' },
            taskPrompt: 'do a',
            consumes: [],
            contract: {
              outputPath: 'a.out',
              judge: { rubric: 'r', requireToolEvidence: false },
            },
          },
        ],
      },
    ]);
    const res = await runPlan(p, 'fb-retry-fail', {
      generate: stub,
      defaultModel: 'm',
      runsRoot,
      maxRepairs: 0,
    });
    const a = res.outcomes.find((o) => o.nodeId === 'a')!;
    expect(judgeCalls).toBe(2);
    expect(a.judge?.verdict).toBe('RETURN');
    expect(a.judge?.pass).toBe(false);
    expect(a.judge?.retry).toBe(1);
    expect(a.judge?.reason).toMatch(/unparseable/i);
    // Default onReturn=dispute → still done with dispute flag; fail-closed is the verdict, not fail-node.
    expect(a.status).toBe('done');
    const j = readLog(res.runDir).find((e) => e.type === 'judge');
    expect(j?.detail).toMatchObject({ verdict: 'RETURN', retry: 1 });
  });

  it('(c) trace-unavailable no longer forces RETURN — model verdict wins, event stamped degraded', async () => {
    let judgeCalls = 0;
    const judgeGen: CouncilGenerate = async ({ system }) => {
      if (system.includes('quality REVIEWER')) {
        judgeCalls++;
        return {
          text: 'REVIEW:\n- deliverable meets rubric\nEVIDENCE:\n- candidate body is complete\nVERDICT: ACCEPT',
          genId: 'j',
          finishReason: 'stop',
        };
      }
      // Seat path unused when CLI executor is injected.
      return { text: 'seat', genId: 's', finishReason: 'stop' };
    };
    const p = plan([
      {
        id: 's1',
        title: 't',
        nodes: [
          {
            id: 'impl',
            agent: { runner: 'cli-grok', seat: 'implementer' },
            taskPrompt: 'implement the fix',
            consumes: [],
            contract: {
              outputPath: 'impl.out',
              // requireToolEvidence true would have forced trace-unavailable under the old overlay.
              judge: { rubric: 'did it implement', requireToolEvidence: true },
            },
          },
        ],
      },
    ]);
    const res = await runPlan(p, 'fb-trace-lost', {
      generate: async () => ({ text: 'unused', genId: 'g', finishReason: 'stop' }),
      judgeGenerate: judgeGen,
      defaultModel: 'm',
      runsRoot,
      maxRepairs: 0,
      sandboxRoot: runsRoot,
      writeIntent: () => true,
      executors: {
        'cli-grok': lostTraceExecutor(
          'CHANGE REGISTER: applied the fix in prices.ts via tools; suite green.',
        ),
      },
    });
    const impl = res.outcomes.find((o) => o.nodeId === 'impl')!;
    expect(impl.status).toBe('done');
    expect(judgeCalls).toBe(1);
    // Model ACCEPT stands — harness loss must not force RETURN.
    expect(impl.judge?.verdict).toBe('ACCEPT');
    expect(impl.judge?.pass).toBe(true);
    expect(impl.judge?.tool_trace_status).toBe('lost');
    expect(impl.judge?.overlay).toBe('degraded-trace-lost');
    expect(impl.judge?.zero_tool_calls).toBeNull();
    const j = readLog(res.runDir).find((e) => e.type === 'judge');
    expect(j?.detail).toMatchObject({
      verdict: 'ACCEPT',
      tool_trace_status: 'lost',
      overlay: 'degraded-trace-lost',
    });
    // Additive-only: core keys still present.
    expect(j?.detail).toHaveProperty('rubric');
    expect(j?.detail).toHaveProperty('pass');
    expect(existsSync(join(res.runDir, 'impl.out'))).toBe(true);
  });

  it('(d) zero-tools overlay STILL forces RETURN even when the model says ACCEPT', async () => {
    let judgeCalls = 0;
    const stub: CouncilGenerate = async ({ system }) => {
      if (system.includes('quality REVIEWER')) {
        judgeCalls++;
        return {
          text: 'REVIEW:\n- looks fine\nEVIDENCE:\n- self-report only\nVERDICT: ACCEPT',
          genId: 'j',
          finishReason: 'stop',
        };
      }
      return {
        text: 'Done! I wrote prices.ts and verified the suite.',
        genId: 'g',
        finishReason: 'stop',
      };
    };
    const p = plan([
      {
        id: 's1',
        title: 't',
        nodes: [
          {
            id: 'impl',
            agent: { seat: 'implementer' },
            taskPrompt: 'Implement prices.ts',
            consumes: [],
            contract: {
              outputPath: 'impl.out',
              judge: { rubric: 'did it implement', requireToolEvidence: true },
            },
          },
        ],
      },
    ]);
    // API path with tools held but never called → healthy empty harvest (not lost).
    const res = await runPlan(p, 'fb-zero-tools', {
      generate: stub,
      defaultModel: 'm',
      runsRoot,
      maxRepairs: 0,
      toolsFor: () => ({ write_file: {}, read_local: {} }),
    });
    const impl = res.outcomes.find((o) => o.nodeId === 'impl')!;
    expect(impl.status).toBe('done');
    expect(impl.judge?.verdict).toBe('RETURN');
    expect(impl.judge?.tool_trace_status).toBe('empty');
    expect(impl.judge?.zero_tool_calls).toBe(true);
    expect(impl.judge?.overlay).toMatch(/zero-tools|write-fabrication|missing-evidence/);
    // Not the degrade stamp — this is a real fabrication signal.
    expect(impl.judge?.overlay).not.toBe('degraded-trace-lost');
    expect(impl.judge?.tool_trace_status).not.toBe('lost');
    const j = readLog(res.runDir).find((e) => e.type === 'judge');
    expect(j?.detail).toMatchObject({
      verdict: 'RETURN',
      tool_trace_status: 'empty',
      zero_tool_calls: true,
    });
    expect(judgeCalls).toBe(1);
  });

  it('(e) judge event journal shape stays additive-only (artifact contract)', async () => {
    // Snapshot the known core keys; new fields (retry, lost, degraded-trace-lost) must not rename/remove them.
    const CORE = [
      'rubric',
      'verdict',
      'reason',
      'score',
      'threshold',
      'pass',
      'attempt',
    ] as const;
    const stub: CouncilGenerate = async ({ system }) => {
      if (system.includes('quality REVIEWER') || system.includes('no parseable VERDICT')) {
        return {
          text: 'EVIDENCE:\n- inline content\nVERDICT: ACCEPT',
          genId: 'j',
          finishReason: 'stop',
        };
      }
      return { text: 'OUTPUT[a]', genId: 'g', finishReason: 'stop' };
    };
    const p = plan([
      {
        id: 's1',
        title: 't',
        nodes: [
          {
            id: 'a',
            agent: { seat: 'reviewer' },
            taskPrompt: 'do a',
            consumes: [],
            contract: {
              outputPath: 'a.out',
              judge: { rubric: 'r', requireToolEvidence: false },
            },
          },
        ],
      },
    ]);
    const res = await runPlan(p, 'fb-additive', {
      generate: stub,
      defaultModel: 'm',
      runsRoot,
      maxRepairs: 0,
    });
    const j = readLog(res.runDir).find((e) => e.type === 'judge');
    expect(j).toBeDefined();
    const d = j!.detail as Record<string, unknown>;
    for (const k of CORE) {
      expect(d).toHaveProperty(k);
    }
    // Known additive evidence fields remain optional but when present use established names.
    if ('tool_trace_status' in d) {
      expect(['ok', 'empty', 'unavailable', 'lost']).toContain(d.tool_trace_status);
    }
    if ('overlay' in d) {
      expect(typeof d.overlay).toBe('string');
    }
    if ('retry' in d) {
      expect(typeof d.retry).toBe('number');
    }
    // No renames of the binary accept path.
    expect(d.verdict === 'ACCEPT' || d.verdict === 'RETURN' || d.verdict === null).toBe(true);
    expect(typeof d.pass).toBe('boolean');
  });
});
