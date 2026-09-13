// @purpose: Fleet grok nodes must not inherit operator Claude/Cursor MCP
// @why: grok-nodes-kb-mcp-handshake-fails-20260810 — 13,762 failed kb-dopomogai-operator inits
// @role: safety-critical test
// @stability: experimental

import { describe, expect, it } from 'vitest';
import {
  FLEET_DENIED_MCP_SERVERS,
  FLEET_GROK_MCP_ENV,
  fleetGrokSpawnEnv,
} from '../../../../lib/opused/fleet/executors/grok-mcp-jail';

describe('fleetGrokSpawnEnv', () => {
  it('disables Claude and Cursor MCP discovery even when the parent env enabled them', () => {
    const env = fleetGrokSpawnEnv({
      GROK_CLAUDE_MCPS_ENABLED: 'true',
      GROK_CURSOR_MCPS_ENABLED: 'true',
      PATH: '/usr/bin',
    });
    expect(env.GROK_CLAUDE_MCPS_ENABLED).toBe('false');
    expect(env.GROK_CURSOR_MCPS_ENABLED).toBe('false');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('names the inherited operator server so a rename is a deliberate edit', () => {
    expect(FLEET_DENIED_MCP_SERVERS).toContain('kb-dopomogai-operator');
    expect(FLEET_GROK_MCP_ENV.GROK_CLAUDE_MCPS_ENABLED).toBe('false');
  });
});
