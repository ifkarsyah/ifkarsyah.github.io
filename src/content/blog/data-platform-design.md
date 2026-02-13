---
title: "Designing a Data Platform That Doesn't Rot"
description: "Lessons from building internal data platforms: what makes them last, what kills them, and the principles I try to apply."
pubDate: 2023-08-05
author: "ifkarsyah"
tags: ["Data Platform", "Infrastructure", "Architecture"]
image:
  url: "https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=800"
  alt: "Infrastructure architecture"
---

## Why Data Platforms Rot

Most data platforms start with good intentions and end up as a tangle of undocumented pipelines, mystery tables, and "just don't touch it" jobs that everyone is afraid to change. I've seen this pattern enough times to recognize it early.

The rot usually starts with the same few antipatterns.

## Antipattern 1: No Ownership Model

If everyone owns the data platform, nobody owns the data platform. Tables accumulate with no owner. Pipelines break and nobody knows who should fix them. Deprecated columns live forever because removing them might break something.

Fix: Every table and pipeline should have an explicit owner — a team, not an individual. Ownership lives in metadata, not in people's heads.

## Antipattern 2: Schema as an Afterthought

The most expensive migrations are the ones where you realize six months in that a column means something different to different teams, or that a field that should be a timestamp is stored as a string.

Fix: Define schemas formally before data flows into them. Use schema registries for streaming data. Enforce types and nullability constraints at write time, not at query time.

## Antipattern 3: No Data Contracts Between Producer and Consumer

When the application team changes an event payload, the data team finds out when their pipeline breaks at 2 AM. This is the most common cause of incident.

Fix: Treat the data your application emits as an API. Version it. Document it. Breaking changes require a deprecation period. Producers should own the contract, consumers should be notified of changes.

## What Good Looks Like

A healthy data platform has:

- **Discoverability** — engineers can find the table they need without asking Slack
- **Reliability** — SLAs are defined and monitored, failures alert the right people
- **Self-service** — teams can onboard new data sources without a ticket to the platform team
- **Lineage** — you can trace where a number came from, all the way back to the source event

None of these are hard technical problems. They are organizational and process problems that require consistent discipline to maintain.

## The Boring Truth

The best data platforms are boring. They use well-understood tools, have simple mental models, and optimize for the engineer reading the code six months from now — not the engineer writing it today.

Resist the urge to adopt every new tool. A well-operated Airflow + dbt + Spark setup beats a half-implemented modern data stack with five new tools nobody understands.
