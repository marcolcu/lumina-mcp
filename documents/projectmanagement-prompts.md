# Project Management Integration — Prompts & Tools

> **Lumina MCP** provides tools and prompts for integrating with popular project management systems (Jira, Trello, OpenProject, GitHub, ClickUp) through the Model Context Protocol. This allows AI agents to directly ingest ticket requirements and build precisely what was specified.

---

## 🔧 Tools

### `get_jira_ticket`

Fetch a Jira issue by its ID or Key, including title, description, labels, comments, reporter, and epic links.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `issueIdOrKey` | `string` | ✅ | Jira issue ID or Key (e.g., `PROJ-123`) |
| `domain` | `string` | ✅ | Jira workspace domain (e.g., `yourcompany` for `yourcompany.atlassian.net`) |
| `email` | `string` | ✅ | Email associated with your Jira account |
| `apiToken` | `string` | ✅ | Your Jira API token |

> **Note:** If you have set `JIRA_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` as environment variables in your MCP config, the AI agent will use those automatically without needing to pass credentials in the prompt.

**Example:**
```
/mcp:lumina-mcp-local:get_jira_ticket

issueIdOrKey: "PROJ-123"
domain: "yourcompany"
email: "user@example.com"
apiToken: "your_api_token_here"
```

**Returns:** Title, description, status, priority, assignee, labels, comments, epic link, and acceptance criteria.

---

### `get_trello_card`

Fetch a Trello card by its ID or shortlink, including description, status, checklist items, and comment history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cardId` | `string` | ✅ | Trello card ID or shortlink |
| `apiKey` | `string` | ✅ | Your Trello API key |
| `apiToken` | `string` | ✅ | Your Trello API token |

> **Note:** If `TRELLO_API_KEY` and `TRELLO_API_TOKEN` are set in your MCP environment config, they will be used automatically.

**Example:**
```
/mcp:lumina-mcp-local:get_trello_card

cardId: "abc123xyz"
apiKey: "your_trello_api_key"
apiToken: "your_trello_api_token"
```

**Returns:** Card title, description, list/column, checklists with completion status, labels, members, and all comments.

---

### `get_openproject_work_package`

Fetch an OpenProject work package by its ID, including assignee, priority, description, status, and comments.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workPackageId` | `number` | ✅ | OpenProject work package ID |
| `domain` | `string` | ✅ | OpenProject instance URL (e.g., `https://openproject.yourcompany.com`) |
| `apiKey` | `string` | ✅ | Your OpenProject API key/token |

> **Note:** If `OPENPROJECT_URL` and `OPENPROJECT_API_KEY` are set in your MCP environment config, they will be used automatically.

**Example:**
```
/mcp:lumina-mcp-local:get_openproject_work_package

workPackageId: 42
domain: "https://openproject.yourcompany.com"
apiKey: "your_openproject_api_key"
```

**Returns:** Subject, description, type, status, priority, assignee, due date, and activity/comments.

---

### `get_github_issue`

Fetch a GitHub issue, including its body, comments, labels, milestones, and any linked pull requests.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `owner` | `string` | ✅ | Repository owner |
| `repo` | `string` | ✅ | Repository name |
| `issueNumber` | `number` | ✅ | GitHub issue number |
| `githubToken` | `string` | ❌ | GitHub Token (uses env var `GITHUB_TOKEN` or `GITHUB_PERSONAL_ACCESS_TOKEN` if omitted) |

**Example:**
```
/mcp:lumina-mcp-local:get_github_issue

owner: "Wahyu-Labs"
repo: "lumina-mcp"
issueNumber: 11
```

**Returns:** Core issue metadata, comments, assignees, labels, and linked pull requests via cross-references.

---

### `create_jira_ticket`

