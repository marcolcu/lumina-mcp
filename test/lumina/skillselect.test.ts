import { describe, expect, it } from 'vitest';
import { explainDecision, selectSkills } from '../../src/lumina/skillselect.js';
import type { SkillInfo } from '../../src/lumina/tui/skills.js';

const sk = (name: string, description: string, scope = 'user', extra: Partial<SkillInfo> = {}): SkillInfo => ({ name, description, scope, path: `/skills/${name}/SKILL.md`, ...extra });
const SKILLS: SkillInfo[] = [
  sk('security-review', 'Review code changes for security vulnerabilities: authentication, authorization, injection, secrets.'),
  sk('caveman-review', 'Ultra-compressed code review comments. Use when reviewing PRs or asking for a terse review.'),
  sk('caveman-commit', 'Write terse conventional commit messages. Use when the user asks for a commit message.'),
  sk('caveman', 'Ultra-compressed communication mode that cuts token usage.'),
  sk('migration', 'Plan and write safe database migrations with rollback steps.'),
  sk('safe-refactor', 'Refactor code in small verified steps without changing behavior.'),
  sk('frontend-design', 'Design polished frontend UI components and pages with good visual hierarchy.'),
  sk('skill-creator', 'Create or update skills.', 'system'),
  sk('deploy', 'Deploy the app to production.', 'repo', { tools: [{ type: 'env_var', value: 'LUMINA_TEST_DEPLOY_TOKEN_UNSET' }] }),
];
const pick = (text: string, max = 2) => selectSkills(text, SKILLS, { auto: true, maxAuto: max });
const names = (text: string, max = 2) => pick(text, max).selected.map((p) => p.skill.name);

describe('automatic skill selection', () => {
  it('single skill: matches the request intent', () => {
    expect(names('Review authentication security.')).toEqual(['security-review']);
    expect(names('Write a database migration to add an index on orders')).toEqual(['migration']);
  });
  it('Indonesian requests', () => {
    expect(names('tolong tinjau keamanan autentikasi di modul login')).toEqual(['security-review']);
    expect(names('buat migrasi basis data untuk tabel order')).toEqual(['migration']);
  });
  it('no relevant skill: ordinary coding requests attach nothing', () => {
    for (const t of ['Fix the order list API endpoint.', 'add a button to the settings page', 'perbaiki bug di halaman checkout', 'explain how routing works']) expect(pick(t).mode).toBe('none');
  });
  it('multiple skills only when each is clearly required', () => {
    expect(names('Do a security review of the auth flow and write the database migration for the new sessions table').sort()).toEqual(['migration', 'security-review']);
    expect(names('Do a security review of the auth flow and write the database migration for the new sessions table', 1)).toHaveLength(1);
    expect(pick('Do a security review of the auth flow and write the database migration for the new sessions table', 1).dropped[0].reason).toMatch(/limit of 1/);
  });
  it('conflicting skills of the same family are not combined: the better match is kept and the other explained', () => {
    const skills = [...SKILLS, sk('review', 'Review code changes for bugs, style and missing tests.')];
    const d = selectSkills('security review of the auth changes', skills, { auto: true, maxAuto: 2 });
    expect(d.selected.map((p) => p.skill.name)).toEqual(['security-review']);
    expect(d.dropped).toEqual([{ skill: expect.objectContaining({ name: 'review' }), reason: expect.stringMatching(/conflicts with security-review/) }]);
    expect(explainDecision(d)).toMatch(/Not used: review — conflicts with security-review/);
  });
  it('explicit $skill takes precedence and disables automatic selection', () => {
    const d = pick('$caveman-commit for my security review changes');
    expect([d.mode, d.explicit.map((s) => s.name), d.selected]).toEqual(['explicit', ['caveman-commit'], []]);
    expect(explainDecision(d)).toMatch(/invoked it explicitly/);
  });
  it('unavailable skills (required environment not set) are never activated, and /why says so', () => {
    const d = pick('deploy the app to production');
    expect(d.selected).toEqual([]);
    expect(d.dropped[0]).toEqual({ skill: expect.objectContaining({ name: 'deploy' }), reason: 'needs LUMINA_TEST_DEPLOY_TOKEN_UNSET (not set)' });
    process.env.LUMINA_TEST_DEPLOY_TOKEN_UNSET = 'x';
    expect(names('deploy the app to production')).toEqual(['deploy']);
    delete process.env.LUMINA_TEST_DEPLOY_TOKEN_UNSET;
  });
  it('pasted documentation that names skills does not activate them; the instruction still can', () => {
    const doc = `## Team process\n\n${'Our team uses security-review, migration and caveman-commit skills for every PR. '.repeat(12)}\n\n## Notes\nThe migration skill and the security review process are described above.`;
    expect(pick(`Implement the CSV export described below.\n\n${doc}`).mode).toBe('none');
    const d = pick(`Review authentication security in this module.\n\n${doc}`);
    expect(d.selected.map((p) => p.skill.name)).toEqual(['security-review']);
    expect(explainDecision(d)).toMatch(/pasted reference material is not used/);
    expect(pick(doc).mode).toBe('none');
  });
  it('one weak shared word is not enough (no unnecessary activation)', () => {
    expect(pick('review my changes').mode).toBe('none'); // only "review": too vague to pick between review skills
    expect(pick('refactor this function').mode).toBe('none');
  });
  it('project skills win ties over global ones (Codex precedence)', () => {
    const both = [sk('security-review', 'Review code for security issues.', 'user'), { ...sk('security-review', 'Review code for security issues.', 'repo'), path: '/repo/.agents/skills/security-review/SKILL.md' }];
    expect(selectSkills('security review of auth', both, { auto: true, maxAuto: 2 }).selected[0].skill.path).toBe('/repo/.agents/skills/security-review/SKILL.md');
  });
  it('disabled by config; /why explains each case', () => {
    expect(selectSkills('Review authentication security', SKILLS, { auto: false, maxAuto: 2 }).mode).toBe('none');
    expect(explainDecision(undefined)).toMatch(/No request/);
    expect(explainDecision(pick('Review authentication security.'))).toMatch(/^Skill: security-review \[global\]\nWhy: its name matches "security", "review"; its description also covers "authentication"\nAbout: Review code changes[\s\S]*Request: "Review authentication security\."$/);
    expect(explainDecision(pick('fix the bug'))).toMatch(/No skill was selected/);
  });
  it('skill selection never reads SKILL.md (lazy loading is Codex\'s job): only metadata is used', () => {
    const d = pick('Review authentication security.');
    expect(d.selected[0].skill).toEqual(SKILLS[0]); // same metadata object; the path is handed to Codex untouched
  });
});
