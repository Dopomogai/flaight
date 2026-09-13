// @purpose: Named outbound connections for compute nodes — secrets stay in env, not the plan
// @why: Plan may REQUEST a connection id; it must never carry the URL secret or inline code
// @role: safety-critical
// @stability: experimental

export interface HttpConnection {
  id: string;
  kind: 'http';
  baseUrl: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function parseConnectionsJson(raw: string | undefined): HttpConnection[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('OPUSED_CONNECTIONS_JSON is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('OPUSED_CONNECTIONS_JSON must be an array');
  const out: HttpConnection[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    if (rec.kind !== 'http') continue;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const baseUrl = typeof rec.baseUrl === 'string' ? rec.baseUrl.trim() : '';
    if (!id || !baseUrl) continue;
    out.push({ id, kind: 'http', baseUrl });
  }
  return out;
}

export function assertLoopbackHttp(baseUrl: string): URL {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`connection baseUrl is not a URL: ${baseUrl}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`connection protocol not allowed: ${u.protocol}`);
  }
  if (!LOOPBACK.has(u.hostname)) {
    throw new Error(`connection host not loopback: ${u.hostname}`);
  }
  return u;
}

export function lookupHttpConnection(
  env: NodeJS.ProcessEnv,
  id: string,
): HttpConnection | undefined {
  return parseConnectionsJson(env.OPUSED_CONNECTIONS_JSON).find((c) => c.id === id);
}
