import type { AppClient } from './chat.js';
import type { Key } from './keys.js';

export interface SkillInfo { name: string; description: string; scope: string; path: string; }
type SkillsClient = Pick<AppClient, 'request' | 'onNotification'>;

const SCOPE_ORDER: Record<string, number> = { repo: 0, user: 1, admin: 2, system: 3 };
export const scopeLabel = (s: string): string => ({ repo: 'project', user: 'global', system: 'system', admin: 'admin' } as Record<string, string>)[s] ?? s;

interface RawSkill { name: string; description?: string; shortDescription?: string; interface?: { shortDescription?: string }; path: string; scope: string; enabled: boolean; }

/**
 * Lightweight skill metadata from Codex's own `skills/list` (global, project-local `.agents/skills`, system).
 * Only name/description/path are kept, never SKILL.md bodies: Codex loads those itself when a skill is used.
 * Cached per session; the server's `skills/changed` notification invalidates it.
 */
export class SkillCatalog {
  private cache?: SkillInfo[];
  private stale = true;
  private off?: () => void;
  failed = 0; // skills Codex could not load (malformed SKILL.md)

  constructor(private client: SkillsClient, private readonly cwd: string) { this.attach(client); }

  attach(client: SkillsClient): void {
    this.off?.();
    this.client = client;
    this.stale = true;
    this.off = client.onNotification((method) => { if (method === 'skills/changed') this.stale = true; });
  }

  async load(force = false): Promise<SkillInfo[]> {
    if (this.cache && !this.stale && !force) return this.cache;
    const res = await this.client.request<{ data: { skills: RawSkill[]; errors?: unknown[] }[] }>('skills/list', { cwds: [this.cwd], forceReload: force || this.stale });
    const raw = res.data.flatMap((e) => e.skills);
    this.failed = res.data.reduce((n, e) => n + (e.errors?.length ?? 0), 0);
    const seen = new Set<string>();
    this.cache = raw
      .filter((s) => s.enabled && !seen.has(s.name) && seen.add(s.name))
      .map((s) => ({ name: s.name, scope: s.scope, path: s.path, description: (s.interface?.shortDescription ?? s.shortDescription ?? s.description ?? '').replace(/\s+/g, ' ').trim() }))
      .sort((a, b) => (SCOPE_ORDER[a.scope] ?? 9) - (SCOPE_ORDER[b.scope] ?? 9) || a.name.localeCompare(b.name));
    this.stale = false;
    return this.cache;
  }
}

/** Skills explicitly invoked with `$name` in a prompt (known, enabled skills only; each once). */
export function mentionedSkills(text: string, skills: SkillInfo[]): SkillInfo[] {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const found = new Map<string, SkillInfo>();
  for (const m of text.matchAll(/(?:^|[^\w$])\$([A-Za-z0-9][\w:.-]*)/g)) {
    let token = m[1];
    while (token && !byName.has(token)) token = token.replace(/[.:,;)-]+$|[^.:,;)-]$/, ''); // trim trailing punctuation, then characters
    const hit = byName.get(token);
    if (hit) found.set(hit.name, hit);
  }
  return [...found.values()];
}

export type PickerResult = 'consumed' | 'close' | 'select';
const VISIBLE = 8;

/** Keyboard-driven list with type-to-filter. Pure state; the TUI paints `rows()` and acts on the result of `handle()`. */
export class SkillPicker {
  filter: string;
  index = 0;
  constructor(private readonly all: SkillInfo[], filter = '') { this.filter = filter; }

  get matches(): SkillInfo[] {
    const f = this.filter.toLowerCase();
    if (!f) return this.all;
    const name = this.all.filter((s) => s.name.toLowerCase().includes(f));
    return [...name, ...this.all.filter((s) => !name.includes(s) && s.description.toLowerCase().includes(f))];
  }
  get selected(): SkillInfo | undefined { return this.matches[this.index]; }

  handle(k: Key): PickerResult {
    const n = this.matches.length;
    if (k.t === 'text' || k.t === 'paste') { this.filter += k.s.replace(/\s+/g, ' ').trimStart(); this.index = 0; return 'consumed'; }
    switch (k.name) {
      case 'up': this.index = n ? (this.index + n - 1) % n : 0; return 'consumed';
      case 'down': this.index = n ? (this.index + 1) % n : 0; return 'consumed';
      case 'home': this.index = 0; return 'consumed';
      case 'end': this.index = Math.max(0, n - 1); return 'consumed';
      case 'backspace': this.filter = this.filter.slice(0, -1); this.index = 0; return 'consumed';
      case 'kill-line-start': this.filter = ''; this.index = 0; return 'consumed';
      case 'submit': case 'tab': return this.selected ? 'select' : 'consumed';
      case 'escape': case 'interrupt': case 'eof': return 'close';
      default: return 'consumed';
    }
  }

  /** Header + up to 8 rows around the selection, each fitted to `width` (plain text; `paint` adds styling). */
  rows(width: number, paint: { accent(s: string): string; dim(s: string): string }): string[] {
    const m = this.matches;
    const start = Math.max(0, Math.min(this.index - Math.floor(VISIBLE / 2), m.length - VISIBLE));
    const fit = (s: string) => (s.length > width ? `${s.slice(0, width - 1)}…` : s);
    const nameW = Math.min(28, Math.max(8, ...m.slice(start, start + VISIBLE).map((s) => s.name.length)));
    const head = `  Skills ${m.length}/${this.all.length}${this.filter ? ` · filter: ${this.filter}` : ' · type to filter'} · ↑↓ select · Enter insert · Esc close`;
    const out = [paint.dim(fit(head))];
    if (!m.length) out.push(paint.dim('  no matching skills'));
    m.slice(start, start + VISIBLE).forEach((s, i) => {
      const sel = start + i === this.index;
      const line = fit(`${sel ? '▸' : ' '} ${s.name.padEnd(nameW).slice(0, nameW)} ${scopeLabel(s.scope).padEnd(7)} ${s.description}`);
      out.push(sel ? paint.accent(line) : line);
    });
    return out;
  }
}
