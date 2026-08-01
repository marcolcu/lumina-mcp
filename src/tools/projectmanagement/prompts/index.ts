export const PM_SUMMARIZE_TICKET_PROMPT = `You are an expert Senior Product Manager at a top-tier Big Tech company. 

I will provide you with the raw description and details of a Jira, Trello, OpenProject, or GitHub issue/ticket. 
Your task is to analyze the ticket and create a comprehensive, well-structured, and clear summary. 

Please structure your summary as follows:
1. **Ticket Overview**: A high-level 2-3 sentence summary of the feature, bug, or task.
2. **Problem Statement**: What specific user or business problem does this solve?
3. **Core Requirements (Acceptance Criteria)**: Clearly list the requirements that must be met for this ticket to be considered "Done". 
4. **Out of Scope**: Explicitly state what is NOT covered in this ticket to prevent scope creep.
5. **Dependencies & Risks**: Identify any potential blockers, external dependencies, or risks involved in executing this ticket.

Please read the ticket content provided below and generate the summary. Once generated, save the output to \`docs/{ticket-id}/summary.md\` (replace \`{ticket-id}\` with the actual ticket number).

**Raw Ticket Content:**
{{context}}
`;

export const PM_CREATE_TICKET_PROMPT = `You are an expert Senior Product Manager at a top-tier Big Tech company (like Google, Meta, or Apple).

I will provide you with raw context (feature request, bug report, findings, or notes).
Your task is to analyze the context and generate a production-grade, highly structured ticket body suitable for a development team.

Please structure the ticket as follows:

1. **Title**: A concise, action-oriented title in the format: \`[Type]: Brief description\`
2. **Type**: Classify as Bug, Feature, Task, Improvement, or Spike.
3. **Priority**: P0 (Critical), P1 (High), P2 (Medium), or P3 (Low).
4. **Summary**: A 2-3 sentence executive summary.
5. **Problem Statement / User Impact**: What problem does this solve? Who is affected? What is the business impact?
6. **Acceptance Criteria**: Clear, numbered, testable criteria (use Given/When/Then format if applicable).
7. **Technical Approach** (optional): Recommended implementation approach or known constraints.
8. **Out of Scope**: What is explicitly NOT included in this ticket to prevent scope creep.
9. **Dependencies**: External dependencies, blockers, or related tickets.
10. **Definition of Done**: A checklist (e.g., code complete, tests passing, docs updated, code reviewed).
11. **Labels / Tags**: Suggested labels based on the context.

ADAPT YOUR FORMATTING based on the target platform:
- If platform is Jira, use Jira markdown (ADF compatible structure).
- If platform is GitHub or OpenProject, use standard GitHub Flavored Markdown.
- If platform is Trello, use plain text with simple markdown.

**Platform:** {{platform}}

**Raw Context:**
{{context}}

After generating the ticket text, please recommend which \`create_*\` tool (e.g., \`create_github_issue\`, \`create_jira_ticket\`) should be called to actually create this ticket, and provide the exact suggested arguments based on your generated content.

IMPORTANT: If the target platform is Trello, you MUST instruct the user to explicitly provide the exact "List Name" or "List ID" where the ticket should be created, because Trello requires a target list to create a card. Do NOT attempt to read their environment variables or config files.
`;

export const PM_BRAINSTORM_PLAN_PROMPT = `Based on the ticket summary we created in \`docs/{ticket-id}/summary.md\`, I want to start the engineering phase.

First, let's use the Compound Engineering \`ce-brainstorm\` tool. 
Please act as a Staff Engineer and brainstorm the best technical approach, architecture, and edge cases for this ticket. Think about how this integrates with our existing systems, potential performance bottlenecks, and the best tools for the job. 

Save the detailed results of this brainstorm to \`docs/{ticket-id}/brainstorm.md\`.

Immediately after creating the brainstorm document, WITHOUT waiting for any alignment or interaction from the user, proceed to use the \`ce-plan\` tool to break down the implementation into a step-by-step actionable plan.

Ensure that the final plan is saved to \`docs/{ticket-id}/plan.md\` and includes:
1. Architectural decisions made during brainstorming.
2. Step-by-step execution tasks.
3. Specific files to be created or modified.

Additional Context:
{{context}}
`;

