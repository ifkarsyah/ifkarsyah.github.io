---
title: "Claude Code Series, Part 6: Best Practices & Real-world Tips"
description: "Master Claude Code with effective prompting, context management, and workflow patterns."
pubDate: 2026-02-28
author: "ifkarsyah"
domain: "AI Engineering"
stack: ["Claude Code"]
---

## When to Use Claude Code (and When Not To)

Claude Code is powerful, but it's not always the right tool.

### ✅ Use Claude Code For

- **Complex refactoring** — "Convert class components to hooks across the codebase"
- **Bug investigation** — "Why is this memory leak happening? Find the source and fix it"
- **Feature implementation** — "Add a checkout flow with error handling"
- **Test writing** — "Write comprehensive tests for this utility function"
- **Documentation** — "Generate API docs from the code"
- **Multi-file changes** — Any task touching 5+ files

### ❌ Don't Use Claude Code For

- **Quick fixes** — Use your editor for simple edits
- **Simple completions** — Copilot or your IDE is faster
- **Tasks requiring human judgment** — Design decisions, architectural choices
- **Sensitive operations** — Don't let Claude Code handle production secrets
- **Unfamiliar codebases** — You need to understand what's happening first

## Writing Effective Prompts

### The 3-Part Prompt Framework

**Part 1: Context**
Give Claude the background it needs:

```
We have a React SaaS app with Next.js. The user authentication uses NextAuth.js.
I want to add a "forgot password" feature.
```

**Part 2: Specific Task**
Be concrete, not vague:

```
Bad: "Improve the login system"
Good: "Add a 'Forgot Password' flow that:
  1. Shows an email input on the login page
  2. Sends a reset link via email
  3. Validates the token and lets users reset their password"
```

**Part 3: Constraints**
Mention limitations or requirements:

```
Constraints:
- Use NextAuth callbacks, don't implement custom auth
- Store reset tokens in the database with 1-hour expiry
- Send emails via our SendGrid account
- Keep the UI consistent with shadcn/ui components
```

### Full Example

```
Context:
We're building a task management app in React with TypeScript.
Tasks are stored in a PostgreSQL database via Drizzle ORM.

Task:
Add a "Bulk edit" feature where users can:
1. Select multiple tasks via checkboxes
2. Change priority, status, or assignee for all selected tasks at once
3. Show a confirmation dialog with a summary of changes

Constraints:
- Use React Query for mutations
- POST to /api/tasks/bulk-update
- UI should match existing task cards
- Include error handling and toast notifications
```

Claude will understand your entire context and write code that fits your patterns.

## Context Management

Claude Code reads your entire codebase, but larger projects can hit context limits.

### Symptoms of Context Overload
- Claude becomes vague: "Let me check the codebase..."
- Responses get shorter and less detailed
- It forgets earlier parts of your conversation

### Solutions

**1. Narrow the scope explicitly**
```
"In the src/components/auth/ directory, add a password reset flow"
```

Instead of: "Add password reset" (Claude might search your whole codebase)

**2. Use CLAUDE.md to compress context**
```markdown
# CLAUDE.md

## Architecture
- Next.js 14 with API routes
- Authentication: NextAuth.js
- Database: Drizzle ORM + PostgreSQL
- Styling: Tailwind + shadcn/ui
- State: React Query for async, Zustand for global state
```

Now Claude knows your stack without reading every file.

**3. Reference specific files**
```
"In src/lib/auth/index.ts, add a password reset function"
```

Claude will read only the relevant file instead of your entire project.

**4. Clear conversation history if stuck**
```
/clear
```

Fresh context often helps. Start a new session if Claude seems confused.

## Anti-patterns to Avoid

### 1. Over-specification
```
Bad: "Add a button 14px from the left, with Roboto font, blue #0066FF..."
Good: "Add a submit button styled like the ones in forms/"
```

Trust Claude to match your patterns.

### 2. Asking Claude to decide architecture
```
Bad: "Design our authentication system"
Good: "Implement JWT authentication following RFC 7519"
```

You decide direction; Claude implements.

### 3. Approving without reading
When Claude asks for permission, read the proposed change carefully:
```
[Tool: Bash]
Command: rm -rf node_modules && npm install

You should ALWAYS read what's about to happen.
```

### 4. Asking for "clean code" without specifics
```
Bad: "Refactor this for better practices"
Good: "Reduce the cyclomatic complexity of this function using early returns"
```

Be specific about what "better" means.

