// @purpose: Unit tests for judge-evidence overlay + claim heuristics (dec-judge-seam P0/P1)
// @why: scar goals-status-verify-20260803 — claims + zero tools must force RETURN without model mood
// @role: safety-critical test
// @stability: experimental

import { describe, expect, it } from 'vitest';
import {
  acceptNeedsEvidence,
  applyJudgeOverlay,
  CLAIMS_WORK,
  claimsWork,
  countWriteOps,
  evidenceWaiver,
  parseEvidenceCited,
  resolveToolTraceStatus,
  zeroToolCalls,
} from '../../../../lib/opused/fleet/judge-evidence';

describe('resolveToolTraceStatus / zeroToolCalls', () => {
  it('undefined → unavailable; [] → empty; non-empty → ok', () => {
    expect(resolveToolTraceStatus(undefined)).toBe('unavailable');
    expect(resolveToolTraceStatus([])).toBe('empty');
    expect(resolveToolTraceStatus([{ name: 'read_file', arg: 'a.ts' }])).toBe('ok');
  });

  it('zero_tool_calls is null when unavailable', () => {
    expect(zeroToolCalls('unavailable', null)).toBeNull();
    expect(zeroToolCalls('empty', 0)).toBe(true);
    expect(zeroToolCalls('ok', 3)).toBe(false);
  });
});

describe('CLAIMS_WORK / claimsWork', () => {
  it('matches scar-style fabrication prose', () => {
    expect(claimsWork('I wrote prices.ts and verified the suite')).toBe(true);
    expect(claimsWork('implemented the fix; file: lib/x.ts')).toBe(true);
    expect(claimsWork('ran tests successfully')).toBe(true);
    expect(CLAIMS_WORK.test('edited and applied the patch')).toBe(true);
  });

  it('does not match neutral synthesis', () => {
    expect(claimsWork('OUTPUT[a]')).toBe(false);
    expect(claimsWork('Analysis: the module looks correct.')).toBe(false);
  });
});

describe('applyJudgeOverlay — scar matrix', () => {
  it('claims + zero tools → forced RETURN (scar reproduction)', () => {
    const r = applyJudgeOverlay({
      toolTraceStatus: 'empty',
      toolEventCount: 0,
      writeOps: 0,
      isWriter: false,
      gatesRed: false,
      requireToolEvidence: false,
      text: 'Done! I rewrote prices.ts with the full implementation.',
    });
    expect(r).not.toBeNull();
    expect(r!.overlay).toBe('zero-tools');
    expect(r!.forceReturn).toMatch(/zero tool calls/i);
  });

  it('requireToolEvidence + empty tools → RETURN even without claims', () => {
    const r = applyJudgeOverlay({
      toolTraceStatus: 'empty',
      toolEventCount: 0,
      writeOps: 0,
      isWriter: true,
      gatesRed: false,
      requireToolEvidence: true,
      text: 'OUTPUT[impl]',
    });
    expect(r?.overlay).toBe('zero-tools');
  });

  it('writer + zero writeOps + fenced code → write-fabrication', () => {
    const r = applyJudgeOverlay({
      toolTraceStatus: 'ok',
      toolEventCount: 2,
      writeOps: 0,
      isWriter: true,
      gatesRed: false,
      requireToolEvidence: false,
      text: 'rewrite:\n```ts\nconst x = 1;\n```',
    });
    expect(r?.overlay).toBe('write-fabrication');
  });

  it('gates red → gates-red overlay', () => {
    const r = applyJudgeOverlay({
      toolTraceStatus: 'ok',
      toolEventCount: 5,
      writeOps: 2,
      isWriter: true,
      gatesRed: true,
      requireToolEvidence: true,
      text: 'all green',
    });
    expect(r?.overlay).toBe('gates-red');
  });

  it('unavailable + requireToolEvidence does NOT force (harness loss degrades in runJudge)', () => {
    // JUDGE-RECOMMENDATION-2026-08-04: trace-unavailable no longer forces RETURN.
    // Neutral + claim prose both must return null so the model can ACCEPT honest work.
    const neutral = applyJudgeOverlay({
      toolTraceStatus: 'unavailable',
      toolEventCount: null,
      writeOps: 0,
      isWriter: true,
      gatesRed: false,
      requireToolEvidence: true,
      text: 'OUTPUT[impl]',
    });
    expect(neutral).toBeNull();
    const claims = applyJudgeOverlay({
      toolTraceStatus: 'unavailable',
      toolEventCount: null,
      writeOps: 0,
      isWriter: true,
      gatesRed: false,
      requireToolEvidence: true,
      text: 'I wrote prices.ts and verified the suite',
    });
    expect(claims).toBeNull();
  });

  it('honest work with tools → null (model may ACCEPT)', () => {
    // Tree fact required when claimsOrShows: writeOps alone is not innocence (still-foolable D4).
    const r = applyJudgeOverlay({
      toolTraceStatus: 'ok',
      toolEventCount: 4,
      writeOps: 2,
      isWriter: true,
      gatesRed: false,
      requireToolEvidence: true,
      text: 'CHANGE REGISTER: wrote prices.ts file: lib/prices.ts',
      filesChanged: { known: true, filesChanged: [' M lib/prices.ts'] },
    });
    expect(r).toBeNull();
  });

  it('pure synthesis zero tools without requireToolEvidence → null', () => {
    const r = applyJudgeOverlay({
      toolTraceStatus: 'empty',
      toolEventCount: 0,
      writeOps: 0,
      isWriter: false,
      gatesRed: false,
      requireToolEvidence: false,
      text: 'OUTPUT[a]',
    });
    expect(r).toBeNull();
  });
});

