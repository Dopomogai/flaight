// @purpose: Unit tests for tree-level write evidence (porcelain line keys + content digests + surface attribution)
// @why: E4 false alarm + EXP-013 false-clean on pre-dirty same-path re-edit (14/14 writeGate:fail frames known-CLEAN while writeOps climbed). T10/T16 are the load-bearing reds against line-only HEAD — cover seat 2026-08-08T08-23-17-304Z re-proved both fail with AssertionError "expected 0 to be greater than 0" under real HEAD revert of lib/opused/fleet/tree-change.ts (behavioural length assert, not missing-symbol). Suite polarity: positives T1/T2/T5/T7/T9/T10/T16/T17/T22 + live smoke; negatives T3/T4/T6/T8/T11/T12/T15a/b/T18/T20/T21/T23.
// @role: safety-critical test
// @stability: experimental

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  diffTreeSnapshots,
  extractSurfacePaths,
  parsePorcelainLines,
  pathFromPorcelainLine,
  snapshotTree,
  treeKnownClean,
  treeWorkLanded,
  type FilesChangedFact,
  type TreeSnapshot,
} from '../../../../lib/opused/fleet/tree-change';
import { writeGateShouldFail } from '../../../../lib/opused/fleet/run';
import { applyJudgeOverlay } from '../../../../lib/opused/fleet/judge-evidence';

function initRepo(trackedName = 'tracked.ts'): string {
  const dir = mkdtempSync(join(tmpdir(), 'tree-content-'));
  const run = (args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  };
  run(['init']);
  run(['config', 'user.email', 't@example.test']);
  run(['config', 'user.name', 't']);
  writeFileSync(join(dir, trackedName), 'export const a = 1;\n');
  run(['add', trackedName]);
  run(['commit', '-m', 'init']);
  return dir;
}

describe('parsePorcelainLines / pathFromPorcelainLine (T1–T2)', () => {
  // WHY T1: stress-breaks D1 — path-only keys drop rename/status; line keys are the contract for same-path re-edit.
  it('T1: keeps full lines including rename', () => {
    const lines = parsePorcelainLines(
      [
        ' M lib/a.ts',
        'R  lib/old.ts -> lib/new.ts',
        '?? junk-marker.txt',
        '',
        'x', // too short — dropped
      ].join('\n'),
    );
    expect(lines).toEqual([' M lib/a.ts', 'R  lib/old.ts -> lib/new.ts', '?? junk-marker.txt']);
  });

  // WHY T2: treeWorkLanded attributes by PATH extracted from porcelain; rename destination must win over source.
  it('T2: pathFromPorcelainLine extracts path / rename destination', () => {
    expect(pathFromPorcelainLine(' M lib/a.ts')).toBe('lib/a.ts');
    expect(pathFromPorcelainLine('R  lib/old.ts -> lib/new.ts')).toBe('lib/new.ts');
    expect(pathFromPorcelainLine('?? junk-marker.txt')).toBe('junk-marker.txt');
    expect(pathFromPorcelainLine('')).toBe('');
    expect(pathFromPorcelainLine(' M "my file.ts"')).toBe('my file.ts');
    expect(pathFromPorcelainLine('R  "old a.ts" -> "new b.ts"')).toBe('new b.ts');
  });
});

describe('snapshotTree (T3–T4)', () => {
  // WHY T3: non-git sandbox must be known:false (not-a-git-worktree), never invent known-clean [] (fail-closed).
  it('T3: non-git dir → not-a-git-worktree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tree-nongit-'));
    try {
      const snap = snapshotTree(dir);
      expect(snap.ok).toBe(false);
      if (!snap.ok) expect(snap.reason).toBe('not-a-git-worktree');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WHY T4: missing root must fail closed as root-unavailable — never ok:true with empty lines.
  it('T4: missing root → root-unavailable', () => {
    const snap = snapshotTree(join(tmpdir(), 'tree-missing-root-does-not-exist-zzz'));
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.reason).toBe('root-unavailable');
  });
});

