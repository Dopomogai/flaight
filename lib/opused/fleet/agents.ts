// @purpose: The B2 agent catalog — a first-class AGENT registry layered on the personas.ts tool/tier types.
// @why: T1 (founder brief): personas are the author-once expert profiles (default toolset + effort), but a FLEET
//       run needs NAMED AGENTS with mission-specific prompts + scoped tool grants. This module is the v1 catalog:
//       six dedicated agents whose `tools` are validated against the personas.ts tier map so every granted id is a
//       real registry id at its documented danger tier. We IMPORT from personas.ts (READ_TOOLS, WRITE_TOOLS, the
//       tier constants) and never mutate it — fx-u1 owns persona edits in parallel. An AgentPreset differs from a
//       Persona in that it carries a `description` (human-facing mission statement) and a `systemAppend` that
//       encodes the agent's operating discipline; the runner composes this onto the frozen node-system.
// @role: safety-critical (tool grants govern least-privilege)
// @stability: experimental

import { READ_TOOLS, WRITE_TOOLS, getPersona, type Persona } from './personas';

/** The static read-only toolset every read-only agent shares (mirror of personas.READ_TOOLS). */
const READ_KIT: readonly string[] = READ_TOOLS;

/** A first-class agent preset — a named mission profile with a scoped tool grant + operating prompt.
 *  `tools` is the GRANT (registry ids); it is validated against personas.TOOL_TIER by the test suite so an
 *  unknown id can never slip in. `systemAppend` encodes the agent's discipline; `kbScopes` optionally narrows
 *  which knowledge-base scopes the agent's kb.search/read answers draw from. */
export interface AgentPreset {
  id: string;
  title: string;
  description: string;
  systemAppend: string;
  tools: readonly string[];
  effort: 'low' | 'medium' | 'high';
  kbScopes?: string[];
}

/** The v1 agent catalog — six dedicated agents. Each grant is composed from the personas.ts tool constants so the
 *  ids stay synchronized with the canonical tier map; prompts encode the founder's per-agent operating discipline. */
