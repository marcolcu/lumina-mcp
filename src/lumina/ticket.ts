import { splitPrompt } from '../smart-codex/router.js';

export type TicketIntent = 'understand' | 'implement' | 'clarify' | 'confirm';
export type TicketMode = 'understanding' | 'ready' | 'implementing' | 'done';
export interface TicketRef { id: string; source: 'openproject' | 'jira' | 'pasted'; workPackage?: string }

const UNDERSTAND = /\b(jelaskan|jelasin|pahami|paham|mengerti|apa yang (kamu|anda) (pahami|tangkap)|cek dulu|coba cek|cek tiket\w*|review (requirement|requirements|tiket\w*|ticket)\w*|explain|summari[sz]e|what do you understand|do you understand|walk me through|analy[sz]e (the |this )?(ticket|requirement|issue)|analisa|analisis|ringkas\w*|baca (dulu )?tiket\w*)\b/i;
const IMPLEMENT = /\b(kerjakan|kerjain|implement\w*|implementasi\w*|fix|perbaiki|apply|terapkan|buatkan|selesaikan|lanjut(kan)? (implementasi|ngoding|kerjakan)|proceed|go ahead|eksekusi|execute|do it|jalankan)\b/i;
const CONFIRM = /^\s*(oke|ok|okay|okey|sip|siap|yes|ya|yup|betul|benar|sudah benar|udah benar|correct|right|lgtm|setuju|mantap|good|great|baik)\b/i;

/** Ticket reference in a message: OP-559 / OpenProject #559 / work package 559 / Jira-style KEY-123. */
export function findTicket(text: string): TicketRef | undefined {
  let m = /\bOP-(\d+)\b/i.exec(text) ?? /\b(?:openproject|work ?package|wp)\s*#?\s*(\d+)\b/i.exec(text);
  if (m) return { id: `OP-${m[1]}`, source: 'openproject', workPackage: m[1] };
  // KEY-123 only counts as a ticket when the text talks about one (avoids UTF-8, SHA-256, ES-2022…)
  m = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/.exec(text);
  if (m && /\b(tiket|ticket|issue|jira|story|task|card)\b/i.test(text)) return { id: m[1], source: 'jira' };
  return undefined;
}

/**
 * Deterministic intent of a message, given whether a ticket discussion is already active. Only the user's own request
 * is read (pasted ticket text is ignored). Understanding never implies implementation.
 */
export function classifyIntent(text: string, active: boolean): TicketIntent | undefined {
  const req = splitPrompt(text).instruction;
  const implement = IMPLEMENT.test(req);
  const understand = UNDERSTAND.test(req);
  if (active && CONFIRM.test(req) && implement) return 'confirm';
  if (understand && !(implement && /\b(lalu|then|and then|setelah itu|kemudian)\b/i.test(req))) return active && !findTicket(req) ? 'clarify' : 'understand';
  if (implement) return active ? 'confirm' : 'implement';
  if (active) return 'clarify'; // anything else during a ticket discussion stays read-only
  return undefined;
}

export interface TicketTurn {
  intent: TicketIntent;
  /** Prompt actually sent to Codex. */
  prompt: string;
  /** Text the router should judge (never the pasted ticket body for understanding). */
  routeText: string;
  /** Run this turn in a read-only sandbox (understanding / clarification). */
  readOnly: boolean;
}

const READ_ONLY_RULES = 'Do not modify any files, run migrations, commit, or perform destructive operations in this turn.';

/**
 * Conversation state for one ticket: what it is, the user's clarifications, and where we are. Builds compact prompts:
 * the ticket body lives in the thread history (fetched once); clarifications are restated explicitly at implementation.
 */
export class TicketSession {
  ticket?: TicketRef;
  mode?: TicketMode;
  clarifications: string[] = [];
  fetched = false;
  summary = '';

  get active(): boolean { return Boolean(this.ticket) && (this.mode === 'understanding' || this.mode === 'ready'); }

