# OpenCode BranchFlow

Branching workflow for OpenCode.

Goal: usable branching, switching, and handoff summaries without core patches.

## What It Does

- Adds `/tree` for branch and session tree navigation
- Adds `/branch` to fork from the selected message
- Adds branch labels and notes
- Adds AI handoff summaries when switching branches
- Injects pending handoff summaries into system context on the next turn

## Model

- Pi-style tools usually switch `leaf` inside one session file
- This plugin uses **session-per-branch** with `session.fork` plus tree overlay metadata

Usable, not identical.

## Install

Published package:

- `@exloz/opencode-branchflow`

Package exports two entrypoints:

- `./server`
- `./tui`

Add it directly to OpenCode config:

```jsonc
// .opencode/tui.json
{
  "plugin": ["@exloz/opencode-branchflow@0.1.0"]
}
```

```jsonc
// .opencode/opencode.json
{
  "plugin": ["@exloz/opencode-branchflow@0.1.0"]
}
```

Or install it through OpenCode:

```bash
opencode plugin @exloz/opencode-branchflow@0.1.0
```

## Commands

- `/tree` — open tree dialog, switch branch, branch from node, label, note
- `/branch` — pick message in current session and fork

## Data Storage

Plugin persists state in:

`.opencode/plugins/session-tree/state.json`

State includes:

- node metadata (`label`, `note`, `forkMessageID`, etc.)
- pending/consumed handoff notes

## Summary Model Config

You can configure which model generates branch summaries (`Switch + share summary`) in server plugin config.

```jsonc
// .opencode/opencode.json
{
  "plugin": [
    [
      "@exloz/opencode-branchflow@0.1.0",
      {
        "summaryModelProviderID": "anthropic",
        "summaryModelID": "claude-3-5-sonnet-latest",
        "summaryMaxInputMessages": 28,
        "summaryMaxChars": 7000,
        "summaryPrompt": "" // optional override
      }
    ]
  ]
}
```

Notes:

- Summary is generated server-side when switching to target branch.
- Scope is post-fork activity (messages after branch point) when fork anchor is available.
- Summary is intended to be model-generated, not a heuristic fallback.

## Build

```bash
npm install
npm run typecheck
npm run build
```
