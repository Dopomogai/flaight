// @purpose: Shared model seat — the ONE place ZDR-pinned OpenRouter access is configured for agents
// @why: The privacy page promises "not used to train models." That promise is load-bearing and is
//       enforced HERE, in code, not just in .env: every request pins OpenRouter ZDR/no-training
//       routing, a model with no ZDR endpoint is refused (not silently downgraded), provider
//       reasoning blobs are stripped before anything is persisted/surfaced, and spend is read from
//       upstream_inference_cost (BYOK-for-Google → total_cost is always 0). Both the Analyst (#60,
//       batch) and the Concierge (#63, stream) build on this — the architecture's reuse rule.
//       Wave 1 Lane A of the engine extraction (docs/architecture/PLAN-agent-engine-modularization.md
//       Part II): lifted verbatim from lib/agents/model.ts into @ae/model — zero logic changes.
// @role: logic
// @stability: experimental

import { createOpenRouter, type OpenRouterProvider } from '@openrouter/ai-sdk-provider';

// ── Config ───────────────────────────────────────────────────────────────────

// Founder ruling 2026-06-15: revert the Analyst composer to Google Gemini 3.1 Pro via OpenRouter
// (this is the BYOK-for-Google route — see the spend block below: total_cost is always 0, the real
// inference bills the founder's Google account as upstream_inference_cost). ZDR is still pinned
// per-request (ZDR_PROVIDER_OPTIONS) regardless of model. Override per-env with COMPOSER_MODEL.
// (Was briefly anthropic/claude-opus-4.8; reverted — Gemini is the established BYOK route.)
export const DEFAULT_COMPOSER_MODEL = 'google/gemini-3.1-pro-preview';

// The STRUCTURER seat (analyst-v2): a fast, instruction-following model whose only job is to turn the
// composer's free-form reasoning into the exact JSON slice (A §2 two-stage compose). Reasoning quality
// is the composer's job; reliable schema-conformance is this model's. A cheaper/faster model is correct
// here — it follows formatting rules tightly and doesn't reason. Same ZDR-pinned BYOK route + provider.
export const DEFAULT_STRUCTURER_MODEL = 'google/gemini-3.5-flash';

/**
 * The hard rule, as a constant: every model request pins ZDR + no-training routing. Request-level
 * provider prefs OR with account settings and can only TIGHTEN — so pinning here is fail-safe even
 * if the account default ever loosens. `usage.include` asks OpenRouter to return usage on the wire.
 */
// Provider routing stays OPEN so OpenRouter can use the founder's BYOK route — do NOT add
// require_parameters/only/ignore here: narrowing the pool routes AWAY from the BYOK provider and
// breaks BYOK billing (upstream_inference_cost). The Analyst emits JSON by instruction and parses it
// (model-loop.ts) rather than relying on response_format — provider-agnostic and BYOK-safe (it was
// required by the brief Bedrock/Opus stint, and is kept because it works on every route, Gemini
// included). zdr + data_collection keep the privacy posture; usage.include returns spend on the wire.
export const ZDR_PROVIDER_OPTIONS = {
  openrouter: {
    provider: { zdr: true, data_collection: 'deny' as const },
    usage: { include: true },
  },
} as const;

/**
 * INTERNAL-ONLY posture (D6) — the DELIBERATE relaxation of the ZDR pin for internal Opused/experiment
 * runs. NO `zdr` requirement (so non-ZDR + BYOK endpoints — e.g. the Anthropic-direct BYOK key — become
 * routable) and `data_collection: 'allow'` (so OpenRouter logs the prompt/completion and you can SEE the
 * calls in Logs). DATA IS RETAINED under this posture. NEVER use it on the customer/product path — that
 * path stays 100% ZDR/BYOK/cost-tracked. Opt-in only, by an internal runner explicitly choosing it.
 */
export const INTERNAL_NO_ZDR_PROVIDER_OPTIONS = {
  openrouter: {
    provider: { data_collection: 'allow' as const },
    usage: { include: true },
  },
} as const;

