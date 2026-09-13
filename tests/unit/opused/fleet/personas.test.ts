// @purpose: Unit tests for the persona registry + tool resolution precedence + danger gating (T1)
// @why: The precedence (node > persona > seat) and the fail-safe gate (a plan can REQUEST but never self-GRANT a
//       dangerous tool) are load-bearing safety rules — pin them mechanically so a refactor can't quietly widen
//       what a plan is allowed to arm.
// @role: safety-critical test
// @stability: experimental

import { describe, it, expect } from 'vitest';
import {
  resolveNodeTools,
  tierOf,
  getPersona,
  PERSONAS,
  READ_TOOLS,
  auditPersonaTools,
  UnresolvedToolError,
} from '../../../../lib/opused/fleet/personas';

describe('tierOf', () => {
  it('classifies read/write/exec and defaults unknown tools to exec (fail-safe)', () => {
    expect(tierOf('local.read')).toBe('read');
    expect(tierOf('kb.search')).toBe('read');
    expect(tierOf('local.write')).toBe('write');
    expect(tierOf('local.edit')).toBe('write');
    expect(tierOf('local.test')).toBe('exec');
    expect(tierOf('terminal')).toBe('exec');
    expect(tierOf('browser.act')).toBe('exec');
    expect(tierOf('browser.read')).toBe('read');
    expect(tierOf('some.future.tool')).toBe('exec'); // unknown → most restricted
  });
});

describe('getPersona', () => {
  it('returns built-in personas and undefined for unknown ids', () => {
    expect(getPersona('reviewer')?.title).toBe('code reviewer');
    expect(getPersona('refactorer')?.tools).toContain('local.write');
    expect(getPersona('nope')).toBeUndefined();
  });
  it('reviewer + researcher are read-only by default (the safe majority)', () => {
    for (const id of ['reviewer', 'researcher']) {
      const p = PERSONAS[id];
      expect(p.tools.every((t) => tierOf(t) === 'read')).toBe(true);
    }
  });
});

describe('resolveNodeTools — precedence', () => {
  const allowAll = { write: true, exec: true };

  it('node.tools EXTEND the persona preset by default (wave-2+3 lesson: a plan must never silently narrow an agent below its preset)', () => {
    const r = resolveNodeTools({
      nodeTools: ['kb.search'],
      persona: getPersona('implementer'),
      seatDefault: [...READ_TOOLS, 'local.write'],
      allow: allowAll,
    });
    // The implementer preset (incl. edit_file/copy_file write tools) survives; the node ADDS kb.search.
    expect(r.ids).toContain('local.edit');
    expect(r.ids).toContain('local.copy');
    expect(r.ids).toContain('local.write');
    expect(r.ids).toContain('kb.search');
  });

  it("toolsMode:'replace' restores explicit narrowing", () => {
    const r = resolveNodeTools({
      nodeTools: ['local.read'],
      toolsMode: 'replace',
      persona: getPersona('implementer'),
      seatDefault: [...READ_TOOLS, 'local.write'],
      allow: allowAll,
    });
    expect(r.ids).toEqual(['local.read']);
  });

  it('persona.tools used when node.tools absent', () => {
    const r = resolveNodeTools({ persona: getPersona('refactorer'), seatDefault: ['kb.search'], allow: allowAll });
    expect(r.ids).toContain('local.write');
    expect(r.ids).toContain('local.read');
  });

  it('seatDefault used when neither node nor persona set', () => {
    const r = resolveNodeTools({ seatDefault: ['kb.search', 'local.read'], allow: allowAll });
    expect(r.ids).toEqual(['kb.search', 'local.read']);
  });

  it('dedupes requested ids', () => {
    const r = resolveNodeTools({ nodeTools: ['local.read', 'local.read', 'kb.search'], seatDefault: [], allow: allowAll });
    expect(r.ids).toEqual(['local.read', 'kb.search']);
  });
});

describe('resolveNodeTools — danger gating (a plan can REQUEST but never self-GRANT)', () => {
  it('drops write + exec + terminal when the run granted none (default read-only run)', () => {
    const r = resolveNodeTools({
      nodeTools: ['local.read', 'local.write', 'terminal'],
      seatDefault: [],
      allow: { write: false, exec: false, terminal: false },
    });
    expect(r.ids).toEqual(['local.read']);
    expect(r.dropped.map((d) => d.id).sort()).toEqual(['local.write', 'terminal']);
  });

  it('--write arms write but NOT exec/terminal (test + terminal still dropped)', () => {
    const r = resolveNodeTools({
      nodeTools: ['local.read', 'local.write', 'local.test', 'terminal'],
      seatDefault: [],
      allow: { write: true, exec: false, terminal: false },
    });
    expect(r.ids.sort()).toEqual(['local.read', 'local.write']);
    expect(r.dropped.map((d) => d.id).sort()).toEqual(['local.test', 'terminal']);
  });

  it('exec opt-in arms local.test but NOT terminal (distinct gates)', () => {
    const r = resolveNodeTools({
      nodeTools: ['local.read', 'terminal', 'local.test'],
      seatDefault: [],
      allow: { write: false, exec: true, terminal: false },
    });
    expect(r.ids.sort()).toEqual(['local.read', 'local.test']);
    expect(r.dropped.map((d) => d.id)).toEqual(['terminal']);
  });

  it('terminal opt-in arms the read-only shell WITHOUT arming arbitrary-code exec', () => {
    const r = resolveNodeTools({
      nodeTools: ['local.read', 'terminal', 'local.test'],
      seatDefault: [],
      allow: { write: false, exec: false, terminal: true },
    });
    expect(r.ids.sort()).toEqual(['local.read', 'terminal']);
    expect(r.dropped.map((d) => d.id)).toEqual(['local.test']);
  });

  it('read tools always pass regardless of opt-ins', () => {
    const r = resolveNodeTools({ nodeTools: [...READ_TOOLS, 'browser.read'], seatDefault: [], allow: { write: false, exec: false } });
    expect(r.ids).toEqual([...READ_TOOLS, 'browser.read']);
    expect(r.dropped).toEqual([]);
  });
});

