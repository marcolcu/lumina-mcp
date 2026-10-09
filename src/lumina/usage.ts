import type { AppClient } from './tui/chat.js';

interface Window { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
interface Snapshot { primary: Window | null; secondary: Window | null; credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null; planType: string | null; rateLimitReachedType: string | null; spendControlReached: boolean | null }
export interface RateLimits { ordinaryUsageAllowed: boolean | null; rateLimits: Snapshot; rateLimitResetCredits: { availableCount: number } | null }
export interface AccountUsage { summary: { lifetimeTokens: number; peakDailyTokens: number; currentStreakDays: number }; dailyUsageBuckets: { startDate: string; tokens: number }[] }
export interface SessionUsage { total: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number }; modelContextWindow: number | null; last?: { totalTokens: number } }
export interface UsageData { limits?: RateLimits; account?: AccountUsage; errors: string[] }

/** Reads Codex's own usage numbers (ChatGPT account limits + token totals). Read-only; each call may fail independently. */
export async function fetchUsage(client: Pick<AppClient, 'request'>): Promise<UsageData> {
  const out: UsageData = { errors: [] };
  await Promise.all([
    client.request<RateLimits>('account/rateLimits/read', {}).then((r) => { out.limits = r; }, (e: unknown) => { out.errors.push(`limits: ${msg(e)}`); }),
    client.request<AccountUsage>('account/usage/read', {}).then((r) => { out.account = r; }, (e: unknown) => { out.errors.push(`tokens: ${msg(e)}`); }),
  ]);
  return out;
}
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 120);

const compact = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const bar = (pct: number) => { const n = Math.max(0, Math.min(10, Math.round(pct / 10))); return `${'█'.repeat(n)}${'░'.repeat(10 - n)}`; };
const label = (mins: number | null): string => (!mins ? 'Limit' : mins % 10080 === 0 ? (mins === 10080 ? 'Weekly' : `${mins / 10080}w`) : mins >= 1440 ? `${Math.round(mins / 1440)}d` : `${Math.round(mins / 60)}h window`);
function until(resetsAt: number | null, now: number): string {
  if (!resetsAt) return '';
  const mins = Math.max(0, Math.round((resetsAt * 1000 - now) / 60000));
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  const rel = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  return `resets in ${rel} (${new Date(resetsAt * 1000).toLocaleString('en-GB', { weekday: d ? 'short' : undefined, hour: '2-digit', minute: '2-digit' })})`;
}

/** Plain-text report. `session` is the running conversation's token usage as last reported by the App Server. */
export function formatUsage(data: UsageData, session?: SessionUsage, now = Date.now()): string {
  const lines: string[] = [];
  const l = data.limits;
  if (l) {
    const s = l.rateLimits;
    lines.push(`Codex usage${s.planType ? ` · ${s.planType} plan` : ''}`);
    for (const w of [s.primary, s.secondary]) {
      if (w) lines.push(`  ${label(w.windowDurationMins).padEnd(10)} ${bar(w.usedPercent)} ${String(Math.round(w.usedPercent)).padStart(3)}% used  ${until(w.resetsAt, now)}`.trimEnd());
    }
    if (s.credits?.unlimited) lines.push('  Credits    unlimited');
    else if (s.credits?.hasCredits) lines.push(`  Credits    ${s.credits.balance ?? 'available'}`);
    if (l.rateLimitResetCredits?.availableCount) lines.push(`  Rate-limit resets available: ${l.rateLimitResetCredits.availableCount}`);
    if (l.ordinaryUsageAllowed === false || s.rateLimitReachedType || s.spendControlReached) lines.push(`  ! limit reached${s.rateLimitReachedType ? ` (${s.rateLimitReachedType})` : ''}`);
  }
  const a = data.account;
  if (a) {
    const cutoff = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
    const week = a.dailyUsageBuckets.filter((b) => b.startDate > cutoff).reduce((n, b) => n + b.tokens, 0);
    lines.push(`Account tokens: last 7 days ${compact(week)} · peak day ${compact(a.summary.peakDailyTokens)} · lifetime ${compact(a.summary.lifetimeTokens)} · streak ${a.summary.currentStreakDays}d`);
  }
  if (session) {
    const t = session.total;
    const ctx = session.modelContextWindow && session.last ? ` · context ${Math.round((session.last.totalTokens / session.modelContextWindow) * 100)}% of ${compact(session.modelContextWindow)}` : '';
    lines.push(`This session: ${t.totalTokens.toLocaleString('en-US')} tokens (input ${compact(t.inputTokens)}, cached ${compact(t.cachedInputTokens)}, output ${compact(t.outputTokens)})${ctx}`);
  } else lines.push('This session: no token usage reported yet');
  for (const e of data.errors) lines.push(`  unavailable - ${e}`);
  return lines.join('\n');
}