describe('applyJudgeOverlay — tree-level write evidence (T10–T16)', () => {
  // Cover seat (2026-08-08T01-33-20-891Z): each case pins a plan scar — OLD formulas reimplemented below
  // in cover-tests.out prove T10/T11 would invert without tree attribution.
  const baseWriter = {
    toolTraceStatus: 'ok' as const,
    toolEventCount: 2,
    isWriter: true,
    gatesRed: false,
    requireToolEvidence: false,
  };

  // WHY T10 (positive E4): OLD overlay forced write-fabrication on writeOps===0+fence even when tree dirty —
  // terminal apply without write_file names. NEW must return null when surface ∩ dirty.
  it('T10 E4: writeOps 0 + fenced + attributed dirty → null', () => {
    const r = applyJudgeOverlay({
      ...baseWriter,
      writeOps: 0,
      text: 'applied via shell:\n```ts\n// lib/x.ts\nexport const x = 1;\n```\nfile: lib/x.ts',
      filesChanged: { known: true, filesChanged: [' M lib/x.ts'] },
    });
    expect(r).toBeNull();
  });

  // WHY T11 (negative false-green): OLD treated writeOps>0 as innocence with no tree check; fabricator
  // could fire write tools against wrong paths and pass. NEW forces on known-clean + claims/shows.
  it('T11 false-green: writeOps 2 + known empty + claims/fenced → write-fabrication', () => {
    const r = applyJudgeOverlay({
      ...baseWriter,
      writeOps: 2,
      text: 'CHANGE REGISTER: wrote lib/x.ts\n```ts\nexport const x = 1;\n```',
      filesChanged: { known: true, filesChanged: [] },
    });
    expect(r?.overlay).toBe('write-fabrication');
    expect(r?.forceReturn).toMatch(/tree is unchanged/i);
  });

  // WHY T12 (positive honest no-op / breaks D2): bare writeOps>0 + clean must NOT force without claims/fence —
  // tool no-ops that do not claim work are legitimate.
  it('T12 honest no-op: writeOps 2 + known empty + no claims/fence → null', () => {
    const r = applyJudgeOverlay({
      ...baseWriter,
      writeOps: 2,
      text: 'OUTPUT[impl] — no change needed',
      filesChanged: { known: true, filesChanged: [] },
    });
    expect(r).toBeNull();
  });

  // WHY T13 (negative junk): still-foolable — any dirty without surface intersection must still force fabrication.
  it('T13 junk dirty unattributed + fenced claims → write-fabrication', () => {
    const r = applyJudgeOverlay({
      ...baseWriter,
      writeOps: 0,
      text: 'implemented fix:\n```ts\n// lib/x.ts\nexport const x = 1;\n```',
      filesChanged: { known: true, filesChanged: ['?? junk-marker.txt'] },
    });
    expect(r?.overlay).toBe('write-fabrication');
    expect(r?.forceReturn).toMatch(/do not intersect/i);
  });

  // WHY T14 (negative fail-closed): still-foolable D4 — writeOps>0 is NOT innocence when tree is unknown.
  it('T14 known:false + writeOps 1 + fenced → write-fabrication', () => {
    const r = applyJudgeOverlay({
      ...baseWriter,
      writeOps: 1,
      text: 'rewrite:\n```ts\nconst y = 2;\n```',
      filesChanged: { known: false, reason: 'not-a-git-worktree' },
    });
    expect(r?.overlay).toBe('write-fabrication');
    expect(r?.forceReturn).toMatch(/tree evidence unavailable/i);
  });

  // WHY T15 (secondary regression): legacy callers omit filesChanged; zero writes + fence still forces (old path).
  it('T15 omitted filesChanged + writeOps 0 + fenced → write-fabrication (secondary)', () => {
    const r = applyJudgeOverlay({
      ...baseWriter,
      writeOps: 0,
      text: 'rewrite:\n```ts\nconst y = 2;\n```',
    });
    expect(r?.overlay).toBe('write-fabrication');
    expect(r?.forceReturn).toMatch(/zero write ops/i);
  });

  // WHY T16 (RO positive): write-fabrication arm must not fire on readers — proposals with fences are not writes.
  it('T16 isWriter false + any tree → no write-fabrication', () => {
    const r = applyJudgeOverlay({
      toolTraceStatus: 'ok',
      toolEventCount: 0,
      writeOps: 0,
      isWriter: false,
      gatesRed: false,
      requireToolEvidence: false,
      text: 'proposal:\n```ts\nconst b = 2;\n```',
      filesChanged: { known: true, filesChanged: [] },
    });
    expect(r).toBeNull();
  });
});