/**
 * The INTERACTIVE-seat provider options (concierge + deck GLM loop). Identical to the ZDR/no-ZDR options
 * above but with `sort: 'throughput'` added. Why: a deck build makes the model emit a large
 * `build_styled_deck` payload (every slide's HTML inline in one tool call); on a slow provider — observed:
 * Novita serving GLM-5.2 at ~0.3 tok/s — the model truncates that payload to empty args and loops on the
 * PA server's `-32602` rejection. Sorting the eligible pool by throughput prefers a fast host. `sort` only
 * REORDERS the pool (fallbacks stay on), so it never excludes a required provider, and `zdr: true` still
 * filters to ZDR providers first — the privacy posture is unchanged.
 *
 * SCOPED TO THE INTERACTIVE LOOP ONLY — deliberately NOT applied to the Analyst (lib/agents/analyst), which
 * keeps the plain ZDR_PROVIDER_OPTIONS. A throughput sort on that path could route AWAY from the
 * BYOK-for-Google provider (zeroing `upstream_inference_cost` and breaking spend accounting — the same
 * hazard the "routing stays OPEN" note above guards). The interactive seat is GLM, never BYOK, so throughput
 * is safe here.
 */
export const INTERACTIVE_ZDR_PROVIDER_OPTIONS = {
  openrouter: {
    provider: { zdr: true, data_collection: 'deny' as const, sort: 'throughput' as const },
    usage: { include: true },
  },
} as const;

/** The interactive seat's no-ZDR twin (local-dev escape hatch; mirrors INTERNAL_NO_ZDR_PROVIDER_OPTIONS) with
 *  the same throughput sort. Used only when allowNoZdr is set (non-production). */
export const INTERACTIVE_NO_ZDR_PROVIDER_OPTIONS = {
  openrouter: {
    provider: { data_collection: 'allow' as const, sort: 'throughput' as const },
    usage: { include: true },
  },
} as const;

export interface ModelConfig {
  apiKey: string;
  composerModel: string;
  structurerModel: string;
  requireZdr: boolean;
  /** INTERNAL self-host escape hatch: when set, the provider points at this OpenAI-compatible
   *  base URL (e.g. a Modal vLLM endpoint / the GLM box) instead of OpenRouter. Absent = OpenRouter as before. */
  baseURL?: string;
}

/**
 * Read the model config from the environment. `OPENROUTER_REQUIRE_ZDR` defaults to ON: it may be
 * disabled ONLY by an explicit 'false' (local dev escape hatch), never default-off (spike gotcha 7).
 */
export function readModelConfig(env: Record<string, string | undefined> = process.env): ModelConfig {
  const baseURL = env.OPUSED_BASE_URL || undefined;
  return {
    // When self-hosting (OPUSED_BASE_URL set), the upstream needs no real key — vLLM accepts any.
    // Fall back to 'local' so the apiKey guard passes without an OpenRouter key.
    apiKey: env.OPENROUTER_API_KEY ?? (baseURL ? 'local' : ''),
    composerModel: env.COMPOSER_MODEL || DEFAULT_COMPOSER_MODEL,
    structurerModel: env.STRUCTURER_MODEL || DEFAULT_STRUCTURER_MODEL,
    // Default true. Only the literal string 'false' disables the posture.
    requireZdr: env.OPENROUTER_REQUIRE_ZDR !== 'false',
    baseURL,
  };
}

// ── Provider factory + startup assert ──────────────────────────────────────────

export class ZdrPostureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZdrPostureError';
  }
}

/**
 * Build the OpenRouter provider. Asserts the ZDR posture at construction: an empty key, or
 * REQUIRE_ZDR disabled outside an explicit local-dev opt-in, throws rather than running with a
 * loosened privacy guarantee. The per-request ZDR pin (ZDR_PROVIDER_OPTIONS) is the runtime
 * enforcement; this is the startup guard. A custom `fetch` may be injected (tests / wire audit).
 */
