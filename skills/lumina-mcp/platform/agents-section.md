## Lumina MCP

Use Lumina MCP before local guesses when a request depends on live database state, a Jira/Trello/OpenProject/GitHub/ClickUp item, or an existing remote pull request. For an unfamiliar database schema, list tables, inspect only relevant tables, then run a parameterized read-only query. Use local files and local git for application behavior and uncommitted changes.

Remote mutations—including commits and pushes, PR or issue creation, comments, review submission or resolution, deletion, and time logging—require an explicit user request for that exact action. Never invent remote results or retry an ambiguous mutation automatically. Prefer credentials configured in the MCP environment and never echo tokens.

Use `get_orchestration_phase` only inside an explicitly requested Lumina orchestration workflow.
