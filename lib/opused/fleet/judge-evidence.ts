// @purpose: Deterministic pre-model judge overlay — tool-trace status, claim heuristics, anti-fabrication
// @why: dec-judge-seam P0/P1 — journal done ≠ verified work (scar goals-status-verify-20260803); model mood must not ACCEPT zero-tool fabrication
// @role: safety-critical
// @stability: experimental

import type { ToolEvent } from '../council/types';
import { treeKnownClean, treeWorkLanded, type FilesChangedFact } from './tree-change';
import { JUDGE_WRITE_TOOL_NAMES } from './write-tool-names';

/** How honestly we know the node's tool trace. */
export type ToolTraceStatus = 'ok' | 'empty' | 'unavailable' | 'lost';

/**
 * Overlay tag recorded on JudgeVerdict.
 * Force-return tags: zero-tools | gates-red | write-fabrication | missing-evidence.
 * `trace-unavailable` is legacy (pre-2026-08-04); harness loss now stamps `degraded-trace-lost` and does NOT force.
 */
export type JudgeOverlayKind =
  | 'none'
  | 'zero-tools'
  | 'gates-red'
  | 'write-fabrication'
  | 'trace-unavailable'
  | 'missing-evidence'
  | 'degraded-trace-lost';

/**
 * Conservative "claims real work" heuristic on the deliverable self-report.
 * Prefer plan `requireToolEvidence` for high-stakes nodes; this catches prose fabrication.
 * Note: `wrote` is unanchored so "rewrote" matches (scar-shaped self-report).
 */
export const CLAIMS_WORK =
  /(re)?wrote|edited|applied|fixed|implemented|ran tests|verified|file:/i;

/**
 * Re-exported from the leaf `write-tool-names` so `tree-change` can read the list without importing
 * this module — that edge was a cycle and it took the fleet CLI down at load time. Consumers keep
 * importing it from here; do not move the definition back inline.
 */
export { JUDGE_WRITE_TOOL_NAMES };

const WRITE_SET = new Set<string>(JUDGE_WRITE_TOOL_NAMES);

/** Map harness toolEvents → trace status for the journal / overlay. */
export function resolveToolTraceStatus(toolEvents: ToolEvent[] | undefined): ToolTraceStatus {
  if (toolEvents === undefined) return 'unavailable';
  if (toolEvents.length === 0) return 'empty';
  return 'ok';
}

/** true only when status is empty/ok-with-zero — never true when unavailable or lost. */
export function zeroToolCalls(status: ToolTraceStatus, count: number | null | undefined): boolean | null {
  if (status === 'unavailable' || status === 'lost') return null;
  if (status === 'empty') return true;
  return (count ?? 0) === 0;
}

export function countWriteOps(events: ToolEvent[] | undefined): number {
  if (!events?.length) return 0;
  return events.filter((e) => WRITE_SET.has(e.name)).length;
}

export function claimsWork(text: string): boolean {
  return CLAIMS_WORK.test(text ?? '');
}

/** Extract short cites under an EVIDENCE: section (bullets or plain lines until next SECTION). */
export function parseEvidenceCited(raw: string): string[] {
  const text = (raw ?? '').trim();
  if (!text) return [];
  const m = text.match(/^\s*EVIDENCE\s*:\s*\r?\n([\s\S]*?)(?=^\s*(?:VERDICT|REVIEW)\s*:|\Z)/im);
  if (!m) {
    // Inline: EVIDENCE: - a - b on same block without strict next header
    const m2 = text.match(/^\s*EVIDENCE\s*:\s*\r?\n([\s\S]+)/im);
    if (!m2) return [];
    return bulletsFrom(m2[1]);
  }
  return bulletsFrom(m[1]);
}

function bulletsFrom(block: string): string[] {
  const out: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      if (out.length) break;
      continue;
    }
    if (/^(VERDICT|REVIEW)\s*:/i.test(t)) break;
    const bullet = t.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    if (bullet) out.push(bullet.slice(0, 240));
    if (out.length >= 12) break;
  }
  return out;
}

