// @purpose: The token convention for Opused — we speak in TOKENS, not chars/KB (operator rule, 2026-06-17)
// @why: Model windows, read caps, and bundle sizes are all about tokens; chars/KB hide what actually fits.
//       This is a cheap, deterministic approximation (no tokenizer dep): ~4 chars/token, good enough for
//       sizing reads + context. Every size we report or cap should go through here so the unit is uniform.
// @role: logic
// @stability: experimental

/** Crude but stable: English/code averages ~4 chars per token. Good enough for sizing, not billing. */
export const CHARS_PER_TOKEN = 4;

/** Approximate token count of a string (or pass a char count directly). */
export function approxTokens(input: string | number): number {
  const chars = typeof input === 'string' ? input.length : input;
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** Chars that fit in a token budget — for slicing a read to a token cap. */
export function tokensToChars(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

/** Human label, always in tokens: 'k tok' over 1000, else 'tok'. */
export function fmtTokens(input: string | number): string {
  const t = approxTokens(input);
  return t >= 1000 ? `~${Math.round(t / 1000)}k tok` : `~${t} tok`;
}
