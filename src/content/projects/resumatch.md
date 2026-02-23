---
title: "Resumatch — Resume & Job Matching Pipeline"
description: "A three-stage Rust CLI pipeline that scrapes job postings, parses PDF resumes, and identifies skill gaps between a resume and a job description."
date: 2024-10-24
domain: "Frontend"
stack: ["React", "TypeScript", "Vite"]
link: "https://github.com/ifkarsyah/resumatch"
image: ""
featured: false
---

## Overview

**Resumatch** is a Rust-based pipeline for job seekers who want to systematically understand how well their resume fits a given role. It consists of three composable CLI tools that can be run independently or chained together.

## Pipeline

```
job-extractor → resume-parser → resume-matcher
     ↓               ↓               ↓
  job.json      resume.json      gaps.json
```

### 1. `job-extractor`
Scrapes job postings from Lever (a common ATS), extracting the role title, requirements, and responsibilities into structured JSON.

### 2. `resume-parser`
Parses a PDF resume and extracts structured data — skills, experience, education — into JSON.

### 3. `resume-matcher`
Compares the job JSON against the resume JSON and produces a match report: aligned skills, missing skills, and suggested improvements.

## Tech Stack

- **Rust** — all three tools
- **Lever API** — job posting source
- **PDF parsing** — resume extraction
- **JSON** — inter-stage data format
