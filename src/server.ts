import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { randomUUID } from "node:crypto"
import {
  appendHandoff,
  consumeHandoffs,
  loadState,
  patchNode,
  pendingHandoffs,
  saveState,
  upsertNode,
} from "./shared/store.js"
import { ensureLineage } from "./shared/tree.js"
import { createSession, deleteSession, getMessages, promptText, toMessageLite } from "./shared/client.js"
import type { HandoffMeta } from "./shared/types.js"

const id = "session-tree"

type Config = {
  summaryModel?: {
    providerID: string
    modelID: string
  }
  summaryPrompt?: string
  summaryMaxInputMessages: number
  summaryMaxChars: number
}

const SUMMARY_SYSTEM = [
  "You are a branch summarizer.",
  "Never call tools.",
  "Output only requested markdown structure.",
  "Be concise and concrete.",
].join(" ")

const SUMMARY_AGENT = "summary"

const SUMMARY_PROMPT = `Create structured summary of this branch work for context handoff.

Summarize ONLY branch delta after fork point (what is different vs parent/shared history).
Do NOT restate context that exists before fork point.

Use this EXACT format:

## Goal
[What user trying accomplish in this branch]

## Constraints & Preferences
- [constraints/preferences/requirements]
- [(none) if none]

## Progress
### Done
- [x] [completed tasks/changes]

### In Progress
- [ ] [started but not finished]

### Blocked
- [blocking issues, if any]

## Key Decisions
- **[Decision]**: [short rationale]

## Next Steps
1. [best next action to continue work]

Keep concise. Preserve exact file paths, function names, error messages.`

const server: Plugin = async (ctx, options) => {
  const base = pickBase(ctx.worktree, ctx.directory)
  const cfg = parseConfig(options)

  const ensure = async (sessionID: string) => {
    const state = await loadState(base)
    await ensureLineage(ctx.client as never, state, sessionID)
    await saveState(base, state)
  }

  const hooks: Hooks = {
    event: async ({ event }) => {
      const sid = eventSessionID(event)
      if (event.type === "session.deleted" && sid) {
        const state = await loadState(base)
        delete state.nodes[sid]
        state.handoffs = state.handoffs.filter(
          (h) => h.fromSessionID !== sid && h.toSessionID !== sid,
        )
        await saveState(base, state)
      }
    },

    "chat.message": async ({ sessionID }) => {
      await patchNode(base, sessionID, { lastVisitedAt: Date.now() })
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const state = await loadState(base)
      const queued = state.handoffs.filter((h) => h.toSessionID === input.sessionID && h.status === "pending")
      if (!queued.length) return

      let changed = false
      for (const handoff of queued) {
        const mode = handoff.mode ?? inferMode(handoff)
        if (handoff.mode !== mode) {
          handoff.mode = mode
          changed = true
        }
        if (mode !== "summary") continue
        if (handoff.summaryStatus === "ready" && handoff.text?.trim()) continue
        const built = await buildSummary(ctx.client as never, state, handoff, cfg)
        if (built.text?.trim()) handoff.text = built.text
        if (!built.text?.trim()) delete handoff.text
        handoff.summaryStatus = built.error ? "failed" : "ready"
        handoff.summaryError = built.error
        changed = true
      }
      if (changed) await saveState(base, state)

      const ready = state.handoffs.filter((h) => h.toSessionID === input.sessionID && h.status === "pending" && canInject(h))
      if (!ready.length) return
      output.system.push(formatHandoffs(ready))
      await consumeHandoffs(
        base,
        input.sessionID,
        ready.map((h) => h.id),
      )
    },
  }

  return hooks
}

const plugin: PluginModule & { id: string } = {
  id,
  server,
}

export default plugin

function formatHandoffs(list: Awaited<ReturnType<typeof pendingHandoffs>>) {
  const body = list
    .map((h) => {
      const tag = h.mode === "summary" ? "[session-tree:summary]" : "[session-tree:raw]"
      const text = h.text && h.text.length > 0 ? h.text : "(empty handoff)"
      return `- from ${h.fromSessionID} @ ${new Date(h.createdAt).toISOString()}\n${tag}\n${text}`
    })
    .join("\n\n")
  return [
    "<system-reminder>",
    "Branch handoff context from other session branch:",
    body,
    "Use as context, continue current branch goals.",
    "</system-reminder>",
  ].join("\n")
}

function canInject(handoff: HandoffMeta) {
  const mode = handoff.mode ?? inferMode(handoff)
  if (mode === "raw") return !!handoff.text?.trim()
  if (!handoff.text?.trim()) return false
  return handoff.summaryStatus === "ready"
}

