# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.4.0] — 2026-07-30

### Added
- **Compound Engineering & Strict Security Code Review**: Refactored `AI_CODE_REVIEWER_PROMPT` in `src/tools/gitsystem/prompts/index.ts` to evaluate PRs across 5 Compound Engineering lenses (System Design, Scalability, Component Reusability, Resilience, Security) alongside strict OWASP Top 10 security checks, SQL/Command Injection defense, secret exposure scanning, Auth/ACL boundary checks, strict type safety (no `any`), and zero swallowed exceptions.
- **Multi-File Context Pre-Gathering**: Refactored `CODE_REVIEW_PROMPT` in `src/tools/orchestration/prompts/index.ts` to mandate pre-gathering multi-file structural context, symbol definitions, and related interfaces before running code review.
- **Unit Testing & Documentation**: Added unit test coverage for prompt content in `test/gitsystem/index.test.ts` and `test/orchestration/service/orchestration.service.test.ts`, and added architectural pattern documentation in `docs/solutions/architecture-patterns/compound-engineering-code-review-integration.md`.

---

## [1.3.2] — 2026-07-03


### Added
- **Gitea Integration**: Added full version control support for Gitea, including tools to create PRs (`create_gitea_pr`), fetch diffs (`get_gitea_pr_diff`), review code (`review_gitea_pr`), and fix PR reviews (`fix_gitea_pr_review`).
- **Integration Tests**: Implemented comprehensive, production-grade integration tests using Vitest and Testcontainers for PostgreSQL and MySQL controllers to ensure reliable DB connections.

### Fixed
- **Security & CI/CD**: Resolved DOM-based XSS vulnerabilities in the website (`DocsLayout.tsx`) and updated GitHub Actions workflows to enforce least-privilege permissions.

## [1.3.1] — 2026-06-28

### Added
- **E2E Testing Prompt**: Added the `create-e2e-test` prompt to generate comprehensive, production-grade end-to-end (E2E) tests covering happy path user journeys, negative flows, edge cases, UI stability, and accessibility checks (ARIA, keyboard navigation, contrast).
- **Unit Tests for Testing Controller**: Added a Vitest test suite under `test/testing/controller/testing.controller.test.ts` to verify the registration and behavior of the unit test and E2E test prompts.

---

## [1.3.0] — 2026-06-27

### Added
- **Testing Module**: Added `testing` module with a highly robust `create-unit-test` prompt. 
- **Big Tech QA Standards**: The `create-unit-test` prompt instructs the LLM to act as a Senior SDET / QA Automation Engineer, mandating >80% test coverage and encompassing Happy Path, Negative Path, Edge Cases & Boundaries, Security & Validation, Concurrency & Asynchrony, and State & Lifecycle.
- **Cross-Domain Intelligence**: Explicit instructions for the AI to infer the execution domain (Frontend, Backend, or Mobile) and use appropriate domain-specific mocking strategies (e.g., DOM interactions for React, DB connections for Node.js/Go, and native modules for iOS/Android).

---

## [1.2.0] — 2026-06-24

### Added
- **Direct Ticket Creation**: Empower AI agents to create tickets directly in your project management system. Added `create_jira_ticket`, `create_trello_card`, `create_openproject_work_package`, and `create_github_issue` tools.
- **Senior PM Ticket Generation**: Added `pm_create_ticket` prompt. The AI acts as a Senior PM, digesting raw feature requests or bug reports and structuring them into Big Tech-standard tickets before creating them on your board.
- **GitHub Issue Context Retrieval**: Enhanced `get_github_issue` tool to automatically fetch issue comments, labels, milestones, and linked pull requests via timeline events using parallel API calls.
- **Advanced QA Test Catalog**: Upgraded the `pm_test_catalog` prompt to act as a "Strict Senior QA Engineer". It now mandates 8 rigorous testing categories (Security, Accessibility, Performance, etc.) with dual-format outputs (Markdown + structured `.txt`).

---

## [1.1.3] — 2026-06-21

### Changed
- **Documentation**: Removed the static npm version badge from `README.md` to avoid confusion when new versions are released.

---

## [1.1.2] — 2026-06-21

### Added
- **npm SEO Optimization**: Added comprehensive package metadata (`keywords`, `author`, `repository`, `homepage`, `license`, `bugs`) to `package.json` to significantly improve discoverability and ranking on the npm registry.

---

## [1.1.1] — 2026-06-21

### Changed
- **Documentation**: Updated `README.md` to point to the new official GitHub Pages documentation website instead of the legacy Vercel domain.

---

## [1.1.0] — 2026-06-21

### Added
- **Automated Publishing Workflow**: Added `.github/workflows/publish-package.yml` to automatically publish the package to npm and GitHub Packages when a new GitHub Release is created.
- **Brand Assets**: Integrated new Lumina MCP brand assets and logos into the website.

