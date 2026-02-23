---
title: "Dotfiles — Personal Dev Environment Config"
description: "Personal dotfiles managed with GNU Stow, covering zsh, vim, VSCode, git, SSH, Docker, and macOS package management via Brewfile."
date: 2025-10-19
domain: "Backend"
stack: ["Rust"]
link: "https://github.com/ifkarsyah/dotfiles"
image: ""
featured: false
---

## Overview

A version-controlled collection of personal configuration files managed with **GNU Stow**. Each tool's config lives in its own directory and gets symlinked to the right location with a single command.

## Covered Tools

| Config | Tool |
|--------|------|
| `.zshrc`, `.bashrc` | Shell (zsh/bash) |
| `.vimrc` | Vim |
| `settings.json`, `keybindings.json` | VSCode |
| `.gitconfig`, `.gitignore_global` | Git |
| `config` | SSH |
| `daemon.json` | Docker |
| `Brewfile` | macOS packages (Homebrew) |

## Setup

```sh
git clone https://github.com/ifkarsyah/dotfiles ~/.dotfiles
cd ~/.dotfiles
stow zsh vim git vscode
```

GNU Stow creates symlinks from `~/.dotfiles/<tool>/` into `$HOME`, keeping everything tracked in one repo.
