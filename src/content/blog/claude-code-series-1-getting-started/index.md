---
title: "Claude Code Series, Part 1: Getting Started"
description: "Installation, API setup, and your first Claude Code commands."
pubDate: 2026-02-23
author: "ifkarsyah"
domain: "AI Engineering"
stack: ["Claude Code"]
---

## Installation

Claude Code requires Node.js 18+. Install it globally via npm:

```bash
npm install -g @anthropic-ai/claude-code
```

Verify the installation:

```bash
claude-code --version
```

## API Key Setup

Claude Code communicates with Claude via the Anthropic API. You'll need an API key from [console.anthropic.com](https://console.anthropic.com).

1. Sign up or log in at Anthropic's console
2. Navigate to **API Keys**
3. Create a new API key
4. Copy it and set it as an environment variable:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

To make this permanent, add it to your shell profile (~/.zshrc, ~/.bashrc, etc.):

```bash
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.zshrc
source ~/.zshrc
```

## Your First Session

Open a terminal in any project directory and start Claude Code:

```bash
claude-code
```

You'll see an interactive prompt. Try something simple first:

```
You: "List the main files in this project"
```

Claude will read your directory structure and respond. If it wants to run a command (like `ls` or `cat`), it will ask for permission first:

```
[Tool Use: Bash]
Command: ls -la
Ready to execute? (y/n)
```

Approve with `y` and watch Claude work.

## Key Mental Models

### 1. Claude reads your entire codebase

Unlike Copilot (which sees only the current file), Claude Code automatically scans your project. It understands:
- Your file structure
- Language and framework (React, Python, Rust, etc.)
- Common patterns and naming conventions
- Dependencies and imports

This means you can ask it to "add a button to the login form" and it will find the login form, understand the styling system, and make changes that match your codebase's patterns.

### 2. You're the decision maker

Claude Code never does anything destructive without your approval. When it needs to:
- Delete files
- Run commands
- Make commits
- Force-push to git

...it stops and waits for you to say yes or no. Read the proposed action carefully before approving.

### 3. Multi-turn conversations

Claude Code sessions are stateful. Previous messages inform future responses. You can refine requests:

```
You: "Add a loading spinner to the button"
Claude: [Makes changes]
You: "Make it spin faster"
Claude: [Refines the animation]
```

## Basic Commands

Here are common things to ask Claude Code:

### Code exploration
- "Show me how authentication works in this codebase"
- "What does the [function name] function do?"
- "Find all usages of [class name]"

### Bug fixes
- "Fix the error: [error message]"
- "Why is this test failing?"
- "Refactor this function to be cleaner"

### Feature addition
- "Add a search bar to the homepage"
- "Implement error handling for the API call"
- "Create a dark mode toggle"

### Testing & documentation
- "Write tests for [component]"
- "Generate API documentation"
- "Add comments to this function"

## Exiting Claude Code

Press `Ctrl+C` to exit or type:

```
/exit
```

Your conversation history is saved locally, so you can resume it later (or start fresh).

## Next Steps

Now that you're set up, the next post dives into **hooks** — how to automate workflows, enforce project rules, and get notified when Claude needs input.

**Next:** [Part 2 — Hooks — Automate Workflows](/blog/claude-code-series-2-hooks)
