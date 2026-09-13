// @purpose: Council types — a seat is {model, angle}, the panel fans out, the judge synthesizes
// @why: This is the shared vocabulary for Opused's "fan-out → judge" (docs/opused/00 §2). The two axes
//       are orthogonal BY TYPE: a Seat carries BOTH a `model` (which LLM) and an `angle`+`system` (the
//       lens / role) — you compose them freely. Every seat receives the SAME full `context` (the Fusion
//       fix). The generate fn is injected (CouncilGenerate) so the panel/judge are pure + zero-spend in
//       tests. R11: outputs are PROSE + STRUCTURE only — no numeric scores ever originate here.
// @role: logic
// @stability: experimental

/** One council seat: a model running a specific lens. The orchestrator sets `system` (the angle prompt). */
export interface Seat {
  id: string;             // stable id, e.g. 'architect'
  model: string;          // OpenRouter slug, e.g. 'anthropic/claude-opus-4.8'
  angle: string;          // human label of the lens, e.g. 'architect' / 'skeptic' / 'simplicity'
  system: string;         // the angle system prompt the orchestrator injects for THIS seat
  maxOutputTokens?: number;
  tools?: string[];       // registry tool ids this seat may call (e.g. ['kb.search','local.read']) — agentic seat
  maxSteps?: number;      // tool-loop step cap for an agentic seat (default 6)
}

/** The result of one seat's run. A failed seat is ok:false (graceful degrade — the panel goes on). */
export interface SeatResult {
  seat: Seat;
  ok: boolean;
  text: string | null;
  genId: string | null;
  finishReason: string | null;
  truncated: boolean;  // hit the output cap (finishReason==='length') — answer may be cut off (first-class warning)
  retried: boolean;    // was re-run with a bigger budget after a starved first try
  toolsUsed: string[]; // model-facing tool names actually called during the run (empty for a pure-completion seat)
  latencyMs: number;
  error?: string;
}

/** How the judge shapes its reply. The judge PREAMBLE (attribution, injection fence, R11 no-numbers) is
 *  invariant; only this output contract varies per task. Built-ins: synthesisFormat (default), proseFormat,
 *  customFormat(instructions, schema). `instructions` is appended to the preamble; `parse` turns the raw
 *  reply into the verdict object (or null if unusable — the run degrades to raw, never crashes). */
export interface JudgeFormat {
  instructions: string;
  parse: (raw: string) => Record<string, unknown> | null;
}

/** The judge / orchestrator seat (disjoint from the panel by default — D3). */
export interface JudgeConfig {
  model: string;
  maxOutputTokens?: number;
  /** Output contract for this task. Defaults to the 5-field synthesis verdict. */
  format?: JudgeFormat;
}

/** A whole council invocation. */
export interface CouncilConfig {
  task: string;           // the question / instruction
  context: string;        // the full packed bundle — EVERY seat gets this verbatim (the fix)
  seats: Seat[];
  judge: JudgeConfig;
  concurrency?: number;   // bounded fan-out (default 3)
  maxUsd?: number;        // per-invocation ceiling; a pre-flight estimate over it refuses to spend
  estCostPerCallUsd?: number; // crude per-call estimate for the pre-flight guard (default 0.05)
}

/** The judge's structured synthesis. ALL prose — no numbers/scores (R11). */
export interface JudgeVerdict {
  consensus: string[];        // points the seats agree on
  contradictions: string[];   // where seats disagree (the signal correlated clones would hide)
  blind_spots: string[];      // what NO seat covered (completeness)
  unique_insights: string[];  // a single seat's non-obvious contribution worth keeping
  final: string;              // the synthesized answer/verdict (prose)
}

/** The full owned output (R7): per-seat data + the synthesis + total cost. */
export interface CouncilResult {
  task: string;
  seats: SeatResult[];
  verdict: JudgeVerdict | Record<string, unknown> | null; // synthesis verdict, a custom-format object, or null (raw kept)
  judgeRaw: string | null;      // raw judge text — fallback + audit
  judgeFailed: boolean;
  costUsd: number;              // total: panel + judge, summed BYOK-correct
}

/** The injected model call — the ONE seam that touches a real LLM. Stubbed in tests for zero spend.
 *  When `tools` is present the live impl runs an agentic loop (stopWhen stepCountIs(maxSteps)) and
 *  reports the tool names it called back in `toolCalls`. */
/** One tool invocation: the tool name + the salient argument (which file/query/dir) + an error if it failed.
 *  This is what makes "how are the tools actually being used?" answerable per seat. */
export interface ToolEvent {
  name: string;   // model-facing tool name, e.g. 'read_local'
  arg: string;    // the salient input — path / query / dir / sessionId
  error?: string; // set iff the tool returned { error } (never-throw convention)
}

/** One real model call's full content — the ground-truth "log" of what was sent and what came back. */
export interface CallTrace {
  model: string;
  system: string;
  prompt: string;
  response: string;
  finishReason: string | null;
  toolCalls: string[];     // tool names in call order (kept for back-compat)
  toolEvents: ToolEvent[]; // name + which file/query + error — the debuggable record
  elapsedMs?: number;      // whole-call wall-clock ms
  // Token usage (summed across agentic steps). Enables per-node tok/s = completionTokens / (elapsedMs/1000).
  // Normalized from the SDK's usage (v5 inputTokens/outputTokens or older prompt/completionTokens).
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** One agentic step's telemetry, surfaced AS IT FINISHES (W3 live-view seed) — normalized from the SDK's
 *  onStepFinish. `tools` = the tool names called this step; `tokens` = completion tokens if the provider reports. */
export interface StepInfo {
  index: number;
  tools: string[];
  tokens?: number;
  finishReason?: string;
}

export type CouncilGenerate = (args: {
  model: string;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  tools?: Record<string, unknown>;
  maxSteps?: number;
  /** W3: per-step callback (composed with the seam's stall-watchdog + step-log). The runner uses it to append
   *  node_step events to run.jsonl so the cockpit can stream a node's live progress. */
  onStep?: (info: StepInfo) => void;
  /** L1: per-call trace — the runner persists each call as a turn record (nodes/<id>/turns/<NN>.json). */
  onCall?: (trace: CallTrace) => void;
  /** #43 CONTINUATION (founder design): the node's prior conversation (user/assistant/tool messages, AI-SDK
   *  ModelMessage shape — opaque here so this module stays SDK-free). When present, the call CONTINUES that
   *  conversation instead of starting fresh from `prompt` — the node keeps everything it read and did.
   *  `prompt` carries the NEW instruction (feedback); the seam appends it as the final user message and it
   *  is what the L1 turn record shows (not the whole history dump). */
  messages?: unknown[];
}) => Promise<{
  text: string; genId: string | null; finishReason: string | null; toolCalls?: string[];
  /** #43: the RESUMABLE history after this call — input messages (or the prompt as a user turn) + everything
   *  the model did (assistant turns, tool calls, tool results). Feed back via `messages` to continue. */
  messages?: unknown[];
}>;