### Changed
- **CI/CD Deployments**: Updated GitHub Pages deployment workflow (`deploy-docs.yml`) to Node 22 and configured Vite `base` path for correct asset loading on GitHub Pages.
- **Documentation & Styling**: Removed emojis from `README.md` headings, simplified footer and license texts, and updated badges (including a dynamic tests passing badge).
- **Contributing Guide**: Updated `CONTRIBUTING.md` to establish project vision, simplify expectations, and clarify Node 22 prerequisites.
- **Orchestration**: Fixed orchestration localization issues.

---

## [1.0.6] — 2026-06-21

### Added
- **Version Control Extended Tools**: Added three new GitHub tools to complete the PR discussion lifecycle:
  - `get_github_pr_diff` — Download a clean unified diff of any open GitHub PR for automated review or analysis.
  - `reply_to_pr_comment` — Reply to an inline comment within a GitHub Pull Request review thread.
  - `resolve_pr_review_thread` — Resolve a GitHub PR review thread by its GraphQL node ID, closing the discussion.
- **Multilingual Website (ID/EN)**: The documentation website now supports Bahasa Indonesia and English with a language switcher in the navbar, fully responsive on desktop and mobile.
- **Version Dropdown in Docs Navbar**: Added a version selector in the docs navigation bar showing the current Lumina MCP package version with a **Latest** badge.
- **On-This-Page Navigation Fix**: Fixed section anchor links in docs pages — clicking an item in the "On this page" sidebar now correctly scrolls to the corresponding section.
- **Orchestration Development Cycle Diagram**: Replaced the "6-Phase Development Cycle" label with "Orchestration Development Cycle" and updated the engineering workflow diagram on the landing page.
- **CONTRIBUTING.md**: Added a comprehensive contributing guide following international open source standards, covering setup, coding standards, PR guidelines, bug reporting, commit message conventions, and scope definitions.

### Changed
- **Project Management naming**: Renamed "Project Management Ingestion" to "Project Management Integration" across the website, documentation, and README for clarity.
- **README.md**: Completely restructured to focus on tools, prompts, and usage examples. Removed local development steps (moved to `CONTRIBUTING.md`). Added all 7 GitHub tools, all PM tools, and full orchestration phase table.
- **Documents folder updated**: All files in `documents/` updated to reflect the current tool surface — `github-prompts.md` now documents all 7 tools, `orchestration-prompts.md` has clearer phase descriptions and PM integration examples, `projectmanagement-prompts.md` now documents env variable auto-detection and Orchestration integration.
- **Footer text**: Simplified footer from "© 2026 Wahyu-Labs Lumina MCP" to "© 2026 Lumina MCP".
- **Indonesian translation quality**: Improved tone and phrasing of Bahasa Indonesia copy across hero, database, git, project management, and orchestration sections to be more professional and natural.

---

## [1.0.5] — 2026-06-19

### Added
- **Native Fallback Prompts**: Added Big Tech-style professional fallback instructions for Orchestration (`fallback-brainstorm.md`, `fallback-work.md`, `fallback-review.md`, `fallback-compound.md`) when Compound Engineering tools are unavailable.
- **Cross-Client Detection**: Expanded the detection logic to identify MCP installations not only in Antigravity (`~/.gemini`), but also across Cursor, Claude Desktop, VS Code (via Cline/Roo Code), and Claude Code CLI.
- **Automated Fallback Bundling**: Updated `esbuild` configuration to ensure fallback markdown files are automatically packaged and distributed with the npm build.

---

## [1.0.4] — 2026-06-16

### Added
- **Unified Orchestration & Compound Engineering UI**: Restructured the documentation website and merged the landing page orchestration flow with Compound Engineering. The Orchestration phases are now explicitly mapped to Compound Engineering slash commands (`/ce-brainstorm`, `/ce-plan`, `/ce-work`, `/ce-code-review`, `/ce-compound`).
- **Comprehensive PM Documentation**: Added step-by-step API key tutorials and exact environment variable setup tables for Jira, Trello, and OpenProject on the documentation site.
- **Segmented Docs Architecture**: Split monolithic docs into dedicated modular pages for Project Management, Databases, Version Control, and Compound Engineering.

---

## [1.0.3] — 2026-06-14

### Added
- **Orchestration Workflow Module** (`lumina-orchestrate` prompt and `get_orchestration_phase` tool).
- 6-Phase AI Orchestration Engine:
  1. Planning & Brainstorming
  2. Execution (ce-work)
  3. Unit Testing
  4. Code Review (ce-code-review)
  5. Verification (Language specific tests + Database checks)
  6. Git & GitHub Push
- Dynamic test skipping logic (`includeTest` boolean) which shifts phases seamlessly.
- **Production Build Pipeline**: Replaced standard TypeScript compiler output with an optimized `esbuild` configuration (`build.ts`).
- Minification and mangling enabled to bundle the entire application into a fast, lightweight, and obfuscated single binary.
- Added `bin` executable mapping and shebang (`#!/usr/bin/env node`) for perfect `npx` compatibility across all OS when executed by AI Clients (Cursor, Antigravity, Claude Code, Codex).

