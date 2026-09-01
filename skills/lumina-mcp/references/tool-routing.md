# Lumina tool routing

## Databases

Use MySQL tools for MySQL and PostgreSQL tools for PostgreSQL.

| Need | MySQL | PostgreSQL | Selection rule |
|---|---|---|---|
| Discover schema | `list_mysql_tables` | `list_postgresql_tables` | Call when table names are unknown. |
| Inspect one table | `inspect_mysql_table` | `inspect_postgresql_table` | Call before querying an unfamiliar table. |
| Read live data | `execute_mysql_query` | `execute_postgres_query` | Call when the query is known; use bound parameters. |
| Diagnose performance | `analyze_mysql_query` | `analyze_postgresql_query` | Call for EXPLAIN, index, or performance questions—not ordinary result retrieval. |
| Persist an audit | `save_audit_report` | `save_audit_report_pg` | Call only after the report content exists and the user wants a file. |

Do not list and inspect every table by default. Narrow discovery from the user's question to minimize latency and data exposure.

## Project management

- Jira key → `get_jira_ticket`
- Trello ID or shortlink → `get_trello_card`
- OpenProject ID → `get_openproject_work_package`
- Assigned OpenProject work without a known ID → `get_my_openproject_work_packages`
- GitHub issue → `get_github_issue`
- ClickUp list discovery → `list_clickup_tasks`
- Known ClickUp task → `get_clickup_task`; fetch `get_clickup_task_comments` only when discussion history matters

Creation, comments, updates, deletion, and time logging are remote mutations. Require explicit user intent immediately before calling:

- `create_jira_ticket`, `create_trello_card`, `create_openproject_work_package`, `create_github_issue`
- `add_openproject_work_package_comment`, `add_openproject_time_entry`
- `create_clickup_comment`, `update_clickup_comment`, `delete_clickup_comment`

## GitHub and Gitea

Use provider-specific PR tools for authoritative remote state:

- Fetch PR content: `get_github_pr_diff` or `get_gitea_pr_diff`
- Submit a review: `review_github_pr` or `review_gitea_pr`
- Fetch existing feedback for local fixes: `fix_github_pr_review` or `fix_gitea_pr_review`
- Create a PR: `create_github_pr` or `create_gitea_pr`

GitHub additionally supports `reply_to_pr_comment` and `resolve_pr_review_thread`.

Use `generate_commit_and_push` only for an explicit commit-and-push request and pass only the intended files. For local inspection, use local git commands instead. Never treat a request to draft a message, review code, or summarize changes as permission to push or publish.

## Orchestration

`get_orchestration_phase` returns phase instructions for an already-running Lumina workflow. Request phases in order and pass a concise `previousPhaseSummary` when context must carry forward. Do not use it as a generic planning tool.
