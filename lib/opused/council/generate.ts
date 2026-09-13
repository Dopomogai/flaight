// @purpose: The LIVE CouncilGenerate — the only place the council touches a real model (ZDR-pinned)
// @why: Keeps panel.ts/judge.ts pure + zero-spend (they take an injected CouncilGenerate; tests stub it).
//       This adapter reuses the SHARED seat (lib/agents/model.ts): the ZDR pin, the provider factory, the
//       providerMetadata strip. One provider is built and reused across every seat. Subscription seats
//       (claude:/codex) are intentionally NOT handled here — the product path is 100% OpenRouter/ZDR (D6).
// @role: safety-critical
// @stability: experimental

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateText, stepCountIs, type ModelMessage } from 'ai';
import {
  createComposerProvider,
  readModelConfig,
  recordGenerationCost,
  ZDR_PROVIDER_OPTIONS,
  INTERNAL_NO_ZDR_PROVIDER_OPTIONS,
  INTERACTIVE_ZDR_PROVIDER_OPTIONS,
  INTERACTIVE_NO_ZDR_PROVIDER_OPTIONS,
} from '../../agents/model';
import type { CouncilGenerate, ToolEvent, CallTrace } from './types';

/** Re-export types for back-compat (existing imports from generate.ts still compile). */
export type { ToolEvent, CallTrace } from './types';

/**
 * Wire-audit fetch: tee the EXACT request body the AI SDK sends to the endpoint into a JSONL file, then call
 * through unchanged. This is the diagnostic for the "tools leak as <tool_call> text on the AI-SDK path but
 * parse cleanly via a direct curl" bug (first live F0 run, Agents-A1): capture the SDK's body and diff it
 * against a known-good direct call to find why vLLM doesn't enter tool-parse mode — the differing field
 * (tool_choice shape, the OpenRouter-provider dialect, or a ZDR providerOptions param a vanilla vLLM doesn't
 * expect) is the fix. Gated by OPUSED_WIRE_AUDIT; never on by default. Never breaks the call.
 */
export function makeWireAuditFetch(logPath: string, base: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    try {
      if (init?.body && typeof init.body === 'string') {
        mkdirSync(dirname(logPath), { recursive: true });
        appendFileSync(logPath, init.body + '\n', 'utf8');
      }
    } catch { /* a logging failure must never break the model call */ }
    return base(input, init);
  }) as typeof fetch;
}

// ── W4 model router ─────────────────────────────────────────────────────────────
// Per-slug provider routing: OPUSED_MODEL_ROUTES (JSON array) maps slug PREFIXES to endpoints, so ONE run
// can mix providers — e.g. `box:` slugs to the self-hosted vLLM while bare slugs stay on OpenRouter:
//   OPUSED_MODEL_ROUTES=[{"prefix":"box:","baseUrl":"https://…modal.run/v1"}]
//   plan node: { agent: { model: "box:internscience/agents-a1" } }  → the box
//   plan node: { agent: { model: "z-ai/glm-5.2" } }                 → OpenRouter (no prefix match)
// This replaces the all-or-nothing OPUSED_FORCE_MODEL posture for mixed fleets (force-pin still works and
// is resolved BEFORE routing, so a forced slug may itself carry a route prefix).

export interface ModelRoute {
  /** Slug prefix this route claims (matched with startsWith, first match wins, checked in array order). */
  prefix: string;
  /** OpenAI-compatible endpoint for this route. Absent = OpenRouter (useful to remap slugs only). */
  baseUrl?: string;
  /** Name of the ENV VAR holding this route's api key (never the key itself — env JSON is not a secret store).
   *  Absent: a baseUrl route falls back to OPENROUTER_API_KEY or 'local' (vLLM accepts any). */
  apiKeyEnv?: string;
  /** Fixed slug to send upstream (e.g. the one model a vLLM serves). Absent = requested slug minus prefix. */
  model?: string;
}

/** Parse OPUSED_MODEL_ROUTES. NEVER throws — a malformed env var must not kill a run; invalid entries are
 *  dropped loudly. Exported for tests. */