/** True when the model reply includes a non-empty EVIDENCE section. */
export function hasEvidenceSection(raw: string): boolean {
  return parseEvidenceCited(raw).length > 0 || /^\s*EVIDENCE\s*:\s*\S+/im.test(raw ?? '');
}

/** Recorded on the verdict when tool evidence could not be demanded. Never `true`/`false` — a REASON. */
export type EvidenceWaiver = 'no-tools-armed';

/**
 * Can this node be asked for tool evidence at all?
 *
 * THE 2026-08-07 SCAR. A sim rehearsal of the audit (runId `sim-2026-08-07T01-23-02-886Z`) reported
 * `run_finish {done:11, failed:0}` while **8 of those 11 nodes had burned their entire 6-attempt repair
 * budget** on `zero tool calls — claims lack tool evidence`. Sim forces every runner to `api` and passes
 * no `toolsFor` (`scripts/fleet.ts:1229` — "sim nodes call no registry tools"), so the node holds an EMPTY
 * tool bundle. Zero tool calls from a node armed with zero tools is **arithmetic, not fabrication** — the
 * rubric was structurally unsatisfiable, and 48 repair cycles per run were spent discovering at attempt 6
 * what was already true at attempt 0. Same shape retroactively in `sim-2026-08-06T23-50-35-336Z` (4 of 11).
 *
 * So the waiver is keyed on the ARMED BELT, not on a sim flag. That is deliberate and stronger:
 * - It is right in every seam. A live prose-synthesis node (`audit-reporter` ships `tools: []` with
 *   `toolsMode:'replace'`) is equally unable to produce a tool call, and would hit the same wall.
 * - It cannot be forged by a runner label. A node that really holds tools and calls none stays caught —
 *   which is the whole reason the zero-tools overlay exists.
 *
 * **Fails closed on ignorance**: `undefined` (belt not known to the caller, e.g. a CLI node whose belt is a
 * `--tools` allowlist rather than a bundle — and where an empty allowlist means the DEFAULT toolset stays
 * armed, so zero is not even representable) waives NOTHING and keeps today's behaviour exactly.
 *
 * The waiver is RECORDED on the verdict (`evidence_waived`) rather than applied silently: an ACCEPT that
 * was never asked for evidence must not be readable as evidence-backed. That was the founder-facing half of
 * the defect — the run looked like a clean 11✓ 0✗.
 */
export function evidenceWaiver(toolsArmed: number | undefined): EvidenceWaiver | null {
  if (toolsArmed === undefined) return null;
  if (toolsArmed > 0) return null;
  return 'no-tools-armed';
}

export interface JudgeOverlayInput {
  toolTraceStatus: ToolTraceStatus;
  toolEventCount: number | null;
  writeOps: number;
  isWriter: boolean;
  gatesRed: boolean;
  requireToolEvidence: boolean;
  text: string;
  /** When true, treat fenced code + writer + zero writes as fabrication (mirrors E-1 signal). */
  hasFencedCode?: boolean;
  /** From `evidenceWaiver()` — set means the node could not call a tool, so zero calls prove nothing. */
  evidenceWaived?: EvidenceWaiver | null;
  /**
   * Tree-level fact from before/after porcelain under the node root.
   * `undefined` = caller did not take a snapshot (legacy unit tests) → fail-closed claims path (not known-empty).
   * `known:false` = snapshot attempted and failed → same; never treat as filesChanged:[].
   */
  filesChanged?: FilesChangedFact;
  /** Optional tool events for path attribution (write-tool args). */
  toolEvents?: ToolEvent[];
}

export interface JudgeOverlayResult {
  forceReturn: string;
  overlay: Exclude<JudgeOverlayKind, 'none'>;
}

/**
 * Pure pre-model rules. Returns a forced RETURN reason + overlay tag, or null (model may ACCEPT).
 * Order: gates-red → empty+claims/require → write-fabrication.
 * Harness-lost trace (`unavailable`) never forces — judge on content; runJudge stamps
 * tool_trace_status:'lost' + overlay:'degraded-trace-lost' (JUDGE-RECOMMENDATION-2026-08-04).
 * zero-tools stays: empty from a HEALTHY harvest is the fabrication signal.
 */
