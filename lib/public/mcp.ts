import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listRuns, readArtifact } from './observe';

/** Local read-only MCP transport; launching agents or changing files is deliberately not exposed. */
export function createObserver(root: string): McpServer {
  const server = new McpServer({ name: 'flaight-observer', version: '0.1.0' });
  server.registerTool('list_runs', {
    description: 'List up to 100 local run directories. Presence does not imply completion.',
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => ({ content: [{ type: 'text', text: JSON.stringify(listRuns(root)) }] }));
  server.registerTool('read_run_artifact', {
    description: 'Read a stored plan, journal, or declared output up to 64 KiB from a local run.',
    inputSchema: { run_id: z.string().max(128), artifact: z.string().max(256) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ run_id, artifact }) => {
    try { return { content: [{ type: 'text', text: readArtifact(root, run_id, artifact) }] }; }
    catch { return { isError: true, content: [{ type: 'text', text: 'Artifact unavailable, outside scope, or exceeds the size limit.' }] }; }
  });
  return server;
}
