// @purpose: Structural validation of a node's output against its contract.schema — enforced at the edge (F3)
// @why: A node's contract.schema was CARRIED but never checked (plan.ts §Contract), so a malformed output
//       flowed silently into the next node's context pack — exactly the "garbage downstream" failure the plan
//       graph exists to prevent. F3 validates at the PRODUCING edge (run.ts, before the .out is written): a
//       bad output is retried once with the errors injected, then hard-failed and NOT written, so a consumer
//       never receives malformed input. Kept dependency-light (no ajv) — a ~50-line structural check over the
//       JSON-Schema subset a work-list manifest needs (type/required/properties/items/enum). Unknown schema
//       keys are ignored (forward-compatible). This is also what lets F-SIM synthesize schema-shaped stub
//       outputs that PASS the same check the real ones do.
// @role: safety-critical
// @stability: experimental

/** Extract a JSON value from model output: a fenced ```json block if present, else the whole trimmed text.
 *  Returns null when nothing parses (the caller treats that as a schema failure — no silent pass). */
export function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    // Last resort: the first balanced-looking {...} or [...] span (models sometimes wrap prose around JSON).
    const span = candidate.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (span) {
      try { return JSON.parse(span[1]); } catch { /* fall through */ }
    }
    return null;
  }
}

export type SchemaResult = { ok: true } | { ok: false; errors: string[] };

/** Validate a value against a JSON-Schema-ish object (the manifest subset). A non-object schema (or undefined)
 *  means "nothing to enforce" → ok. Collects EVERY error (not just the first) so a repair prompt is complete. */
export function validateAgainstSchema(value: unknown, schema: unknown): SchemaResult {
  if (!isRecord(schema)) return { ok: true };
  const errors: string[] = [];
  walk(value, schema, '$', errors);
  return errors.length ? { ok: false, errors } : { ok: true };
}

function walk(value: unknown, schema: Record<string, unknown>, path: string, errors: string[]): void {
  const type = typeof schema.type === 'string' ? schema.type : undefined;

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((e) => e === value)) {
      errors.push(`${path}: value ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
    }
  }

  switch (type) {
    case 'object': {
      if (!isRecord(value)) { errors.push(`${path}: expected object, got ${typeName(value)}`); return; }
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (typeof key === 'string' && !(key in value)) errors.push(`${path}.${key}: required property missing`);
        }
      }
      if (isRecord(schema.properties)) {
        for (const [key, sub] of Object.entries(schema.properties)) {
          if (key in value) walk(value[key], sub as Record<string, unknown>, `${path}.${key}`, errors);
        }
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) { errors.push(`${path}: expected array, got ${typeName(value)}`); return; }
      if (isRecord(schema.items)) {
        value.forEach((el, i) => walk(el, schema.items as Record<string, unknown>, `${path}[${i}]`, errors));
      }
      return;
    }
    case 'string':
      if (typeof value !== 'string') errors.push(`${path}: expected string, got ${typeName(value)}`);
      return;
    case 'number':
    case 'integer':
      if (typeof value !== 'number') errors.push(`${path}: expected number, got ${typeName(value)}`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${typeName(value)}`);
      return;
    default:
      // No (or unknown) type → only enum/nested checks applied above; nothing more to enforce here.
      return;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
