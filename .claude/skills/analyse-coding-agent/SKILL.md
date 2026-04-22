---
name: analyse-coding-agent
description: >-
  Deep architectural analysis of coding agent codebases, producing structured writeups.
  Use when the user wants to analyse, review, or understand an existing coding agent's
  architecture, design, features, or limitations. Triggers on: "analyse coding agent",
  "analyze agent", "review this agent", "how does this agent work", or when given a
  repo URL / local path to a coding agent codebase for analysis. Also use when comparing
  coding agents or researching agent architectures.
---

# Analyse Coding Agent

Perform deep architectural analysis of a coding agent codebase and produce a structured writeup.

## Input

The user provides one argument: a git repo URL or a local filesystem path.

## Workflow

### 1. Resolve the source

```
if input looks like a URL (contains github.com, gitlab.com, starts with https://, or ends in .git):
    extract repo-name from URL (last path segment, strip .git suffix)
    clone to /tmp/<repo-name> (shallow clone with --depth=1 for speed)
    target_dir = /tmp/<repo-name>
else:
    treat input as local path
    target_dir = resolved absolute path
    extract agent-name from directory name
```

### 2. Explore the codebase

Spawn multiple Explore agents in parallel to cover different analysis dimensions. Each agent should work at "very thorough" depth. All exploration targets `target_dir`.

**Batch 1 — Structure and stack:**
- Agent A: Map the top-level architecture. Identify entry points, core modules, directory structure, build system, language(s), and key dependencies. Look at package.json/Cargo.toml/pyproject.toml/go.mod etc.
- Agent B: Find and analyse the LLM integration layer. How does it call models? Which providers/models are supported? How are prompts constructed, templated, or managed? Is there prompt caching, token counting, or context window management?

**Batch 2 — Agent mechanics:**
- Agent C: Analyse the tool/action system. How does the agent execute code, run shell commands, read/write files, browse the web? What tools are available? How are tools registered, dispatched, and sandboxed?
- Agent D: Analyse planning, reasoning, and control flow. Is it a simple loop, ReAct, tree-of-thought, plan-then-execute? How does it decide what to do next? How does it handle multi-step tasks?

**Batch 3 — Supporting systems:**
- Agent E: Analyse memory, context, and state management. How does it maintain conversation history? Is there persistent memory? How does it handle context window limits (truncation, summarisation, compaction)?
- Agent F: Analyse error handling, recovery, sandboxing, and security. How does it handle tool failures? Does it retry? What security boundaries exist? How is user code isolated?

**Batch 4 — Extensibility:**
- Agent G: Analyse extension points, plugin systems, configuration, and customisation. Can users add tools, modify behaviour, write plugins? How is it configured?

### 3. Synthesise findings

After all exploration completes, synthesise the agents' findings into a single coherent writeup. Resolve contradictions by re-reading specific files if needed.

### 4. Write the report

Write to `writeups/<agent-name>.md` using this structure:

```markdown
# <Agent Name> — Architecture Analysis

> One-paragraph summary: what this agent is, what it's for, and what makes it distinctive.

## Overview

| Attribute | Detail |
|-----------|--------|
| Language | ... |
| LLM Provider(s) | ... |
| License | ... |
| Repository | ... |
| Stars / Activity | ... (if available) |

## Architecture

High-level description of the system design. Include an ASCII diagram if the architecture
has interesting structure. Describe the main execution loop / control flow.

## Core Components

For each major component/module:
### <Component Name>
What it does, how it fits in, key implementation details.
Include short code snippets (< 20 lines) where they illuminate the design.

## LLM Integration

How the agent talks to models. Prompt management, token handling, streaming,
multi-model support, context window strategy.

## Tool System

What tools exist, how they're registered and dispatched, how results flow back.
The execution model for code/shell/file operations.

## Planning & Reasoning

The agent's cognitive architecture. How it decides what to do, decomposes tasks,
handles multi-step workflows. Name the pattern (ReAct, plan-and-execute, etc.)
if one applies.

## Memory & Context Management

Conversation history, persistent memory, context window management,
summarisation/compaction strategies.

## Error Handling & Recovery

How failures are detected, reported, retried. Graceful degradation.

## Security & Sandboxing

Isolation model, permission systems, what's trusted vs untrusted.

## Extensibility

Plugin systems, configuration, hooks, customisation points.

## Dependencies & Tech Stack

Key libraries and why they matter. Build and deployment model.

## Strengths

Bulleted list of what this agent does well or what's notably clever.

## Limitations

Bulleted list of gaps, weaknesses, missing features, or design trade-offs
that constrain the agent. Be honest and specific.

## Key Takeaways for Our Agent

3-5 bullet points on specific ideas, patterns, or lessons worth
adopting or avoiding when building our own coding agent.
```

### 5. Report completion

After writing, tell the user the writeup path and give a 2-3 sentence summary of the most interesting findings.
