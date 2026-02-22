---
title: "Claude Code Series, Part 0: Overview"
description: "An introduction to Claude Code and how it differs from GitHub Copilot and Cursor."
pubDate: 2026-02-22
author: "ifkarsyah"
tags: ["Claude Code", "AI", "Developer Tools"]
---

## What is Claude Code?

Claude Code is Anthropic's official CLI tool for Claude, bringing the power of Claude AI directly into your terminal and development workflow. Unlike traditional autocompletion tools, Claude Code is fundamentally **agentic** — it reads your entire codebase, understands context deeply, and can execute multi-step tasks autonomously with your permission.

It's not a VSCode extension like Copilot or Cursor. It's a command-line interface that treats your project as a cohesive whole, allowing Claude to make intelligent decisions across files, run commands, and even commit code on your behalf.

## Claude Code vs. GitHub Copilot vs. Cursor

| Feature | Claude Code | GitHub Copilot | Cursor |
|---------|------------|---|---|
| **Interface** | CLI (terminal-based) | VSCode extension | Standalone IDE |
| **Context awareness** | Reads entire codebase | Single file + imports | Single file + imports |
| **Multi-step tasks** | Yes (agentic) | No (line-by-line) | Limited |
| **Tool execution** | Bash, file ops, search | None | None |
| **Permission model** | Explicit approval per action | Auto-complete | Auto-complete |
| **CLAUDE.md support** | Yes (project instructions) | No | No |
| **Custom skills/commands** | Yes | No | Limited |
| **MCP integrations** | Yes (Notion, GitHub, etc.) | No | No |
| **Learning curve** | Moderate (CLI + prompting) | Shallow | Shallow |
| **Best for** | Complex refactors, bug fixes, full features | Quick inline completions | Fast IDE-based development |

## Why Claude Code Matters

1. **Full context** — It understands your entire project structure, not just the current file.
2. **Autonomous execution** — It can make decisions, run tests, create commits, and manage permissions.
3. **Extensible** — CLAUDE.md, custom skills, and MCP servers let you shape its behavior for your team.
4. **Safe by default** — Requires explicit approval for destructive actions (deletions, force pushes).

## Series Roadmap

This series covers everything you need to use Claude Code effectively:

- **Part 0 (this post):** Overview and comparison
- **Part 1:** Getting Started — Installation, API setup, and first commands
- **Part 2:** Hooks — Automate Workflows — Desktop notifications, auto-formatting, protecting files, and enforcing project rules
- **Part 3:** Custom Commands & Slash Prompts — CLAUDE.md project instructions, custom slash commands, and extending functionality
- **Part 4:** MCP (Model Context Protocol) — Connecting external services (Notion, GitHub, web content, etc.)
- **Part 5:** Building Claude Skills — Creating reusable, shareable automations with SKILL.md
- **Part 6:** Best Practices & Real-world Tips — Prompt strategies, context management, team workflows, anti-patterns

By the end of this series, you'll understand not just *how* to use Claude Code, but *when* to use it and how to supercharge your workflow with hooks, MCP integrations, and custom skills.

**Next:** [Part 1 — Getting Started](/blog/claude-code-series-1-getting-started)
