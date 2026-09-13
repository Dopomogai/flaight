// @purpose: cli-grok NodeExecutor — Grok Build TUI headless print as a fleet node backend
// @why: dec-040 / CR-3: parity with cli-claude — product CLI owns tools; Opused drives -p + json
//       CR-2b safety: process-group kill, cwd clamp (resolveNodeCwd), --disallowed-tools when !write
//       Multi-turn (2026-07-20 triad dry-run): --max-turns + --always-approve — without them a build
//       node states intent and exits after ~2 turns with zero tool calls (stdin closed blocks approvals).
//       2026-07-20 argv conflict (tower probes): --permission-mode acceptEdits|dontAsk WITH
//       --always-approve suppresses the tool loop in headless -p (1 model call, zero tools). Driver is
//       --always-approve alone; do NOT emit --permission-mode on this path.
// @role: safety-critical
// @stability: experimental

import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import type { ToolEvent } from '../../council/types';
import type { CliUsage, NodeExecutor, NodeExecContext, NodeExecResult } from '../executor';
import { resolveNodeCwd } from '../executor';
import { countWriteOps } from '../judge-evidence';
import { createDefaultCliSpawn, type CliSpawn } from './cli-process';
import { fleetGrokSpawnEnv } from './grok-mcp-jail';

export type GrokCliSpawn = CliSpawn;

/**
 * CR-2b read-only ALLOWLIST for Grok Build CLI (--tools). grok 0.2.111's --disallowed-tools is
 * INEFFECTIVE under headless -p (proven live 2026-08-04: deny run_terminal_command under either
 * doc spelling — "run_terminal_command" per 01-getting-started, "run_terminal_cmd" per
 * 14-headless-mode — and the agent still shelled; the --tools allowlist blocks). Read-only nodes
 * therefore get the read-only tool SET, not a deny list. Write/shell/subagent tools
 * (search_replace, run_terminal_command, spawn_subagent, todo_write) are absent by construction.
 */
export const GROK_READ_ONLY_TOOLS = 'read_file,grep,list_dir';

/**
 * Extra tools a plan may grant a *read-only* cli-grok node via `node.tools` + toolsMode extend/replace.
 * Names match grok 0.2.111 (`~/.grok/docs/user-guide/01-getting-started.md`, 14-headless-mode).
 * Write/shell/subagent-tier tools are NEVER on this list — denial-by-absence holds for
 * search_replace / run_terminal_command / spawn_subagent / todo_write even when a plan names them.
 */
export const GROK_READ_SAFE_EXTRA_TOOLS = ['web_search', 'web_fetch'] as const;

/** Full read-safe set = default read-only tools ∪ plan-extendable extras. */
export const GROK_READ_SAFE_TOOLS: ReadonlySet<string> = new Set([
  ...GROK_READ_ONLY_TOOLS.split(',').map((s) => s.trim()).filter(Boolean),
  ...GROK_READ_SAFE_EXTRA_TOOLS,
]);

/**
 * Legacy deny list, only emitted when a caller explicitly passes disallowedTools. Kept with Grok
 * 0.2.111 tool names (NOT Claude's Edit/Write/Bash) — but see above: upstream currently does not
 * enforce it, so prefer the allowlist default.
 */
export const GROK_READ_ONLY_DISALLOWED_TOOLS =
  'search_replace,run_terminal_command,spawn_subagent';

/**
 * Registry tool id → the grok tool names that DELIVER that capability.
 *
 * The plan grants tools in the registry vocabulary (`local.read`, `browser.read`); the grok CLI belt speaks
 * its own (`read_file`, `grep`, `list_dir`). Until 2026-08-07 the resolver compared the two directly, so
 * EVERY node granted `local.read` was recorded as `toolsDropped: ["local.read"]` — verified across all six
 * cli-grok nodes of the 08-06 audit run. The nodes still worked, because grok's default read belt happens to
 * cover reading, which is exactly why nobody noticed: the plan's declared grants were decorative, and a
 * `local.read`-only node like `endpoint-census` had its ENTIRE declared grant dropped.
 *
 * Translating is the fix rather than widening the allowlist: the belt still only ever contains grok read
 * tools, and an id with no entry here stays dropped — which is now a real signal (`browser.read` genuinely
 * cannot be served by the grok CLI) instead of noise that hides it.
 */
export const GROK_REGISTRY_TOOL_EQUIVALENTS: Readonly<Record<string, readonly string[]>> = {
  'local.read': ['read_file', 'grep', 'list_dir'],
  'local.grep': ['grep'],
  'local.list': ['list_dir'],
  'web.search': ['web_search'],
  'web.fetch': ['web_fetch'],
};

