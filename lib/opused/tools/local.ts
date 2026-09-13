// @purpose: Sandboxed local-file tools (list/read) an agentic seat can call — confined to ONE root dir
// @why: To test tool-using council seats against local files without a "read any path" hole (exactly the
//       injection/exfil risk the skeptic seat flagged). Every path is resolved and MUST stay inside the
//       configured root — traversal (../) is refused. Tools NEVER throw (KB-tool convention): a bad path
//       returns { error } so the model adapts. Read size is capped so one big file can't blow the window.
// @role: safety-critical
// @stability: experimental

import { tool } from 'ai';
import { z } from 'zod';
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { resolve, relative, sep, join } from 'node:path';
import { approxTokens, tokensToChars } from '../tokens';

// We speak in TOKENS (operator rule). Default read cap = 60k tokens, so most files (incl. the ~20k-tok
// model-loop.ts) come back whole in one read; larger files paginate via offset/nextOffset.
const DEFAULT_MAX_TOKENS = 60_000;
const MAX_LIST = 200;
// read_many total-response cap (~60k chars): even with many small files the combined payload stays
// window-bounded. Later files past this cap are omitted with a note rather than blowing the window.
const READ_MANY_TOTAL_CHARS = 60_000;
const READ_MANY_MAX_PATHS = 20;

/** True iff `abs` is the root itself or strictly inside it (no `..` escape, no sibling-prefix trick).
 *  Exported so the write tools share this ONE safety guard (a sandbox check shouldn't be duplicated). */
export function withinRoot(root: string, abs: string): boolean {
  if (abs === root) return true;
  const rel = relative(root, abs);
  return !rel.startsWith('..') && !rel.startsWith(sep) && !rel.includes(`..${sep}`);
}
const within = withinRoot;

/** Shared safety pass for a read target — the ONE guard both read_local and read_many use so it is
 *  NEVER duplicated (and therefore never weakened). Plain withinRoot check FIRST (so a `..` traversal
 *  gets the contractual sandbox error, not ENOENT), THEN realpath canonicalization so an inside
 *  symlink pointing outside is also refused (the escape fix). Returns the safe absolute path or
 *  `{ error }` (tools never throw — KB-tool convention). */
