import path from 'node:path';
import { RouterConfig, TIERS, Tier } from './config.js';
import { discover } from './context.js';
import { ModelInfo, loadCatalog, resolveModel } from './models.js';

export interface Preferences { model?: string; reasoning?: string; tier?: Tier; }
export interface RouteInput { task: string; repository?: string; context?: string; preferences?: Preferences; }
export interface Route {
  tier: Tier;
  complexity_score: number;
  /** Complexity without the risk bonus: how hard the work is, independent of how sensitive the domain is. */
  base_complexity: number;
  /** Characters of pasted reference material (ticket, docs, code) that were NOT used to judge complexity/risk. */
  reference_chars: number;
  confidence: number;
  risk: 'low' | 'medium' | 'high';
  model: string;
  reasoning_effort: string;
  agent_strategy: 'single' | 'single_then_review' | 'parallel';
  relevant_files: string[];
  require_review: boolean;
  escalation_allowed: boolean;
  reason: string;
}

const LEX = {
  sensitive: /\b(payments?|billing|checkout|stripe|paypal|refunds?|invoices?|ledger|financial|transactions?|auth|authentication|authorization|authori[sz]e|login|passwords?|credentials?|jwt|oauth|sso|rbac|permissions?|security|vulnerabilit\w*|cve|xss|csrf|sql injection|secrets?|encrypt\w*|migrations?|drop table|production data|data integrity|pii|(?:refresh|access|api|auth|bearer|csrf) tokens?)\b/gi,
  hard: /\b(refactor\w*|architect\w*|redesign|restructur\w*|decoupl\w*|monolith|concurren\w*|race conditions?|deadlocks?|distributed|memory leaks?|intermittent|complex|multi-?file|performance|async|rewrite|migrate)\b/gi,
  normal: /\b(add|implement|create|build|endpoint|api|crud|component|feature|service|fix|bug|tests?|unit|validation|route|handler|hook|ganti|ubah|tambah\w*|perbaiki|buat|hapus|pindah\w*|sesuaikan|integrasi\w*)\b/gi,
  // trivial operations (cosmetic/textual)
  fast: /\b(renam\w*|typos?|spelling|text|copy|label|wording|colou?rs?|styl\w*|css|padding|margin|spacing|font|comments?|readme|docs?|documentation|changelog|translations?|tooltips?|placeholders?|headings?|bump|version|icon)\b/gi,
  // surfaces where a trivial operation cannot change security behavior
  safeObject: /\b(page|button|label|text|copy|readme|docs?|documentation|comments?|changelog|tooltips?|placeholders?|banner|icon|colou?rs?|css|style|styling|ui|layout|headings?|titles?|translations?|wording|spacing|font)\b/i,
  // words showing real code logic is touched
  logic: /\b(implement\w*|verif\w*|validat\w*|middleware|handlers?|flow|rotat\w*|signatures?|sign(ing)?|hash\w*|schema|quer(y|ies)|endpoints?|api|logic|guards?|polic(y|ies)|webhooks?|sessions?|refactor\w*|rewrite|encrypt\w*)\b/i,
  feature: /\b(crud|components?|features?|services?|routes?|hooks?|tests?|unit)\b/i,
  scope: /\b(all|every|entire|whole|across|multiple|throughout|codebase|semua|seluruh|setiap)\b/gi,
  readOnly: /^\s*(explain|describe|summari[sz]e|list|show|where|how|why|what)\b/i,
  modify: /\b(implement|fix|add|change|update|refactor|rewrite|remove|delete|create|build|migrate|rotate|replace|patch|ganti|ubah|tambah\w*|perbaiki|buat|hapus)\b/i,
  // the user explicitly limits the scope ("only one page", "cuma 1 halaman")
  narrow: /\b(only|just|single|one (page|file|component|screen|endpoint|function)|1 (page|file|halaman|endpoint|komponen)|satu (halaman|file|endpoint|komponen|page)|hanya|cuma|saja|aja)\b/i,
};
const INJECTION = /(ignore|disregard|override|bypass)\b.{0,30}\b(rules?|routing|instructions?|policy|tier)|(treat|classify|mark)\b.{0,20}\bas\b.{0,10}\b(fast|trivial|low)|force\s+(tier|fast|low)|system prompt/i;
const DESTRUCTIVE = /\b(drop|truncate|delete all|rm -rf|wipe|purge|migrations?)\b/i;

