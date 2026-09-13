// @purpose: Before/after git porcelain snapshot of a node root — tree-level write evidence
// @why: writeOps counts tool NAMES; terminal heredocs and wrong-path write_file fool it (E4 2026-08-08)
// @role: safety-critical
// @stability: experimental

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, normalize } from 'node:path';
import type { ToolEvent } from '../council/types';
// Leaf import on purpose: importing this from './judge-evidence' is a cycle, and both modules read
// the list at module-init time, so it killed `pnpm fleet` on load. Do not repoint this at the judge.
import { JUDGE_WRITE_TOOL_NAMES } from './write-tool-names';

/** Why a tree snapshot failed — same vocabulary as `FilesChangedFact` known:false. */
export type TreeSnapshotFailReason = 'not-a-git-worktree' | 'snapshot-failed' | 'root-unavailable';

/** Tree-level write evidence. Never invent zero when the engine cannot see the tree. */
export type FilesChangedFact =
  | { known: true; filesChanged: string[] } // porcelain line keys that changed (status and/or content); [] = known clean
  | { known: false; reason: TreeSnapshotFailReason };

/**
 * Opaque before-snapshot. Callers must not interpret keys outside diffTreeSnapshots.
 * `digests` maps repo-relative path → content identity at snapshot time (sha256 hex, or
 * the sentinel `absent` when a delete-shaped porcelain path is missing on disk). Used only so
 * same-porcelain-line re-edits are visible; not a public API for the gate.
 */
export type TreeSnapshot =
  | { ok: true; root: string; lines: Set<string>; digests: Map<string, string> }
  | { ok: false; reason: TreeSnapshotFailReason };

const WRITE_NAME_SET = new Set<string>(JUDGE_WRITE_TOOL_NAMES);

/**
 * Clamp: only ever run git with -C <absRoot>. Refuse roots outside sandboxRoot when provided.
 * Constraint: never pass plan paths as free-form shell; argv is fixed literals + one abs root.
 */
export function assertRootInsideSandbox(nodeRoot: string, sandboxRoot: string): string {
  const root = resolve(sandboxRoot);
  const abs = resolve(nodeRoot);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`tree-change root escapes sandboxRoot: ${abs} (sandbox ${root})`);
  }
  return abs;
}

/**
 * Parse `git status --porcelain=v1` into FULL line keys (XY + path / rename).
 * Line keys catch status-letter and rename changes; they do NOT catch content-only
 * re-edits that leave the same porcelain line (e.g. still ` M path`). Content identity
 * for dirty paths lives in TreeSnapshot.digests and is compared in diffTreeSnapshots.
 * Rename lines keep the full line so status/path changes are visible.
 */
export function parsePorcelainLines(stdout: string): string[] {
  const out: string[] = [];
  for (const line of (stdout ?? '').split(/\r?\n/)) {
    if (!line || line.length < 4) continue;
    out.push(line);
  }
  return out;
}

/**
 * Decode a git porcelain v1 path that may be C-quoted (`"my file.ts"`, escapes).
 * Without this, digests resolve a non-existent path and can invent known-clean on re-edit.
 */