  reset(): void { this.ticket = undefined; this.mode = undefined; this.clarifications = []; this.fetched = false; this.summary = ''; }

  private source(): string {
    const t = this.ticket!;
    if (t.source === 'openproject') {
      return this.fetched
        ? `Use the details of OpenProject work package ${t.workPackage} already in this conversation; do not fetch it again unless I ask for fresh data.`
        : `Fetch OpenProject work package ${t.workPackage} once with the lumina-mcp tool get_openproject_work_package.`;
    }
    if (t.source === 'jira') return this.fetched ? `Use the details of ${t.id} already in this conversation.` : `Fetch ${t.id} once with the lumina-mcp tool get_jira_ticket.`;
    return 'The ticket text is the one I pasted.';
  }

  private confirmed(): string {
    return this.clarifications.length ? `Clarifications I gave (they override the original ticket):\n${this.clarifications.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : 'No clarifications: the ticket as written is confirmed.';
  }

  /** Returns how to run this message, or undefined when it is not part of a ticket workflow. */
  prepare(text: string): TicketTurn | undefined {
    const req = splitPrompt(text).instruction;
    const mentioned = findTicket(req);
    const pasted = Boolean(splitPrompt(text).reference);
    const intent = classifyIntent(text, this.active && !(mentioned && mentioned.id !== this.ticket?.id));
    if (!intent) return undefined;

    if (intent === 'understand') {
      this.reset();
      this.ticket = mentioned ?? (pasted ? { id: 'pasted ticket', source: 'pasted' } : undefined);
      if (!this.ticket) return undefined; // "explain X" without a ticket: ordinary question
      this.mode = 'understanding';
      return {
        intent, readOnly: true, routeText: req,
        prompt: `${text}\n\n[Lumina: understanding mode for ${this.ticket.id}. ${this.source()} ${READ_ONLY_RULES} Reply concisely with: 1) what the ticket asks, 2) expected behaviour, 3) relevant components/files, 4) implementation considerations, 5) missing or ambiguous requirements. Mark what is stated in the ticket vs your assumptions; do not invent requirements.]`,
      };
    }
    if (intent === 'clarify') {
      this.clarifications.push(req.trim().slice(0, 600));
      this.mode = 'ready';
      return {
        intent, readOnly: true, routeText: req,
        prompt: `${text}\n\n[Lumina: clarification for ${this.ticket!.id} — update your understanding with this, briefly restate the changed requirement(s) and any remaining open questions. ${this.source()} ${READ_ONLY_RULES} Do not start implementing.]`,
      };
    }
    // implement / confirm
    const fromDiscussion = intent === 'confirm' && this.ticket;
    if (!fromDiscussion) {
      // direct implementation request: no confirmation step forced
      this.reset();
      this.ticket = mentioned ?? (pasted ? { id: 'pasted ticket', source: 'pasted' } : undefined);
      if (!this.ticket) return undefined;
      this.mode = 'implementing';
      return { intent: 'implement', readOnly: false, routeText: text, prompt: text };
    }
    this.mode = 'implementing';
    return {
      intent, readOnly: false,
      // re-route on what will actually be built: the understanding summary + the user's corrections
      routeText: `${req}\n${this.clarifications.join('\n')}\n${this.summary}`,
      prompt: `${text}\n\n[Lumina: implement ${this.ticket!.id} now using the confirmed requirements. ${this.source()} ${this.confirmed()}]`,
    };
  }

  /** After a turn: remember the explanation (compact) and whether the ticket was fetched. */
  afterTurn(answer: string, tools: string[], ok: boolean): void {
    if (!this.ticket) return;
    if (tools.some((t) => /^get_(openproject_work_package|jira_ticket)$/.test(t))) this.fetched = true;
    if (this.mode === 'understanding' || this.mode === 'ready') { if (answer.trim()) this.summary = answer.replace(/\s+/g, ' ').trim().slice(0, 1500); }
    else if (this.mode === 'implementing' && ok) this.mode = 'done';
  }
}
