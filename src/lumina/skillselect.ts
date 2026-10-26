import { splitPrompt } from '../smart-codex/router.js';
import { words } from './retrieval.js';
import { SkillInfo, mentionedSkills, scopeLabel } from './tui/skills.js';

/**
 * Automatic skill selection over the skills Codex already discovered (`skills/list`). Deterministic: the request's
 * own words (never pasted reference material) are matched against each skill's name and description. A selected
 * skill is attached as a native Codex skill item, so Codex loads its SKILL.md lazily and applies its instructions,
 * tool requirements and restrictions exactly as with an explicit `$skill`. No model call is made to choose.
 */
export interface Picked { skill: SkillInfo; score: number; nameHits: string[]; descHits: string[] }
export interface SkillDecision {
  request: string;
  mode: 'explicit' | 'auto' | 'none';
  selected: Picked[];
  explicit: SkillInfo[];
  /** Candidates that matched but were not used, and why (conflict, unavailable, limit). */
  dropped: { skill: SkillInfo; reason: string }[];
  note?: string;
  /** The prompt carried pasted reference material, which was ignored for selection. */
  pasted?: boolean;
}

const PRIORITY: Record<string, number> = { repo: 0, user: 1, admin: 2, system: 3 }; // Codex's precedence: project first
// words that say nothing about WHICH skill fits (they appear in most descriptions)
const GENERIC = new Set(['use', 'used', 'using', 'when', 'whenever', 'skill', 'skills', 'user', 'asks', 'ask', 'asked', 'want', 'wants', 'need', 'needs', 'help', 'helps', 'any', 'all', 'with', 'the', 'and', 'for', 'you', 'your', 'about', 'this', 'that', 'into', 'from', 'code', 'file', 'task', 'work', 'mode', 'tool', 'tools', 'make', 'create', 'new', 'run', 'get', 'set', 'thing', 'also', 'like', 'such', 'not', 'only', 'more', 'other', 'project', 'request', 'trigger', 'triggers', 'please', 'tolong', 'yang', 'dan', 'untuk', 'ini', 'itu', 'dengan', 'agar', 'bisa', 'mau', 'saya', 'kamu']);
// Indonesian → English, so one lexicon serves both languages
const ID: Record<string, string> = {
  tinjau: 'review', tinjauan: 'review', periksa: 'review', cek: 'review', telaah: 'review', ulas: 'review', audit: 'audit',
  keamanan: 'security', aman: 'security', autentikasi: 'authentication', otentikasi: 'authentication', otorisasi: 'authorization', login: 'login',
  uji: 'test', pengujian: 'test', tes: 'test', dokumentasi: 'documentation', dokumen: 'documentation', perbaiki: 'fix', benahi: 'fix',
  komit: 'commit', rilis: 'release', terjemah: 'translate', terjemahkan: 'translate', desain: 'design', tampilan: 'ui', gambar: 'image',
  basi: 'database', // "basis (data)" after plural stemming
  kinerja: 'performance', performa: 'performance', rapikan: 'refactor', refaktor: 'refactor', migrasi: 'migration', basis: 'database', ringkas: 'summary', ringkasan: 'summary',
  jelaskan: 'explain', selidiki: 'investigate', investigasi: 'investigate', rencana: 'plan', rencanakan: 'plan',
};
/** Light suffix folding so safely/safe, failures/fail, migrations/migration meet (applied to both sides alike). */
const stem = (w: string) => { const m = /^(.{4,}?)(?:ingly|edly|ations?|ures?|ing|ed|ly)$/.exec(w); return m ? m[1] : w; };
const termMap = (s: string) => new Map(words(s).map((w) => ID[w] ?? w).filter((w) => !GENERIC.has(w)).map((w) => [stem(w), w] as const));
const terms = (s: string) => new Set(termMap(s).keys());

/** Required tools Lumina can check locally (environment variables); others are left to Codex, which owns them. */
export function unavailable(s: SkillInfo): string | undefined {
  const missing = (s.tools ?? []).filter((t) => t.type === 'env_var' && !process.env[t.value]).map((t) => t.value);
  return missing.length ? `needs ${missing.join(', ')} (not set)` : undefined;
}