function inferMode(handoff: HandoffMeta): "summary" | "raw" {
  if (handoff.mode === "summary" || handoff.mode === "raw") return handoff.mode
  if ((handoff.text || "").includes("[session-tree:summary]")) return "summary"
  return "raw"
}

async function buildSummary(client: Parameters<Plugin>[0]["client"], state: Awaited<ReturnType<typeof loadState>>, handoff: HandoffMeta, cfg: Config) {
  const forkID = handoff.sourceForkMessageID || state.nodes[handoff.fromSessionID]?.forkMessageID
  const snap = (handoff.sourceSnapshot || "").trim()
  const convo = snap || (await readBranch(client, handoff.fromSessionID, forkID, cfg.summaryMaxInputMessages, cfg.summaryMaxChars))
  if (!convo.trim()) {
    return {
      error: "source-empty",
    }
  }
  const prompt = [
    "Summarize ONLY conversation that happened AFTER branch point.",
    forkID ? `Branch point message id: ${forkID}` : "Branch point message id: (unknown)",
    "",
    "<conversation>",
    convo,
    "</conversation>",
    "",
    (cfg.summaryPrompt || SUMMARY_PROMPT).trim(),
  ].join("\n")

  try {
    const temp = await createSession(client as never, "session-tree-summary")
    try {
      const text = await promptText(client as never, {
        sessionID: temp.id,
        text: prompt,
        model: cfg.summaryModel,
        agent: SUMMARY_AGENT,
        tools: { "*": false },
        system: SUMMARY_SYSTEM,
      })
      if (!text.trim()) throw new Error("empty-summary")
      return { text }
    } finally {
      await deleteSession(client as never, temp.id).catch(() => undefined)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      error: reason,
    }
  }
}

async function readBranch(
  client: Parameters<Plugin>[0]["client"],
  sessionID: string,
  forkID: string | undefined,
  maxInput: number,
  maxChars: number,
) {
  const raw = await readMessages(client, sessionID)
  const all = raw.map(toMessageLite).filter((x): x is NonNullable<typeof x> => !!x)
  const list = clipBranch(all, forkID, maxInput)
  if (!list.length) return ""
  return serialize(list, maxChars)
}

async function readMessages(client: Parameters<Plugin>[0]["client"], sessionID: string) {
  const first = await getMessages(client as never, sessionID)
  if (first.length) return first
  await wait(180)
  return getMessages(client as never, sessionID)
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clipBranch(list: Array<{ id: string; role: string; text: string }>, forkID: string | undefined, max: number) {
  const take = Math.max(1, max)
  if (!forkID) return list.slice(-take)
  const i = list.findIndex((x) => x.id === forkID)
  if (i < 0) return list.slice(-take)
  return list.slice(i + 1).slice(-take)
}

function serialize(list: Array<{ role: string; text: string }>, maxChars: number) {
  const limit = Math.max(1000, maxChars)
  const lines: string[] = []
  let used = 0
  for (const m of list) {
    const text = (m.text || "(no text)").replace(/\s+/g, " ").trim()
    const cut = text.slice(0, 600)
    const row = `${m.role}: ${cut}`
    if (used + row.length > limit) break
    lines.push(row)
    used += row.length
  }
  return lines.join("\n")
}

function parseConfig(options: Record<string, unknown> | undefined): Config {
  const maxInput = numberOpt(options?.summaryMaxInputMessages, 28)
  const maxChars = numberOpt(options?.summaryMaxChars, 7000)
  const providerID = strOpt(options?.summaryModelProviderID)
  const modelID = strOpt(options?.summaryModelID)
  const summaryModel = providerID && modelID ? { providerID, modelID } : undefined
  return {
    summaryModel,
    summaryPrompt: strOpt(options?.summaryPrompt),
    summaryMaxInputMessages: maxInput,
    summaryMaxChars: maxChars,
  }
}

function strOpt(input: unknown) {
  if (typeof input !== "string") return
  const value = input.trim()
  return value || undefined
}

function numberOpt(input: unknown, fallback: number) {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) return Math.floor(input)
  if (typeof input === "string") {
    const parsed = Number(input)
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return fallback
}

function pickBase(worktree: string, directory: string) {
  if (worktree && worktree !== "/") return worktree
  return directory
}

function eventSessionID(event: unknown) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return
  const wrap = event as { properties?: unknown }
  if (!wrap.properties || typeof wrap.properties !== "object" || Array.isArray(wrap.properties)) return
  const properties = wrap.properties as Record<string, unknown>
  if (typeof properties.sessionID === "string") return properties.sessionID
  if (!properties.info || typeof properties.info !== "object" || Array.isArray(properties.info)) return
  const info = properties.info as Record<string, unknown>
  if (typeof info.id !== "string") return
  return info.id
}