/**
 * Resolve `--tools` for a non-writeCapable cli-grok node from `node.tools` + `toolsMode`.
 *
 * - No `node.tools`: default `GROK_READ_ONLY_TOOLS` (read-only default unchanged).
 * - `extend` (default): base + extras that are in the read-safe set.
 * - `replace`: only the intersection of requested ∩ read-safe (can narrow; never widen past the set).
 * - Registry ids (`local.read`, …) are translated via GROK_REGISTRY_TOOL_EQUIVALENTS before the check.
 * - Names with no grok equivalent land in `dropped` (caller journals a warn — never silent, never
 *   hard-fail). A non-empty `dropped` now means the capability is genuinely UNAVAILABLE on this runner.
 *
 * Empty allowlists never emit: grok 0.2.111 ignores empty `--tools` and restores the default full
 * toolset (privilege escalation) — fall back to the read-only base instead.
 */
export function resolveGrokReadOnlyTools(opts: {
  nodeTools?: string[];
  toolsMode?: 'extend' | 'replace';
}): { allowed: string[]; allowedCsv: string; dropped: string[] } {
  const base = GROK_READ_ONLY_TOOLS.split(',').map((s) => s.trim()).filter(Boolean);
  const requested = (opts.nodeTools ?? []).map((s) => s.trim()).filter(Boolean);
  if (requested.length === 0) {
    return { allowed: base, allowedCsv: base.join(','), dropped: [] };
  }

  const dropped: string[] = [];
  const safeRequested: string[] = [];
  for (const id of requested) {
    if (GROK_READ_SAFE_TOOLS.has(id)) {
      safeRequested.push(id);
      continue;
    }
    // A registry id names a CAPABILITY; translate it to the grok tools that serve it. Only names that
    // survive the read-safe check are kept, so translation can never widen the belt.
    const equivalents = GROK_REGISTRY_TOOL_EQUIVALENTS[id]?.filter((n) => GROK_READ_SAFE_TOOLS.has(n)) ?? [];
    if (equivalents.length > 0) safeRequested.push(...equivalents);
    else dropped.push(id);
  }

  const mode = opts.toolsMode ?? 'extend';
  let allowed: string[];
  if (mode === 'replace') {
    allowed = [...new Set(safeRequested)];
  } else {
    allowed = [...new Set([...base, ...safeRequested])];
  }
  // Empty --tools is ignored by grok (full toolset) — never emit that for a read-only belt.
  if (allowed.length === 0) allowed = base;

  return { allowed, allowedCsv: allowed.join(','), dropped };
}

/** Default agent-turn budget when node.agent.turns.max is unset (write-capable build seats). */
export const GROK_DEFAULT_MAX_TURNS_WRITE = 60;
/** Default agent-turn budget for read-only / non-write seats. */
export const GROK_DEFAULT_MAX_TURNS_READ = 25;

export interface CliGrokExecutorOptions {
  /** Binary name or path (default `grok` / OPUSED_GROK_BIN). */
  bin?: string;
  /** Wall clock for one print invocation (default 15 min / OPUSED_CLI_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Injectable spawn (tests). */
  spawn?: GrokCliSpawn;
  /**
   * When true: write-capable headless (--always-approve, no tool deny list).
   * When false: --tools ALLOWLIST belt (CR-2b) — default GROK_READ_ONLY_TOOLS, optionally
   * extended/replaced from node.tools within GROK_READ_SAFE_TOOLS (see resolveGrokReadOnlyTools).
   * Never pair with --permission-mode on this path — that flag suppresses tools under -p (tower 2026-07-20).
   */
  writeCapable?: boolean;
  /**
   * Optional pre-resolved `--tools` CSV for read-only nodes (from resolveGrokReadOnlyTools / run.ts).
   * When unset, the executor resolves from `ctx.node.tools` + `ctx.node.toolsMode` at run time.
   * Ignored when writeCapable.
   */
  toolsAllowlist?: string;
  /** Extra argv (e.g. --model). */
  extraArgs?: string[];
}

/**
 * Resolve Grok --max-turns: honor node.agent.turns.max when set; else write→60 / read→25.
 * Proven pattern: ~/.tower/scripts/seat-run.sh uses --max-turns 80 for unattended builds.
 */
export function resolveGrokMaxTurns(opts: {
  writeCapable: boolean;
  /** From node.agent.turns.max when the plan sets a conversational/CLI turn budget. */
  nodeMaxTurns?: number;
}): number {
  const n = opts.nodeMaxTurns;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  return opts.writeCapable ? GROK_DEFAULT_MAX_TURNS_WRITE : GROK_DEFAULT_MAX_TURNS_READ;
}

