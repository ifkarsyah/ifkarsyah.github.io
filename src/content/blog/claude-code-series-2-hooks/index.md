---
title: "Claude Code Series, Part 2: Hooks — Automate Workflows"
description: "Use hooks to automate code formatting, block edits to protected files, get notified when Claude needs input, and enforce project rules."
pubDate: 2026-02-24
author: "ifkarsyah"
domain: "AI Engineering"
stack: ["Claude Code"]
---

## What Are Hooks?

**Hooks** are shell commands that execute at specific points in Claude Code's lifecycle. They provide deterministic control — you decide exactly what happens before file edits, after commands run, when Claude needs input, or when sessions start/end. Unlike relying on Claude to remember your preferences, hooks guarantee certain actions always happen.

With hooks, you can:
- **Auto-format code** after every edit with Prettier
- **Notify you** when Claude is waiting for input
- **Block edits** to sensitive files like `.env` or `.git/`
- **Re-inject context** after conversation compaction
- **Audit changes** to configuration files
- **Validate commands** before they execute

## Hook Lifecycle Events

Hooks fire at key points during Claude Code's execution:

| Event | Fires When | Use Case |
|-------|-----------|----------|
| `SessionStart` | Session begins or resumes | Inject project context |
| `UserPromptSubmit` | You submit a prompt | Validate or enhance input |
| `PreToolUse` | Before a tool runs (can block!) | Protect files, validate commands |
| `PostToolUse` | After a tool succeeds | Auto-format, logging |
| `PermissionRequest` | Permission dialog appears | Auto-allow/deny certain actions |
| `Notification` | Claude needs your attention | Desktop notifications |
| `Stop` | Claude finishes responding | Verify work, ask for continuation |
| `ConfigChange` | Settings change | Audit configuration |
| `SessionEnd` | Session ends | Cleanup, logging |

## Quick Start: Desktop Notifications

The easiest hook to set up notifies you when Claude is waiting for input. Open Claude Code and type `/hooks` to access the interactive menu. Select `Notification`, then copy the command for your OS:

**macOS:**
```bash
osascript -e 'display notification "Claude Code needs your attention" with title "Claude Code"'
```

**Linux:**
```bash
notify-send 'Claude Code' 'Claude Code needs your attention'
```

**Windows (PowerShell):**
```powershell
powershell.exe -Command "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show('Claude Code needs your attention', 'Claude Code')"
```

The `/hooks` menu saves it to `~/.claude/settings.json` automatically. Done!

## Example 1: Auto-format Code After Edits

Automatically run Prettier whenever Claude edits a file:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.file_path' | xargs npx prettier --write"
          }
        ]
      }
    ]
  }
}
```

Add this to `.claude/settings.json` (project-level) or `~/.claude/settings.json` (global). The `matcher: "Edit|Write"` ensures it only runs after file edits, not after all tool calls.

## Example 2: Block Edits to Protected Files

Prevent Claude from accidentally modifying `.env`, `package-lock.json`, or anything in `.git/`:

Create `.claude/hooks/protect-files.sh`:

```bash
#!/bin/bash
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

PROTECTED_PATTERNS=(".env" "package-lock.json" ".git/")

for pattern in "${PROTECTED_PATTERNS[@]}"; do
  if [[ "$FILE_PATH" == *"$pattern"* ]]; then
    echo "Blocked: $FILE_PATH matches protected pattern '$pattern'" >&2
    exit 2
  fi
done

exit 0
```

Make it executable:
```bash
chmod +x .claude/hooks/protect-files.sh
```

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/protect-files.sh"
          }
        ]
      }
    ]
  }
}
```

Now if Claude tries to edit `.env`, it gets blocked with your message, and it adjusts its approach automatically.

## Example 3: Re-inject Context After Compaction