export function applyJudgeOverlay(input: JudgeOverlayInput): JudgeOverlayResult | null {
  const {
    toolTraceStatus,
    toolEventCount,
    writeOps,
    isWriter,
    gatesRed,
    requireToolEvidence,
    text,
    hasFencedCode,
    evidenceWaived,
    filesChanged,
    toolEvents,
  } = input;
  const claims = claimsWork(text);

  if (gatesRed) {
    return {
      forceReturn: 'gates red — compiler/tests outrank any claim of success',
      overlay: 'gates-red',
    };
  }

  // gates-red stays ABOVE the waiver: a red compiler outranks everything, tools or no tools.
  // The zero-tools overlay, though, is a fabrication test — and there is nothing to fabricate away from
  // when the node held no tools. Waived → fall through to the model judge on content.
  if (toolTraceStatus === 'empty' && !evidenceWaived && (requireToolEvidence || claims)) {
    return {
      forceReturn: 'zero tool calls — claims lack tool evidence',
      overlay: 'zero-tools',
    };
  }

  // Write-fabrication: attributed tree dirty is primary; writeOps never proves landing alone.
  // Sibling of lost tool channel: absence of a tree fact is NOT evidence of zero writes —
  // and writeOps is NOT evidence of landing when the tree is unknown or unattributed.
  if (
    toolTraceStatus !== 'unavailable' &&
    toolTraceStatus !== 'lost' &&
    isWriter
  ) {
    const fenced =
      hasFencedCode === true || /```[\w.+-]*\r?\n[\s\S]*?```/.test(text ?? '');
    const claimsOrShows = claims || fenced;
    const tree = filesChanged;
    const events = toolEvents;

    if (tree?.known === true) {
      if (treeWorkLanded(tree, text, events)) {
        // Attributed work on the tree (terminal or write tool) — do not force on writeOps alone.
      } else if (treeKnownClean(tree)) {
        // Known clean tree.
        // False green: write-tool calls + claims/shows, no net tree change.
        // Bare writeOps>0 with no claims/fence is an honest tool no-op (breaks-honest D2) — do NOT force.
        if (writeOps > 0 && claimsOrShows) {
          return {
            forceReturn:
              'writer reported write-tool calls but the node root tree is unchanged while claiming or showing applied work',
            overlay: 'write-fabrication',
          };
        }
        if (writeOps === 0 && claimsOrShows) {
          return {
            forceReturn:
              'writer held write tools but the node root tree is unchanged while claiming or showing applied work',
            overlay: 'write-fabrication',
          };
        }
      } else {
        // Known dirty but unattributed (junk marker / peer path) — treat as not landed.
        if (claimsOrShows) {
          return {
            forceReturn:
              'writer dirty paths do not intersect the deliverable/tool surface while claiming or showing applied work',
            overlay: 'write-fabrication',
          };
        }
      }
    } else {
      // tree undefined OR known:false → fail closed on claims/shows (still-foolable D4).
      // writeOps>0 is NOT innocence when the tree cannot be read.
      if (claimsOrShows) {
        return {
          forceReturn:
            tree?.known === false
              ? `tree evidence unavailable (${tree.reason}) — writeOps cannot prove work landed while claiming or showing applied work`
              : 'writer held write tools but made zero write ops while claiming or showing applied work',
          overlay: 'write-fabrication',
        };
      }
    }
  }

  // Silence unused when count present for future policies
  void toolEventCount;
  return null;
}

/**
 * After a model ACCEPT: require EVIDENCE cites when requireToolEvidence is on.
 * Returns forced reason or null.
 */
export function acceptNeedsEvidence(args: {
  requireToolEvidence: boolean;
  verdict: 'ACCEPT' | 'RETURN' | null;
  raw: string;
  /** From `evidenceWaiver()` — a node with no belt cannot cite tool evidence it was never able to gather. */
  evidenceWaived?: EvidenceWaiver | null;
}): string | null {
  if (args.evidenceWaived) return null;
  if (!args.requireToolEvidence) return null;
  if (args.verdict !== 'ACCEPT') return null;
  if (hasEvidenceSection(args.raw)) return null;
  return 'ACCEPT without EVIDENCE section while requireToolEvidence is set';
}
