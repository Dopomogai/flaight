// @purpose: Compute-node contract — named in-box/external logic, never inline plan script
// @why: Founder: interconnect workflows with live container logic + external connections
// @role: logic
// @stability: experimental

export interface ComputeArgs {
  [key: string]: string | number | boolean | undefined;
}

export interface ConsumedArtifact {
  nodeId: string;
  text: string;
}

export type ComputeResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export type ComputeFn = (input: {
  args: ComputeArgs;
  consumed: ConsumedArtifact[];
  env: NodeJS.ProcessEnv;
}) => Promise<ComputeResult>;

export interface ComputeDecl {
  id: string;
  /** What this does, for the autorouter / template author — not executed. */
  whenToUse: string;
  fn: ComputeFn;
}