// ── B3: Registration gating (drop-and-log persona defaults, fail-loud explicit node.tools) ──────────────

describe('resolveNodeTools — registration gating (registryIds)', () => {
  // A representative read-only registry (no terminal, no write/exec tools armed).
  const readRegistry = new Set<string>([...READ_TOOLS, 'browser.read']);

  it('drops persona-default unregistered tool with reason "unregistered"', () => {
    // security-auditor has `terminal` in its persona.tools; registry lacks it.
    const r = resolveNodeTools({
      persona: getPersona('security-auditor'),
      seatDefault: [],
      allow: { write: false, exec: false, terminal: true },
      registryIds: readRegistry,
    });
    expect(r.ids).not.toContain('terminal');
    const drop = r.dropped.find((d) => d.id === 'terminal');
    expect(drop).toBeDefined();
    expect(drop!.reason).toBe('unregistered');
  });

  it('throws UnresolvedToolError for explicit node.tools unregistered id', () => {
    expect(() =>
      resolveNodeTools({
        nodeTools: ['nonexistent.tool'],
        seatDefault: [],
        allow: { write: true, exec: true },
        registryIds: readRegistry,
      }),
    ).toThrow(UnresolvedToolError);
  });

  it('still tier-gates registered tools (reason "tier")', () => {
    // local.write IS in the registry but allow.write is false.
    const registryWithWrite = new Set([...readRegistry, 'local.write']);
    const r = resolveNodeTools({
      nodeTools: ['local.read', 'local.write'],
      seatDefault: [],
      allow: { write: false, exec: false },
      registryIds: registryWithWrite,
    });
    expect(r.ids).toEqual(['local.read']);
    const drop = r.dropped.find((d) => d.id === 'local.write');
    expect(drop).toBeDefined();
    expect(drop!.reason).toBe('tier');
  });

  it('without registryIds behaves as today (no registration check, only tier gating)', () => {
    // nonexistent.tool is exec tier (unknown → exec) and dropped by tier — no throw without registryIds.
    const r = resolveNodeTools({
      nodeTools: ['local.read', 'nonexistent.tool'],
      seatDefault: [],
      allow: { write: false, exec: false },
    });
    expect(r.ids).toEqual(['local.read']);
    expect(r.dropped.map((d) => d.id)).toEqual(['nonexistent.tool']);
    expect(r.dropped[0].reason).toBe('tier');
  });
});

// ── B3: Persona audit ─────────────────────────────────────────────────────────────────────────────────

describe('auditPersonaTools', () => {
  it('returns every persona tool id with registered flag', () => {
    // A registry that has read + write + test tools but NOT terminal.
    const registryIds = new Set<string>([
      ...READ_TOOLS,
      'browser.read',
      ...['local.write', 'local.edit', 'local.delete', 'local.move'],
      'local.test',
    ]);
    const audit = auditPersonaTools(registryIds);

    // Every persona × tool pair is represented.
    let expectedCount = 0;
    for (const p of Object.values(PERSONAS)) expectedCount += p.tools.length;
    expect(audit).toHaveLength(expectedCount);

    // security-auditor's terminal is flagged unregistered.
    const terminalEntry = audit.find((a) => a.persona === 'security-auditor' && a.id === 'terminal');
    expect(terminalEntry).toBeDefined();
    expect(terminalEntry!.registered).toBe(false);
    expect(terminalEntry!.tier).toBe('exec');

    // implementer's local.test is registered.
    const testEntry = audit.find((a) => a.persona === 'implementer' && a.id === 'local.test');
    expect(testEntry).toBeDefined();
    expect(testEntry!.registered).toBe(true);
    expect(testEntry!.tier).toBe('exec');
  });

  it('marks all tools registered when registry is complete', () => {
    const allToolIds = new Set<string>();
    for (const p of Object.values(PERSONAS)) for (const id of p.tools) allToolIds.add(id);
    const audit = auditPersonaTools(allToolIds);
    expect(audit.every((a) => a.registered)).toBe(true);
  });
});