export const isReadOnlyTask = (task: string): boolean => LEX.readOnly.test(task) && !LEX.modify.test(task);

// ---- git intent (English + Indonesian) -------------------------------------------------------------
// Commit messages are metadata: they are stripped before judging what the user actually asked for.
const COMMIT_MSG = [
  /\b(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\([^)\n]*\))?!?:[^\n]*/gi, // conventional-commit subject, to end of line
  /(?:-m|--message)[ =]*(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi, // git commit -m "..."
  /\b(?:dengan|pakai|with|using|gunakan|use)\s+(?:(?:the|this|ini)\s+)?(?:commit\s+)?(?:message|pesan)\b[^\n]*/gi, // "with message <free text>"
  /\b(?:untuk|for|as)\s+(?:the\s+)?(?:commit\s+)?(?:message|pesan)\b[^\n]*/gi,
];
const GIT_OP = /\b(commit|push|git\s+(?:add|status|diff|log|stash|commit|push|pull)|stage|staging)\b/i;
const GIT_WORK = /\b(implement\w*|implementasi\w*|fix\w*|perbaiki|refactor\w*|create|buat\w*|build|write|tulis|debug|resolve|patch|update|ubah|ganti|change|remove|hapus|delete|migrate|rewrite|add|tambah\w*|upgrade|install)\b/i;
const GIT_DANGEROUS = /\b(force[- ]?push|push\s+(?:-f|--force)\b|--force(?:-with-lease)?|(?:rewrite|rewriting|tulis ulang|ubah)\s+(?:the\s+)?(?:git\s+)?(?:history|riwayat)|reset\s+--hard|filter-(?:branch|repo)|git\s+clean\s+-\w*f|(?:hapus|delete)\s+(?:remote\s+)?branch|push\s+paksa)\b/i;
const GIT_CONFLICT = /\b(merge\s+conflicts?|conflicts?|konflik|rebase)\b/i;

export type GitIntent = 'simple' | 'conflict' | 'dangerous';
export function gitIntent(task: string): GitIntent | undefined {
  let s = task;
  for (const re of COMMIT_MSG) s = s.replace(re, ' ');
  if (GIT_DANGEROUS.test(s)) return 'dangerous';
  if (GIT_CONFLICT.test(s)) return 'conflict';
  // a pure git operation: git verbs present, and no work verbs left (after dropping "git add")
  return GIT_OP.test(s) && !GIT_WORK.test(s.replace(/\bgit\s+add\b/gi, 'git')) ? 'simple' : undefined;
}

const count = (re: RegExp, s: string) => (s.match(re) ?? []).length;

const REF_LABEL = /^\s*(?:\*\*)?(description|deskripsi|ticket|tiket|acceptance criteria|ac|api|endpoints?|request|response|payload|contoh|example|notes?|catatan|context|konteks|spec|specification|dokumentasi|docs?|background|latar belakang|summary|ringkasan)(?:\*\*)?\s*[:：]/i;

/**
 * Separates what the user asks (instruction) from material pasted for reference (ticket text, API docs, Markdown,
 * code). Reference = fenced code, Markdown headings/tables/quotes, labelled sections ("Description:", "API:"),
 * and long paragraphs. Short prompts are all instruction.
 */