/** Flexible JSON envelope for grok --output-format json (fields evolve; we accept several shapes). */
export interface GrokPrintJson {
  type?: string;
  is_error?: boolean;
  error?: string;
  result?: string;
  text?: string;
  content?: string;
  message?: string;
  response?: string;
  output?: string;
  session_id?: string;
  sessionId?: string;
  id?: string;
  total_cost_usd?: number;
  cost_usd?: number;
  duration_ms?: number;
  /** Token usage when the product reports it (live-observed 2026-07/08: text+usage envelopes). */
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

function extractText(data: GrokPrintJson): string {
  for (const key of ['result', 'text', 'content', 'message', 'response', 'output'] as const) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

function extractSessionId(data: GrokPrintJson): string | undefined {
  if (typeof data.session_id === 'string' && data.session_id) return data.session_id;
  if (typeof data.sessionId === 'string' && data.sessionId) return data.sessionId;
  if (typeof data.id === 'string' && data.id) return data.id;
  return undefined;
}

export function parseGrokPrintOutput(
  stdout: string,
  format: 'json' | 'plain' = 'json',
): { ok: true; data: GrokPrintJson; text: string } | { ok: false; error: string } {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false, error: 'empty stdout from grok -p' };

  if (format === 'plain') {
    return { ok: true, data: { text: trimmed }, text: trimmed };
  }

  let raw = trimmed;
  if (!raw.startsWith('{')) {
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
    const lastObj = [...lines].reverse().find((l) => l.startsWith('{') && l.endsWith('}'));
    if (!lastObj) {
      // Fall back: treat whole stdout as plain deliverable (some builds still print text under json).
      if (trimmed.length > 0) return { ok: true, data: { text: trimmed }, text: trimmed };
      return { ok: false, error: 'no JSON object in grok stdout' };
    }
    raw = lastObj;
  }
  try {
    const data = JSON.parse(raw) as GrokPrintJson;
    if (data.is_error || data.error) {
      return {
        ok: false,
        error: `grok is_error: ${typeof data.error === 'string' ? data.error : typeof data.result === 'string' ? data.result : raw.slice(0, 400)}`,
      };
    }
    const text = extractText(data);
    if (!text.trim()) return { ok: false, error: 'grok json result empty' };
    return { ok: true, data, text };
  } catch (e) {
    return { ok: false, error: `grok json parse: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function grokFinite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Harvest token usage from a grok -p JSON envelope (BENCHMARK-PREP checklist 1 — CLI-seat metering
 * parity). Never invents: undefined when the envelope carried no usage; each field present only when
 * reported. total_tokens uses the product's own figure when given, else the known in+out sum.
 */
export function extractGrokEnvelopeUsage(data: GrokPrintJson): CliUsage | undefined {
  const u = data.usage;
  if (!u || typeof u !== 'object') return undefined;
  const input = grokFinite(u.input_tokens);
  const output = grokFinite(u.output_tokens);
  const total = grokFinite(u.total_tokens);
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(total !== undefined
      ? { totalTokens: total }
      : input !== undefined && output !== undefined
        ? { totalTokens: input + output }
        : {}),
  };
}

/**
 * Parse tool invocations from grok `--output-format json` envelopes / stream frames.
 * Real product envelopes today often omit a tool channel (text+usage only) — callers should treat
 * an empty parse with no tool channel as **unavailable** (leave NodeExecResult.toolEvents undefined),
 * not as honest zero tools. Returns every tool frame found (read + write) so the judge gets honest counts.
 */
export function parseGrokToolEvents(stdout: string): ToolEvent[] {
  const events: ToolEvent[] = [];
  const seen = new Set<string>();
  const push = (name: string, arg: string, error?: string) => {
    const n = (name ?? '').trim();
    if (!n) return;
    const a = (arg ?? '').slice(0, 500);
    const key = `${n}\0${a}\0${error ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push(error ? { name: n, arg: a, error } : { name: n, arg: a });
  };

  const ingestUnknown = (node: unknown, depth = 0): void => {
    if (depth > 8 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) ingestUnknown(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;

    // Content-block style: { type: 'tool_use', name, input }
    const type = typeof o.type === 'string' ? o.type : '';
    if (
      (type === 'tool_use' || type === 'tool-call' || type === 'tool_call' || type === 'function_call') &&
      typeof o.name === 'string'
    ) {
      push(o.name, salientArg(o.input ?? o.arguments ?? o.args ?? o.parameters), typeof o.error === 'string' ? o.error : undefined);
    }
    // Flat tool call: { name/tool/toolName, input/arguments }
    if (
      (typeof o.name === 'string' || typeof o.tool === 'string' || typeof o.toolName === 'string') &&
      (o.input != null || o.arguments != null || o.args != null || type.startsWith('tool'))
    ) {
      const name = (o.name ?? o.tool ?? o.toolName) as string;
      if (name && type !== 'text' && type !== 'thinking') {
        push(name, salientArg(o.input ?? o.arguments ?? o.args ?? o.parameters), typeof o.error === 'string' ? o.error : undefined);
      }
    }
    // Nested arrays that product CLIs emit
    for (const key of ['tool_calls', 'toolCalls', 'tools', 'tool_events', 'toolEvents', 'calls'] as const) {
      if (Array.isArray(o[key])) ingestUnknown(o[key], depth + 1);
    }
    if (Array.isArray(o.content)) ingestUnknown(o.content, depth + 1);
    if (Array.isArray(o.messages)) ingestUnknown(o.messages, depth + 1);
    if (Array.isArray(o.turns)) ingestUnknown(o.turns, depth + 1);
    if (Array.isArray(o.events)) ingestUnknown(o.events, depth + 1);
    if (o.message != null) ingestUnknown(o.message, depth + 1);
    if (o.function != null && typeof o.function === 'object') {
      const fn = o.function as Record<string, unknown>;
      if (typeof fn.name === 'string') push(fn.name, salientArg(fn.arguments ?? fn.input));
    }
  };

  const trimmed = (stdout ?? '').trim();
  if (!trimmed) return events;

  // Whole-envelope JSON (pretty multi-line or single-line)
  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      ingestUnknown(JSON.parse(trimmed));
    }
  } catch {
    /* fall through to line scan */
  }

  // JSONL / stream noise: each line that is a JSON object
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      ingestUnknown(JSON.parse(t));
    } catch {
      /* skip */
    }
  }