describe('diffTreeSnapshots (T5–T7)', () => {
  // WHY T5: positive landing signal — clean→dirty must produce known non-empty for E4 innocence path.
  it('T5: clean→dirty → known non-empty', () => {
    const before: TreeSnapshot = { ok: true, root: '/r', lines: new Set(), digests: new Map() };
    const after: TreeSnapshot = {
      ok: true,
      root: '/r',
      lines: new Set([' M lib/a.ts']),
      digests: new Map([['lib/a.ts', 'h1']]),
    };
    const fact = diffTreeSnapshots(before, after);
    expect(fact).toEqual({ known: true, filesChanged: [' M lib/a.ts'] });
  });

  // WHY T6: still-foolable D4 — snapshot failure must never invent filesChanged:[] (would clear fabrication).
  it('T6: either side failed → known:false (never invent [])', () => {
    const fail: TreeSnapshot = { ok: false, reason: 'snapshot-failed' };
    const ok: TreeSnapshot = { ok: true, root: '/r', lines: new Set(), digests: new Map() };
    expect(diffTreeSnapshots(fail, ok)).toEqual({ known: false, reason: 'snapshot-failed' });
    expect(diffTreeSnapshots(ok, fail)).toEqual({ known: false, reason: 'snapshot-failed' });
    expect(
      diffTreeSnapshots(ok, { ok: true, root: '/other', lines: new Set(), digests: new Map() }),
    ).toEqual({
      known: false,
      reason: 'snapshot-failed',
    });
  });

  // WHY T7: stress-breaks D1 — path-only keys treat ` M a.ts` vs `M  a.ts` as same path → empty diff false green.
  it('T7: same-path re-edit — different porcelain LINE for same path is non-empty diff', () => {
    // Path-only keys would treat both as "a.ts" and invent clean; line keys keep the status byte.
    const digests = new Map([['a.ts', 'x']]);
    const before: TreeSnapshot = {
      ok: true,
      root: '/r',
      lines: new Set([' M a.ts']),
      digests,
    };
    const after: TreeSnapshot = {
      ok: true,
      root: '/r',
      lines: new Set(['M  a.ts']),
      digests,
    };
    const fact = diffTreeSnapshots(before, after);
    expect(fact.known).toBe(true);
    if (fact.known) {
      expect(fact.filesChanged.length).toBeGreaterThan(0);
      expect(fact.filesChanged).toEqual(expect.arrayContaining([' M a.ts', 'M  a.ts']));
    }
  });
});

describe('treeWorkLanded attribution (T8–T9)', () => {
  // WHY T8: still-foolable junk-marker — any dirty must NOT clear fabrication without surface ∩ dirty.
  it('T8: junk dirty unattributed + fenced body naming lib/x.ts → false', () => {
    const fact: FilesChangedFact = { known: true, filesChanged: ['?? junk-marker.txt'] };
    const text = 'applied:\n```ts\n// lib/x.ts\nexport const x = 1;\n```';
    // surface may extract lib/x.ts from prose; dirty is only junk-marker — no intersection
    expect(treeWorkLanded(fact, text)).toBe(false);
    expect(treeKnownClean(fact)).toBe(false);
  });

  // WHY T9: E4 positive — terminal apply that dirties the named path must count as work landed.
  it('T9: dirty lib/x.ts + surface file: lib/x.ts → true', () => {
    const fact: FilesChangedFact = { known: true, filesChanged: [' M lib/x.ts'] };
    expect(treeWorkLanded(fact, 'CHANGE REGISTER: file: lib/x.ts applied via terminal')).toBe(true);
  });

  // WHY: surface extract must ignore read-only tools so peer/read paths cannot fake attribution.
  it('extractSurfacePaths picks write-tool args and repo paths', () => {
    const paths = extractSurfacePaths('see lib/foo.ts', [
      { name: 'write_file', arg: 'lib/bar.ts' },
      { name: 'read_file', arg: 'lib/ignore.ts' },
    ]);
    expect(paths).toEqual(expect.arrayContaining(['lib/foo.ts', 'lib/bar.ts']));
    expect(paths).not.toContain('lib/ignore.ts');
  });
});

