import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parsePlan, type FleetPlan } from '../opused/fleet/plan';
import { runPlan, type RunResult } from '../opused/fleet/run';
import { makeSimGenerate } from '../opused/fleet/sim';

/** Simulation never dispatches a CLI, tool, compute connection, or separate model judge. */
export function offlinePlan(input: unknown): FleetPlan {
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > 100_000) throw new Error('Plan exceeds 100 KB');
  const parsed = parsePlan(input);
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  const plan = parsed.plan;
  const nodes = plan.stages.flatMap(s => s.nodes);
  if (nodes.length > 64) throw new Error('CLI simulation is limited to 64 nodes');
  for (const stage of plan.stages) {
    if (stage.sharedInject?.length) throw new Error('Offline simulation does not read injected files');
    for (const node of stage.nodes) {
      if (node.kind !== 'agent' || node.agent.runner !== 'api') throw new Error('Offline simulation requires agent/api nodes');
      if (node.inject.length || node.tools?.length || node.agent.cwd || node.agent.preset || node.agent.persona || node.agent.session) {
        throw new Error('Offline simulation does not use files, tools, sessions, or presets');
      }
      if (node.contract.judge?.runner) throw new Error('Offline simulation does not dispatch an external judge');
    }
  }
  return plan;
}

export async function simulate(input: unknown, runsRoot: string): Promise<RunResult> {
  const plan = offlinePlan(input);
  mkdirSync(runsRoot, { recursive: true });
  const root = realpathSync(resolve(runsRoot));
  // Allocate a fresh directory: never overwrite or resume somebody else's run.
  const runDir = mkdtempSync(join(root, 'sim-'));
  const runId = basename(runDir);
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  const result = await runPlan(plan, runId, {
    generate: makeSimGenerate(plan), defaultModel: 'simulation', concurrency: 4,
    runsRoot: root, sandboxRoot: runDir, maxRepairs: 0, judgeSeamEnv: {},
    runMeta: { sim: true, source: 'standalone-cli' },
  });
  return result;
}