  return events;
}

/** True when stdout's parseable envelope has an explicit tool-event channel (even if empty). */
export function grokStdoutHasToolChannel(stdout: string): boolean {
  const trimmed = (stdout ?? '').trim();
  if (!trimmed) return false;
  try {
    if (trimmed.startsWith('{')) {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      return hasToolChannelKeys(o);
    }
  } catch {
    /* */
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      if (hasToolChannelKeys(JSON.parse(t) as Record<string, unknown>)) return true;
    } catch {
      /* */
    }
  }
  return false;
}

function hasToolChannelKeys(o: Record<string, unknown>): boolean {
  for (const k of ['tool_calls', 'toolCalls', 'tool_events', 'toolEvents', 'tools', 'calls']) {
    if (k in o) return true;
  }
  if (Array.isArray(o.messages) || Array.isArray(o.turns) || Array.isArray(o.events) || Array.isArray(o.content)) {
    // Only treat as a tool channel if nested tool_use-ish nodes exist OR empty content array of blocks
    const probe = JSON.stringify(o).includes('"tool_use"') || JSON.stringify(o).includes('"tool_call"');
    return probe;
  }
  return false;
}

/**
 * The grok tool-trace channel that ACTUALLY exists in 0.2.111: per-session events.jsonl at
 * ~/.grok/sessions/<encoded-cwd>/<sessionId>/events.jsonl records tool_started/tool_completed with
 * tool_name + outcome. The stdout envelope carries NO tool frames in either --output-format
 * (live-proven 2026-08-04: json and streaming-json both emit only thought/text/end). Harness-side
 * read AFTER the run — the agent never touches it. Lookup globs the sessionId across cwd dirs
 * because macOS resolves symlinks (/tmp → /private/tmp) before grok encodes the dir name.
 * Returns undefined when the session file cannot be found/read (= 'unavailable'), [] when it
 * exists and honestly records zero tool calls (= 'empty').
 */
