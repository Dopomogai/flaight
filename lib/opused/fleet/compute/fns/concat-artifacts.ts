// @purpose: Deterministic merge of consumed node artifacts into one text
// @why: First compute id — $0, no model; downstream agents cite one file
// @role: logic
// @stability: experimental

import type { ComputeFn } from '../types';

export const concatArtifacts: ComputeFn = async ({ consumed }) => {
  if (consumed.length === 0) {
    return { ok: false, reason: 'concat-artifacts: no consumed artifacts' };
  }
  const parts = consumed.map((c) => `===== ${c.nodeId} =====\n${c.text.trimEnd()}\n`);
  return { ok: true, text: parts.join('\n') };
};
