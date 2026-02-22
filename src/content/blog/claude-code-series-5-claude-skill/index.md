---
title: "Claude Code Series, Part 5: Building Claude Skills"
description: "Create reusable, shareable automation with Claude Skills."
pubDate: 2026-02-27
author: "ifkarsyah"
tags: ["Claude Code", "AI", "Developer Tools"]
---

## What Are Claude Skills?

A **Claude Skill** is a reusable automation that lives in a `SKILL.md` file. It combines **frontmatter** (configuration) with **markdown instructions** that tell Claude how to do something.

Skills can be invoked two ways:
1. **You invoke them** — Type `/skill-name` to run it manually
2. **Claude invokes them** — Claude detects when a skill is relevant and uses it automatically

Think of them as team knowledge + automation bundled into single commands.

## Key Differences from Slash Commands

| Old Way (slash commands) | New Way (skills) |
|---|---|
| `.claude/commands/foo.md` (text only) | `.claude/skills/foo/SKILL.md` (with frontmatter) |
| You invoke only | You OR Claude can invoke |
| No configuration | Frontmatter controls behavior |
| Static prompt | Can reference supporting files |

## Anatomy of a Skill

Every skill has this structure:

```
~/.claude/skills/my-skill/
├── SKILL.md          # Required: frontmatter + instructions
├── template.md       # Optional: template for output
├── examples/         # Optional: example outputs
└── scripts/          # Optional: executable helpers
```

The `SKILL.md` is the entry point:

```yaml
---
name: explain-code
description: Explains code with visual diagrams and analogies
---

When explaining code, always include:

1. **Start with an analogy**: Compare to something from everyday life
2. **Draw a diagram**: Use ASCII art to show flow or structure
3. **Walk through the code**: Explain step-by-step
4. **Highlight a gotcha**: What's a common misconception?

Keep explanations conversational and visual.
```

That's it. No JSON configs, no parameters object. Just YAML + markdown.

## Example 1: Simple Skill

**Create `~/.claude/skills/explain-code/SKILL.md`:**

```yaml
---
name: explain-code
description: Explains code with visual diagrams and analogies. Use when explaining how code works or teaching about a codebase.
---

When explaining code, always include:

1. **Start with an analogy**: Compare to something from everyday life
2. **Draw a diagram**: Use ASCII art to show the flow or structure
3. **Walk through the code**: Explain step-by-step what happens
4. **Highlight a gotcha**: What's a common mistake or misconception?

Keep it conversational and visual.
```

**Usage:**

```
# You invoke it:
/explain-code src/auth/login.ts

# Or Claude detects it's relevant:
You: "How does this code work?"
Claude: [Automatically uses /explain-code skill]
```

## Example 2: Skill with Arguments

Skills can accept arguments using `$ARGUMENTS`:

**Create `~/.claude/skills/migrate-component/SKILL.md`:**

```yaml
---
name: migrate-component
description: Migrate a component from one framework to another
---

Migrate the `$0` component from `$1` to `$2`.

Requirements:
1. Preserve all existing behavior and tests
2. Keep the same component API
3. Match the target framework's conventions
4. Update all imports and usages
5. Run tests to verify nothing broke

Output:
- Show before/after code snippets
- List any breaking changes
- Explain framework-specific patterns used
```

**Usage:**

```
/migrate-component SearchBar React Vue
# $0 = SearchBar, $1 = React, $2 = Vue
```

## Frontmatter Reference

Control skill behavior with these frontmatter fields:

| Field | Purpose |
|-------|---------|
| `name` | Becomes the `/slash-command` |
| `description` | Tells Claude when to use the skill |
| `disable-model-invocation: true` | Only you can invoke (good for `/deploy`, `/commit`) |
| `user-invocable: false` | Only Claude can invoke (good for background knowledge) |
| `allowed-tools` | Limit which tools Claude can use (e.g., `Read, Grep` for read-only) |
| `context: fork` | Run in isolated subagent (separate context, no conversation history) |
| `agent` | Which subagent type (`Explore`, `Plan`, `general-purpose`) |

### Example: Deploy Skill

Only you should trigger deployments, not Claude:

```yaml
---
name: deploy
description: Deploy the application to production
disable-model-invocation: true
---

Deploy the application:
1. Run the test suite
2. Build the application
3. Push to the deployment target
4. Verify the deployment succeeded
```

Now Claude can't accidentally deploy because your code looks good.

### Example: Read-only Research Skill

This skill only reads files, never modifies them:

```yaml
---
name: codebase-audit
description: Audit the codebase for security issues
allowed-tools: Read, Grep, Glob
---

Scan the codebase for security issues:

1. Find hardcoded passwords or API keys
2. Check for SQL injection vulnerabilities
3. Look for missing input validation
4. Identify insecure dependency versions

Report findings with file and line numbers.
```

## Example 3: Skill with Supporting Files

For complex workflows, organize files in the skill directory:

