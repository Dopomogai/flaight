// @purpose: Shared CLI process helpers — process-group kill + detached spawn for product CLIs
// @why: CR-2b/CR-3: claude and grok executors must reap orphan tool trees on timeout; one kill/spawn impl.
// @role: safety-critical
// @stability: experimental

import { spawn } from 'node:child_process';

/** Injectable process spawn — tests stub without a real CLI binary. */
export type CliSpawn = (args: {
  bin: string;
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Optional stdin body (unused when prompt is argv). */
  stdin?: string;
}) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Kill a child and (on Unix) its process group. CR-2b: timeout must not leave orphan bash/tool trees.
 * detached spawn makes the child the group leader → process.kill(-pid) reaps descendants.
 */
export function killProcessTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (pid === undefined || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      process.kill(pid, signal);
    } catch {
      /* already dead */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already dead */
    }
  }
}

/**
 * Default spawn via child_process.spawn (not exec — avoids shell injection).
 * Unix: detached process group + group kill on timeout.
 * @param label short name for timeout log lines (e.g. "claude", "grok")
 */
export function createDefaultCliSpawn(label: string): CliSpawn {
  return ({ bin, argv, cwd, env, timeoutMs, stdin }) =>
    new Promise((resolvePromise) => {
      const useGroup = process.platform !== 'win32';
      const child = spawn(bin, argv, {
        cwd,
        env: env ?? process.env,
        stdio: stdin !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
        detached: useGroup,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        resolvePromise({ stdout, stderr, exitCode });
      };
      const timer = setTimeout(() => {
        killProcessTree(child.pid, 'SIGTERM');
        setTimeout(() => {
          killProcessTree(child.pid, 'SIGKILL');
        }, 2_000);
        stderr += `\n[opused] ${label} timeout after ${timeoutMs}ms (process-group kill)\n`;
        finish(124);
      }, timeoutMs);
      child.stdout?.on('data', (b: Buffer) => {
        stdout += b.toString('utf8');
      });
      child.stderr?.on('data', (b: Buffer) => {
        stderr += b.toString('utf8');
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        stderr += err.message;
        finish(127);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code ?? 1);
      });
      if (stdin !== undefined && child.stdin) {
        child.stdin.end(stdin, 'utf8');
      }
    });
}
