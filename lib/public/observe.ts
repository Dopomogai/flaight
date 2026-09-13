import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parsePlan } from '../opused/fleet/plan';

const safeId = (id: string) => /^[A-Za-z0-9_-]+$/.test(id);

/** Read only an existing regular file inside the configured run directory, with a byte limit. */
function boundedRead(root: string, file: string): string {
  const realRoot = realpathSync(root);
  const target = resolve(root, file);
  const rel = relative(realRoot, realpathSync(target));
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Path outside run directory');
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65_536) throw new Error('Artifact is not a regular file under 64 KiB');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

export function listRuns(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink() && safeId(e.name))
    .map(e => e.name).sort().slice(0, 100);
}

export function readArtifact(root: string, runId: string, artifact: string): string {
  if (!safeId(runId)) throw new Error('Invalid run ID');
  const actualRoot = realpathSync(root);
  const runDir = realpathSync(join(actualRoot, runId));
  if (relative(actualRoot, runDir) !== runId) throw new Error('Run directory is not a direct child');
  if (artifact === 'plan.json' || artifact === 'run.jsonl') return boundedRead(runDir, artifact);
  const parsed = parsePlan(JSON.parse(boundedRead(runDir, 'plan.json')));
  if (!parsed.ok) throw new Error('Invalid stored plan');
  const declared = parsed.plan.stages.flatMap(s => s.nodes.map(n => n.contract.outputPath));
  if (!declared.includes(artifact)) throw new Error('Artifact is not declared in the plan');
  return boundedRead(runDir, artifact);
}
