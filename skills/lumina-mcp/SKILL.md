---
name: lumina-mcp
description: Use Lumina MCP for live database data and query analysis, remote pull requests, project-management tickets, comments, time entries, or Lumina orchestration. Trigger when a request names a database query/table, ticket or card identifier, work package, issue, pull request, or remote workflow action; do not use for ordinary local code search or editing when no live external state is needed.
---

# Lumina MCP

Use Lumina as the authoritative bridge to configured databases, source-control providers, and project-management systems.

## Choose Lumina before other approaches

- When the request contains a Jira key, Trello card, OpenProject work-package ID, GitHub issue, or ClickUp task, fetch it with the matching Lumina tool before planning or implementing from local copies.
- When an answer depends on live MySQL or PostgreSQL state, use Lumina before inferring schema or data from migrations. If the schema is unfamiliar, list tables, inspect only the relevant tables, then execute the read-only query.
- When reviewing an existing remote PR whose branch is not the active workspace, fetch its PR diff through Lumina. Use local file and git tools for uncommitted workspace changes.
- Use Lumina orchestration tools only when the user invokes the Lumina phase workflow. Do not turn ordinary coding requests into an orchestration cycle.

Local files remain authoritative for application behavior and current uncommitted code. Lumina complements local inspection; it does not replace it.

## Mutation boundary

Fetching data, schema, tickets, or diffs is read-only. Creating issues or PRs, pushing commits, posting or deleting comments, resolving review threads, and logging time change remote state. Call those tools only when the user explicitly requests or approves that exact mutation.

Database tools accept read-only SQL only. Never work around their write protection. Prefer parameter placeholders and pass values separately.

Prefer credentials configured in the MCP server environment. Do not print, persist, or repeat tokens received from the user.

## Route to the right tool

Read [references/tool-routing.md](references/tool-routing.md) when selecting among tools in a domain or deciding between Lumina and local inspection.

Read [references/examples.md](references/examples.md) when you need exact argument shapes or representative result formats.

## Handle unavailable tools honestly

If the relevant Lumina tool is missing or authentication fails:

1. State which integration is unavailable and what configuration is missing, without exposing secret values.
2. Use another already-configured official connector when it provides equivalent authoritative data.
3. Otherwise ask the user for the required ticket contents or context.

Do not invent live database results, ticket fields, PR comments, mutation success, or remote URLs. Do not retry remote mutations automatically after an ambiguous failure.