export function splitPrompt(text: string): { instruction: string; reference: string } {
  if (text.length <= 600) return { instruction: text, reference: '' };
  const paragraphs: { text: string; fenced: boolean }[] = [];
  let buf: string[] = [];
  let fence = false;
  const flush = (fenced = false) => { if (buf.join('').trim()) paragraphs.push({ text: buf.join('\n'), fenced }); buf = []; };
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { if (fence) { buf.push(line); flush(true); fence = false; } else { flush(); fence = true; buf.push(line); } continue; }
    if (fence) { buf.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    buf.push(line);
  }
  flush(fence);
  let inRef = false; // after a labelled section starts, following paragraphs belong to it until a short plain one
  const parts = paragraphs.map((p) => {
    const lines = p.text.split('\n');
    const markdown = /^\s{0,3}(#{1,6}\s|\|.*\||>\s)/m.test(p.text);
    const labelled = REF_LABEL.test(lines[0]);
    if (labelled) inRef = true;
    const long = lines.length >= 6 || p.text.length > 700;
    const ref = p.fenced || markdown || labelled || long || (inRef && lines.length > 1);
    if (!ref) inRef = false;
    return { ...p, ref };
  });
  const instruction = parts.filter((p) => !p.ref).map((p) => p.text).join('\n\n').trim();
  const reference = parts.filter((p) => p.ref).map((p) => p.text).join('\n\n');
  return instruction ? { instruction, reference } : { instruction: text, reference: '' };
}

/** Whether a text carries enough intent to be routed on its own (otherwise the whole prompt is used). */
const hasIntent = (t: string) => count(LEX.normal, t) + count(LEX.hard, t) + count(LEX.fast, t) + count(LEX.sensitive, t) + count(LEX.scope, t) > 0;

export function route(input: RouteInput, cfg: RouterConfig, catalog: ModelInfo[] = loadCatalog()): Route {
  // Long prompts often paste a ticket or API docs next to a short request: judge the REQUEST; the pasted material is
  // context for the model, not evidence of complexity or risk. Vague requests ("do this ticket") use everything.
  const split = splitPrompt(input.task);
  const focused = Boolean(split.reference) && hasIntent(split.instruction);
  const task = focused ? split.instruction : input.task;
  const full = `${input.task}\n${input.context ?? ''}`.slice(0, 20000); // safety checks always see everything
  const text = `${task}\n${input.context ?? ''}`.slice(0, 20000);
  const h = {
    // "security review/audit" names an activity, not a sensitive domain: risk comes from what the code is (auth, payments…)
    sensitive: count(LEX.sensitive, text.replace(/\b(security|keamanan)\s+(review|audit|check|scan|pass)\w*/gi, 'review')), hard: count(LEX.hard, text), normal: count(LEX.normal, text),
    fast: count(LEX.fast, text), scope: count(LEX.scope, text),
  };
  const o = cfg.optimization;
  const git = gitIntent(task);
  // git ops need no file hints (and message words would only pull in unrelated files)
  const found = o.minimal_context && git !== 'simple'
    ? discover(task, path.resolve(input.repository ?? process.cwd()), { maxFiles: o.max_context_files, maxScanned: o.max_scanned_files, maxDepth: o.max_analysis_depth, maxReadBytes: o.max_file_read_bytes })
    : { files: [], confident: false, components: 0 };
  const files = found.files;
  const injection = INJECTION.test(full);
  const words = task.trim().split(/\s+/).length;
  const reasons: string[] = [];
  if (focused) reasons.push(`routed on the request; ${split.reference.length} chars of pasted reference used as context only`);

  // --- intent: judge the operation and the affected code, not just the domain words ---
  const logic = LEX.logic.test(task);
  const trivialOp = h.fast > 0 && !logic && h.hard === 0 && h.scope === 0 && !LEX.feature.test(task);
  let sensitive = h.sensitive > 0;
  if (sensitive && trivialOp && LEX.safeObject.test(task) && !logic) {
    sensitive = false;
    reasons.push('sensitive domain mentioned, but change is cosmetic/documentation only');
  } else if (sensitive && LEX.readOnly.test(task) && !LEX.modify.test(task)) {
    sensitive = false;
    h.normal = Math.max(h.normal, 1);
    reasons.push('read-only question about a sensitive domain');
  }

  if (git === 'simple') { sensitive = false; reasons.push('git operation; commit message is metadata'); }
  else if (git === 'dangerous') { sensitive = true; reasons.push('destructive/history-rewriting git operation'); }

  // an explicitly narrow request ("only this page") lowers complexity unless it names hard work
  const narrow = LEX.narrow.test(task) && h.hard === 0 && h.scope === 0;
  if (narrow) reasons.push('narrow scope requested');
  // base complexity excludes sensitivity; dependency spread adds to it
  const spread = found.confident && found.components >= 3 ? 1 : 0;
  const base = Math.max(0, Math.min(10, 2 + Math.min(h.normal, 3) + 3 * Math.min(h.hard, 2) + 2 * Math.min(h.scope, 1)
    - Math.min(h.fast, 2) + (files.length > 5 && found.confident ? 1 : 0) + spread + (words > 60 ? 1 : 0)
    - (narrow ? 1 : 0)));
  const score = Math.min(10, base + (sensitive ? 4 : 0));

  let tier: Tier;
  if (sensitive) { tier = 'critical'; reasons.push('modifies security/payment/data-integrity logic (or intent unclear)'); }
  else if ((base >= 7 && h.hard + h.scope + spread > 0) || (h.hard > 0 && base >= 5)) { tier = 'hard'; reasons.push('multi-factor complexity'); }
  else if (git === 'conflict') { tier = 'hard'; reasons.push('git conflict resolution'); }
  else if (git === 'simple' || trivialOp) { tier = 'fast'; reasons.push('trivial edit'); }
  else if (base >= 3 && h.normal + h.hard + h.scope > 0) { tier = 'normal'; reasons.push('standard implementation work'); }
  else { tier = cfg.routing.default_tier; reasons.push('ambiguous; conservative default'); }
  if (spread && tier !== 'critical') reasons.push(`touches ${found.components} components`);

  const hits = h.sensitive + h.hard + h.normal + h.fast;
  let confidence = hits === 0 ? 0.4 : Math.min(0.95, 0.6 + 0.1 * Math.min(hits, 3));
  if (h.fast > 0 && h.hard > 0) confidence -= 0.15;
  if (found.confident) confidence += 0.05;
  if (git) confidence = Math.max(confidence, 0.85);
  if (injection) {
    confidence = Math.min(confidence, 0.4);
    if (TIERS.indexOf(tier) < TIERS.indexOf('normal')) tier = 'normal';
    reasons.push('routing-override language in task ignored (treated as data)');
  }
  // low confidence never lands on the cheapest tier
  if (confidence < 0.5 && tier === 'fast') tier = 'normal';

  const prefs = input.preferences ?? {};
  if (prefs.tier && TIERS.includes(prefs.tier)) { tier = prefs.tier; reasons.push(`tier override: ${tier}`); }

  // model follows the tier; reasoning is adjusted independently: a trivial operation inside
  // security-sensitive code keeps the strong model but needs less thinking.
  const risk = tier === 'critical' ? 'high' : tier === 'hard' || sensitive ? 'medium' : 'low';
  const simpleCritical = tier === 'critical' && !prefs.tier && git !== 'dangerous' && trivialOp && !logic && h.hard === 0;
  const wantModel = prefs.model ?? cfg.models[tier];
  const wantEffort = prefs.reasoning ?? (simpleCritical ? cfg.reasoning.critical_simple : cfg.reasoning[tier]);
  const resolved = resolveModel(catalog, wantModel, wantEffort, Boolean(prefs.model || prefs.reasoning));
  if (resolved.note) reasons.push(resolved.note);
  if (prefs.reasoning === 'low' && (tier === 'critical' || tier === 'hard')) {
    reasons.push('warning: low reasoning explicitly requested for a high-risk task');
  }

  const parallel = /\b(in parallel|independent(ly)? (modules|services|tasks))\b/i.test(text) && (tier === 'hard' || tier === 'critical');
  const requireReview = tier === 'critical' && score >= 8;
  return {
    tier, complexity_score: score, base_complexity: base, reference_chars: focused ? split.reference.length : 0, confidence: Math.round(confidence * 100) / 100, risk,
    model: resolved.model, reasoning_effort: resolved.effort,
    agent_strategy: parallel && cfg.routing.default_agents > 1 ? 'parallel' : requireReview ? 'single_then_review' : 'single',
    relevant_files: files, require_review: requireReview,
    escalation_allowed: cfg.escalation.enabled && !DESTRUCTIVE.test(full),
    reason: reasons.join('; '),
  };
}

export function explain(r: Route): string {
  return [
    `Tier ${r.tier} (score ${r.complexity_score}/10, confidence ${r.confidence}, risk ${r.risk})`,
    `Model ${r.model} @ ${r.reasoning_effort}; agents: ${r.agent_strategy}; review: ${r.require_review}`,
    `Escalation ${r.escalation_allowed ? 'allowed' : 'disabled'}; files: ${r.relevant_files.length ? r.relevant_files.join(', ') : 'none (Codex discovers)'}`,
    `Why: ${r.reason}`,
  ].join('\n');
}