Create a new Jira issue directly from your AI agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectKey` | `string` | ✅ | Jira Project Key (e.g., `PRJ`) |
| `summary` | `string` | ✅ | Issue title/summary |
| `issueType` | `string` | ✅ | Issue type (e.g., `Task`, `Bug`, `Story`) |
| `description` | `string` | ❌ | Issue description in plain text or ADF |
| `priority` | `string` | ❌ | Issue priority (e.g., `High`, `Medium`, `Low`) |
| `labels` | `array` | ❌ | Array of labels |

---

### `create_trello_card`

Create a new Trello card in a specific list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `idList` | `string` | ✅ | Trello target list ID |
| `name` | `string` | ✅ | Trello card title/name |
| `desc` | `string` | ❌ | Trello card description |
| `due` | `string` | ❌ | Due date (ISO 8601) |

---

### `create_openproject_work_package`

Create a new OpenProject work package.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectId` | `string` | ✅ | OpenProject Project ID or slug |
| `subject` | `string` | ✅ | Work package subject/title |
| `type` | `string` | ✅ | Work package type (e.g., `Task`, `Bug`) |
| `description` | `string` | ❌ | Work package description |

---

### `add_openproject_time_entry`

Log spent time on an OpenProject work package (fills the "Spent time" field). Accepts hours as a decimal number (e.g., `2.5`) or an ISO 8601 duration string (e.g., `PT2H30M`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workPackageId` | `string` | ✅ | OpenProject Work Package ID to log spent time against |
| `hours` | `number \| string` | ✅ | Decimal hours (e.g., `2.5`) or ISO 8601 duration (e.g., `PT2H30M`) |
| `spentOn` | `string` | ❌ | Date the time was spent, `YYYY-MM-DD`. Defaults to today if omitted |
| `comment` | `string` | ❌ | Optional comment describing the work done |
| `activityId` | `string` | ❌ | Time entry activity ID (e.g., Development, Management). Defaults to the instance default if omitted |
| `domain` | `string` | ✅ | OpenProject instance URL |
| `apiKey` | `string` | ✅ | Your OpenProject API key/token |

> **Note:** If `OPENPROJECT_URL` and `OPENPROJECT_API_KEY` are set in your MCP environment config, they will be used automatically.

**Example:**
```
/mcp:lumina-mcp-local:add_openproject_time_entry

workPackageId: 42
hours: 2.5
comment: "Implemented the API integration"
domain: "https://openproject.yourcompany.com"
apiKey: "your_openproject_api_key"
```

**Returns:** The created time entry object (id, hours, spentOn, work package link).

---

### `create_github_issue`

Create a new GitHub issue in a repository.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `owner` | `string` | ✅ | Repository owner |
| `repo` | `string` | ✅ | Repository name |
| `title` | `string` | ✅ | Issue title |
| `body` | `string` | ❌ | Markdown description for the issue |
| `labels` | `array` | ❌ | Array of label names |

---

### `list_clickup_tasks`

List tasks from a ClickUp list, optionally filtered by status, assignee, tag, or due date range. Returns a concise summary (id, name, status, assignee, url, due_date) — use this when browsing/filtering multiple tasks. Use `get_clickup_task` instead when you already have a specific task ID and need full details.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `listId` | `string` | ✅ | ClickUp List ID to fetch tasks from |
| `status` | `string` | ❌ | Filter by status name (e.g., `in progress`) |
| `assignee` | `string` | ❌ | Filter by assignee user ID |
| `tag` | `string` | ❌ | Filter by tag name |
| `dueDateFrom` | `string` | ❌ | Filter tasks due at/after this Unix timestamp (ms) |
| `dueDateTo` | `string` | ❌ | Filter tasks due at/before this Unix timestamp (ms) |
| `apiToken` | `string` | ❌ | ClickUp Personal API Token (uses env var `CLICKUP_API_TOKEN` if omitted) |

> **Note:** If `CLICKUP_API_TOKEN` is set in your MCP environment config, it will be used automatically.

**Returns:** Array of `{ id, name, status, assignee, url, due_date }`.

---

### `get_clickup_task`

Fetch full details of a single ClickUp task by its ID, including description, status, priority, assignees, custom fields, and url. Use this when you already know the specific `taskId`; use `list_clickup_tasks` instead when you need to search/browse tasks within a list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | `string` | ✅ | ClickUp Task ID |
| `apiToken` | `string` | ❌ | ClickUp Personal API Token (uses env var `CLICKUP_API_TOKEN` if omitted) |

**Returns:** Full task object (description, status, priority, assignees, custom fields, url).

---

### `get_clickup_task_comments`

Fetch all comments on a ClickUp task, including comment text, author, date, and resolved status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | `string` | ✅ | ClickUp Task ID to fetch comments for |
| `apiToken` | `string` | ❌ | ClickUp Personal API Token (uses env var `CLICKUP_API_TOKEN` if omitted) |

**Returns:** Array of `{ id, comment_text, user, date, resolved }`.

---

### `create_clickup_comment`

Add a new comment to a ClickUp task, optionally assigning it to a user or notifying all watchers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | `string` | ✅ | ClickUp Task ID to add a comment to |
| `commentText` | `string` | ✅ | Comment text content |
| `assignee` | `number` | ❌ | User ID to assign the comment to |
| `notifyAll` | `boolean` | ❌ | Whether to notify all task watchers |
| `apiToken` | `string` | ❌ | ClickUp Personal API Token (uses env var `CLICKUP_API_TOKEN` if omitted) |

**Returns:** `{ id, url }` of the newly created comment.

---

### `update_clickup_comment`

Edit the text of an existing ClickUp comment by its ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `commentId` | `string` | ✅ | ClickUp Comment ID to update |
| `commentText` | `string` | ✅ | New comment text content |
| `apiToken` | `string` | ❌ | ClickUp Personal API Token (uses env var `CLICKUP_API_TOKEN` if omitted) |

---

### `delete_clickup_comment`

Delete an existing ClickUp comment by its ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `commentId` | `string` | ✅ | ClickUp Comment ID to delete |
| `apiToken` | `string` | ❌ | ClickUp Personal API Token (uses env var `CLICKUP_API_TOKEN` if omitted) |

---

## 💬 Prompts

### `pm_summarize_ticket`

> **Title:** Senior PM Summarize Ticket

Summarize a raw Jira, Trello, or OpenProject ticket as a Senior Product Manager. Translates raw ticket JSON into a concise, business-focused summary covering the problem statement, requirements, and acceptance criteria.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | `string` | ❌ | Raw ticket JSON or natural language context |

**Example:**
```
Fetch and summarize Jira ticket LUM-402.
```

**Output includes:**
- Problem statement in plain language
- Business context and motivation
- Acceptance criteria in testable format
- Priority and risk assessment

---

### `pm_brainstorm_plan`

> **Title:** Staff Engineer Brainstorm and Plan

Brainstorm technical approaches and create a step-by-step implementation plan based on the ticket summary. Acts as a Staff Engineer mapping product requirements to concrete architectural changes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | `string` | ❌ | Ticket summary or context |

**Example:**
```
Download OpenProject work package #82 and create a technical implementation plan.
```

**Output includes:**
- High-level architectural decisions
- File-by-file change manifest
- API contracts and interface changes
- Dependencies and risk areas

---

### `pm_test_catalog`

> **Title:** Strict QA Test Catalog Generator

Generate a comprehensive, FAANG-level test catalog based on the ticket and technical plan. Enforces 8 rigorous testing categories (Happy Path, Negative Path, Edge Cases, Security, Performance, Accessibility, Responsiveness, Integration) and generates both Markdown and structured `.txt` formats.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | `string` | ❌ | Ticket summary, technical plan, or context |

**Example:**
```
Get the checklist from Trello card 64b19c and generate a full test catalog.
```

**Output includes:**
- Unit test cases per component
- Integration test scenarios
- Edge cases and negative test cases
- Acceptance criteria verification checklist

---

### `pm_create_ticket`

> **Title:** Senior PM Create Ticket

Generate a production-grade, highly structured ticket body based on raw context (feature request, bug report, findings). The AI acts as a Senior Product Manager at a Big Tech company.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | `string` | ❌ | Raw feature request, bug report, or context |

**Example:**
```
/pm_create_ticket "Create a ticket for the user registration form with first name, last name, email, and password."
```

**Output includes:**
- Concise Title, Type, and Priority
- Executive summary and Problem Statement
- Testable Acceptance Criteria
- Dependencies, Out of Scope, and Definition of Done
- A direct recommendation with precise arguments to call the relevant `create_*` tool.

---

## 🔗 Integration with Orchestration

Project Management tools integrate directly with the **Lumina Orchestration Engine**. During Phase 1 (Discovery & Analysis), the orchestration agent automatically calls the PM tools to fetch tickets and inject requirements into the planning context:

```
/lumina-orchestrate includeTest=true
> Fetch Jira ticket LUM-402 first, then start orchestration.
```

This ensures the entire development cycle — from code to PR — is grounded in the exact requirements from your project management system.
