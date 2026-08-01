# Project Management Integration — Prompts & Tools

> **Lumina MCP** provides three tools and three prompts for integrating with popular project management systems (Jira, Trello, OpenProject) through the Model Context Protocol. This allows AI agents to directly ingest ticket requirements and build precisely what was specified.

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

### `get_jira_ticket_comments`

Fetch comments and activity history for a Jira ticket/issue by its ID or Key.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `issueIdOrKey` | `string` | ✅ | Jira issue ID or Key (e.g., `PROJ-123`) |
| `domain` | `string` | ❌ | Jira workspace domain (e.g., `yourcompany`) |
| `email` | `string` | ❌ | Email associated with your Jira account |
| `apiToken` | `string` | ❌ | Your Jira API token |
| `startAt` | `number` | ❌ | Index of the first item to return for pagination |
| `maxResults` | `number` | ❌ | Maximum number of items to return per page |

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

### `get_openproject_work_package_comments`

Fetch comments, reviews, and activity history for an OpenProject work package by its ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workPackageId` | `string` | ✅ | OpenProject work package ID |
| `domain` | `string` | ❌ | OpenProject domain |
| `apiKey` | `string` | ❌ | OpenProject API Key |
| `offset` | `number` | ❌ | Page number / offset for pagination |
| `pageSize` | `number` | ❌ | Number of elements per page |

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

### `dev_check_comment`

> **Title:** Developer Check Comments and Reviews

Fetch and review comments, activity logs, and review feedback for a ticket or issue (Jira, OpenProject, GitHub, Trello). The AI acts as a Senior Developer extracting key decisions, unresolved questions, and next steps from ticket discussions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | `string` | ❌ | Ticket ID/Key or natural language context (e.g. `PRJ-123` or `#42`) |

**Example:**
```
/dev_check_comment command="Check comments and review status for Jira ticket PRJ-123"
```

**Output includes:**
- Ticket & Discussion Overview
- Key Decisions & Requirements Updates
- Open Questions & Action Items
- Recommended Next Steps

---


## 🔗 Integration with Orchestration

Project Management tools integrate directly with the **Lumina Orchestration Engine**. During Phase 1 (Discovery & Analysis), the orchestration agent automatically calls the PM tools to fetch tickets and inject requirements into the planning context:

```
/lumina-orchestrate includeTest=true
> Fetch Jira ticket LUM-402 first, then start orchestration.
```

This ensures the entire development cycle — from code to PR — is grounded in the exact requirements from your project management system.