export function selectSkills(text: string, skills: SkillInfo[], opts: { auto: boolean; maxAuto: number }): SkillDecision {
  const explicit = mentionedSkills(text, skills);
  const base = { request: text, selected: [], dropped: [] as SkillDecision['dropped'] };
  // explicit $skill wins; auto-selection never adds to it
  if (explicit.length) return { ...base, mode: 'explicit', explicit };
  if (!opts.auto || opts.maxAuto === 0) return { ...base, mode: 'none', explicit: [], note: 'automatic skill selection is off (skills.auto_select)' };
  // judge the request, not pasted docs/tickets that merely mention skill names
  const sp = splitPrompt(text);
  // a long prompt without a short request paragraph is all pasted material: nothing in it is the user's intent
  const pasted = Boolean(sp.reference) || text.length > 600;
  if (!sp.reference && text.length > 600) return { ...base, mode: 'none', explicit: [], pasted, note: 'no short request found in the pasted text; use $skill to pick one' };
  const said = termMap(pasted ? sp.instruction : text); // stem → the word as the user wrote it (for /why)
  const req = new Set(said.keys());
  const cands: Picked[] = [];
  for (const s of skills) {
    const nameTerms = terms(s.name);
    const nameHits = [...nameTerms].filter((w) => req.has(w));
    // a skill is chosen for what it IS: its whole name (or two of its name words) must be in the request,
    // or part of its name plus a description that clearly fits (two or more of its words)
    const full = nameHits.length > 0 && nameHits.length === nameTerms.size;
    const descHits = [...terms(s.description)].filter((w) => req.has(w) && !nameTerms.has(w));
    if (!full && nameHits.length < 2 && !(nameHits.length && descHits.length >= 2)) continue;
    const score = 2 * nameHits.length + (full ? 1 : 0) + Math.min(descHits.length, 3);
    // one-word names ("migration") also need their description to fit the request
    if (score >= 4) cands.push({ skill: s, score, nameHits: nameHits.map((w) => said.get(w) ?? w), descHits: descHits.map((w) => said.get(w) ?? w) });
  }
  cands.sort((a, b) => b.score - a.score || (PRIORITY[a.skill.scope] ?? 9) - (PRIORITY[b.skill.scope] ?? 9) || a.skill.name.localeCompare(b.skill.name));
  const selected: Picked[] = [];
  const dropped = base.dropped;
  for (const c of cands) {
    const why = unavailable(c.skill);
    if (why) { dropped.push({ skill: c.skill, reason: why }); continue; }
    // skills of the same family (sharing a name word, e.g. review / security-review) give competing instructions: keep the best
    const rival = selected.find((p) => [...terms(p.skill.name)].some((w) => terms(c.skill.name).has(w)));
    if (rival) { dropped.push({ skill: c.skill, reason: `conflicts with ${rival.skill.name} (same kind of skill; the better match was kept)` }); continue; }
    if (selected.length >= opts.maxAuto) { dropped.push({ skill: c.skill, reason: `limit of ${opts.maxAuto} automatic skill(s)` }); continue; }
    selected.push(c);
  }
  return { ...base, dropped, mode: selected.length ? 'auto' : 'none', explicit: [], selected, pasted };
}

/** /why: which skill, why, and which words of the request triggered it. */
export function explainDecision(d: SkillDecision | undefined): string {
  if (!d) return 'No request has been sent yet in this session.';
  const req = d.request.split('\n')[0].slice(0, 120);
  if (d.mode === 'explicit') return `Skills: ${d.explicit.map((s) => `$${s.name} [${scopeLabel(s.scope)}]`).join(', ')}\nWhy: you invoked ${d.explicit.length === 1 ? 'it' : 'them'} explicitly with $name (automatic selection is skipped then).\nRequest: "${req}"`;
  const lines: string[] = [];
  if (d.mode === 'none') lines.push(`No skill was selected for the last request${d.note ? ` (${d.note})` : ' — no available skill matched what was asked'}. Codex may still use one on its own.`);
  for (const p of d.selected) {
    lines.push(`Skill: ${p.skill.name} [${scopeLabel(p.skill.scope)}]`);
    lines.push(`Why: its name matches ${p.nameHits.map((w) => `"${w}"`).join(', ')}${p.descHits.length ? `; its description also covers ${p.descHits.map((w) => `"${w}"`).join(', ')}` : ''}`);
    if (p.skill.description) lines.push(`About: ${p.skill.description.slice(0, 160)}`);
  }
  for (const x of d.dropped) lines.push(`Not used: ${x.skill.name} — ${x.reason}`);
  lines.push(`Request: "${req}"${d.pasted ? ' (pasted reference material is not used for skill selection)' : ''}`);
  return lines.join('\n');
}
