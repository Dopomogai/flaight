// @purpose: Run one registered compute id against consumed artifacts
// @why: Unknown id and thrown fn are defects; ok:false is a verdict
// @role: safety-critical
// @stability: experimental

import { getCompute } from './registry';
import type { ComputeArgs, ComputeResult, ConsumedArtifact } from './types';

export async function executeCompute(input: {
  computeId: string;
  args: ComputeArgs;
  consumed: ConsumedArtifact[];
  env: NodeJS.ProcessEnv;
}): Promise<ComputeResult> {
  const decl = getCompute(input.computeId);
  if (!decl) {
    return { ok: false, reason: `unknown compute id: ${input.computeId}` };
  }
  return decl.fn({ args: input.args, consumed: input.consumed, env: input.env });
}