function unquotePorcelainPath(raw: string): string {
  const t = raw.trim();
  if (t.length < 2 || t[0] !== '"' || t[t.length - 1] !== '"') return t;
  const inner = t.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = inner[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === '"' || n === '\\') out += n;
    else if (n >= '0' && n <= '7') {
      let oct = n;
      if (inner[i + 1] >= '0' && inner[i + 1] <= '7') oct += inner[++i];
      if (inner[i + 1] >= '0' && inner[i + 1] <= '7') oct += inner[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else {
      out += n;
    }
  }
  return out;
}

/** Path portion of a porcelain v1 line (rename → destination; unquoted). */
export function pathFromPorcelainLine(line: string): string {
  if (!line || line.length < 4) return '';
  const body = line.slice(3);
  const arrow = body.indexOf(' -> ');
  const raw = (arrow >= 0 ? body.slice(arrow + 4) : body).trim();
  return unquotePorcelainPath(raw);
}

/** Sentinel when a delete-shaped porcelain path is missing on disk. Not exported. */
const DIGEST_ABSENT = 'absent';

/** True when XY status indicates a delete (worktree or index). Only then may digest be `absent`. */
function porcelainLineAllowsAbsent(line: string): boolean {
  if (!line || line.length < 2) return false;
  const x = line[0];
  const y = line[1];
  return x === 'D' || y === 'D';
}

/**
 * Content identity for one porcelain path under root. No git spawn.
 * Fail closed: any read/stat error, non-file, fifo/socket, sandbox escape → null
 * (caller turns the whole snapshot unknown).
 * Missing on disk:
 *   - allowAbsent true (delete-shaped XY) → DIGEST_ABSENT
 *   - otherwise → null (never invent known-clean for a listed non-delete path)
 * Identity is sha256 of bytes only — not mtime/size (mtime-only must not false-dirty).
 */
function digestPathContent(
  root: string,
  relPath: string,
  allowAbsent: boolean,
): string | null {
  if (!relPath) return null;
  let abs: string;
  try {
    abs = assertRootInsideSandbox(resolve(root, relPath), root);
  } catch {
    return null;
  }
  try {
    if (!existsSync(abs)) {
      return allowAbsent ? DIGEST_ABSENT : null;
    }
    const st = statSync(abs);
    // Reject dirs (submodules), fifos, sockets — never hang on blocking specials.
    if (!st.isFile() || st.isFIFO() || st.isSocket()) return null;
    const buf = readFileSync(abs);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/** Paths from a known-true fact’s line keys. */
export function pathsFromFilesChanged(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const p = pathFromPorcelainLine(line);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Snapshot porcelain lines + per-path content digests under nodeRoot.
 * Fail closed to unknown — never return known-empty on error (status OR digest).
 * Git spawns (exactly two on success): rev-parse --is-inside-work-tree; status --porcelain=v1 -uall.
 * Content digests use fs reads only (0 extra git spawns) — required for same-line re-edits and untracked.
 */
export function snapshotTree(
  nodeRoot: string,
  opts?: {
    sandboxRoot?: string;
    /** Test seam only: force digest failure / alternate identity. Production leaves this unset. */
    digestPath?: (root: string, relPath: string) => string | null;
  },
): TreeSnapshot {
  if (!nodeRoot || !existsSync(nodeRoot)) {
    return { ok: false, reason: 'root-unavailable' };
  }
  let root: string;
  try {
    root = opts?.sandboxRoot
      ? assertRootInsideSandbox(nodeRoot, opts.sandboxRoot)
      : resolve(nodeRoot);
  } catch {
    return { ok: false, reason: 'root-unavailable' };
  }

  const inside = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (inside.status !== 0 || String(inside.stdout).trim() !== 'true') {
    return { ok: false, reason: 'not-a-git-worktree' };
  }

  const st = spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '-uall'], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (st.status !== 0 || st.error) {
    return { ok: false, reason: 'snapshot-failed' };
  }

  const lines = parsePorcelainLines(st.stdout ?? '');
  const digests = new Map<string, string>();
  for (const line of lines) {
    const p = pathFromPorcelainLine(line);
    if (!p) continue;
    if (digests.has(p)) continue; // same path on two lines (rare); first digest wins
    let d: string | null;
    try {
      if (opts?.digestPath) {
        d = opts.digestPath(root, p);
      } else {
        d = digestPathContent(root, p, porcelainLineAllowsAbsent(line));
      }
    } catch {
      // Inject or unexpected throw must degrade to unknown, never crash the node mid-gate.
      return { ok: false, reason: 'snapshot-failed' };
    }
    if (d === null) {
      return { ok: false, reason: 'snapshot-failed' };
    }
    digests.set(p, d);
  }
  return { ok: true, root, lines: new Set(lines), digests };
}

/**
 * Diff two snapshots into a FilesChangedFact (still porcelain LINE keys in filesChanged).
 * (1) Symmetric difference of porcelain line sets (status / rename / appear / disappear).
 * (2) Same line still present both sides, but path content digest changed → include that line
 *     (the measured pre-dirty re-edit case). Journal shape stays porcelain lines for attribution.
 * Guarantees: never invent known-empty on failed/mismatched roots; missing digests map or
 * missing per-path digest for a shared line → known:false (fail closed).
 */
export function diffTreeSnapshots(before: TreeSnapshot, after: TreeSnapshot): FilesChangedFact {
  if (!before.ok) return { known: false, reason: before.reason };
  if (!after.ok) return { known: false, reason: after.reason };
  if (before.root !== after.root) {
    return { known: false, reason: 'snapshot-failed' };
  }
  // Partial / legacy snapshots without digests must not throw or invent clean.
  if (!before.digests || !after.digests) {
    return { known: false, reason: 'snapshot-failed' };
  }

  const changed: string[] = [];
  for (const line of after.lines) {
    if (!before.lines.has(line)) changed.push(line);
  }
  for (const line of before.lines) {
    if (!after.lines.has(line)) changed.push(line);
  }

  // Content-only re-edits: porcelain line string unchanged, worktree bytes changed.
  const afterLineByPath = new Map<string, string>();
  for (const line of after.lines) {
    const p = pathFromPorcelainLine(line);
    if (p && !afterLineByPath.has(p)) afterLineByPath.set(p, line);
  }
  for (const line of before.lines) {
    if (!after.lines.has(line)) continue; // already in line symdiff if only on one side
    const p = pathFromPorcelainLine(line);
    if (!p) continue;
    const bd = before.digests.get(p);
    const ad = after.digests.get(p);
    if (bd === undefined || ad === undefined) {
      return { known: false, reason: 'snapshot-failed' };
    }
    if (bd !== ad) {
      changed.push(afterLineByPath.get(p) ?? line);
    }
  }

  return { known: true, filesChanged: [...new Set(changed)].sort() };
}

function normPath(p: string): string {
  return normalize(p.replace(/^\.\/+/, '').trim()).replace(/\\/g, '/');
}

function pathsMatch(a: string, b: string): boolean {
  const na = normPath(a);
  const nb = normPath(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

/**
 * Surface paths the deliverable / write tools claim to touch.
 * Used only for attribution of dirty porcelain — not a second write counter.
 */
export function extractSurfacePaths(text: string, toolEvents?: ToolEvent[]): string[] {
  const out = new Set<string>();
  for (const e of toolEvents ?? []) {
    if (WRITE_NAME_SET.has(e.name) && e.arg?.trim()) out.add(normPath(e.arg));
  }
  const raw = text ?? '';
  for (const m of raw.matchAll(/\bfile:\s*([^\s,;)`'"]+)/gi)) {
    out.add(normPath(m[1]));
  }
  // Repo-shaped paths in prose / fences / plan headers
  for (const m of raw.matchAll(
    /(?:^|[\s`'"(\[]|FILE\s+[A-Z]\s*[—–:-]\s*)((?:lib|app|tests|scripts|components|packages|db)\/[\w./+-]+\.\w+)/gim,
  )) {
    out.add(normPath(m[1]));
  }
  // Fence language tags: ```ts lib/foo.ts
  for (const m of raw.matchAll(/```[\w.+-]*\s+((?:lib|app|tests|scripts|components|packages|db)\/[^\s`]+)/g)) {
    out.add(normPath(m[1]));
  }
  return [...out];
}

/**
 * True only when known dirty AND at least one dirty path intersects the surface.
 * Empty surface + any dirty ⇒ false (junk-marker / peer dirt cannot clear fabrication).
 */
export function treeWorkLanded(
  fact: FilesChangedFact | undefined,
  text: string,
  toolEvents?: ToolEvent[],
): boolean {
  if (!fact || fact.known !== true) return false;
  if (fact.filesChanged.length === 0) return false;
  const dirty = pathsFromFilesChanged(fact.filesChanged);
  const surface = extractSurfacePaths(text, toolEvents);
  if (surface.length === 0) return false;
  return dirty.some((d) => surface.some((s) => pathsMatch(d, s)));
}

/** Known empty porcelain under root (not unknown, not dirty). */
export function treeKnownClean(fact: FilesChangedFact | undefined): boolean {
  return fact?.known === true && fact.filesChanged.length === 0;
}