export function parseModelRoutes(raw: string | undefined): ModelRoute[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) { console.warn('[council] OPUSED_MODEL_ROUTES is not a JSON array — ignoring.'); return []; }
    const routes: ModelRoute[] = [];
    for (const e of arr) {
      if (e && typeof e === 'object' && typeof (e as ModelRoute).prefix === 'string' && (e as ModelRoute).prefix.length > 0) {
        routes.push(e as ModelRoute);
      } else {
        console.warn(`[council] OPUSED_MODEL_ROUTES: dropping invalid entry ${JSON.stringify(e)} (needs non-empty "prefix").`);
      }
    }
    return routes;
  } catch {
    console.warn('[council] OPUSED_MODEL_ROUTES is not valid JSON — ignoring.');
    return [];
  }
}

/** Resolve a requested slug against the route table: first prefix match wins. Returns the upstream slug to
 *  send and which route claimed it (null = the default provider). Pure; exported for tests. */
export function resolveModelRoute(routes: ModelRoute[], requested: string): { slug: string; routeIndex: number | null } {
  for (let i = 0; i < routes.length; i++) {
    if (requested.startsWith(routes[i].prefix)) {
      return { slug: routes[i].model ?? requested.slice(routes[i].prefix.length), routeIndex: i };
    }
  }
  return { slug: requested, routeIndex: null };
}

/** Reject if a model call runs past `ms` — a slow/hung provider must not stall the whole run forever.
 *  On timeout the seat call throws → the panel degrades it to ok:false and the run continues.
 *  `onTimeout` MUST abort the underlying call: rejecting the wrapper alone leaks a detached generateText
 *  loop that keeps calling the provider + executing tools forever (the wave-1 zombie: nodes marked failed
 *  at 600s while their loops burned credits for 3 more hours — run 2026-07-09T01-13-25-189Z). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      try { onTimeout?.(); } catch { /* the rejection below must win regardless */ }
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** How many CONSECUTIVE steps may end in invalid tool-call input before the call is cut. GLM via a slow
 *  provider truncates large tool-JSON (write_file args cut mid-content) and then retries the identical
 *  emission forever — the SDK feeds "Invalid input for tool …: JSON parsing failed" back each round and
 *  nothing ever converges. Three identical strikes = structural, not transient; abort with a NON-retryable
 *  message (must not match the runner's transient markers: 'timed out after' / 'no step progress'). */
export const INVALID_TOOL_INPUT_STREAK_LIMIT = 3;
const INVALID_TOOL_INPUT_RE = /Invalid input for tool|JSON parsing failed|InvalidToolInput/i;

/** Does a finished step carry the SDK's unparseable-tool-args error (in content parts or tool results)?
 *  Pure; exported for tests. */
export function stepHasInvalidToolInput(s: unknown): boolean {
  try {
    const step = s as { content?: unknown; toolResults?: unknown };
    const dump = JSON.stringify(step.content ?? '') + JSON.stringify(step.toolResults ?? '');
    return INVALID_TOOL_INPUT_RE.test(dump);
  } catch {
    return false;
  }
}

/** Pull the one argument that says WHAT a tool acted on (path for reads, query for search, etc.).
 *  retro B3: the prior 160-char source-only serialization cut copy/move targets (`path` → `to`) down to
 *  the source path alone, so copy-first compliance was unverifiable from the trace and every non-1.0
 *  score in run -631Z was lost to that blind spot. Now: copy/move shapes show src → dest, read_many's
 *  `paths` array is joined, and the budget is 2048 everywhere so a real path is never truncated. */
export function salientArg(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    // (a) copy/move-shaped inputs: show source → destination so the trace proves the copy happened.
    if (typeof o.path === 'string' && typeof o.to === 'string') {
      return `${o.path} → ${o.to}`.slice(0, 2048);
    }
    // (b) read_many: a `paths` array joined with ', ' (a 3000-path bundle still fits the budget).
    if (Array.isArray(o.paths)) {
      return (o.paths as unknown[]).map((p) => String(p)).join(', ').slice(0, 2048);
    }
    // (c) existing fallback chain, (d) 2048-char budget everywhere (was 160).
    const v = o.path ?? o.query ?? o.dir ?? o.sessionId ?? o.cwd;
    return v != null ? String(v).slice(0, 2048) : JSON.stringify(o).slice(0, 2048);
  }
  return '';
}