function resolveGrokSessionEventsPath(grokHome: string, sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  const sessionsDir = resolve(grokHome, 'sessions');
  try {
    for (const cwdDir of readdirSync(sessionsDir)) {
      const candidate = resolve(sessionsDir, cwdDir, sessionId, 'events.jsonl');
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** One node's MCP init outcome, read from grok's own log. `failures` is what our journal never carried. */
export type GrokMcpInit = {
  attempted: number;
  connected: string[];
  failed: { server: string; errorType: string; message: string }[];
  /** Tool names that actually reached the node, across all connected servers. */
  tools: string[];
};

/**
 * Harvest the MCP init result for one grok session.
 *
 * @why A capability the node did NOT get is invisible in our journal, and that silence had a
 *   measurable price: `kb-dopomogai-operator` failed its handshake on **13,762 of 13,762** attempts
 *   between 2026-07-26 and 2026-08-10 — never once connected — and every one of those failures
 *   appeared only in grok's own events.jsonl. Our runs recorded nothing, so for two weeks every
 *   fleet node was silently KB-blind while the journal looked healthy. The cause was mundane once
 *   read (`Auth required, when send initialize request`: grok inherits the server URL from
 *   ~/.claude.json but cannot execute its Claude-specific `headersHelper`); the defect worth fixing
 *   in OUR code is that nothing told us.
 *
 *   This is the same shape as `toolsDropped`, which we already journal — a granted capability that
 *   silently is not there — so it lands in the same `tools_warn` channel rather than a new one.
 *   Returns undefined when the session log cannot be found (= unavailable, not "no MCP").
 */
export function parseGrokSessionMcpInit(grokHome: string, sessionId: string): GrokMcpInit | undefined {
  const eventsPath = resolveGrokSessionEventsPath(grokHome, sessionId);
  if (!eventsPath) return undefined;

  const connected: string[] = [];
  const failed: { server: string; errorType: string; message: string }[] = [];
  const tools: string[] = [];
  let attempted = 0;
  try {
    for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue;
      }
      const server = typeof frame.server_name === 'string' ? frame.server_name : '';
      if (frame.type === 'mcp_server_connected' && server) {
        connected.push(server);
        if (Array.isArray(frame.tools)) for (const n of frame.tools) if (typeof n === 'string') tools.push(n);
      } else if (frame.type === 'mcp_server_failed' && server) {
        failed.push({
          server,
          errorType: typeof frame.error_type === 'string' ? frame.error_type : 'unknown',
          // Truncated: these carry a full Rust transport type chain and the useful part is the head.
          message: (typeof frame.error_message === 'string' ? frame.error_message : '').slice(0, 300),
        });
      } else if (frame.type === 'mcp_init_completed' && typeof frame.total_servers === 'number') {
        attempted = frame.total_servers;
      }
    }
  } catch {
    return undefined;
  }
  if (!attempted && !connected.length && !failed.length) return undefined;
  return { attempted: attempted || connected.length + failed.length, connected, failed, tools };
}

export function parseGrokSessionToolEvents(grokHome: string, sessionId: string): ToolEvent[] | undefined {
  const eventsPath = resolveGrokSessionEventsPath(grokHome, sessionId);
  if (!eventsPath) return undefined;

  const events: ToolEvent[] = [];
  const openByIdx = new Map<number, number>(); // events[] idx for a started-but-uncompleted tool
  try {
    for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = frame.type;
      const name = typeof frame.tool_name === 'string' ? frame.tool_name : '';
      if (!name) continue;
      if (type === 'tool_started') {
        openByIdx.set(events.length, events.length);
        events.push({ name, arg: '' });
      } else if (type === 'tool_completed') {
        const outcome = typeof frame.outcome === 'string' ? frame.outcome : '';
        if (outcome && outcome !== 'success') {
          // Mark the most recent unfinished event with this name as errored.
          for (let i = events.length - 1; i >= 0; i--) {
            if (events[i].name === name && !events[i].error) {
              events[i] = { name, arg: events[i].arg ?? '', error: outcome };
              break;
            }
          }
        }
      }
    }
  } catch {
    return undefined;
  }
  return events;
}

/** Default grok home (override OPUSED_GROK_HOME for tests / non-standard installs). */
export function grokHomeDir(env: Record<string, string | undefined> = process.env): string {
  return env.OPUSED_GROK_HOME?.trim() || resolve(homedir(), '.grok');
}

function salientArg(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.slice(0, 500);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of [
      'path',
      'file_path',
      'filePath',
      'target_file',
      'target_directory',
      'file',
      'query',
      'pattern',
      'command',
      'url',
    ]) {
      if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).slice(0, 500);
    }
    try {
      return JSON.stringify(v).slice(0, 500);
    } catch {
      return '';
    }
  }
  return '';
}

export const defaultGrokSpawn: GrokCliSpawn = createDefaultCliSpawn('grok');

/**
 * Map node.effortHint → grok CLI --reasoning-effort value.
 * Verified against grok 0.2.111 --help: `--reasoning-effort <EFFORT>` (alias `--effort`).
 * Only low|medium|high are valid EffortHint values on the plan schema; unknown → omit flag.
 */
export function resolveGrokReasoningEffort(
  effortHint: string | undefined,
): 'low' | 'medium' | 'high' | undefined {
  if (effortHint === 'low' || effortHint === 'medium' || effortHint === 'high') return effortHint;
  return undefined;
}