When your conversation gets long, Claude's context window fills up and older messages are summarized. This can lose important details. Use a `SessionStart` hook to re-inject critical context after every compaction:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Reminder: Use Bun instead of npm. Run bun test before committing. Tech stack: Next.js, TypeScript, Tailwind CSS.'"
          }
        ]
      }
    ]
  }
}
```

Any text printed to stdout is added to Claude's context automatically.

## How Hooks Work: Input, Output, and Exit Codes

When a hook fires, Claude Code passes JSON to your script on stdin. Your script reads that JSON, does its work, and tells Claude Code what to do via exit codes:

```bash
#!/bin/bash
INPUT=$(cat)

# Parse JSON input
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

# Make a decision
if echo "$COMMAND" | grep -q "drop table"; then
  echo "Blocked: dropping tables is not allowed" >&2
  exit 2  # Exit 2 = BLOCK the action
fi

exit 0  # Exit 0 = ALLOW the action
```

**Exit codes:**
- **0**: Action proceeds (or context is added if it's a `SessionStart`/`UserPromptSubmit` hook)
- **2**: Action is blocked; your stderr message is shown to Claude
- **Other**: Action proceeds, but output is only logged (visible in verbose mode)

## Hook Matchers: Filter When Hooks Fire

Without a matcher, a hook fires on every occurrence. Matchers narrow it down. For example, auto-format only after file edits:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",  // Only match Edit or Write tools
        "hooks": [{ "type": "command", "command": "prettier --write ..." }]
      }
    ]
  }
}
```

Common matchers:
- **Tool matchers**: `Bash`, `Edit|Write`, `Read`, `Glob`, `Grep`
- **MCP tools**: `mcp__github__.*` (all GitHub tools)
- **Session matchers**: `startup`, `resume`, `clear`, `compact`
- **Notification matchers**: `permission_prompt`, `idle_prompt`

## Hook Locations: Scope and Sharing

Where you place a hook determines its scope:

| Location | Scope | Shared? |
|----------|-------|---------|
| `~/.claude/settings.json` | All your projects | No (local machine only) |
| `.claude/settings.json` | Current project only | Yes (can commit to repo) |
| `.claude/settings.local.json` | Current project | No (gitignored) |
| Plugin/Skill frontmatter | While active | Yes (bundled) |

**Project-level hooks** (`.claude/settings.json`) are best for team conventions — commit them to git so everyone uses the same rules.

## Advanced: Prompt-based and Agent-based Hooks

For decisions that need judgment (not just deterministic rules), use `type: "prompt"` or `type: "agent"` hooks:

**Prompt hook** — uses Claude to evaluate a condition:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Check if all requested tasks are complete. Return {\"ok\": true} or {\"ok\": false, \"reason\": \"what remains\"}."
          }
        ]
      }
    ]
  }
}
```

**Agent hook** — spawns a subagent that can run commands and read files:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "agent",
            "prompt": "Verify all unit tests pass. Run the test suite and check results."
          }
        ]
      }
    ]
  }
}
```

These are powerful for complex decisions that require context.

## Common Patterns

**Log every Bash command:**
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.command' >> ~/.claude/command-log.txt"
          }
        ]
      }
    ]
  }
}
```

**Audit configuration changes:**
```json
{
  "hooks": {
    "ConfigChange": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "jq -c '{timestamp: now | todate, file: .file_path}' >> ~/audit.log"
          }
        ]
      }
    ]
  }
}
```

## Troubleshooting

**Hook not firing?**
- Run `/hooks` to verify it's registered
- Check the matcher pattern matches your tool name exactly (case-sensitive)
- Make sure you're triggering the right event

**JSON parsing error?**
- Ensure your shell profile (`~/.zshrc`) doesn't have unconditional `echo` statements. Wrap them with `if [[ $- == *i* ]]; then ... fi`

**Script error?**
- Test it manually: `echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | ./my-hook.sh`
- Make sure scripts are executable: `chmod +x ./my-hook.sh`

## Next: Custom Slash Commands

With CLAUDE.md, hooks, and customs commands, you can enforce project rules and create shortcuts for common workflows.

**Next:** [Part 3 — Custom Commands & Slash Prompts](/blog/claude-code-series-3-custom-commands)
