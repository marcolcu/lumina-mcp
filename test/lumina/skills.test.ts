import { describe, expect, it } from 'vitest';
import { KeyParser } from '../../src/lumina/tui/keys.js';
import { SkillCatalog, SkillInfo, SkillPicker, mentionedSkills } from '../../src/lumina/tui/skills.js';

const raw = (name: string, scope: string, extra: Record<string, unknown> = {}) => ({ name, description: `${name} description`, path: `/p/${name}/SKILL.md`, scope, enabled: true, ...extra });
const fakeClient = (skills: unknown[], errors: unknown[] = []) => {
  const calls: { method: string; params: unknown }[] = [];
  let notify: (m: string, p: unknown) => void = () => undefined;
  const client = {
    request: async (method: string, params: unknown) => { calls.push({ method, params }); return { data: [{ cwd: '/w', skills, errors }] }; },
    onNotification: (h: (m: string, p: unknown) => void) => { notify = h; return () => undefined; },
  };
  return { client: client as never, calls, emit: (m: string) => notify(m, {}) };
};
const S = (name: string, scope = 'user', description = `${name} description`): SkillInfo => ({ name, scope, description, path: `/p/${name}` });

describe('SkillCatalog', () => {
  it('lists global + project skills via skills/list (metadata only), hides disabled, dedupes, orders project → global → system', async () => {
    const { client, calls } = fakeClient([
      raw('b-global', 'user'), raw('sys', 'system'), raw('proj', 'repo', { shortDescription: 'short', interface: { shortDescription: 'Interface short' } }),
      raw('a-global', 'user', { description: 'multi\n  line   text' }), raw('off', 'user', { enabled: false }), raw('b-global', 'user'),
    ], [{ message: 'bad skill' }]);
    const c = new SkillCatalog(client, '/w');
    const list = await c.load();
    expect(list.map((s) => `${s.scope}:${s.name}`)).toEqual(['repo:proj', 'user:a-global', 'user:b-global', 'system:sys']);
    expect(list[0].description).toBe('Interface short');
    expect(list[1].description).toBe('multi line text');
    expect(Object.keys(list[0]).sort()).toEqual(['description', 'name', 'path', 'scope']); // no SKILL.md bodies
    expect(calls[0].params).toMatchObject({ cwds: ['/w'] });
    expect(c.failed).toBe(1);
  });
  it('caches until skills/changed or force', async () => {
    const f = fakeClient([raw('x', 'user')]);
    const c = new SkillCatalog(f.client, '/w');
    await c.load(); await c.load();
    expect(f.calls).toHaveLength(1);
    f.emit('skills/changed');
    await c.load();
    expect(f.calls).toHaveLength(2);
    await c.load(true);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2].params).toMatchObject({ forceReload: true });
  });
});

describe('mentionedSkills', () => {
  const skills = [S('caveman'), S('zebra-greeting', 'repo'), S('compound-engineering:ce-plan')];
  const names = (t: string) => mentionedSkills(t, skills).map((s) => s.name);
  it('finds explicit $name references (start, middle, punctuation, plugin names), once each', () => {
    expect(names('$caveman hello')).toEqual(['caveman']);
    expect(names('use $zebra-greeting, then $caveman. also $caveman')).toEqual(['zebra-greeting', 'caveman']);
    expect(names('run ($compound-engineering:ce-plan) now')).toEqual(['compound-engineering:ce-plan']);
    expect(names('line1\n$caveman')).toEqual(['caveman']);
  });
  it('ignores unknown names, prices, shell variables and mid-word dollars', () => {
    expect(names('$unknown $5 $$caveman a$caveman ${caveman}')).toEqual([]);
    expect(names('costs $5.00')).toEqual([]);
  });
});

describe('SkillPicker', () => {
  const all = ['alpha', 'beta', 'gamma', 'delta'].map((n, i) => S(n, 'user', i === 3 ? 'mentions beta indirectly' : `${n} desc`));
  const key = (s: string) => new KeyParser().feed(s)[0];
  const paint = { accent: (x: string) => x, dim: (x: string) => x };
  it('navigates with wrap-around, filters by name then description, selects and closes', () => {
    const p = new SkillPicker(all);
    expect(p.handle(key('\x1b[B'))).toBe('consumed');
    expect(p.selected?.name).toBe('beta');
    p.handle(key('\x1b[A')); p.handle(key('\x1b[A'));
    expect(p.selected?.name).toBe('delta'); // wrapped
    p.handle(key('\x1b[H'));
    expect(p.selected?.name).toBe('alpha');
    for (const ch of 'beta') p.handle({ t: 'text', s: ch });
    expect(p.matches.map((s) => s.name)).toEqual(['beta', 'delta']); // name match first, description match after
    p.handle(key('\x7f'));
    expect(p.filter).toBe('bet');
    expect(p.handle(key('\r'))).toBe('select');
    expect(p.selected?.name).toBe('beta');
    expect(p.handle(key('\x1b'))).toBe('close');
    expect(p.handle(key('\x03'))).toBe('close');
  });
  it('Enter with no match does nothing; rows are width-fitted and scroll around the selection', () => {
    const p = new SkillPicker(all, 'zzz');
    expect(p.handle(key('\r'))).toBe('consumed');
    expect(p.rows(40, paint).at(-1)).toContain('no matching skills');
    const many = Array.from({ length: 30 }, (_, i) => S(`skill-${String(i).padStart(2, '0')}`, 'user', 'a very long description '.repeat(5)));
    const q = new SkillPicker(many);
    for (let i = 0; i < 15; i++) q.handle(key('\x1b[B'));
    const rows = q.rows(40, paint);
    expect(rows).toHaveLength(9); // header + 8
    expect(rows.every((r) => r.length <= 40)).toBe(true);
    expect(rows.find((r) => r.startsWith('▸'))).toContain('skill-15');
  });
});

describe('keys: escape and tab', () => {
  it('lone Escape and Tab are reported as keys (also in CSI-u form)', () => {
    expect(new KeyParser().feed('\x1b')).toEqual([{ t: 'key', name: 'escape' }]);
    expect(new KeyParser().feed('\t')).toEqual([{ t: 'key', name: 'tab' }]);
    expect(new KeyParser().feed('\x1b[9u')).toEqual([{ t: 'key', name: 'tab' }]);
    expect(new KeyParser().feed('\x1b[27u')).toEqual([{ t: 'key', name: 'escape' }]);
    expect(new KeyParser().feed('\x1b[A')).toEqual([{ t: 'key', name: 'up' }]); // sequences are not mistaken for Escape
  });
});
