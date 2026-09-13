// @purpose: The persona registry — named expert profiles (default toolset + effort) a plan node references
// @why: T1, the founder's "mixture of experts, but each is a dedicated LLM": a node names a PERSONA and inherits
//       that expert's default tool grant + effort, instead of every plan re-declaring tools inline. This is the
//       author-once contract: `security-auditor` always gets read+terminal, `refactorer` gets read+write, etc.
//       The KB agent owns the CANONICAL persona catalog (docs/prompts); this module is the ENGINE mechanism the
//       runner resolves. Precedence (least surprise): node-level fields OVERRIDE the persona, which overrides the
//       seat default. DANGER-tiered tools are only ever ARMED by the matching CLI opt-in — a persona/plan can
//       REQUEST `local.write`/`terminal` but the tool stays inert unless the run was launched --write/--terminal.
// @role: safety-critical
// @stability: experimental

/** A tool's danger tier — governs whether a plan/persona REQUEST is honored, or gated behind a CLI opt-in.
 *  read: always available. write: needs --write. exec: needs --test/--terminal (runs code / shell). */
export type ToolTier = 'read' | 'write' | 'exec';

/** The canonical tier of every registry tool id. A tool absent here is treated as `exec` (fail-safe: unknown =
 *  most-restricted). Keep in sync with tools/registry.ts ids — the runtime catalog emitter (T1) reconciles this
 *  with the KB agent's _registry/tools.json convention doc. */
export const TOOL_TIER: Record<string, ToolTier> = {
  'kb.search': 'read',
  'kb.read': 'read',
  'local.list': 'read',
  'local.read': 'read',
  'local.read-many': 'read',
  'local.diff': 'read',
  'local.map': 'read',
  'transcript.list': 'read',
  'transcript.search': 'read',
  'transcript.read': 'read',
  'opused.council': 'read',
  'local.write': 'write',
  'local.edit': 'write',
  'local.delete': 'write',
  'local.move': 'write',
  'local.copy': 'write',
  'local.test': 'exec',
  'terminal': 'exec',
  'browser.read': 'read',
  'browser.screenshot': 'read',
  'browser.read_console': 'read',
  'browser.read_network': 'read',
  // Tier read, not exec: the CDP session refuses any host outside localhost / example.test, so this
  // verb cannot reach a client system at all — and operator-led walk nodes run with exec OFF, which
  // an exec tier would silently drop, leaving the node unable to reach its own assigned flow.
  'browser.navigate': 'read',
  'browser.act': 'exec',
};

/** Registry id → model-facing tool name. Static mirror of tools/registry.ts (which builds entries
 *  conditionally at runtime) so plan validation can cross-check taskPrompt tool MENTIONS against GRANTS
 *  without building a registry. Keep in sync when a tool is added. */
export const MODEL_NAME_BY_ID: Record<string, string> = {
  'kb.search': 'search_knowledge',
  'kb.read': 'read_source',
  'local.list': 'list_files',
  'local.read': 'read_local',
  'local.read-many': 'read_many',
  'local.diff': 'diff_files',
  'local.map': 'repo_map',
  'local.write': 'write_file',
  'local.edit': 'edit_file',
  'local.delete': 'delete_file',
  'local.move': 'move_file',
  'local.copy': 'copy_file',
  'local.test': 'run_tests',
  'terminal': 'terminal',
  'transcript.list': 'transcript_list',
  'transcript.search': 'transcript_search',
  'transcript.read': 'transcript_read',
  'opused.council': 'run_council',
  'browser.read': 'browser_read',
  'browser.screenshot': 'browser_screenshot',
  'browser.read_console': 'browser_read_console',
  'browser.read_network': 'browser_read_network',
  'browser.navigate': 'browser_navigate',
};

export function tierOf(toolId: string): ToolTier {
  return TOOL_TIER[toolId] ?? 'exec'; // unknown tool → most restricted (fail-safe)
}

export const READ_TOOLS = ['kb.search', 'kb.read', 'local.list', 'local.read', 'local.read-many', 'local.diff', 'local.map'] as const;
export const WRITE_TOOLS = ['local.write', 'local.edit', 'local.delete', 'local.move', 'local.copy'] as const;

/** A named expert profile. `tools` is the DEFAULT grant (registry ids); `model`/`effort` are optional defaults.
 *  `systemAppend` is an optional extra framing line appended to the frozen node-system (kept short — the base
 *  fleet framing stays stage-invariant so the cacheable prefix isn't fragmented). */
export interface Persona {
  id: string;
  title: string;
  tools: string[];
  effort?: 'low' | 'medium' | 'high';
  model?: string;
  systemAppend?: string;
}

/** The built-in persona catalog. Read-only experts by default (the safe majority); writer/exec personas request
 *  their tier but only arm under the matching CLI flag. The KB agent's catalog can extend this by convention. */
export const PERSONAS: Record<string, Persona> = {
  reviewer: {
    id: 'reviewer', title: 'code reviewer',
    tools: [...READ_TOOLS], effort: 'medium',
    systemAppend: 'Review for concrete, symbol-grounded improvements; "no change needed" is a valid honest verdict.',
  },
  'security-auditor': {
    id: 'security-auditor', title: 'security auditor',
    tools: [...READ_TOOLS, 'terminal'], effort: 'high',
    systemAppend: 'Hunt sandbox escapes, path traversal, unvalidated input, secret leakage; give the concrete exploit path + the guard.',
  },
  researcher: {
    id: 'researcher', title: 'researcher',
    tools: [...READ_TOOLS, 'browser.read'], effort: 'medium',
    systemAppend: 'Gather + synthesize from the injected material and read-only tools; cite what you used.',
  },
  refactorer: {
    id: 'refactorer', title: 'refactoring implementer',
    tools: [...READ_TOOLS, ...WRITE_TOOLS], effort: 'high',
    systemAppend: 'Apply behavior-preserving refactors via your write tools; minimal surgical edits; never change an exported interface.',
  },
  implementer: {
    id: 'implementer', title: 'implementer',
    tools: [...READ_TOOLS, ...WRITE_TOOLS, 'local.test'], effort: 'high',
    systemAppend: 'Apply changes via your write tools (prose is not applied); keep it compiling + green.',
  },
};