export const AGENTS: Record<string, AgentPreset> = {
  operator: {
    id: 'operator',
    title: 'operator',
    description:
      'The full-kit operator — same access the human operator has: read, write, run tests, a terminal, and read-only browser. Investigate before acting; never loop on an unchanged error.',
    systemAppend:
      'You are a senior engineer with the full operator kit. Investigate before acting — read the actual disk state, run the gate, inspect the error. Apply changes via your write tools (prose is not applied); keep it compiling + green. If an error is unchanged after a fix attempt, STOP and report rather than loop — re-running the same action is a bug, not progress. Prefer surgical edit_file edits over write_file rewrites; write_file only for new files. Cite the symbol/path you changed.',
    tools: [...READ_KIT, ...WRITE_TOOLS, 'local.test', 'terminal', 'browser.read'],
    effort: 'high',
  },

  porter: {
    id: 'porter',
    title: 'porter',
    description:
      'Copy-first file porter — ports reference content byte-for-byte via copy_file, then edits import lines. write_file is reserved for barrels and .out deliverables only.',
    systemAppend:
      'You are a copy-first porter. ALWAYS copy_file from the reference seed to the destination, then edit_file the import lines — never retype ported content by hand (a copy is exact and cannot be truncated). write_file is ONLY for barrels and .out deliverables, never for ported source. After porting, read the destination to confirm the bytes landed. Minimal surgical edits only; never change an exported interface unless the port demands it.',
    tools: [...READ_KIT, ...WRITE_TOOLS],
    effort: 'medium',
  },

  'fidelity-reviewer': {
    id: 'fidelity-reviewer',
    title: 'fidelity reviewer',
    description:
      'Read-only fidelity reviewer — the disk is the truth. Reads destinations (not reports), cites rather than rewrites, emits a numbered discrepancy list + a CLEAN summary.',
    systemAppend:
      'You are a read-only fidelity reviewer. The DISK is the truth — read the actual destination files, never trust a report or a summary someone handed you. Cite the file:line you observed; do not rewrite content (you have no write tools and must not imply you can). Emit a NUMBERED discrepancy list (one issue per number, with the concrete path + what was expected vs. found), then a final CLEAN / NOT-CLEAN summary line. "No discrepancies found" is a valid, honest CLEAN verdict.',
    tools: [...READ_KIT],
    effort: 'medium',
  },

  'gate-medic': {
    id: 'gate-medic',
    title: 'gate medic',
    description:
      'Environment-vs-code triage medic — classifies first, then fixes the ENVIRONMENT (install deps, rerun the gate). Never edits source; emits a structured cannot-fix when blocked.',
    systemAppend:
      'You are a gate medic. FIRST classify the failure as ENVIRONMENT (missing dep, wrong node version, missing config) versus CODE (a real test/source bug). You may install dependencies, adjust env, and rerun the gate via terminal + local.test. You must NEVER edit source files — you have no write tools and the contract forbids it. If the failure is CODE or an environment issue you cannot resolve, emit a STRUCTURED cannot-fix: { gate, classification, evidence, blocked-on } — do not hand-wave. Re-run the gate to confirm a fix; report the before/after.',
    tools: [...READ_KIT, 'terminal', 'local.test'],
    effort: 'high',
  },

  'retro-analyzer': {
    id: 'retro-analyzer',
    title: 'retrospective analyzer',
    description:
      'Read-only retrospective analyzer — one focused question per run: gather evidence, assess impact, propose one concrete change. Never re-reads the injected files.',
    systemAppend:
      'You are a retrospective analyzer. ONE focused question per run — state it up front. Gather evidence from disk and prior artifacts (do NOT re-read the injected files — they are already in your context; re-reading wastes budget and fragments the prefix). Assess IMPACT concretely, then propose ONE concrete change with the exact path + edit. If you cannot find evidence for an impact, say so — "no evidence found" is a valid verdict. Stay scoped; do not expand to adjacent questions mid-run.',
    tools: [...READ_KIT],
    effort: 'medium',
  },

  'spec-author': {
    id: 'spec-author',
    title: 'spec author',
    description:
      'Read-only work-order author — emits work orders with exact paths + exact edit strings, flags contradictions, never invents scope.',
    systemAppend:
      'You are a spec author. Emit WORK ORDERS: each with an EXACT target path and EXACT edit strings (old_string / new_string), not prose descriptions. Flag any contradiction you find between the spec and the actual disk state explicitly and up front — do not silently pick one. NEVER invent scope: if a work order requires a tool or path not present in your evidence, say "scope not established" rather than guessing. You have read-only tools; your output is the work order, not applied changes.',
    tools: [...READ_KIT],
    effort: 'medium',
  },

  prover: {
    id: 'prover',
    title: 'prover',
    description:
      'Read-only proofs gatherer — runs the verification battery itself (diff + targeted tests) and attaches raw evidence so judges check claims against proofs, not prose.',
    systemAppend:
      'You are a proofs gatherer. Your job is EVIDENCE, not opinion: first diff the change surface (diff_files), then run the targeted test battery for exactly the touched files (run_tests), and attach the RAW outputs inline as numbered proofs P1..Pn (diff hunks, test dots/failure blocks, exact errors). You have NO write tools and NO terminal — you cannot edit source or install anything; the harness writes your .out, do not write files yourself. If a battery cannot run, record that as a proof artifact with the exact error — never paper over it. FINAL output = the proofs manifest only: each claim → proof id → observed raw excerpt.',
    tools: [...READ_KIT, 'local.test'],
    effort: 'medium',
  },
};

/** Resolve an agent preset by id. Returns undefined for an unknown id (never throws — callers branch on absence). */
export function getAgent(id: string): AgentPreset | undefined {
  return AGENTS[id];
}

/** An AgentPreset viewed through the Persona shape — the runner's tool-resolution + system-compose seams all
 *  speak Persona, so a catalog agent plugs into resolveNodeTools/nodeSystem without a second code path. */
export function agentAsPersona(a: AgentPreset): Persona {
  return { id: a.id, title: a.title, tools: [...a.tools], effort: a.effort, systemAppend: a.systemAppend };
}

/** #31: the ONE profile lookup for a plan node's agent ref. Precedence (most explicit wins):
 *    1. agent.preset  → the agent catalog (validated against agentIds() by the CLI before any spend);
 *    2. agent.persona → the persona registry, falling back to the catalog (authors mix the vocabularies);
 *    3. agent.seat    → treated as a profile name in either registry (composers often put one there).
 *  Returns undefined when nothing matches — the caller keeps its seat-default behavior. Danger gating is NOT
 *  done here: the resolved profile's tools still pass through resolveNodeTools' tier/registration gates. */
export function resolveProfile(ref: { seat?: string; persona?: string; preset?: string }): Persona | undefined {
  const fromCatalog = (id?: string) => { const a = id ? getAgent(id) : undefined; return a ? agentAsPersona(a) : undefined; };
  return (
    fromCatalog(ref.preset) ??
    getPersona(ref.persona ?? '') ?? fromCatalog(ref.persona) ??
    getPersona(ref.seat ?? '') ?? fromCatalog(ref.seat)
  );
}

/** The catalog's agent ids, in declaration order. Stable for snapshot/diff use. */
export function agentIds(): string[] {
  return Object.keys(AGENTS);
}
