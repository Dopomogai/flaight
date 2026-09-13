// @purpose: Load the fleet's safety-critical modules under the loader the CLI actually uses (tsx)
// @why: judge-evidence <-> tree-change was a top-level cycle. `pnpm fleet` died on load; every vitest
//       file stayed green because Vite resolves cyclic bindings lazily and tsx does not. A test that
//       only imports the module in-process cannot see this class of break. (2026-08-08)
// @role: safety-critical
// @stability: stable

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FLEET = join(process.cwd(), 'lib', 'opused', 'fleet');

/**
 * Load `entry` in a real tsx subprocess and return `'OK:<value>'`, or `'LOAD-FAILED: <first line>'`.
 *
 * Two things here are load-bearing, both learned the hard way on 2026-08-08:
 *
 * 1. The extension picks the loader. `.mts` makes tsx use the ESM loader and `.ts` the CJS one, and
 *    the cycle crashed on OPPOSITE entry points under the two (ESM died entering tree-change, CJS
 *    died entering judge-evidence). Testing one loader would have missed half the break.
 *
 * 2. We must NOT let the child's raw stderr reach vitest's error serializer. When execFileSync's
 *    thrown Error carried the tsx crash dump, vitest's stack parser hit the sourcemap comment in it,
 *    threw `SyntaxError: Unexpected token` inside `parseErrorStacktrace`, and then reported two
 *    genuinely-failing tests as PASSED (its own warning: "This might cause false positive tests").
 *    So we catch, keep one sanitized line, and assert on a plain string. A regression test that the
 *    reporter can turn green is not a regression test.
 */
function loadUnderTsx(ext: 'mts' | 'ts', source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-load-'));
  const file = join(dir, `entry.${ext}`);
  writeFileSync(file, source);
  try {
    const out = execFileSync('npx', ['tsx', file], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return out.trim();
  } catch (e: unknown) {
    const raw = String((e as { stderr?: string }).stderr ?? (e as Error).message ?? '');
    const line =
      raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /^(ReferenceError|TypeError|SyntaxError|Error)\b/.test(l)) ?? 'no error line';
    return `LOAD-FAILED: ${line.replace(/[^\x20-\x7e]/g, '?').slice(0, 160)}`;
  }
}

describe('fleet module graph loads under tsx (the loader `pnpm fleet` uses)', () => {
  it('entering tree-change first initialises its write-name set (ESM)', () => {
    expect(
      loadUnderTsx(
        'mts',
        `import { treeKnownClean } from '${FLEET}/tree-change';\n` +
          `console.log('OK:' + typeof treeKnownClean);\n`,
      ),
    ).toBe('OK:function');
  });

  it('entering judge-evidence first initialises JUDGE_WRITE_TOOL_NAMES (CJS)', () => {
    expect(
      loadUnderTsx(
        'ts',
        `import { JUDGE_WRITE_TOOL_NAMES } from '${FLEET}/judge-evidence';\n` +
          `console.log('OK:' + JUDGE_WRITE_TOOL_NAMES.length);\n`,
      ),
    ).toBe('OK:11');
  });

  it('the write-name list stays a leaf — an import there can re-break the CLI', () => {
    expect(
      loadUnderTsx(
        'mts',
        `import { JUDGE_WRITE_TOOL_NAMES } from '${FLEET}/write-tool-names';\n` +
          `console.log('OK:' + JUDGE_WRITE_TOOL_NAMES.length);\n`,
      ),
    ).toBe('OK:11');
  });
});