describe('live git snapshot smoke', () => {
  // WHY: hermetic unit tests alone cannot prove spawn+porcelain; smoke pins real git dirty visibility.
  it('git worktree dirty is visible in snapshot/diff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tree-git-'));
    try {
      const run = (args: string[]) => {
        const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
      };
      run(['init']);
      run(['config', 'user.email', 't@example.test']);
      run(['config', 'user.name', 't']);
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 1;\n');
      run(['add', 'tracked.ts']);
      run(['commit', '-m', 'init']);
      const before = snapshotTree(dir);
      expect(before.ok).toBe(true);
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2;\n');
      const after = snapshotTree(dir);
      expect(after.ok).toBe(true);
      const fact = diffTreeSnapshots(before, after);
      expect(fact.known).toBe(true);
      if (fact.known) expect(fact.filesChanged.some((l) => l.includes('tracked.ts'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('content-keyed pre-dirty re-edit (T10–T23)', () => {
  // WHY T10: measured defect (EXP-013 / tree-fact-false-clean-on-pre-dirty-same-path-20260808) —
  // apply-then-cover leaves path already " M"; re-edit keeps the same porcelain line; line-only
  // symdiff returns [] while writeOps climb (14/14 writeGate:fail frames known-CLEAN on 2026-08-08).
  // FAIL-AGAINST-OLD protocol (real production file only — never a scratch double):
  //   1) cp lib/opused/fleet/tree-change.ts /tmp/tree-change.GOOD-cover.ts
  //   2) git show HEAD:lib/opused/fleet/tree-change.ts > lib/opused/fleet/tree-change.ts
  //   3) pnpm vitest run tests/unit/opused/fleet/tree-change.test.ts -t "T10:|T16:"
  //      → both FAIL: AssertionError: expected 0 to be greater than 0 at lines 221 and 347
  //         (fact.filesChanged.length under line-only symdiff) — behavioural, not missing-symbol
  //   4) cp /tmp/tree-change.GOOD-cover.ts lib/opused/fleet/tree-change.ts
  //   5) full file re-green: 26 passed / 0 failed
  // Cover seat of run 2026-08-08T08-23-17-304Z ran this protocol end-to-end (see cover-tests.out).
  it('T10: pre-dirty same-path re-edit → known non-empty naming path', () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2;\n'); // pre-dirty
      const before = snapshotTree(dir);
      expect(before.ok).toBe(true);
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 3;\n'); // re-edit same path
      const after = snapshotTree(dir);
      expect(after.ok).toBe(true);
      // Behavioural core FIRST (so fail-against-old is length>0, not a shape/missing-field assert):
      // line-only HEAD returns known:true filesChanged:[] here; content keys return non-empty.
      const fact = diffTreeSnapshots(before, after);
      expect(fact.known).toBe(true);
      if (fact.known) {
        expect(fact.filesChanged.length).toBeGreaterThan(0);
        expect(fact.filesChanged.some((l) => l.includes('tracked.ts'))).toBe(true);
      }
      // Content keys must mark the tree dirty — this is the R4 false-green input under old code.
      expect(treeKnownClean(fact)).toBe(false);
      // Shape of the fix (after behavioural asserts): digests present and differ for same porcelain line.
      if (before.ok && after.ok) {
        expect(before.digests).toBeInstanceOf(Map);
        expect(after.digests).toBeInstanceOf(Map);
        expect(before.digests.has('tracked.ts')).toBe(true);
        const line = [...before.lines].find((l) => l.includes('tracked.ts'));
        expect(line).toBeTruthy();
        expect(after.lines.has(line!)).toBe(true);
        expect(before.digests.get('tracked.ts')).not.toBe(after.digests.get('tracked.ts'));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WHY T11: nothing written on dirty tree → still known clean diff (fabrication still caught).
  it('T11: dirty tree, no write → known true empty filesChanged', () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2;\n');
      const before = snapshotTree(dir);
      expect(before.ok).toBe(true);
      const after = snapshotTree(dir);
      expect(after.ok).toBe(true);
      const fact = diffTreeSnapshots(before, after);
      expect(fact).toEqual({ known: true, filesChanged: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WHY T12: A→B→A identical content between snapshots ⇒ [] (over-report guard).
  it('T12: touch then restore identical bytes → known true empty', () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2;\n'); // pre-dirty A
      const before = snapshotTree(dir);
      expect(before.ok).toBe(true);
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 99;\n'); // B
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2;\n'); // back to A
      const after = snapshotTree(dir);
      expect(after.ok).toBe(true);
      const fact = diffTreeSnapshots(before, after);
      expect(fact).toEqual({ known: true, filesChanged: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // T13/T14 are T3/T4 (passed before) — leave those cases; alias names for cover paste.
  it('T13: non-git → not-a-git-worktree (same as T3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tree-nongit-t13-'));
    try {
      const snap = snapshotTree(dir);
      expect(snap.ok).toBe(false);
      if (!snap.ok) expect(snap.reason).toBe('not-a-git-worktree');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T14: missing root → root-unavailable (same as T4)', () => {
    const snap = snapshotTree(join(tmpdir(), 'tree-missing-root-t14-zzz'));
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.reason).toBe('root-unavailable');
  });

  // WHY T15a: digest failure must degrade snapshot to unknown, never invent known-empty.
  it('T15a: digestPath null → snapshot-failed; diff known false', () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2;\n');
      const before = snapshotTree(dir);
      expect(before.ok).toBe(true);
      const bad = snapshotTree(dir, { digestPath: () => null });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.reason).toBe('snapshot-failed');
      const fact = diffTreeSnapshots(before, bad);
      expect(fact.known).toBe(false);
      if (!fact.known) expect(fact.reason).toBe('snapshot-failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WHY T15b: digest throw must not escape snapshotTree.
  it('T15b: digestPath throw → snapshot-failed, no uncaught throw', () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2;\n');
      const bad = snapshotTree(dir, {
        digestPath: () => {
          throw new Error('x');
        },
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.reason).toBe('snapshot-failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WHY T16: measured gate scenario — live pre-dirty re-edit fact must flip writeGateShouldFail to false
  // so cover-tests is not ordered to re-APPLY work already on disk (judge RETURN quoting false clean).
  // Under OLD line-only code, the same live repo produces filesChanged:[] → treeKnownClean → gate true.
  // FAIL-AGAINST-OLD: same protocol as T10 (REAL production file only; see T10 comment + cover-tests.out).
  // Positive arm MUST use live diffTreeSnapshots output — never a hand-built non-empty filesChanged.
  // Control arm keeps the OLD false-clean shape { known:true, filesChanged:[] } still failing the gate.
  it('T16: pre-dirty re-edit fact flips writeGateShouldFail to false', () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2;\n'); // pre-dirty
      const before = snapshotTree(dir);
      expect(before.ok).toBe(true);
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 3;\n'); // re-edit
      const after = snapshotTree(dir);
      expect(after.ok).toBe(true);
      // Fact MUST come from live diff — never a hand-built non-empty array for the positive arm.
      const fact = diffTreeSnapshots(before, after);
      expect(fact.known).toBe(true);
      if (fact.known) {
        expect(fact.filesChanged.length).toBeGreaterThan(0);
        expect(fact.filesChanged.some((l) => l.includes('tracked.ts'))).toBe(true);
      }
      // Content keys make treeKnownClean false — that is what silences hard-gate R4.
      expect(treeKnownClean(fact)).toBe(false);
      const claimsText = 'CHANGE REGISTER: wrote tracked.ts and verified';
      expect(
        writeGateShouldFail({
          writeToolNamesLength: 3,
          writeOps: 2,
          text: claimsText,
          filesChanged: fact,
        }),
      ).toBe(false);
      // Control: empty known-true fact (the OLD false-clean shape) still fails the gate.
      expect(
        writeGateShouldFail({
          writeToolNamesLength: 3,
          writeOps: 2,
          text: claimsText,
          filesChanged: { known: true, filesChanged: [] },
        }),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WHY T17: untracked re-edit must be visible (pure git-diff designs miss ?? paths).
  it('T17: untracked content re-edit → non-empty fact naming u.ts', () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, 'u.ts'), 'export const u = 1;\n');
      const before = snapshotTree(dir);
      expect(before.ok).toBe(true);
      writeFileSync(join(dir, 'u.ts'), 'export const u = 2;\n');
      const after = snapshotTree(dir);
      expect(after.ok).toBe(true);
      const fact = diffTreeSnapshots(before, after);
      expect(fact.known).toBe(true);
      if (fact.known) {
        expect(fact.filesChanged.length).toBeGreaterThan(0);
        expect(fact.filesChanged.some((l) => l.includes('u.ts'))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WHY T18: mtime-only must not false-dirty (identity is bytes, not mtime).
  it('T18: mtime-only change → known true empty', () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2;\n');
      const before = snapshotTree(dir);
      expect(before.ok).toBe(true);
      const future = new Date(Date.now() + 60_000);
      utimesSync(join(dir, 'tracked.ts'), future, future);
      const after = snapshotTree(dir);
      expect(after.ok).toBe(true);
      const fact = diffTreeSnapshots(before, after);
      expect(fact).toEqual({ known: true, filesChanged: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WHY T19: residual honesty — unattributed peer dirt silences R4; judge still write-fabrication.
  it('T19: peer dirty silences writeGate R4; judge still write-fabrication', () => {
    const fact: FilesChangedFact = { known: true, filesChanged: [' M tests/unit/peer.test.ts'] };
    const text =
      'applied work to lib/x.ts:\n```ts\n// lib/x.ts\nexport const x = 1;\n```\nCHANGE REGISTER: wrote lib/x.ts';
    expect(
      writeGateShouldFail({
        writeToolNamesLength: 3,
        writeOps: 2,
        text,
        filesChanged: fact,
      }),
    ).toBe(false);
    const overlay = applyJudgeOverlay({
      isWriter: true,
      writeOps: 2,
      toolTraceStatus: 'ok',
      toolEventCount: 2,
      gatesRed: false,
      requireToolEvidence: false,
      text,
      filesChanged: fact,
    });
    expect(overlay?.overlay).toBe('write-fabrication');
  });

  // WHY T20: missing digests map must fail closed (never throw, never invent []).
  it('T20: missing digests map → known false', () => {
    const before = {
      ok: true as const,
      root: '/r',
      lines: new Set([' M a.ts']),
      // digests intentionally omitted — legacy / partial shape
    } as TreeSnapshot;
    const after: TreeSnapshot = {
      ok: true,
      root: '/r',
      lines: new Set([' M a.ts']),
      digests: new Map([['a.ts', 'h1']]),
    };
    const fact = diffTreeSnapshots(before, after);
    expect(fact.known).toBe(false);
    if (!fact.known) expect(fact.reason).toBe('snapshot-failed');
  });

  // WHY T21: non-file digest failure → snapshot-failed.
  it('T21: non-file digest inject → snapshot-failed', () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2;\n');
      const bad = snapshotTree(dir, { digestPath: () => null });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.reason).toBe('snapshot-failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WHY T22: spaced/quoted path re-edit exercises unquote + content keys.
  it('T22: spaced filename pre-dirty re-edit → non-empty fact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tree-space-'));
    try {
      const run = (args: string[]) => {
        const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
      };
      run(['init']);
      run(['config', 'user.email', 't@example.test']);
      run(['config', 'user.name', 't']);
      writeFileSync(join(dir, 'my file.ts'), 'export const a = 1;\n');
      run(['add', 'my file.ts']);
      run(['commit', '-m', 'init']);
      writeFileSync(join(dir, 'my file.ts'), 'export const a = 2;\n'); // pre-dirty
      const before = snapshotTree(dir);
      expect(before.ok).toBe(true);
      writeFileSync(join(dir, 'my file.ts'), 'export const a = 3;\n'); // re-edit
      const after = snapshotTree(dir);
      expect(after.ok).toBe(true);
      const fact = diffTreeSnapshots(before, after);
      expect(fact.known).toBe(true);
      if (fact.known) {
        expect(fact.filesChanged.length).toBeGreaterThan(0);
        expect(fact.filesChanged.some((l) => l.includes('my file.ts'))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WHY T23: non-delete missing digest → known false (allowAbsent false path).
  it('T23: non-delete missing via digest null → known false', () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2;\n');
      const before = snapshotTree(dir);
      expect(before.ok).toBe(true);
      const bad = snapshotTree(dir, { digestPath: () => null });
      expect(bad.ok).toBe(false);
      const fact = diffTreeSnapshots(before, bad);
      expect(fact.known).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
