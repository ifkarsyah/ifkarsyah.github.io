---
title: "Claude Code Series, Part 3: Custom Commands & Slash Prompts"
description: "Extend Claude Code with CLAUDE.md, slash commands, hooks, and automation."
pubDate: 2026-02-25
author: "ifkarsyah"
tags: ["Claude Code", "AI", "Developer Tools"]
---

## CLAUDE.md: Project-Level Instructions

The most powerful way to customize Claude Code is with a **CLAUDE.md** file in your project root. It's a markdown file that tells Claude:
- Your tech stack and conventions
- Coding standards and patterns
- What to avoid
- Team-specific workflows

### Example CLAUDE.md

```markdown
# CLAUDE.md

## Project Overview
This is a Next.js SaaS app with TypeScript, Tailwind, and shadcn/ui.

## Tech Stack
- Frontend: Next.js 14, React, Tailwind CSS, shadcn/ui
- Backend: Next.js API routes (NO external servers)
- Database: PostgreSQL with Drizzle ORM
- Auth: NextAuth.js v5

## Key Patterns
- Use `useCallback` for event handlers in components
- Server actions for mutations, API routes only for GET
- Error handling: always show user-friendly messages
- CSS: Tailwind utilities only, no custom CSS files

## Code Style
- Prettier config: 2-space indent, single quotes
- Components are functional, hooks over class components
- Types in separate .types.ts files

## What NOT to Do
- Don't use `eval()` or `dangerouslySetInnerHTML`
- Don't create environment files without `.example` versions
- Don't commit node_modules or .env
- Don't use `global` state outside of Context API

## Testing
- Use Jest + React Testing Library
- All new features require unit tests
- Run `npm run test` before committing
```

When you run Claude Code in this project, it reads CLAUDE.md and follows these rules automatically. No need to repeat your stack or conventions in every prompt.

## Slash Commands

Slash commands are special commands that start with `/` and control Claude Code sessions. The SDK provides several built-in commands:

### Built-in Commands
- `/compact` — Compact conversation history by summarizing older messages
- `/clear` — Clear conversation history and start fresh
- `/help` — Show available commands

You can send these commands through the SDK by including them in your prompt.

## Creating Custom Slash Commands

Custom slash commands are defined as **markdown files** in dedicated directories:

### File Locations
- **Project commands**: `.claude/commands/` — Available only in the current project
- **Personal commands**: `~/.claude/commands/` — Available across all your projects

### Basic Example

Create `.claude/commands/refactor.md`:

```markdown
Refactor the selected code to improve readability and maintainability.
Focus on clean code principles and best practices.
```

This creates the `/refactor` command.

### With Configuration

Create `.claude/commands/security-check.md`:

```markdown
---
allowed-tools: Read, Grep, Glob
description: Run security vulnerability scan
model: claude-opus-4-6
---

Analyze the codebase for security vulnerabilities including:
- SQL injection risks
- XSS vulnerabilities
- Exposed credentials
- Insecure configurations
```

### Advanced: Commands with Arguments

Create `.claude/commands/fix-issue.md`:

```markdown
---
argument-hint: [issue-number] [priority]
description: Fix a GitHub issue
---

Fix issue #$1 with priority $2.
Check the issue description and implement the necessary changes.
```

Use it with: `/fix-issue 123 high`

### Advanced: Commands with Bash

Custom commands can execute bash and include file contents:

Create `.claude/commands/code-review.md`:

```markdown
---
allowed-tools: Read, Grep, Glob, Bash(git diff:*)
description: Comprehensive code review
---

## Changed Files
!`git diff --name-only HEAD~1`

## Detailed Changes
!`git diff HEAD~1`

Review the above changes for code quality, security, performance, and test coverage.
```

### Organization with Namespacing

Organize commands in subdirectories:

```bash
.claude/commands/
├── frontend/
│   ├── component.md
│   └── style-check.md
├── backend/
│   ├── api-test.md
│   └── db-migrate.md
└── review.md
```

## Hooks: Pre/Post Tool Execution

Hooks are shell scripts that run **before** or **after** Claude Code executes a tool. They're perfect for automation:

### Pre-hooks (before Claude runs a command)
- Validate the command is safe
- Check prerequisites (e.g., "is Docker running?")
- Run setup steps

### Post-hooks (after Claude runs a command)
- Format output
- Run dependent steps
- Log or notify

### Example Hook: Auto-format after edits

Create `~/.claude/hooks/post-edit.sh`:

```bash
#!/bin/bash
# After Claude edits files, auto-format them

if command -v prettier &> /dev/null; then
  prettier --write "$@"
fi

if command -v eslint &> /dev/null; then
  eslint --fix "$@"
fi
```

Register it in your config, and every time Claude edits a file, it automatically gets formatted.

## Introduction to MCP Integrations

Claude Code can integrate with external services via **MCP (Model Context Protocol)** — we'll cover this deeply in Part 4, but here's a preview:

With MCP, Claude Code can:
- Fetch data from Notion databases while coding
- Query GitHub issues and PRs
- Access web content without leaving the terminal
- Connect to custom data sources

Example workflow with MCP:
```
You: "Add the features from our Notion backlog to the README"

Claude: [Uses Notion MCP]
        [Reads your Notion database]
        [Updates README with current features]
```

MCP makes Claude Code more powerful by expanding what information it can access.

## Best Practices for Custom Commands

1. **Name clearly** — `/test-api` not `/t`
2. **Keep prompts concise** — One sentence, max
3. **Chain related tasks** — One command runs multiple steps
4. **Document in your CLAUDE.md** — Other team members need to know

## Next: Connecting Everything with MCP

Custom commands are local. MCP opens the door to external integrations — databases, issue trackers, documentation, and more.

**Next:** [Part 4 — MCP (Model Context Protocol)](/blog/claude-code-series-4-mcp)