### 5. Ignoring CLAUDE.md
If you set coding standards in CLAUDE.md but Claude violates them:
```
Claude: [Suggests using `var` for a variable]
You: "Remember CLAUDE.md — we use const/let only"
```

Remind Claude of your rules. It will adjust.

## Real-world Workflows

### Workflow 1: Feature Implementation

```
Session 1: Plan & Scaffold
You: "Plan a checkout flow with payment processing using Stripe"
Claude: [Lists files to create, explains architecture]
You: "Looks good, implement it"

Session 2: Refine & Test
You: "Add error handling for failed payments"
Claude: [Refines payment error handling]
You: "Write integration tests"
Claude: [Writes tests, runs them]

Session 3: Polish
You: "The checkout button should have a loading state"
Claude: [Adds loading state, runs tests again]
```

### Workflow 2: Bug Investigation

```
You: "Tests are timing out on ci.yml. Investigate."
Claude: [Reads CI config]
        [Reads test files]
        [Identifies slow database queries]
        [Suggests mock/stub approach]
        [Implements fix]
        [Runs tests locally]
```

### Workflow 3: Combining MCP + Skills

```
You: "/sync-coverage-to-notion --threshold 80"
Claude: [Runs tests locally via Bash]
        [Fetches Notion database via MCP]
        [Creates page with results]
        [Posts summary]
```

## Performance Tips

### 1. Batch related tasks
```
Instead of:
- "Add dark mode"
- "Add light mode"
- "Add system preference detection"

Do:
- "Add theme system with dark, light, and auto modes"
```

Claude works faster with related tasks grouped.

### 2. Use background mode for long tasks
```
/run implement-feature "Add file upload with S3 integration"
```

Let Claude work while you do other things.

### 3. Test incrementally
Don't ask for everything at once:
```
First: "Create the API endpoint"
Claude: [Creates and tests]

Then: "Add client-side upload component"
Claude: [Adds and tests]

Finally: "Integrate S3 handling"
Claude: [Integrates and tests]
```

This gives Claude time to verify each step works.

## Team Best Practices

### 1. Share your CLAUDE.md
Put it in your repo. Every team member (and Claude Code) uses the same standards.

### 2. Document Custom Skills
```markdown
# skills/lint-and-format.md

## Usage
/lint-and-format

## What it does
1. Runs eslint with auto-fix
2. Runs prettier
3. Runs TypeScript type-check
4. Commits changes if clean

## Requirements
- Node 18+
- eslint configured
```

### 3. Establish MCP Standards
Agree on which MCP servers you use:
```
Team-approved MCP:
- Notion (for backlog)
- GitHub (for issues)
- Web Fetch (for docs)

Not approved:
- External APIs without company review
```

### 4. Set Approval Thresholds
Decide what requires human approval:
```
Auto-approve:
- File reads
- Simple edits to single files
- Test runs

Require approval:
- Deletions
- Multi-file refactoring
- Git operations
- Anything touching auth or payments
```

## Debugging Claude Code Issues

### Issue: Claude ignores CLAUDE.md

**Solution:** Explicitly remind it:
```
You: "Remember, CLAUDE.md says we use Tailwind, not CSS modules"
Claude: [Adjusts approach]
```

### Issue: Claude forgets earlier context

**Solution:** Summarize for it:
```
You: "So we decided to use JWT tokens, not sessions.
       Please implement that in the auth endpoint."
```

### Issue: Claude makes permission mistakes

**Solution:** Deny and clarify:
```
Claude: [Proposes deleting a file]
You: n
You: "Don't delete that. Instead, move it to the archive folder."
Claude: [Archives the file]
```

## Measuring Success

Track these metrics to know if Claude Code is helping:

| Metric | Target |
|--------|--------|
| **Time to implement features** | -40% vs. manual coding |
| **Test coverage** | Stays above threshold |
| **Code quality** | Passes linting, types, reviews |
| **Bug escape rate** | No increase in production bugs |
| **Team satisfaction** | Engineers prefer using it |

If you're not hitting targets, it might be:
- Unclear CLAUDE.md standards
- Prompts that are too vague
- Using Claude Code for the wrong tasks

## Closing: You're Ready

You've learned:
1. What Claude Code is and why it's different
2. How to set it up and use basic commands
3. How it executes multi-step agentic tasks
4. How to customize it with CLAUDE.md and commands
5. How to expand it with MCP integrations
6. How to build reusable skills
7. Best practices for real-world usage

Now start small:
- Pick one simple task this week
- Try Claude Code on it
- Refine your approach next week

The more you use it, the better you'll become at prompting and workflow design. Happy coding!
