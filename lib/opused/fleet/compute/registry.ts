// @purpose: Named compute registry — a plan can REQUEST an id, never define a function
// @why: Same law as tools: request, never self-grant. Mirrors FLAIGHT-ARCHITECTURE.md
// @role: safety-critical
// @stability: experimental

import { concatArtifacts } from './fns/concat-artifacts';
import { httpConnection } from './fns/http-connection';
import type { ComputeDecl } from './types';

const DECLS: readonly ComputeDecl[] = [
  {
    id: 'artifact.concat',
    whenToUse: 'Join consumed node .out files into one artifact. No model. Use before a synth that should see one file.',
    fn: concatArtifacts,
  },
  {
    id: 'http.connection',
    whenToUse:
      'GET/POST a registered loopback connection (OPUSED_CONNECTIONS_JSON). In-container services only. Never a public host.',
    fn: httpConnection,
  },
];

const BY_ID = new Map(DECLS.map((d) => [d.id, d]));

export function getCompute(id: string): ComputeDecl | undefined {
  return BY_ID.get(id);
}

export function listComputeIds(): string[] {
  return DECLS.map((d) => d.id);
}

export function listComputeDecls(): readonly ComputeDecl[] {
  return DECLS;
}
