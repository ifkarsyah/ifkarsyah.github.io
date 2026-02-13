---
title: "CLI Task Manager"
description: "A fast terminal-based task management tool with project tracking, time logging, and markdown export."
date: 2023-05-20
tags: ["Go", "CLI", "Open Source"]
link: "https://github.com/ifkarsyah/taskr"
image: ""
featured: false
---

## Overview

A terminal-first task manager built for developers who live in the command line. Supports projects, priorities, time tracking, and exports to markdown.

## Features

- **Projects** – Organize tasks under projects with tags and statuses
- **Time Tracking** – Built-in timer with start/stop/log commands
- **Markdown Export** – Export project status as formatted markdown reports
- **Fuzzy Search** – Instantly find tasks with fuzzy matching
- **Shell Completion** – Bash, Zsh, and Fish completions included

## Quick Start

```bash
# Install
go install github.com/ifkarsyah/taskr@latest

# Add a task
taskr add "Implement rate limiting" --project api-gateway --priority high

# List tasks
taskr list --project api-gateway

# Start timer
taskr timer start <task-id>
```

## Why

Built out of frustration with heavy GUI tools and cloud-dependent apps. Everything is stored locally as SQLite — fast, offline, and private.