---

## [1.0.2] — 2026-06-14

### Added
- **Project Management MCP integrations** for Jira, Trello, and OpenProject.
- Tools: `get_jira_ticket`, `get_trello_card`, `get_openproject_work_package` for automated ticket retrieval.
- Prompts: `pm_summarize_ticket` (Senior PM Ticket Summarization), `pm_brainstorm_plan` (Staff Engineer Brainstorm & Plan), and `pm_test_catalog` (Strict QA Test Catalog Generator).
- Stronger security practices: Domain sanitization for Jira endpoints and OAuth headers instead of query parameters for Trello API calls.

---

## [1.0.1] — 2026-06-08

### Added
- GitHub/Git Source Control MCP integration (under the `gitsystem` module).
- Tools: `generate_commit_and_push` (granularity staging), `create_github_pr`, `review_github_pr`, `fix_github_pr_review` (fetches reviews and inline comments concurrently).
- Prompts: `commit_generator_message` (Conventional Commit and JIRA trace), `tech_company_pr_creator` (Netflix/Meta-style description template), `ai_code_reviewer` (strict Senior Staff level review), `fix_pr_review_message` (guided AI fix and commit/push workflow).
- Prompt-Based GitHub Fallback Rules: Native instruction-based fallbacks embedded in all Git/GitHub prompts. The executing AI agent dynamically tries calling `lumina-mcp` tools primary, falls back to the official GitHub MCP server (`github`) secondary, and falls back to executing local CLI commands (`gh` CLI or `git`) tertiary if tokens or environment variables are missing.
- Strict validation test suite with 40 passing tests using Vitest covering database repositories, services, and MCP integrations.

---

## [1.0.0] — 2026-06-07

### Added

#### MySQL Tools
- `execute_mysql_query` — Execute read-only SQL queries with safe parameter binding
- `list_mysql_tables` — List all tables in a MySQL database
- `inspect_mysql_table` — Inspect table structure (columns, types, keys)
- `analyze_mysql_query` — Run `EXPLAIN` / `EXPLAIN ANALYZE` with Senior DB Auditor report
- `save_audit_report` — Persist AI-generated audit reports to `docs/database/`

#### PostgreSQL Tools
- `execute_postgres_query` — Execute read-only SQL queries with safe parameter binding (`$1`, `$2`)
- `list_postgresql_tables` — List all public-schema tables in a PostgreSQL database
- `inspect_postgresql_table` — Inspect table structure (columns, types, nullability, defaults)
- `analyze_postgresql_query` — Run `EXPLAIN` / `EXPLAIN ANALYZE` with Senior DB Auditor report
- `save_audit_report_pg` — Persist AI-generated audit reports to `docs/database/`

#### MCP Prompts
- `running_query` — Natural-language MySQL query generator with auto schema detection
- `auditor_query` — MySQL query performance & security auditor (Principal DBA level)
- `running_pg_query` — Natural-language PostgreSQL query generator with auto schema detection
- `auditor_pg_query` — PostgreSQL query performance & security auditor (Principal DBA level)

#### Security
- Read-only query enforcement (only `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`, `WITH`)
- SQL injection detection (comments, tautologies, `UNION SELECT`)
- Sensitive column auto-filtering (`password`, `token`, `secret`, `credential`, etc.)
- Configurable restricted columns via `.lumina/database/restricColumn.json`

#### Architecture
- Layered architecture: Controller → Service → Repository
- Zod-based DTO validation for all tool inputs
- Shared types and interfaces for query analysis results
- MCP prompt argument compatibility patch for IDE hosts (Antigravity, Claude Code, Cursor)
- Docker Compose setup for local MySQL 8.0 and PostgreSQL 15
- Optional `databaseName` parameter for multi-database environments

#### Developer Experience
- TypeScript strict mode with ESM modules
- ESLint + Prettier code formatting
- Vitest test suite with coverage reporting
- Hot-reload development via `tsx watch`

---

[1.2.0]: https://github.com/Wahyu-Labs/lumina-mcp/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/Wahyu-Labs/lumina-mcp/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/Wahyu-Labs/lumina-mcp/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/Wahyu-Labs/lumina-mcp/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Wahyu-Labs/lumina-mcp/compare/v1.0.6...v1.1.0
[1.0.6]: https://github.com/Wahyu-Labs/lumina-mcp/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/Wahyu-Labs/lumina-mcp/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/Wahyu-Labs/lumina-mcp/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/Wahyu-Labs/lumina-mcp/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Wahyu-Labs/lumina-mcp/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Wahyu-Labs/lumina-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Wahyu-Labs/lumina-mcp/releases/tag/v1.0.0
