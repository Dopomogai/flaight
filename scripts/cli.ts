import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePlan } from '../lib/opused/fleet/plan';
import { simulate } from '../lib/public/simulate';

const [command, file, runsRoot = 'runs'] = process.argv.slice(2);
if (!file || !['validate', 'simulate'].includes(command)) {
  console.log('Usage: pnpm flaight validate <plan.json>\n       pnpm flaight simulate <plan.json> [runs-directory]');
  process.exitCode = command === '--help' || !command ? 0 : 2;
} else {
  try {
    const raw = readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > 100_000) throw new Error('Plan exceeds 100 KB');
    const input: unknown = JSON.parse(raw);
    if (command === 'validate') {
      const parsed = parsePlan(input);
      if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
      console.log(JSON.stringify({ valid: true, name: parsed.plan.name, stages: parsed.plan.stages.length }));
    } else {
      const result = await simulate(input, resolve(runsRoot));
      console.log(JSON.stringify({ simulation: true, runId: result.runId, runDir: result.runDir,
        done: result.done, failed: result.failed, skipped: result.skipped,
        pausedAt: result.stoppedAtGate ?? null }, null, 2));
      process.exitCode = result.failed || result.skipped || result.stoppedAtGate || result.stoppedBy ? 1 : 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Command failed');
    process.exitCode = 1;
  }
}
