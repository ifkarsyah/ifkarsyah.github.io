---
title: "Claude Code Series, Part 4: MCP (Model Context Protocol)"
description: "Connect Claude Code to external services and expand its capabilities with MCP."
pubDate: 2026-02-26
author: "ifkarsyah"
tags: ["Claude Code", "AI", "Developer Tools"]
---

## What is MCP?

**MCP (Model Context Protocol)** is a standardized way for Claude to access external services, databases, and tools. It's a bridge between Claude Code and the outside world.

Think of it like this:
- Without MCP: Claude Code works within your local codebase
- With MCP: Claude Code can fetch docs from Notion, query GitHub issues, read web pages, and more — all while you're in your terminal

MCP servers expose **resources** (data it can read) and **tools** (actions it can take).

## Built-in MCP Servers

Claude Code ships with several pre-configured MCP servers:

### 1. Notion
Access your Notion databases and pages.

```
You: "What tasks are in our backlog?"

Claude: [Uses Notion MCP]
        [Lists all items from your Notion backlog database]

You: "Add a new task: 'Implement dark mode'"

Claude: [Creates a new Notion page in the backlog]
```

### 2. GitHub
Query issues, PRs, and repository data.

```
You: "Show me open bugs assigned to me"

Claude: [Fetches issues from GitHub API via MCP]
        [Lists bugs with labels and descriptions]
```

### 3. Web Fetch
Read and analyze web pages.

```
You: "What does the API documentation say about authentication?"

Claude: [Fetches the docs URL via MCP]
        [Reads and summarizes the authentication section]
```

### 4. Filesystem
Advanced file operations beyond Claude's built-in tools.

```
You: "Find all TODO comments in the project"

Claude: [Uses MCP to recursively search the filesystem]
        [Lists all TODOs with line numbers]
```

## Example: Using Notion MCP

Let's say you have a Notion database of technical articles. Here's how Claude Code uses it:

**Step 1: Connect Notion**
Set up the Notion MCP server in your `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-notion"],
      "env": {
        "NOTION_API_KEY": "ntn_..."
      }
    }
  }
}
```

**Step 2: Query Notion from Claude Code**

```
You: "Which articles are about distributed systems?"

Claude: [Queries Notion database via MCP]
        [Filters by tag 'distributed-systems']
        Articles found:
        - Kafka Exactly-once Semantics
        - Raft Consensus Algorithm
        - Two-phase Commit Explained
```

**Step 3: Act on the data**

```
You: "Update our blog README with these articles"

Claude: [Reads the list from Notion]
        [Updates README with latest articles]
        [Commits and pushes the change]
```

## Setting Up Custom MCP Servers

MCP servers are just programs that follow the MCP spec. You can run custom ones:

### Example: Company Wiki MCP

Create a simple Node.js MCP server that reads your internal wiki:

```javascript
// wiki-mcp-server.js
const { Server } = require('@modelcontextprotocol/sdk');

const server = new Server({
  name: 'wiki',
  version: '1.0.0',
});

// Expose wiki search as a tool
server.tool('search-wiki', {
  description: 'Search your internal wiki',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search term' }
    },
    required: ['query']
  },
  handler: async (params) => {
    // Query your wiki API
    const results = await fetch(`https://wiki.company.com/api/search?q=${params.query}`);
    return results.json();
  }
});

server.start();
```

Register it in `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "wiki": {
      "command": "node",
      "args": ["/path/to/wiki-mcp-server.js"]
    }
  }
}
```

Now Claude Code can search your wiki:

```
You: "What's our policy on database backups?"

Claude: [Searches wiki via MCP]
        [Finds and reads the backup policy document]
```

## Real-world MCP Workflow

Here's how MCP transforms your workflow:

**Before MCP:**
```
You: "Add the features from our Notion board to the backlog"
Claude: I can't access Notion. You'll need to copy-paste them.
```

**With MCP:**
```
You: "Add the features from our Notion board to the backlog"

Claude: [Uses Notion MCP to fetch the board]
        [Reads all items]
        [Creates GitHub issues for each]
        [Posts a summary]
        ✓ Done!
```

**MCP enables context flow:** Notion → Claude Code → Your repo → GitHub

## Common MCP Use Cases

| Use Case | MCP Server | Benefit |
|----------|-----------|---------|
| **Sync docs to code** | Notion | Keep README and code in sync |
| **Auto-create issues** | GitHub | Turn Notion tasks into GitHub issues |
| **Reference web docs** | Web Fetch | Cite official docs while coding |
| **Query databases** | Custom | Access business logic and requirements |
| **Search internal tools** | Custom | Find examples in your codebase |

## Limitations & Best Practices

**Limitations:**
- MCP adds latency (network calls)
- Servers must be running and authenticated
- Complex operations need careful permission handling

**Best practices:**
- Keep MCP operations concise (don't fetch 1000 rows)
- Use MCP to **gather context**, not as your only tool
- Combine with local file operations for speed
- Test MCP workflows before relying on them in CI/CD

## Next: Building Reusable Skills

MCP connects you to external data. **Skills** let you create reusable, shareable tools that combine multiple tools and MCP servers into one command.

**Next:** [Part 5 — Building Claude Skills](/blog/claude-code-series-5-claude-skill)