export function getPersona(id: string): Persona | undefined {
  return PERSONAS[id];
}

/** Thrown when an EXPLICIT `node.tools` entry names a tool that isn't in the built registry — a plan
 *  authoring error we surface fail-loud (never silently drop what was asked for by name). Contrast:
 *  a persona/seat-DEFAULT tool that's unregistered is dropped-and-logged, not thrown. */
export class UnresolvedToolError extends Error {}

/**
 * Resolve the tool-id list a node should receive, honoring precedence + danger gating. Precedence (highest first):
 *   1. node.tools (explicit per-node grant)   2. persona.tools   3. seatDefault (the CLI's read/write set)
 * Then GATE: a requested tool is dropped unless its tier is allowed by the run's opt-ins (`allow`). read is always
 * allowed; write needs allow.write; exec needs allow.exec. Returns { ids, dropped } so the caller can log what a
 * plan asked for but didn't get (never silently — least privilege must be auditable).
 *
 * Registration gating (B3 drop-and-log policy): when `registryIds` is provided, an id NOT in the built registry is
 *   - THROWN as `UnresolvedToolError` if it came from `nodeTools` (the plan author asked for it by name — fail-loud),
 *   - DROPPED with `reason: 'unregistered'` if it came from a persona/seat default (drop-and-log, never abort).
 * When `registryIds` is absent, no registration check runs (backward-compat — only tier gating). Every dropped
 * entry carries a `reason`: `'tier'` (registered but not opted-in) or `'unregistered'` (not in the registry).
 */
export function resolveNodeTools(
  opts: {
    nodeTools?: string[];
    persona?: Persona;
    seatDefault: string[];
    // write: arms local.write/edit/… (--write). exec: arms local.test (runs arbitrary model code — --test).
    // terminal: arms the allowlisted read-only shell (--terminal) — a distinct, safer opt-in than exec so an
    // investigator persona can get `terminal` WITHOUT also being able to run arbitrary test code.
    allow: { write: boolean; exec: boolean; terminal?: boolean };
    registryIds?: Set<string>; // the built registry's key set — enables registration gating
    // 'extend' (DEFAULT): node.tools ADD to the persona/seat preset — a plan can grant extra tools but can
    // never silently narrow an agent below its preset. 'replace': the old behavior, for the rare node that
    // genuinely needs a narrower set (must be explicit). Why: wave-2+3 (run -154Z) — the plan's tools list
    // REPLACED the implementer preset and dropped edit_file, forcing writers into the banned write_file
    // path the provider then truncated. Presets are the contract; ad-hoc narrowing broke it invisibly.
    toolsMode?: 'extend' | 'replace';
  },
): { ids: string[]; dropped: { id: string; tier: ToolTier; reason: 'tier' | 'unregistered' }[] } {
  const preset = opts.persona?.tools ?? opts.seatDefault;
  const requested = opts.nodeTools
    ? ((opts.toolsMode ?? 'extend') === 'extend' ? [...preset, ...opts.nodeTools] : opts.nodeTools)
    : preset;
  const explicit = new Set(opts.nodeTools ?? []);
  const ids: string[] = [];
  const dropped: { id: string; tier: ToolTier; reason: 'tier' | 'unregistered' }[] = [];
  for (const id of Array.from(new Set(requested))) {
    const tier = tierOf(id);
    // Registration check (before tier gating): drop-and-log for defaults, fail-loud for explicit node.tools.
    if (opts.registryIds && !opts.registryIds.has(id)) {
      if (explicit.has(id)) throw new UnresolvedToolError(`node.tools requests unregistered tool "${id}"`);
      dropped.push({ id, tier, reason: 'unregistered' });
      continue;
    }
    const ok = id === 'terminal'
      ? !!opts.allow.terminal                                   // its own opt-in (allowlisted read-only shell)
      : tier === 'read' || (tier === 'write' && opts.allow.write) || (tier === 'exec' && opts.allow.exec);
    if (ok) ids.push(id);
    else dropped.push({ id, tier, reason: 'tier' });
  }
  return { ids, dropped };
}

/**
 * Audit every persona's default tool ids against the built registry (B3 deliverable). Returns one row per
 * (persona, tool) pair with its tier and whether the registry currently has it. This surfaces, e.g., the
 * security-auditor's `terminal` appearing as `registered: false` when `--terminal` is off (terminal is only
 * seeded conditionally in `buildToolRegistry`). The caller logs the findings; no side effects.
 */
export function auditPersonaTools(
  registryIds: Set<string>,
): { persona: string; id: string; tier: ToolTier; registered: boolean }[] {
  const out: { persona: string; id: string; tier: ToolTier; registered: boolean }[] = [];
  for (const p of Object.values(PERSONAS)) {
    for (const id of p.tools) {
      out.push({ persona: p.id, id, tier: tierOf(id), registered: registryIds.has(id) });
    }
  }
  return out;
}
