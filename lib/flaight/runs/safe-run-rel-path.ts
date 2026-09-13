// @purpose: Pure run-relative path safety predicate (charset + no "..") with no Node built-ins
// @why: plan.ts and the operator resolver must share ONE isSafeRunRelPath SoT; co-locating it with
//       node:fs in node-output.ts put those built-ins on the /lab/opused Client Component graph
//       (page → run-view → plan → node-output). This leaf is importable from client-reachable modules.
// @role: safety-critical
// @stability: experimental

/**
 * A declared output path is RUN-RELATIVE. Segments are plan-authored slugs; a leading slash, a `..`
 * segment, or a Windows drive is refused outright rather than normalised — normalising an attack into
 * something that happens to stay inside the root is how a traversal check becomes a traversal.
 */
/* A segment may START with `_` but never with `.` — the point of pinning the first character is to exclude
 * dotfiles and `..`, not underscores. (`_` matters in practice: router templates validate with the token
 * `__placeholder_<param>__` substituted in, so forbidding it made every parameterised template unparseable.) */
const SAFE_REL_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

export function isSafeRunRelPath(rel: string): boolean {
  return SAFE_REL_RE.test(rel) && !rel.split('/').includes('..');
}
