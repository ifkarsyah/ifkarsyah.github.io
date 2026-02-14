---
title: "Kanjigen — Kanji Learning Roadmap Generator"
description: "A Jupyter Notebook tool that generates optimal learning roadmaps for a given kanji list, ordering characters by component dependencies."
date: 2021-03-27
tags: ["Python", "Jupyter Notebook", "NLP", "Japanese"]
link: "https://github.com/ifkarsyah/kanjigen"
image: ""
featured: false
---

## Overview

**Kanjigen** generates a learning roadmap for a list of kanji characters. Instead of learning kanji in random order, it figures out which characters to learn first based on their component radicals — so you always learn the building blocks before the compound characters that use them.

Given a target kanji list (e.g., JLPT N3), it outputs a dependency-sorted sequence: learn `木` before `森`, learn `日` before `明`, and so on.

## How It Works

1. Parse each kanji into its component radicals/primitives
2. Build a dependency graph: kanji A depends on kanji B if B is a component of A
3. Topological sort the graph to produce a valid learning order
4. Output the ordered list with annotations

## Tech Stack

- **Python** — graph construction and topological sort
- **Jupyter Notebook** — interactive exploration and visualization
- **Kanji decomposition data** — component/radical mappings