describe('parseEvidenceCited / acceptNeedsEvidence', () => {
  it('extracts EVIDENCE bullets', () => {
    const raw = [
      'REVIEW:',
      '- solid work',
      'EVIDENCE:',
      '- search_replace on lib/x.ts',
      '- typecheck GREEN',
      'VERDICT: ACCEPT',
    ].join('\n');
    expect(parseEvidenceCited(raw)).toEqual([
      'search_replace on lib/x.ts',
      'typecheck GREEN',
    ]);
  });

  it('forces RETURN when ACCEPT lacks EVIDENCE under requireToolEvidence', () => {
    expect(
      acceptNeedsEvidence({
        requireToolEvidence: true,
        verdict: 'ACCEPT',
        raw: 'REVIEW:\n- ok\nVERDICT: ACCEPT',
      }),
    ).toMatch(/EVIDENCE/i);
    expect(
      acceptNeedsEvidence({
        requireToolEvidence: true,
        verdict: 'ACCEPT',
        raw: 'EVIDENCE:\n- tool read_file\nVERDICT: ACCEPT',
      }),
    ).toBeNull();
  });
});

describe('evidenceWaiver — the 2026-08-07 sim scar', () => {
  it('zero armed tools waives; any armed tool does not; unknown fails CLOSED', () => {
    expect(evidenceWaiver(0)).toBe('no-tools-armed');
    expect(evidenceWaiver(1)).toBeNull();
    expect(evidenceWaiver(12)).toBeNull();
    // A caller that does not know its own belt must not be handed a waiver.
    expect(evidenceWaiver(undefined)).toBeNull();
  });

  it('THE SCAR: a waived node with zero tool calls is no longer forced to RETURN', () => {
    // sim-2026-08-07T01-23-02-886Z: 8 of 11 nodes burned all 6 repair attempts on exactly this input,
    // then the run reported 11 done / 0 failed. Sim arms no tools, so the demand was unsatisfiable.
    const input = {
      toolTraceStatus: 'empty' as const,
      toolEventCount: 0,
      writeOps: 0,
      isWriter: false,
      gatesRed: false,
      requireToolEvidence: true,
      text: 'OUTPUT[readiness-verdict] — the verdict per flow, synthesized from the pack.',
    };
    expect(applyJudgeOverlay(input)!.overlay).toBe('zero-tools'); // unwaived: unchanged behaviour
    expect(applyJudgeOverlay({ ...input, evidenceWaived: 'no-tools-armed' })).toBeNull();
  });

  it('a node that HELD tools and called none is still caught — the waiver cannot be forged', () => {
    // The whole point of the overlay. Armed belt → no waiver → the fabrication test still fires.
    const r = applyJudgeOverlay({
      toolTraceStatus: 'empty',
      toolEventCount: 0,
      writeOps: 0,
      isWriter: false,
      gatesRed: false,
      requireToolEvidence: false,
      text: 'I read the census and verified every endpoint.',
      evidenceWaived: evidenceWaiver(3),
    });
    expect(r).not.toBeNull();
    expect(r!.overlay).toBe('zero-tools');
  });

  it('gates-red outranks the waiver — a red compiler is ground truth, tools or no tools', () => {
    const r = applyJudgeOverlay({
      toolTraceStatus: 'empty',
      toolEventCount: 0,
      writeOps: 0,
      isWriter: true,
      gatesRed: true,
      requireToolEvidence: true,
      text: 'all green',
      evidenceWaived: 'no-tools-armed',
    });
    expect(r!.overlay).toBe('gates-red');
  });

  it('acceptNeedsEvidence stops demanding EVIDENCE cites from a node that could not gather any', () => {
    const args = { requireToolEvidence: true, verdict: 'ACCEPT' as const, raw: 'REVIEW: fine\nVERDICT: ACCEPT' };
    expect(acceptNeedsEvidence(args)).toMatch(/without EVIDENCE/i);
    expect(acceptNeedsEvidence({ ...args, evidenceWaived: 'no-tools-armed' })).toBeNull();
  });
});

describe('countWriteOps', () => {
  it('counts API + CLI write tool names', () => {
    expect(
      countWriteOps([
        { name: 'read_file', arg: 'a' },
        { name: 'search_replace', arg: 'b' },
        { name: 'write_file', arg: 'c' },
        { name: 'Edit', arg: 'd' },
      ]),
    ).toBe(3);
  });
});