```
~/.claude/skills/test-coverage/
├── SKILL.md
├── report-template.md
├── examples/
│   └── good-coverage.md
└── scripts/
    └── analyze.js
```

**SKILL.md references the supporting files:**

```yaml
---
name: test-coverage
description: Analyze test coverage and suggest improvements
allowed-tools: Bash(npm test)
---

# Analyze Test Coverage

Analyze test coverage for this project:

1. Read `.nycrc` or `jest.config.js` to understand test setup
2. Run `npm run test -- --coverage`
3. Parse the coverage report
4. Identify files below 80% coverage
5. Suggest 3 ways to improve coverage

For the format of your report, see [report-template.md](report-template.md).
For examples of well-structured coverage reports, see [examples/](examples/).
```

Claude can load these files when needed. They keep your `SKILL.md` focused and clean.

## Using `$ARGUMENTS` for Dynamic Context

Skills support variable substitution. This skill fetches live PR data:

```yaml
---
name: pr-summary
description: Summarize changes in a pull request
allowed-tools: Bash(gh *)
---

Summarize this pull request:

## PR Diff
!`gh pr diff`

## Changed Files
!`gh pr diff --name-only`

## Comments
!`gh pr view --comments`

## Your Task
Summarize the changes, flag potential issues, and suggest improvements.
```

The `!`command`\` syntax runs before Claude sees it. The output gets inserted inline, so Claude gets real data, not the command.

## Where Skills Live

| Location | Scope | Path |
|----------|-------|------|
| Personal | All projects | `~/.claude/skills/my-skill/SKILL.md` |
| Project | This repo only | `.claude/skills/my-skill/SKILL.md` |
| Enterprise | Organization-wide | Via managed settings |

**Best practice:** Put team-wide skills in the project repo under `.claude/skills/`.

## Real-world Skill Example

Here's a skill that combines multiple tools and decision logic:

**`.claude/skills/code-review/SKILL.md`:**

```yaml
---
name: code-review
description: Perform a thorough code review
allowed-tools: Read, Grep, Bash(npm test)
---

# Code Review

Perform a thorough review of the changes:

## Checklist
- [ ] Does it follow our code style? (Check CLAUDE.md)
- [ ] Are there any logic errors or edge cases missed?
- [ ] Is error handling appropriate?
- [ ] Are there any security concerns?
- [ ] Would a simpler approach work?
- [ ] Are tests included and sufficient?

## Steps
1. Read the files that changed
2. Understand the intent by reading related code
3. Run the test suite if possible
4. Flag any issues with line numbers and severity
5. Suggest improvements

## Output Format
- **Critical**: Must fix before merge
- **Important**: Should fix before merge
- **Nice to have**: Consider for future
```

**Usage:**

```
/code-review
# Claude reads git diff and reviews your changes
```

## Controlling Invocation

Three scenarios:

**1. You trigger, Claude doesn't:**
```yaml
disable-model-invocation: true
```
Use for `/commit`, `/deploy`, `/send-slack-message` — side effects you control.

**2. Claude triggers, you can't:**
```yaml
user-invocable: false
```
Use for background knowledge like "legacy-system-context" that Claude should know about.

**3. Both (default):**
```yaml
# No restrictions
```
Claude can use it automatically, or you can invoke with `/skill-name`.

## Advanced: Skills in Subagents

Run a skill in isolated context with `context: fork`:

```yaml
---
name: deep-research
description: Research a topic thoroughly
context: fork
agent: Explore
---

Research `$ARGUMENTS` thoroughly:

1. Find all relevant files using Glob and Grep
2. Read and analyze the code
3. Summarize findings with specific file references
4. List key files and patterns

Be specific. Include file paths and line numbers.
```

This skill runs in a fresh context with the `Explore` agent (optimized for code search). It won't have your conversation history but gets focused tools for deep research.

## Best Practices

### 1. **Clear descriptions**
Claude uses descriptions to decide when to invoke. Be specific:

```yaml
# Bad:
description: "Help with code"

# Good:
description: "Refactor code to be more readable"
```

### 2. **Explicit steps**
Tell Claude exactly what to do:

```markdown
When reviewing a PR:
1. Check for common mistakes (null checks, error handling)
2. Verify test coverage increased
3. Flag security concerns
4. Suggest performance improvements
```

### 3. **Use CLAUDE.md for context**
Don't repeat your team's conventions in every skill. Reference CLAUDE.md:

```markdown
Follow the conventions in CLAUDE.md.
Review against:
- Code style
- Architecture patterns
- Testing standards
```

### 4. **Restrict tools when appropriate**
```yaml
allowed-tools: Read, Grep
```
Read-only audit? Prevent modifications.

### 5. **Organize with supporting files**
Keep SKILL.md under 500 lines. Move detailed docs to separate files.

## Next: Best Practices Across Everything

You now know how to extend Claude Code (CLAUDE.md, skills, MCP). The final part brings it all together with best practices and real-world patterns.

**Next:** [Part 6 — Best Practices & Real-world Tips](/blog/claude-code-series-6-best-practices)