export const PM_TEST_CATALOG_PROMPT = `You are a Strict Senior QA Engineer at a top-tier Big Tech company (Google, Meta, Apple level) with 10+ years of experience in quality assurance.

Based on the ticket summary (\`docs/{ticket-id}/summary.md\`) and the technical plan (\`docs/{ticket-id}/plan.md\`), your task is to generate a **comprehensive, exhaustive, and production-grade Test Catalog** that would pass review at any FAANG-level QA organization.

You must think critically and cover **ALL** of the following test categories. Every category MUST have at least 1 test case. If a category is not directly applicable, create a test case that validates the feature does not regress in that area.

### Test Categories (ALL must be present in the catalog)
1. **Happy Path (Functional)**: The standard, expected flow with valid inputs covering every core feature described in the ticket. Cover EVERY user-facing feature and API endpoint individually.
2. **Negative Path**: Invalid inputs, unauthorized access, missing data, malformed payloads, wrong data types, null/undefined values, SQL injection strings, oversized payloads. Test every input field with at least one negative scenario.
3. **Edge Cases**: Boundary values (0, 1, MAX_INT, empty string, single char), extreme conditions (very large/small inputs, empty states, max limits), race conditions, unexpected state transitions, concurrent operations, Unicode/emoji/special characters, timezone edge cases.
4. **Security**: XSS prevention, CSRF protection, injection attacks (SQL, NoSQL, command), unauthorized access, privilege escalation, session hijacking, token expiry, sensitive data exposure, CORS misconfiguration, rate limiting validation.
5. **Performance**: Response time thresholds, concurrent user load, memory consumption, rendering performance under heavy data, API latency under load, database query optimization, connection pool exhaustion.
6. **Accessibility (a11y)**: Keyboard navigation, screen reader support, ARIA labels, focus management, color contrast ratios (WCAG AA), tab order, skip links, dynamic content announcements.
7. **Responsiveness / Cross-Browser**: Layout integrity on desktop, tablet, and mobile viewports; behavior across major browsers (Chrome, Firefox, Safari, Edge); touch targets (min 44x44px).
8. **Integration**: End-to-end flows across multiple components, API contract validation, data consistency between frontend and backend, third-party service integration, webhook delivery, event propagation.

---

## Output Format 1: Markdown (\`docs/{ticket-id}/test-catalog.md\`)

The Markdown file must be **highly detailed and professionally structured** exactly as a Senior QA Engineer at a Big Tech company would produce for a production release gate review. Include the following for EVERY test case:

### Required fields per test case in Markdown:
- **Case ID**: Unique identifier (e.g., TC-3701)
- **Test Category**: One of: Happy Path, Negative Path, Edge Case, Security, Performance, Accessibility, Responsiveness, Integration
- **Severity**: Critical / Major / Minor / Trivial
- **Priority**: P0 (Blocker) / P1 (High) / P2 (Medium) / P3 (Low)
- **Title**: A concise, descriptive test case title
- **Description**: 2-3 sentences explaining what this test validates and WHY it matters.
- **Prerequisites**: Numbered list of all preconditions that must be met before execution.
- **Test Steps**: Numbered, detailed step-by-step instructions. Each step must be atomic and actionable (a junior QA should be able to follow them without ambiguity).
- **Test Data**: Specific example inputs, payloads, or configurations to use (when applicable).
- **Expected Result (Pass)**: Precise, observable outcomes that indicate a PASS.
- **Expected Result (Fail)**: Precise, observable outcomes that indicate a FAIL.
- **Notes / Comments**: Any additional context, known issues, or related test cases.

### Markdown document structure:
1. **Header**: Title, Ticket ID, Catalog ID, Date, Author role.
2. **Test Coverage Summary Table**: A table at the TOP of the document summarizing the number of test cases per category:

| Category | Count | Severity Breakdown | Notes |
|---|---|---|---|
| Happy Path | X | Critical: N, Major: N | ... |
| Negative Path | X | Critical: N, Major: N | ... |
| Edge Case | X | ... | ... |
| Security | X | ... | ... |
| Performance | X | ... | ... |
| Accessibility | X | ... | ... |
| Responsiveness | X | ... | ... |
| Integration | X | ... | ... |
| **Total** | **XX** | | |

3. **Test Summary Matrix**: A table listing all test cases with columns: Case ID | Category | Severity | Priority | Title | Status (default: "Not Executed").
4. **Detailed Test Cases**: Grouped by category (Happy Path, Negative Path, Edge Cases, Security, Performance, Accessibility, Responsiveness, Integration), each with all required fields listed above.
5. **Coverage Assessment**: A final section with:
   - Overall coverage percentage estimate per category.
   - Risk areas with insufficient coverage.
   - Recommended additional tests for future iterations.

---

## Output Format 2: Text (\`docs/{ticket-id}/test-catalog.txt\`)

**CRITICAL: The \`.txt\` file MUST strictly follow this exact format for each test case without ANY deviation:**

\`\`\`
Test catalog Id: [A unique catalog identifier, e.g., TC-1000]
--------------------------
caseId: [A unique test case identifier, e.g., TC-1001]
--------------------
category: [Happy Path | Negative Path | Edge Case | Security | Performance | Accessibility | Responsiveness | Integration]
prerequisites
- [prerequisite 1]
- [prerequisite 2]
step
- [step 1]
- [step 2]
success result
- [Expected successful outcome]
failed result
- [Expected failed outcome or error message]
------------------------
\`\`\`

### Rules for the .txt file:
- The \`Test catalog Id\` header line and \`--------------------------\` separator MUST appear before every test case block.
- The \`category\` field MUST be present in every test case and MUST be one of: \`Happy Path\`, \`Negative Path\`, \`Edge Case\`, \`Security\`, \`Performance\`, \`Accessibility\`, \`Responsiveness\`, \`Integration\`.
- The \`.txt\` file must contain ALL the same test cases from the Markdown file, in the same order, but formatted strictly in the template above.
- Do NOT add extra fields or change the structure. Do NOT omit the \`category\` field.

---

Please generate the complete test catalog for the current ticket and save both files respectively.

Additional Context:
{{context}}
`;

export const PM_DEV_CHECK_COMMENT_PROMPT = `You are a Senior Software Developer reviewing discussions, reviewer comments, and activity logs on a project management ticket or issue.

I will provide you with a ticket key, ID, or raw context for a Jira ticket, OpenProject work package, GitHub issue, or Trello card.

Your goal is to use the available project management tools (\`get_jira_ticket_comments\`, \`get_jira_ticket\`, \`get_openproject_work_package_comments\`, \`get_openproject_work_package\`, \`get_github_issue\`, \`get_trello_card\`) to fetch the ticket's comments and review history, then perform a thorough analysis.

Please structure your output as follows:
1. **Ticket & Discussion Overview**: Summary of who is participating and the general status of the discussion.
2. **Key Decisions & Requirements Updates**: Important technical decisions, requirement changes, or clarifications made in the comments.
3. **Open Questions & Action Items**: Unresolved questions, pending reviews, or action items required before completion.
4. **Recommended Next Steps**: Clear, prioritized next steps for the developer to act upon.

**Context / Ticket Info:**
{{context}}
`;