export function createComposerProvider(
  config: ModelConfig,
  fetchImpl?: typeof fetch,
): OpenRouterProvider {
  if (!config.apiKey) {
    throw new ZdrPostureError('OPENROUTER_API_KEY is missing — refusing to construct the model provider.');
  }
  if (!config.requireZdr) {
    // Loud, never silent: a loosened posture is only legitimate as a deliberate local-dev choice.
    console.warn(
      '[model] OPENROUTER_REQUIRE_ZDR=false — ZDR enforcement is DISABLED. Local dev only; ' +
        'never ship this. Requests still pin ZDR, but a non-ZDR fallback would not be refused.',
    );
  }
  // Self-host override (INTERNAL): point at a Modal vLLM (or any OpenAI-compatible) endpoint — the GLM box.
  if (config.baseURL) {
    console.warn(`[model] OPUSED_BASE_URL set — routing to self-hosted endpoint ${config.baseURL} (not OpenRouter).`);
  }
  return createOpenRouter({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

// ── providerMetadata strip (spike gotcha 1) ────────────────────────────────────

/**
 * OpenRouter returns `providerMetadata.openrouter.reasoning_details` carrying raw + encrypted Gemini
 * reasoning blobs. They must NEVER enter a persisted artifact or any field that reaches /r/[id].
 * This is the batch equivalent of the Concierge stream firewall's strip step. Defensive and total:
 * we never forward providerMetadata at all from an agent path — callers take only the typed fields
 * they need (text/object/usage) and run them through here if a metadata-bearing object must survive.
 */
export function stripProviderMetadata<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripProviderMetadata(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Drop the known carriers outright, recurse into everything else.
    if (k === 'providerMetadata' || k === 'reasoning_details' || k === 'reasoning') continue;
    out[k] = stripProviderMetadata(v);
  }
  return out as T;
}

// ── BYOK spend accounting (spike gotchas 4, 5) ─────────────────────────────────

export interface GenerationCost {
  id: string;
  provider: string | null;
  model: string | null;
  byok: boolean | null;
  finishReason: string | null;
  /**
   * The number the spend ceiling reads. Under BYOK-for-Google, OpenRouter's `total_cost` is always
   * 0 and the real inference bills the founder's Google account, surfaced as `upstream_inference_cost`.
   * We sum both defensively so the figure is correct whether or not BYOK is in play.
   */
  costUsd: number;
  /** OpenRouter generation tokens (immutable once indexed). Null when the record never resolved. */
  promptTokens: number | null;
  completionTokens: number | null;
  /**
   * Provider-reported latency in ms when present on the generation record. Null when absent or the
   * lookup failed — callers may fall back to their own wall-clock measurement.
   */
  latencyMs: number | null;
}

/** Coerce a numeric OpenRouter field; absent/NaN → null (never invent a zero). */
function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * OpenRouter's generation `latency` is milliseconds (observed live: latency=328 beside a ~0.8s wall
 * clock; generation_time is also ms). Pure; exported for unit tests.
 */
export function normalizeGenerationLatencyMs(latency: unknown): number | null {
  const n = numOrNull(latency);
  if (n === null || n < 0) return null;
  return Math.round(n);
}

/**
 * Look up the OpenRouter generation record for a completed call and extract the BYOK-correct cost.
 * Generation records index LAZILY (spike gotcha 4) — retry with backoff. Read OUT-OF-BAND (after the
 * run, not in the hot path). Returns a best-effort record; on total lookup failure costUsd is 0 and
 * provider is null (the caller logs the gap rather than crashing the job over a billing-readout miss).
 * Token counts + latency ride the same record (immutable per genId once indexed).
 */
export async function recordGenerationCost(
  genId: string,
  apiKey: string,
  opts: { attempts?: number; delayMs?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<GenerationCost> {
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? 2500;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await doFetch(
        `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(genId)}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (res.ok) {
        const { data } = (await res.json()) as { data: Record<string, unknown> };
        const upstream = Number(data.upstream_inference_cost ?? 0) || 0;
        const total = Number(data.total_cost ?? 0) || 0;
        // Prefer billed/native token fields when present; fall back to the plain tokens_* pair.
        const promptTokens =
          numOrNull(data.native_tokens_prompt) ?? numOrNull(data.tokens_prompt);
        const completionTokens =
          numOrNull(data.native_tokens_completion) ?? numOrNull(data.tokens_completion);
        return {
          id: String(data.id ?? genId),
          provider: (data.provider_name as string) ?? null,
          model: (data.model as string) ?? null,
          byok: (data.is_byok as boolean) ?? null,
          finishReason: (data.finish_reason as string) ?? null,
          costUsd: upstream + total, // BYOK: cost lands upstream; non-BYOK: in total. Sum is correct either way.
          promptTokens,
          completionTokens,
          latencyMs: normalizeGenerationLatencyMs(data.latency),
        };
      }
    } catch {
      /* transient — retry */
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return {
    id: genId,
    provider: null,
    model: null,
    byok: null,
    finishReason: null,
    costUsd: 0,
    promptTokens: null,
    completionTokens: null,
    latencyMs: null,
  };
}