/**
 * Build argv for Grok Build headless multi-turn agent loop (CR-3 + 2026-07-20 multiturn fix).
 * Flags BEFORE -p/--prompt-file (order matters — trailing flags after -p are dropped by the CLI).
 * - --max-turns: without this, headless exits after ~2 turns of intent-only text (triad dry-run).
 * - --always-approve: sole approval driver for headless (closed stdin). Do NOT also pass
 *   --permission-mode acceptEdits|dontAsk — tower probes (2026-07-20) proved that combo kills the
 *   tool loop (1 model call, intent-only, no file writes). Matches seat-run unattended pattern.
 * - --reasoning-effort: from node.effortHint (T6; grok 0.2.111 --help confirmed flag spelling).
 * - Read-only: --tools ALLOWLIST when !write (CR-2b; --disallowed-tools is unenforced upstream in
 *   grok 0.2.111 — proven live 2026-08-04); write-capable omits tool restriction.
 * - toolsAllowlist: resolved CSV from resolveGrokReadOnlyTools (base ± plan extras); default base.
 */
export function buildGrokPrintArgv(opts: {
  system: string;
  packPath: string;
  cwd: string;
  writeCapable: boolean;
  /** Agent turn budget (--max-turns). Resolve via resolveGrokMaxTurns. */
  maxTurns: number;
  extraArgs?: string[];
  /** Full mission text when small enough for -p; else use --prompt-file. */
  inlinePrompt?: string;
  disallowedTools?: string;
  /**
   * Resolved read-only `--tools` CSV (from resolveGrokReadOnlyTools). When unset, defaults to
   * GROK_READ_ONLY_TOOLS. Ignored when writeCapable or when disallowedTools is set (legacy path).
   */
  toolsAllowlist?: string;
  /**
   * T6: node.effortHint → `--reasoning-effort low|medium|high`.
   * Flag spelling verified on grok 0.2.111 (`--reasoning-effort <EFFORT>`, alias `--effort`).
   * Omitted when unset/unknown so legacy callers keep prior argv shape.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
}): string[] {
  const maxTurns = Math.max(1, Math.floor(opts.maxTurns));
  const argv: string[] = [
    // Unattended tool loop — must precede -p (seat-run / tower-unattended-permissions).
    // Never add --permission-mode here: it conflicts with --always-approve under -p.
    '--always-approve',
    '--max-turns',
    String(maxTurns),
    '--output-format',
    'json',
    '--cwd',
    opts.cwd,
  ];
  // T6: per-node reasoning effort (before -p so the CLI accepts it).
  if (opts.reasoningEffort) {
    argv.push('--reasoning-effort', opts.reasoningEffort);
  }
  // CR-2b belt — read-only default = --tools ALLOWLIST (GROK_READ_ONLY_TOOLS): grok 0.2.111 does
  // NOT enforce --disallowed-tools under headless -p (live-proven), so denial-by-absence is the
  // only belt that holds. An explicit opts.disallowedTools still emits the legacy deny flag
  // (caller opted into upstream-broken semantics — their choice, documented on the constant).
  // Plan node.tools / toolsMode land via toolsAllowlist (resolveGrokReadOnlyTools) — never widen
  // past GROK_READ_SAFE_TOOLS on a non-writeCapable node.
  if (!opts.writeCapable) {
    if (opts.disallowedTools) argv.push('--disallowed-tools', opts.disallowedTools);
    else {
      const allow =
        typeof opts.toolsAllowlist === 'string' && opts.toolsAllowlist.trim()
          ? opts.toolsAllowlist.trim()
          : GROK_READ_ONLY_TOOLS;
      argv.push('--tools', allow);
    }
  }
  if (opts.system.trim()) {
    argv.push('--rules', opts.system);
  }
  if (opts.extraArgs?.length) argv.push(...opts.extraArgs);

  if (opts.inlinePrompt && opts.inlinePrompt.length <= 80_000) {
    // -p is "headless prompt then exit" (not a 1-turn cap); --max-turns bounds the agent tool loop.
    argv.push('-p', opts.inlinePrompt);
  } else {
    // Large packs: file on disk; --max-turns still applies to the agent loop after the prompt loads.
    argv.push('--prompt-file', opts.packPath);
  }
  return argv;
}

export function createCliGrokExecutor(options: CliGrokExecutorOptions = {}): NodeExecutor {
  const bin = options.bin ?? process.env.OPUSED_GROK_BIN ?? 'grok';
  const envTimeout = Number(process.env.OPUSED_CLI_TIMEOUT_MS);
  const timeoutMs =
    options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 15 * 60_000);
  const spawnFn = options.spawn ?? defaultGrokSpawn;

  return {
    kind: 'cli-grok',
    async run(ctx: NodeExecContext): Promise<NodeExecResult> {
      const cwd = resolveNodeCwd(ctx.node, ctx.sandboxRoot);
      const nodeLogDir = join(ctx.runDir, 'nodes', ctx.node.id);
      try {
        mkdirSync(nodeLogDir, { recursive: true });
      } catch {
        /* ok */
      }
      const packPath = resolve(nodeLogDir, 'cli-pack.txt');
      const fullPrompt = [
        ctx.system ? `===== SYSTEM =====\n${ctx.system}\n` : '',
        '===== MISSION PACK =====',
        ctx.packText,
        '',
        'You are running as an Opused fleet node via Grok Build CLI.',
        'Execute the task. Your FINAL assistant message is the deliverable for the next stage (.out).',
        'Do not ask the operator questions — complete or state blockers in the deliverable.',
      ]
        .filter(Boolean)
        .join('\n');
      writeFileSync(packPath, fullPrompt, 'utf8');

      const writeCapable = options.writeCapable === true;
      const maxTurns = resolveGrokMaxTurns({
        writeCapable,
        nodeMaxTurns: ctx.node.agent.turns?.max,
      });
      const reasoningEffort = resolveGrokReasoningEffort(ctx.node.effortHint);
      // NODE-TOOLS-EXTEND: plan node.tools/toolsMode → --tools CSV (read-only only). Write-capable
      // omits tool restriction (product CLI owns the full set). Pre-resolved options.toolsAllowlist
      // wins when run.ts already resolved (journal warn emitted there); else use the node resolve.
      let toolsAllowlist: string | undefined;
      let toolsDropped: string[] = [];
      if (!writeCapable) {
        const r = resolveGrokReadOnlyTools({
          nodeTools: ctx.node.tools,
          toolsMode: ctx.node.toolsMode,
        });
        toolsDropped = r.dropped;
        toolsAllowlist =
          typeof options.toolsAllowlist === 'string' && options.toolsAllowlist.trim()
            ? options.toolsAllowlist.trim()
            : r.allowedCsv;
      }
      const argv = buildGrokPrintArgv({
        system: ctx.system,
        packPath,
        cwd,
        writeCapable,
        maxTurns,
        extraArgs: options.extraArgs,
        inlinePrompt: fullPrompt.length <= 80_000 ? fullPrompt : undefined,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(toolsAllowlist ? { toolsAllowlist } : {}),
      });

      writeFileSync(
        resolve(nodeLogDir, 'cli-invoke.json'),
        JSON.stringify(
          {
            bin,
            argv: argv.map((a, i) =>
              i > 0 && argv[i - 1] === '-p' && a.length > 500 ? `${a.slice(0, 500)}…(${a.length} chars)` : a,
            ),
            cwd,
            timeoutMs,
            writeCapable,
            maxTurns,
            toolsAllowlist: toolsAllowlist ?? null,
            toolsDropped: toolsDropped.length ? toolsDropped : undefined,
            mcpCompat: { claude: false, cursor: false },
            runner: 'cli-grok',
            ts: ctx.now(),
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );

      if (!existsSync(cwd)) {
        throw new Error(`cli-grok cwd does not exist: ${cwd}`);
      }

      // Retry ONCE on a silent death — nonzero exit with NOTHING on either stream.
      //
      // 2026-08-07: `browser-cdp-chrome--design` came back exit 1 / 0 bytes stdout / 0 bytes stderr while 23
      // sibling nodes in the same stage returned 15KB reports each. The throw escaped to the run level and
      // killed a 453-node fleet at 5 done, discarding all 23 finished reports. Three fleets were running
      // concurrently at the time, so ~72 grok processes were live — a transient spawn failure is by far the
      // likeliest cause, and it is the exact class run.ts already protects the `api` seam against ("a serving
      // hiccup must not cost a node in a wide fan-out", generateTransient). The CLI seam had no equivalent.
      //
      // The condition is deliberately narrow: EMPTY on both streams. Nothing was produced, so there is no
      // partial work to lose and no risk of double-counting a side effect. A nonzero exit that DID say
      // something is a real failure and still throws on the first attempt — a retry there would just hide it.
      // Do not inherit ~/.claude.json / ~/.cursor/mcp.json — that is how
      // kb-dopomogai-operator reached every node (13,762 failed inits).
      const spawnEnv = fleetGrokSpawnEnv();
      let proc = await spawnFn({ bin, argv, cwd, env: spawnEnv, timeoutMs });
      if (proc.exitCode !== 0 && !proc.stdout.trim() && !proc.stderr.trim()) {
        writeFileSync(
          resolve(nodeLogDir, 'cli-retry.json'),
          `${JSON.stringify({ reason: 'silent-death', firstExitCode: proc.exitCode, ts: ctx.now() }, null, 2)}\n`,
          'utf8',
        );
        proc = await spawnFn({ bin, argv, cwd, env: spawnEnv, timeoutMs });
      }

      writeFileSync(resolve(nodeLogDir, 'cli-stdout.txt'), proc.stdout, 'utf8');
      if (proc.stderr) writeFileSync(resolve(nodeLogDir, 'cli-stderr.txt'), proc.stderr, 'utf8');

      if (proc.exitCode !== 0) {
        const tail = (proc.stderr || proc.stdout).slice(-800);
        throw new Error(`cli-grok exit ${proc.exitCode}: ${tail || 'no output'}`);
      }

      const parsed = parseGrokPrintOutput(proc.stdout, 'json');
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }

      const sessionId = extractSessionId(parsed.data);
      const costUsd =
        typeof parsed.data.total_cost_usd === 'number'
          ? parsed.data.total_cost_usd
          : typeof parsed.data.cost_usd === 'number'
            ? parsed.data.cost_usd
            : undefined;

      // dec-judge-seam: parse tool frames when the product emits them. Current grok final envelopes are
      // often text+usage only (no tool channel) — leave toolEvents undefined (= unavailable), not [].
      const parsedTools = parseGrokToolEvents(proc.stdout);
      const hasChannel = grokStdoutHasToolChannel(proc.stdout);
      let toolEvents = parsedTools.length > 0 || hasChannel ? parsedTools : undefined;
      // 2026-08-04: the envelope has NO tool frames in grok 0.2.111 (live-proven) — fall back to the
      // per-session events.jsonl (tool_started/tool_completed), the channel that actually records them.
      if (toolEvents === undefined && sessionId) {
        toolEvents = parseGrokSessionToolEvents(grokHomeDir(), sessionId);
      }
      const writeOps = toolEvents ? countWriteOps(toolEvents) : undefined;

      // Metering parity: real tokens when the envelope reports them (absent = absent, never invented).
      const usage = extractGrokEnvelopeUsage(parsed.data);

      const events: NonNullable<NodeExecResult['events']> = [];
      if (toolsDropped.length) {
        events.push({
          type: 'tools_warn',
          detail: {
            runner: 'cli-grok',
            dropped: toolsDropped,
            reason: 'not-in-read-safe-allowlist',
            toolsMode: ctx.node.toolsMode ?? 'extend',
            allowed: toolsAllowlist,
          },
        });
      }
      // Always journal MCP init when grok recorded one. Emitting only failures made a clean
      // init indistinguishable from "we never looked" — the same silence as 13,762 missed
      // handshakes. Failures still also get tools_warn so existing readers keep working.
      const mcpInit = sessionId ? parseGrokSessionMcpInit(grokHomeDir(), sessionId) : undefined;
      if (mcpInit) {
        events.push({
          type: 'mcp_init',
          detail: {
            runner: 'cli-grok',
            mcpAttempted: mcpInit.attempted,
            mcpConnected: mcpInit.connected,
            mcpFailed: mcpInit.failed,
            mcpToolsReceived: mcpInit.tools,
          },
        });
        if (mcpInit.failed.length) {
          events.push({
            type: 'tools_warn',
            detail: {
              runner: 'cli-grok',
              reason: 'mcp-server-unavailable',
              mcpAttempted: mcpInit.attempted,
              mcpConnected: mcpInit.connected,
              mcpFailed: mcpInit.failed,
              mcpToolsReceived: mcpInit.tools,
            },
          });
          for (const f of mcpInit.failed) {
            console.log(`  ⚠ MCP ${f.server} UNAVAILABLE (${f.errorType}) — this node ran without its tools`);
          }
        }
      }
      events.push({
        type: 'cli_result',
        detail: {
          sessionId,
          durationMs: parsed.data.duration_ms,
          costUsd,
          runner: 'cli-grok',
          ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
          ...(toolEvents !== undefined
            ? { toolEventCount: toolEvents.length, writeOps: writeOps ?? 0 }
            : { tool_trace: 'unavailable' }),
        },
      });

      return {
        text: parsed.text,
        sessionId,
        costHint: typeof costUsd === 'number' ? `$${costUsd.toFixed(4)}` : undefined,
        modelLabel: 'cli-grok',
        exitCode: proc.exitCode,
        ...(usage ? { usage } : {}),
        ...(toolEvents !== undefined ? { toolEvents, writeOps: writeOps ?? 0 } : {}),
        events,
      };
    },
  };
}