function safeResolve(root: string, path: string): { absReal: string } | { error: string } {
  const abs = resolve(root, path);
  if (!within(root, abs)) return { error: 'path escapes the sandbox root' };
  let absReal: string;
  try {
    absReal = realpathSync(abs);
  } catch (e) {
    return { error: `read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!within(root, absReal)) return { error: 'path escapes the sandbox root' };
  return { absReal };
}

/** The two read-only local-file tools, confined to `rootDir`. Returns { error } rather than throwing.
 *  `opts.maxTokens` overrides the per-read token cap (default 60k). */
export function createLocalFileTools(rootDir: string, opts: { maxTokens?: number } = {}) {
  // Canonicalize the ROOT too (not just the target): on macOS tmp dirs live behind a symlink
  // (/var → /private/var), so comparing a realpathed target against a non-realpathed root would
  // refuse every legitimate read. A root that doesn't exist yet keeps its resolved form.
  let root = resolve(rootDir);
  try { root = realpathSync(root); } catch { /* keep resolved form */ }
  const maxChars = tokensToChars(opts.maxTokens ?? DEFAULT_MAX_TOKENS);
  return {
    list_files: tool({
      description:
        'List files under a directory (relative to the sandbox root). Use to discover what local files ' +
        'exist before reading one. Returns relative paths only.',
      inputSchema: z.object({
        dir: z.string().default('.').describe('directory relative to the sandbox root, e.g. "." or "docs/opused"'),
      }),
      execute: async ({ dir }) => {
        const abs = resolve(root, dir);
        // Plain check FIRST (contractual sandbox error for `..` traversal), then canonicalize
        // to refuse an inside symlink that points outside.
        if (!within(root, abs)) return { error: 'path escapes the sandbox root' };
        let safeDir: string;
        try {
          safeDir = realpathSync(abs);
        } catch (e) {
          return { error: `list failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        if (!within(root, safeDir)) return { error: 'path escapes the sandbox root' };
        try {
          const out: string[] = [];
          const walk = (d: string) => {
            for (const name of readdirSync(d)) {
              if (name.startsWith('.') || name === 'node_modules') continue;
              const p = join(d, name);
              const st = statSync(p);
              if (st.isDirectory()) {
                try {
                  const dReal = realpathSync(p);
                  if (!within(root, dReal)) continue;
                  walk(p);
                } catch (e) {
                  // ignore
                }
              } else {
                try {
                  const pReal = realpathSync(p);
                  if (!within(root, pReal)) continue;
                  if (out.length < MAX_LIST) out.push(relative(root, p));
                } catch (e) {
                  // ignore
                }
              }
            }
          };
          walk(safeDir);
          return { files: out, truncated: out.length >= MAX_LIST };
        } catch (e) {
          return { error: `list failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
    }),
    read_local: tool({
      description:
        'Read a local file by its path relative to the sandbox root. Most files return whole (~60k-token cap). ' +
        'If the result has truncated=true, call again with offset=<nextOffset> to read the next chunk — this is ' +
        'how you read a very large file fully instead of seeing only its start.',
      inputSchema: z.object({
        path: z.string().min(1).describe('file path relative to the sandbox root, e.g. "docs/opused/00-requirements.md"'),
        offset: z.number().int().min(0).default(0).describe('char offset to start reading from (use nextOffset from a prior truncated read to continue)'),
      }),
      execute: async ({ path, offset }) => {
        // Reuse the ONE safety guard (safeResolve) — plain withinRoot FIRST, then realpath, so a
        // `..` traversal gets the contractual sandbox error and an inside symlink pointing outside is
        // refused. Never duplicate this logic (a second copy drifts / weakens).
        const sr = safeResolve(root, path);
        if ('error' in sr) return sr;
        try {
          const full = readFileSync(sr.absReal, 'utf8');
          const start = Math.min(offset, full.length);
          const content = full.slice(start, start + maxChars);
          const end = start + content.length;
          const truncated = end < full.length;
          return {
            path, content, offset: start, nextOffset: truncated ? end : null, truncated,
            tokens: approxTokens(content), totalTokens: approxTokens(full),
          };
        } catch (e) {
          return { error: `read failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
    }),
    read_many: tool({
      description:
        'Read up to 20 local files by their paths relative to the sandbox root in one call. Returns per-path ' +
        '{ path, content?, tokens?, error?, note? }. Each file uses the SAME sandbox safety passes as read_local ' +
        '(path traversal + insider-symlink-to-outside are refused per-path; the other paths still succeed). ' +
        'Per-file content is capped at the read cap; the combined response is capped at ~60k chars — files past ' +
        'the total cap are omitted with a note rather than paginated (use read_local for a large single file).',
      inputSchema: z.object({
        paths: z.array(z.string().min(1)).describe('file paths relative to the sandbox root, e.g. ["docs/a.md","lib/b.ts"]'),
      }),
      execute: async ({ paths }) => {
        if (paths.length > READ_MANY_MAX_PATHS) {
          return { error: `too many paths (${paths.length}): read_many accepts at most ${READ_MANY_MAX_PATHS}` };
        }
        const results: Array<{ path: string; content?: string; tokens?: number; error?: string; note?: string }> = [];
        let totalChars = 0;
        let capped = false;
        for (const p of paths) {
          // Past the total cap: omit (with a note) — do NOT read the file, just record it was skipped.
          if (capped || READ_MANY_TOTAL_CHARS - totalChars <= 0) {
            capped = true;
            results.push({ path: p, note: 'omitted: total response cap reached' });
            continue;
          }
          // SAME safety guard as read_local — never a weakened/duplicated copy.
          const sr = safeResolve(root, p);
          if ('error' in sr) { results.push({ path: p, error: sr.error }); continue; }
          try {
            const full = readFileSync(sr.absReal, 'utf8');
            const remaining = READ_MANY_TOTAL_CHARS - totalChars;
            const cap = Math.min(maxChars, remaining);
            const content = full.slice(0, cap);
            let note: string | undefined;
            if (full.length > remaining) {
              // The total cap bound this file (couldn't fit the whole file in the remaining budget).
              note = 'truncated: total response cap reached';
              capped = true;
            } else if (content.length < full.length) {
              // Per-file cap bound this file (file larger than the per-read cap).
              note = 'truncated: per-file cap reached';
            }
            results.push({ path: p, content, tokens: approxTokens(content), ...(note ? { note } : {}) });
            totalChars += content.length;
          } catch (e) {
            results.push({ path: p, error: `read failed: ${e instanceof Error ? e.message : String(e)}` });
          }
        }
        return { results, totalChars, capped };
      },
    }),
  };
}
