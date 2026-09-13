import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { offlinePlan, simulate } from '../lib/public/simulate';
import { readArtifact } from '../lib/public/observe';
import { createObserver } from '../lib/public/mcp';
import { runPlan } from '../lib/opused/fleet/run';

const fixture = JSON.parse(readFileSync(new URL('../examples/research-review.json', import.meta.url), 'utf8'));
const dirs: string[] = [];
function directory() { const p = mkdtempSync(join(tmpdir(), 'flaight-public-')); dirs.push(p); return p; }
afterEach(() => { vi.restoreAllMocks(); for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });

describe('standalone execution', () => {
  it('refuses a rejected approval before invoking the generator', async () => {
    const root = directory(); mkdirSync(join(root, 'rejected'));
    writeFileSync(join(root, 'rejected', 'GATE-preapprove.rejected'), 'rejected');
    const generate = vi.fn();
    await expect(runPlan(offlinePlan(fixture), 'rejected', {
      generate, defaultModel: 'test', runsRoot: root, judgeSeamEnv: {},
    })).rejects.toThrow('REJECTED');
    expect(generate).not.toHaveBeenCalled();
  });
  it('runs both stages, saves outputs, and journals the real dependency order without network', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in simulation'));
    const result = await simulate(fixture, directory());
    expect([result.done, result.failed, result.skipped]).toEqual([3, 0, 0]);
    expect(JSON.parse(readFileSync(join(result.runDir, 'summary.json'), 'utf8'))).toEqual({ summary: 'sim' });
    const events = readFileSync(join(result.runDir, 'run.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
    const summaryStart = events.findIndex(x => x.type === 'node_start' && x.nodeId === 'summary');
    for (const id of ['usability', 'reliability']) expect(events.findIndex(x => x.type === 'node_finish' && x.nodeId === id)).toBeLessThan(summaryStart);
    expect(events[0].detail.sim).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a CLI node and a separately routed judge before creating a run', () => {
    const cli = structuredClone(fixture); cli.stages[0].nodes[0].agent.runner = 'cli-grok';
    expect(() => offlinePlan(cli)).toThrow('agent/api');
    const judge = structuredClone(fixture); judge.stages[0].nodes[0].contract.judge = { rubric: 'Check it', runner: 'cli-grok' };
    expect(() => offlinePlan(judge)).toThrow('external judge');
  });

  it('rejects file injection and forward dependencies', () => {
    const inject = structuredClone(fixture); inject.stages[0].nodes[0].inject = ['/etc/passwd'];
    expect(() => offlinePlan(inject)).toThrow('does not use files');
    const forward = structuredClone(fixture); forward.stages[0].nodes[0].consumes = ['summary'];
    expect(() => offlinePlan(forward)).toThrow();
  });

  it('records a failed output schema instead of accepting the generator response', async () => {
    const plan = offlinePlan(fixture);
    const result = await runPlan(plan, 'invalid-output', {
      generate: async () => ({ text: 'not JSON', genId: 'negative-control', finishReason: 'stop', toolCalls: [] }),
      defaultModel: 'test', runsRoot: directory(), maxRepairs: 0, judgeSeamEnv: {},
    });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.outcomes.find(x => x.nodeId === 'summary')?.status).toBe('failed');
    expect(readFileSync(join(result.runDir, 'run.jsonl'), 'utf8')).toContain('node_schema_fail');
  });
});

describe('local MCP observation', () => {
  it('starts the documented stdio entrypoint and completes a protocol round trip', async () => {
    const root = directory(), run = await simulate(fixture, root);
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', 'tsx', 'scripts/mcp.ts', root],
      cwd: process.cwd(), stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'list_runs', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain(run.runId);
    } finally { await client.close(); await transport.close(); }
  });
  it('lists and reads the same output through a real MCP client/server exchange', async () => {
    const root = directory(); const run = await simulate(fixture, root);
    const server = createObserver(root), client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['list_runs', 'read_run_artifact']);
      const result = await client.callTool({ name: 'read_run_artifact', arguments: { run_id: run.runId, artifact: 'summary.json' } });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: readFileSync(join(run.runDir, 'summary.json'), 'utf8') }]);
      const denied = await client.callTool({ name: 'read_run_artifact', arguments: { run_id: run.runId, artifact: '.env' } });
      expect(denied.isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  });

  it('denies traversal, external symlinks and oversized artifacts', async () => {
    const root = directory(), run = await simulate(fixture, root);
    expect(() => readArtifact(root, '../escape', 'run.jsonl')).toThrow();
    expect(() => readArtifact(root, run.runId, '../.env')).toThrow();
    const outside = join(directory(), 'private.txt'); writeFileSync(outside, 'synthetic-secret');
    rmSync(join(run.runDir, 'summary.json')); symlinkSync(outside, join(run.runDir, 'summary.json'));
    expect(() => readArtifact(root, run.runId, 'summary.json')).toThrow();
    rmSync(join(run.runDir, 'summary.json')); writeFileSync(join(run.runDir, 'summary.json'), 'x'.repeat(65_537));
    expect(() => readArtifact(root, run.runId, 'summary.json')).toThrow('64 KiB');
  });
});
