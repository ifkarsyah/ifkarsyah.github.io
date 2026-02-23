---
title: "Langkah — AI Travel Blog & Planner"
description: "A travel platform combining curated first-hand blog content organized by region, country, and city with an AI-powered itinerary planner chatbot."
date: 2025-01-01
domain: "AI Engineering"
stack: ["Python"]
link: "https://langkah.vercel.app/"
image: ""
featured: true
---

## Overview

**Langkah** (Indonesian for "step") is a travel platform built around two core experiences: authentic travel stories from the road, and an AI-powered planner that uses those stories as context to help users plan their next trip.

The blog is organized in a Region → Country → City hierarchy, with each city covered across five categories — Food, Transportation, Nature, First Day, and Other. The AI chatbot is grounded in this real content, giving recommendations that go beyond generic travel advice.

## Features

### Travel Blog
- **Hierarchical structure** – Posts organized by Region → Country → City for easy navigation
- **Five categories per city** – Food, Transportation, Nature, First Day, and Other
- **Multi-level filtering** – Filter simultaneously by region, country, city, and category
- **Responsive card grid** – Clean layout with images, summaries, and category badges
- **Countries covered** – Japan, China, Qatar, UAE, Germany, and Southeast Asia destinations

### AI Travel Planner
- **Chat interface** – Conversational UI powered by Google AI Studio
- **Blog-grounded responses** – Chatbot has access to all blog content for authentic, specific advice
- **Personalized planning** – Considers budget, trip duration, interests, and travel style
- **Itinerary generation** – Day-by-day plans with activity suggestions

## Tech Stack

- **React 18** + TypeScript — component-driven UI
- **Vite** — fast build tooling
- **Tailwind CSS** + **shadcn/ui** — utility-first styling with pre-built accessible components
- **React Router** — client-side routing
- **TanStack Query** — data fetching and caching
- **Framer Motion** — smooth page and element animations
- **Google AI Studio** — chatbot backend
- **Vercel** — deployment and hosting

## Architecture

Blog content is structured as TypeScript data files organized by geography (`posts/east-asia/tokyo.ts`, `posts/europe/berlin.ts`, etc.), making it straightforward to add new destinations. The chatbot receives the full blog corpus as context, allowing it to reference specific posts when making recommendations.

```
src/data/posts/
├── east-asia/
│   ├── tokyo.ts
│   ├── kyoto.ts
│   └── beijing.ts
├── middle-east/
│   ├── doha.ts
│   └── dubai.ts
├── europe/
└── southeast-asia/
```

## Pages

| Route | Purpose |
|-------|---------|
| `/` | Hero + featured posts + stats |
| `/blog` | Filterable blog listing |
| `/blog/:slug` | Individual post |
| `/travel-planner` | AI chatbot interface |
| `/about` | About the project |
