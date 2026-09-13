// @purpose: Unit tests for the F3 structural validator — extractJson + validateAgainstSchema
// @why: F3 is safety-critical: it is the gate that stops malformed output flowing downstream. These pin the
//       JSON-Schema subset (type/required/properties/items/enum), the every-error-not-just-first behavior a
//       repair prompt needs, and the JSON-extraction that tolerates fenced blocks + prose-wrapped JSON.
// @role: safety-critical test
// @stability: experimental

import { describe, it, expect } from 'vitest';
import { extractJson, validateAgainstSchema } from '../../../../lib/opused/fleet/schema-check';

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('parses a fenced ```json block', () => {
    expect(extractJson('here you go:\n```json\n{"a":1}\n```\nthanks')).toEqual({ a: 1 });
  });
  it('parses a fenced block with no language tag', () => {
    expect(extractJson('```\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });
  it('recovers a JSON span wrapped in prose', () => {
    expect(extractJson('The result is {"ok":true} — done.')).toEqual({ ok: true });
  });
  it('returns null for non-JSON', () => {
    expect(extractJson('just some prose, no json')).toBeNull();
  });
});

const MANIFEST = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'instruction'],
        properties: { id: { type: 'string' }, instruction: { type: 'string' }, severity: { enum: ['low', 'med', 'high'] } },
      },
    },
  },
};

describe('validateAgainstSchema', () => {
  it('accepts a valid manifest', () => {
    const v = { items: [{ id: 'x', instruction: 'do x', severity: 'high' }] };
    expect(validateAgainstSchema(v, MANIFEST)).toEqual({ ok: true });
  });

  it('a non-object schema means nothing to enforce', () => {
    expect(validateAgainstSchema({ anything: true }, undefined)).toEqual({ ok: true });
  });

  it('flags a missing required top-level property', () => {
    const r = validateAgainstSchema({}, MANIFEST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/\$\.items: required property missing/);
  });

  it('flags a wrong type (object vs array)', () => {
    const r = validateAgainstSchema({ items: 'nope' }, MANIFEST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/\$\.items: expected array, got string/);
  });

  it('flags a missing required field inside an array item, with the indexed path', () => {
    const r = validateAgainstSchema({ items: [{ id: 'x' }] }, MANIFEST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/\$\.items\[0\]\.instruction: required property missing/);
  });

  it('flags an enum violation', () => {
    const r = validateAgainstSchema({ items: [{ id: 'x', instruction: 'y', severity: 'CRITICAL' }] }, MANIFEST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/severity: value "CRITICAL" is not one of/);
  });

  it('collects EVERY error, not just the first', () => {
    const r = validateAgainstSchema({ items: [{}] }, MANIFEST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2); // both id AND instruction missing
  });
});
