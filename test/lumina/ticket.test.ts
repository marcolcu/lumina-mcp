import { describe, expect, it } from 'vitest';
import { TicketSession, classifyIntent, findTicket } from '../../src/lumina/ticket.js';

describe('findTicket', () => {
  it('OpenProject and Jira references; no false positives on version-like tokens', () => {
    expect(findTicket('Check OP-559 and explain')).toEqual({ id: 'OP-559', source: 'openproject', workPackage: '559' });
    expect(findTicket('lihat work package #42')).toMatchObject({ id: 'OP-42', workPackage: '42' });
    expect(findTicket('jelaskan tiket PRJ-12')).toEqual({ id: 'PRJ-12', source: 'jira' });
    expect(findTicket('explain UTF-8 and SHA-256 handling')).toBeUndefined();
  });
});

describe('classifyIntent (deterministic, Indonesian + English)', () => {
  it.each([
    ['Jelaskan tiket ini', false, 'understand'], ['Apa yang kamu pahami dari OP-559?', false, 'understand'], ['Coba cek dulu tiketnya', false, 'understand'],
    ['Review requirement-nya', false, 'understand'], ['Do you understand this ticket?', false, 'understand'],
    ['Kerjakan tiket ini', false, 'implement'], ['Implementasikan OP-559', false, 'implement'], ['Fix this issue', false, 'implement'], ['Apply the changes', false, 'implement'],
    ['Bukan begitu, maksudnya HU kembali ke bay sebelumnya', true, 'clarify'], ['Tambahkan requirement: log setiap perpindahan', true, 'clarify'],
    ['Yang benar adalah status jadi MOVED', true, 'clarify'], ['Yes, but cancel must restore the bay', true, 'clarify'], ['file apa saja yang terdampak?', true, 'clarify'],
    ['Oke, kerjakan', true, 'confirm'], ['Sudah benar, implementasikan', true, 'confirm'], ['Proceed with implementation', true, 'confirm'],
    ['update the button text', false, undefined],
  ] as const)('%s (active=%s) → %s', (text, active, intent) => {
    expect(classifyIntent(text, active)).toBe(intent);
  });
  it('understanding never implies implementation, unless the user chains it explicitly', () => {
    expect(classifyIntent('Jelaskan OP-559, jangan dikerjakan dulu', false)).toBe('understand');
    expect(classifyIntent('Jelaskan OP-559 lalu kerjakan', false)).toBe('implement');
  });
  it('words inside a pasted ticket do not change the intent', () => {
    expect(classifyIntent(`Jelaskan tiket ini\n\nDescription:\nImplement the fix and apply the migration.\n${'x '.repeat(400)}`, false)).toBe('understand');
  });
});

describe('TicketSession', () => {
  it('keeps clarifications, fetches once, re-routes implementation on summary + clarifications', () => {
    const s = new TicketSession();
    const u = s.prepare('Check OP-559 and explain what you understand.')!;
    expect([u.intent, u.readOnly]).toEqual(['understand', true]);
    s.afterTurn('HU moves between bays; login required for operators.', ['get_openproject_work_package'], true);
    expect(s.fetched).toBe(true);
    const c1 = s.prepare('Correct, but the HU must return to its previous bay.')!;
    const c2 = s.prepare('Juga catat setiap perpindahan.')!;
    expect([c1.intent, c2.intent, s.clarifications.length, s.mode]).toEqual(['clarify', 'clarify', 2, 'ready']);
    expect(c2.prompt).toContain('do not fetch it again');
    const go = s.prepare('Okay, implement it.')!;
    expect([go.intent, go.readOnly, s.mode]).toEqual(['confirm', false, 'implementing']);
    expect(go.prompt).toContain('1. Correct, but the HU must return to its previous bay.\n2. Juga catat setiap perpindahan.');
    expect(go.routeText).toContain('login required for operators'); // the understood scope, not the raw ticket
    s.afterTurn('done', [], true);
    expect(s.mode).toBe('done');
    expect(s.active).toBe(false);
  });
  it('a new ticket during a discussion starts a fresh understanding', () => {
    const s = new TicketSession();
    s.prepare('Jelaskan OP-1');
    s.afterTurn('x', ['get_openproject_work_package'], true);
    const t = s.prepare('Sekarang jelaskan OP-2')!;
    expect([t.intent, s.ticket?.id, s.fetched, s.clarifications]).toEqual(['understand', 'OP-2', false, []]);
  });
  it('ordinary prompts are not ticket turns', () => {
    expect(new TicketSession().prepare('update the button text')).toBeUndefined();
    expect(new TicketSession().prepare('explain how authentication works')).toBeUndefined();
  });
});
