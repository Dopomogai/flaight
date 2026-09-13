// @purpose: Call a registered loopback HTTP connection from a compute node
// @why: In-container live services sit next to Opused; plan names the connection id only
// @role: safety-critical
// @stability: experimental

import { assertLoopbackHttp, lookupHttpConnection } from '../connections';
import type { ComputeFn } from '../types';

export const httpConnection: ComputeFn = async ({ args, env }) => {
  const connectionId = typeof args.connection === 'string' ? args.connection.trim() : '';
  if (!connectionId) return { ok: false, reason: 'http.connection: args.connection required' };
  const conn = lookupHttpConnection(env, connectionId);
  if (!conn) {
    return { ok: false, reason: `http.connection: unknown connection id ${connectionId}` };
  }
  let base: URL;
  try {
    base = assertLoopbackHttp(conn.baseUrl);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const path = typeof args.path === 'string' && args.path.startsWith('/') ? args.path : '/';
  const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
  if (method !== 'GET' && method !== 'POST') {
    return { ok: false, reason: `http.connection: method not allowed: ${method}` };
  }
  const url = new URL(path, base);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    return { ok: false, reason: 'http.connection: resolved host left loopback' };
  }
  try {
    const res = await fetch(url, {
      method,
      headers: { accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(8_000),
    });
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, reason: `http.connection: ${res.status} ${url.pathname}` };
    }
    return { ok: true, text: body };
  } catch (e) {
    return { ok: false, reason: `http.connection: ${e instanceof Error ? e.message : String(e)}` };
  }
};
