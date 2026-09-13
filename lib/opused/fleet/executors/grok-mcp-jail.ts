// @purpose: Stop fleet grok nodes inheriting the operator's Claude/Cursor MCP set
// @why: grok-nodes-kb-mcp-handshake-fails-20260810 — grok scans ~/.claude.json by default
//       (compat.claude.mcps). That file lists kb-dopomogai-operator (headersHelper, Claude-only).
//       13,762 failed inits, 0 successes. Fix is to not load that source on the fleet path.
// @role: safety-critical
// @stability: experimental

/**
 * Env grok documents for compat.claude / compat.cursor MCP discovery
 * (`~/.grok/docs/user-guide/07-mcp-servers.md`, `05-configuration.md`).
 * Env beats user config.toml. Project `.grok/config.toml` cannot set [compat] —
 * those sections are user-config only — so a file in the node cwd would not stop
 * the Claude scan. This env is the actual cut.
 */
export const FLEET_GROK_MCP_ENV = {
  GROK_CLAUDE_MCPS_ENABLED: 'false',
  GROK_CURSOR_MCPS_ENABLED: 'false',
} as const;

/** The inherited server that burned 13,762 handshakes. Name-only — never a URL or token. */
export const FLEET_DENIED_MCP_SERVERS = ['kb-dopomogai-operator'] as const;

/** Merge onto a spawn env so a parent `=true` cannot leak the operator MCP set onto a node. */
export function fleetGrokSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...FLEET_GROK_MCP_ENV };
}
