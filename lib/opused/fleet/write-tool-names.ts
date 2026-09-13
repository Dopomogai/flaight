// @purpose: The one list of write-tool names, in a leaf module both the judge overlay and the tree snapshot can import
// @why: judge-evidence <-> tree-change was a cycle; both read this list at module init, so `pnpm fleet` died on load under tsx (2026-08-08)
// @role: safety-critical
// @stability: stable

/**
 * Model-facing + CLI product write tool names (API registry + grok/claude product CLIs).
 *
 * Constraint: this module must import NOTHING. Two safety-critical modules read it at module-init
 * time (`new Set(...)`), so any import here can reintroduce a top-level cycle — and a cycle here is
 * not a slow degradation, it is the fleet CLI failing to load at all.
 */
export const JUDGE_WRITE_TOOL_NAMES = [
  'write_file',
  'edit_file',
  'delete_file',
  'move_file',
  'search_replace',
  'Write',
  'Edit',
  'NotebookEdit',
  'write',
  'str_replace',
  'create_file',
] as const;