/**
 * Build a live generate fn + a cost reader, both bound to one OpenRouter provider.
 * `opts.relaxZdr` (INTERNAL ONLY) swaps the ZDR pin for the relaxed posture so logs show + BYOK routes —
 * never pass it on the customer/product path. Default is the full ZDR/BYOK/cost-tracked posture.
 */
export function createLiveCouncil(
  env: Record<string, string | undefined> = process.env,
  opts: { relaxZdr?: boolean; onCall?: (t: CallTrace) => void; callTimeoutMs?: number } = {},
): {
  generate: CouncilGenerate;
  recordCost: (genId: string) => Promise<{ costUsd: number }>;
} {
  const config = readModelConfig(env);
  // Wire audit (diagnostic, off by default): OPUSED_WIRE_AUDIT=<path> tees every outgoing request body to a
  // JSONL so the AI-SDK request can be diffed against a known-good direct call (the tool-serialization bug).
  const wireAuditPath = env.OPUSED_WIRE_AUDIT || undefined;
  // Step telemetry (diagnostic + the seed for cockpit A4 live-view): OPUSED_STEP_LOG=<path> appends one record
  // per agentic step AS IT FINISHES — elapsed ms, token usage (incl. reasoning), tool calls, finishReason. This
  // is what turns "it timed out with no updates" into "K steps, S s/step, R reasoning tokens/step": the log
  // survives a timeout because each step is written when it completes, not after the whole loop returns.
  const stepLogPath = env.OPUSED_STEP_LOG || undefined;
  // Per-step stall watchdog (agentic loops only): abort the call if NO step completes within this window. A
  // blunt whole-call wall-clock cap can't tell a healthy long loop from one hung reading forever; a no-progress
  // watchdog aborts a stuck loop fast (freeing the slot + letting the runner retry-on-timeout) while never
  // penalizing steady progress. Rearmed on each onStepFinish. Default 360s/step (6 min) — a HEAVY write/repair
  // step on a reasoning model (A1) can legitimately exceed 2 min of thinking on a big file; 120s wrongly aborted
  // a repair that was still progressing (measured 2026-07-06). Set 0 to disable (fall back to callTimeoutMs only).
  const stepTimeoutMs = env.OPUSED_STEP_TIMEOUT_MS !== undefined ? Number(env.OPUSED_STEP_TIMEOUT_MS) || 0 : 360_000;
  if (wireAuditPath) console.warn(`[council] WIRE AUDIT ON — request bodies → ${wireAuditPath} (diagnostic; do not leave on).`);
  const provider = createComposerProvider(config, wireAuditPath ? makeWireAuditFetch(wireAuditPath) : undefined); // throws if the ZDR posture isn't satisfied
  // C15 root-cause fix (2026-07-09, build0): three writers died 'Failed to process successful response' —
  // a long completion on a slow provider (observed live in the OpenRouter logs: Novita serving GLM-5.2 at
  // ~18 tok/s) holds one HTTP response open for many minutes until something along the path kills it.
  // Prefer throughput within the SAME privacy posture: the INTERACTIVE_* options only add
  // `sort: 'throughput'` — a pool REORDER (fallbacks stay on, the zdr filter is unchanged). The BYOK
  // spend-accounting hazard that keeps the Analyst on unsorted options does not apply here (the fleet is
  // GLM on OpenRouter, never BYOK). Escape hatch: OPUSED_PROVIDER_SORT=off restores the unsorted options.
  const sortOff = env.OPUSED_PROVIDER_SORT === 'off';
  const providerOptions = opts.relaxZdr
    ? (sortOff ? INTERNAL_NO_ZDR_PROVIDER_OPTIONS : INTERACTIVE_NO_ZDR_PROVIDER_OPTIONS)
    : (sortOff ? ZDR_PROVIDER_OPTIONS : INTERACTIVE_ZDR_PROVIDER_OPTIONS);
  // A hung/slow provider must not stall the whole run forever (this is what killed the report-redesign run
  // mid-Chapter). Per-call cap; on timeout the seat throws → degrades to ok:false → the panel goes on.
  // FOUNDER RULING 2026-07-09: 600s is the FLOOR (300s killed two healthy rt4 writers mid-work). An env
  // value below the floor is clamped up (with a warn); programmatic opts.callTimeoutMs stays unclamped
  // (tests pass tiny timeouts on purpose). For TOOL LOOPS the wall-clock is only a runaway backstop —
  // the per-step stall watchdog above is the progress-aware kill — so it runs at 2× (see wallMsFor).
  const envCallMs = Number(env.OPUSED_CALL_TIMEOUT_MS) || 600_000;
  if (envCallMs < 600_000) console.warn(`[council] OPUSED_CALL_TIMEOUT_MS=${envCallMs} below the 600s floor — clamped to 600000`);
  const callTimeoutMs = opts.callTimeoutMs ?? Math.max(600_000, envCallMs);
  if (opts.relaxZdr) console.warn('[council] ZDR RELAXED (internal mode): data is retained/logged. Do NOT use on the product path.');
  // Self-host force: a single-model endpoint (e.g. Modal vLLM serving only z-ai/glm-5.2) 404s any seat
  // that asks for a different slug (Flash, etc.). When self-hosting, OPUSED_FORCE_MODEL pins EVERY seat
  // and the judge to the served model, so mixed-panel runners route cleanly. Off unless explicitly set.
  const forceModel = config.baseURL ? env.OPUSED_FORCE_MODEL || undefined : undefined;
  if (forceModel) console.warn(`[council] OPUSED_FORCE_MODEL=${forceModel} — all seats + judge pinned to it (self-host).`);

  // W4 router: per-route providers built EAGERLY so a misconfigured route fails at startup, not mid-run.
  // Route apiKey: named env var if given, else OPENROUTER_API_KEY, else 'local' for a baseUrl route (vLLM
  // accepts any key — same fallback readModelConfig uses for the self-host path).
  const routes = parseModelRoutes(env.OPUSED_MODEL_ROUTES);
  const routeProviders = routes.map((rt) => {
    const apiKey = (rt.apiKeyEnv ? env[rt.apiKeyEnv] : undefined) ?? env.OPENROUTER_API_KEY ?? (rt.baseUrl ? 'local' : '');
    return createComposerProvider({ ...config, apiKey, baseURL: rt.baseUrl }, wireAuditPath ? makeWireAuditFetch(wireAuditPath) : undefined);
  });
  if (routes.length) console.warn(`[council] model routes: ${routes.map((r) => `${r.prefix}→${r.baseUrl ?? 'openrouter'}${r.model ? ` (${r.model})` : ''}`).join(' · ')}`);

  const generate: CouncilGenerate = async ({ model, system, prompt, maxOutputTokens, tools, maxSteps, onStep, onCall, messages }) => {
    // Force-pin first (self-host single-model back-compat), then route: first prefix match picks the
    // endpoint + upstream slug; no match = the default provider (OpenRouter, or OPUSED_BASE_URL).
    const resolved = resolveModelRoute(routes, forceModel || model);
    const useModel = resolved.slug;
    const chatProvider = resolved.routeIndex === null ? provider : routeProviders[resolved.routeIndex];
    const base = { model: chatProvider.chat(useModel), maxOutputTokens, providerOptions };
    // #43 CONTINUATION: when the caller passes prior messages, this call CONTINUES that conversation — the
    // node keeps everything it already read/did (tool calls included) instead of starting from a fresh pack.
    // The new instruction (prompt) rides as the final user message; it is also what the L1 trace records.
    const convo = messages
      ? ([...messages, { role: 'user', content: prompt }] as ModelMessage[])
      : undefined;
    const callStart = Date.now();
    let stepIdx = 0;
    // ONE abort controller per call — the wall-clock timeout, the stall watchdog, AND the invalid-tool-input
    // breaker all abort THIS controller, so the loop actually dies (tools stop executing, the provider fetch
    // is cancelled). Created unconditionally: plain completions must be killable too.
    const callController = new AbortController();
    // Stall watchdog — only armed for a tool-loop (single completions emit no step boundaries, so a
    // no-progress abort would wrongly fire mid-generation). Aborts the call if no step finishes within
    // stepTimeoutMs; rearmed by onStepFinish below. armStall() before the call covers the first step.
    const stallMs = tools ? stepTimeoutMs : 0;
    // Tool loops: the stall watchdog is the progress-aware kill (a healthy 20-step loop legitimately
    // exceeds the base cap); the wall-clock is only the runaway backstop → 2×. Plain completions have
    // no step boundaries to observe, so the base wall-clock is their only guard.
    const wallMs = tools ? callTimeoutMs * 2 : callTimeoutMs;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      if (!stallMs) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => callController.abort(new Error(`no step progress for ${Math.round(stallMs / 1000)}s`)), stallMs);
    };
    // Invalid-tool-input circuit breaker (see INVALID_TOOL_INPUT_STREAK_LIMIT above). Counts CONSECUTIVE
    // steps whose results carry the SDK's unparseable-tool-args error; any clean step resets the streak.
    let invalidInputStreak = 0;
    const checkInvalidInputBreaker = (s: unknown) => {
      if (stepHasInvalidToolInput(s)) {
        invalidInputStreak += 1;
        if (invalidInputStreak >= INVALID_TOOL_INPUT_STREAK_LIMIT) {
          callController.abort(new Error(
            `tool-input circuit breaker: ${invalidInputStreak} consecutive steps with unparseable tool-call args ` +
            `(provider truncating tool JSON?) — do not retry`,
          ));
        }
      } else {
        invalidInputStreak = 0;
      }
    };
    // Per-step telemetry (OPUSED_STEP_LOG): logs each step AS IT FINISHES, so a slow loop is visible + survives
    // a timeout. Composed with the stall re-arm into one onStepFinish (either alone wants the hook).
    const logStep = stepLogPath
      ? (s: { usage?: unknown; finishReason?: string; toolCalls?: Array<{ toolName: string }> }, idx: number) => {
          const rec = {
            t: new Date().toISOString(), model: useModel, step: idx, elapsedMs: Date.now() - callStart,
            usage: s.usage, tools: (s.toolCalls ?? []).map((c) => c.toolName), finishReason: s.finishReason,
          };
          try { appendFileSync(stepLogPath, JSON.stringify(rec) + '\n'); } catch { /* never break the call */ }
          console.warn(`  · step ${rec.step} +${Math.round(rec.elapsedMs / 1000)}s tools=[${rec.tools.join(',')}] finish=${rec.finishReason ?? '?'}`);
        }
      : undefined;
    // Steps seen so far — the raw material for a PARTIAL CallTrace when the call dies mid-loop. The wave-1
    // post-mortem was blind on exactly the worst nodes because onCall only fired on success: a node that
    // timed out after 40 steps of work persisted ZERO turns. Accumulated here; flushed in the catch below.
    const stepsSeen: Array<{ tools: string[]; finishReason?: string; tokens?: number }> = [];
    // One composed hook: re-arm the stall watchdog, run the invalid-input breaker, log the step, and (W3)
    // surface a normalized StepInfo to the caller's onStep. stepIdx increments HERE so the index is stable
    // whether or not logStep/onStep are set. Active for every tool-loop — the breaker needs it.
    const onStepFinish = (tools || logStep || onStep)
      ? (s: { usage?: unknown; finishReason?: string; toolCalls?: Array<{ toolName: string }> }) => {
          const idx = stepIdx++;
          armStall();
          checkInvalidInputBreaker(s);
          {
            const u = s.usage as { completionTokens?: number; outputTokens?: number } | undefined;
            stepsSeen.push({ tools: (s.toolCalls ?? []).map((c) => c.toolName), finishReason: s.finishReason, tokens: u?.completionTokens ?? u?.outputTokens });
          }
          logStep?.(s, idx);
          if (onStep) {
            const u = s.usage as { completionTokens?: number; outputTokens?: number } | undefined;
            onStep({ index: idx, tools: (s.toolCalls ?? []).map((c) => c.toolName), tokens: u?.completionTokens ?? u?.outputTokens, finishReason: s.finishReason });
          }
        }
      : undefined;
    // Invalid tool-call DIAGNOSIS (no repair): when the model's tool args fail to parse, record EXACTLY what
    // arrived — byte count + head/tail of the raw args string — to the console + step log. The wave-1 loop
    // was undebuggable precisely because this data didn't exist: the model saw only the SDK's generic
    // 'JSON parsing failed' and guessed (content too long? special chars?) for 13 rounds; the real cause
    // (provider cut the stream mid-args at ~30 tokens) was only visible on the OpenRouter dashboard.
    // Truncation is NOT repairable (the missing bytes are gone) → return null; the SDK feeds its error back
    // and the invalid-input breaker above bounds the retries at 3.
    const diagnoseInvalidToolCall = async (o: { toolCall?: { toolName?: string; input?: unknown }; error?: unknown }) => {
      const raw = typeof o.toolCall?.input === 'string' ? o.toolCall.input : JSON.stringify(o.toolCall?.input ?? '');
      const errMsg = o.error instanceof Error ? o.error.message : String(o.error);
      console.warn(
        `  ⚠ invalid tool-call input: ${o.toolCall?.toolName ?? '?'} — ${raw.length} chars of args received; ` +
        `head=${JSON.stringify(raw.slice(0, 120))} tail=${JSON.stringify(raw.slice(-80))} err=${errMsg.slice(0, 160)}`,
      );
      if (stepLogPath) {
        const rec = { t: new Date().toISOString(), model: useModel, invalidToolInput: { tool: o.toolCall?.toolName, chars: raw.length, head: raw.slice(0, 120), tail: raw.slice(-80), err: errMsg.slice(0, 200) } };
        try { appendFileSync(stepLogPath, JSON.stringify(rec) + '\n'); } catch { /* never break the call */ }
      }
      return null;
    };
    armStall();
    let r: Awaited<ReturnType<typeof generateText>>;
    try {
      r = await withTimeout(generateText({
        ...base,
        system,
        ...(convo ? { messages: convo } : { prompt }),
        abortSignal: callController.signal,
        ...(onStepFinish ? { onStepFinish: onStepFinish as Parameters<typeof generateText>[0]['onStepFinish'] } : {}),
        // Agentic seat: hand it the tools and let it loop up to maxSteps (search/read → reason → answer).
        ...(tools ? {
          tools: tools as Parameters<typeof generateText>[0]['tools'],
          stopWhen: stepCountIs(maxSteps ?? 6),
          experimental_repairToolCall: diagnoseInvalidToolCall as Parameters<typeof generateText>[0]['experimental_repairToolCall'],
        } : {}),
      }), wallMs, `call(${model})`,
      // The abort is the point: without it the rejected call leaves a detached loop still burning credits.
      () => callController.abort(new Error(`call(${model}) timed out after ${Math.round(wallMs / 1000)}s`)));
    } catch (e) {
      // PARTIAL TRACE on failure: flush what the loop DID do (steps, tools, tokens) as a turn record before
      // rethrowing, so a timed-out/aborted node still leaves its L1 history. response stays empty; the
      // finishReason carries the failure so readers can tell a partial from a clean turn at a glance.
      const msg = e instanceof Error ? e.message : String(e);
      const partial: CallTrace = {
        model: useModel, system, prompt, response: '',
        finishReason: `error: ${msg.slice(0, 200)}`,
        toolCalls: stepsSeen.flatMap((s) => s.tools),
        toolEvents: [],
        elapsedMs: Date.now() - callStart,
        completionTokens: stepsSeen.reduce((acc, s) => acc + (s.tokens ?? 0), 0) || undefined,
      };
      try { opts.onCall?.(partial); onCall?.(partial); } catch { /* the original error must win */ }
      throw e;
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
    // Build the debuggable tool record: pair each call with its result (by toolCallId) to capture the
    // salient arg (which file/query) and whether the tool returned { error }.
    const toolEvents: ToolEvent[] = [];
    for (const s of r.steps ?? []) {
      const results = new Map(
        (s.toolResults ?? []).map((tr) => [(tr as { toolCallId?: string }).toolCallId, (tr as { output?: unknown }).output]),
      );
      for (const c of s.toolCalls ?? []) {
        const call = c as { toolName: string; toolCallId?: string; input?: unknown; args?: unknown };
        const out = results.get(call.toolCallId);
        const error = out && typeof out === 'object' && 'error' in out ? String((out as { error: unknown }).error) : undefined;
        toolEvents.push({ name: call.toolName, arg: salientArg(call.input ?? call.args), ...(error ? { error } : {}) });
      }
    }
    const toolCalls = toolEvents.map((e) => e.name);
    let text = r.text.trim();
    let genId = r.response?.id ?? null;
    let finishReason = r.finishReason ?? null;

    // #43: the forced-synthesis turn's messages, appended to the resumable history when that path fired.
    let forcedTail: unknown[] = [];
    // FORCED SYNTHESIS: an agentic run that hits the step cap mid-read returns finishReason='tool-calls'
    // with NO answer (it spent its whole budget reading). Make ONE more no-tools turn that continues the
    // SAME conversation (so it keeps everything it read) and forces the final analysis. This is what
    // turned 5/9 seat failures into answers.
    if (tools && !text) {
      try {
        const forcedController = new AbortController();
        const forced = await withTimeout(generateText({
          ...base,
          system,
          abortSignal: forcedController.signal,
          messages: [
            ...(convo ?? [{ role: 'user', content: prompt } as ModelMessage]),
            ...r.response.messages,
            { role: 'user', content: 'Stop calling tools. Using ONLY the files you have already read above, write your complete final analysis NOW.' },
          ] as ModelMessage[],
        }), callTimeoutMs, `forced(${model})`,
        () => forcedController.abort(new Error(`forced(${model}) timed out after ${Math.round(callTimeoutMs / 1000)}s`)));
        if (forced.text.trim()) {
          text = forced.text.trim();
          genId = forced.response?.id ?? genId;
          finishReason = forced.finishReason ?? finishReason;
          forcedTail = [
            { role: 'user', content: 'Stop calling tools. Using ONLY the files you have already read above, write your complete final analysis NOW.' },
            ...(forced.response?.messages ?? []),
          ];
        }
      } catch { /* keep the empty result — the seat degrades gracefully (ok:false) */ }
    }

    // Record the FULL call content so the operator can observe exactly what was sent + returned.
    const elapsedMs = Date.now() - callStart;
    // Token usage summed across all agentic steps (r.totalUsage), normalized across SDK naming conventions
    // (v5: inputTokens/outputTokens; older: promptTokens/completionTokens). Powers per-node tok/s in retros/UI.
    const u = (r.totalUsage ?? r.usage) as
      | { inputTokens?: number; outputTokens?: number; totalTokens?: number; promptTokens?: number; completionTokens?: number }
      | undefined;
    const promptTokens = u?.inputTokens ?? u?.promptTokens;
    const completionTokens = u?.outputTokens ?? u?.completionTokens;
    const totalTokens = u?.totalTokens ?? ((promptTokens ?? 0) + (completionTokens ?? 0) || undefined);
    const trace: CallTrace = { model: useModel, system, prompt, response: text, finishReason, toolCalls, toolEvents, elapsedMs, promptTokens, completionTokens, totalTokens };
    opts.onCall?.(trace);
    onCall?.(trace);
    // #43: the RESUMABLE history — input conversation (or the prompt as the opening user turn) + everything
    // this call did. A follow-up passes it back via `messages` to continue the same node session.
    const history: unknown[] = [
      ...(convo ?? [{ role: 'user', content: prompt }]),
      ...(r.response?.messages ?? []),
      ...forcedTail,
    ];
    return { text, genId, finishReason, toolCalls, messages: history };
  };

  const recordCost = async (genId: string) => {
    // Self-hosted endpoint (OPUSED_BASE_URL): gen-ids aren't OpenRouter ids and there's no
    // /generation cost API — skip rather than throw. Spend is the GPU-hour, tracked at Modal.
    if (config.baseURL) return { costUsd: 0 };
    const c = await recordGenerationCost(genId, config.apiKey, { fetchImpl: fetch });
    return { costUsd: c.costUsd };
  };

  return { generate, recordCost };
}
