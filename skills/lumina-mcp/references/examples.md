# Lumina examples

These examples show tool-call shapes. Actual results depend on the configured services.

## Query live PostgreSQL data

User request: “How many pending orders were created since August 1?”

When the schema is unknown:

```text
1. list_postgresql_tables({})
2. inspect_postgresql_table({"table":"orders"})
3. execute_postgres_query({
     "query":"SELECT COUNT(*) AS pending_count FROM orders WHERE status = $1 AND created_at >= $2",
     "parameters":["pending","2026-08-01"]
   })
```

Representative result:

```json
[
  { "pending_count": "42" }
]
```

If `orders` and its columns are already confirmed in the current conversation, skip discovery and call only `execute_postgres_query`.

## Load ticket requirements before coding

User request: “Implement Jira LUM-402.”

```text
get_jira_ticket({"issueIdOrKey":"LUM-402"})
```

Representative result shape:

```json
{
  "key": "LUM-402",
  "summary": "Add account recovery",
  "description": "...",
  "status": "In Progress",
  "labels": ["backend"],
  "comments": []
}
```

Use that result for requirements, then inspect local code with filesystem tools. Do not keep calling Jira while implementing unless fresh remote state is needed.

## Inspect a remote GitHub PR

User request: “Review PR 84 in `acme/payments`; the branch is not checked out.”

```text
get_github_pr_diff({"repository":"acme/payments","pullRequestNumber":84})
```

Analyze the returned unified diff locally. Call `review_github_pr` only if the user also asks to publish the review:

```text
review_github_pr({
  "repository":"acme/payments",
  "pullRequestNumber":84,
  "event":"COMMENT",
  "body":"Found one correctness issue; see inline comment.",
  "comments":[
    {"path":"src/refund.ts","line":71,"side":"RIGHT","body":"This retries non-idempotent work."}
  ]
})
```

Representative mutation result:

```json
{
  "success": true,
  "reviewUrl": "https://github.com/acme/payments/pull/84#pullrequestreview-..."
}
```

Do not claim success unless the tool returns it.

## Log OpenProject time

User request: “Log 2.5 hours today on work package 812 for the migration.”

After confirming the target and duration are explicit:

```text
add_openproject_time_entry({
  "workPackageId":"812",
  "hours":2.5,
  "comment":"Database migration"
})
```

This is a remote mutation. Do not infer hours, work-package IDs, or dates that the user did not provide.
