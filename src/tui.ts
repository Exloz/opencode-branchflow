import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { randomUUID } from "node:crypto"
import { appendHandoff, loadState, patchNode, saveState, upsertNode } from "./shared/store.js"
import { forkSession, getMessages, getSession, sendPromptAsync, toMessageLite } from "./shared/client.js"
import { buildTreeView, collectMetaTree, ensureLineage, flatten, repairRoots, rootFor } from "./shared/tree.js"

const id = "session-tree"

const tui: TuiPlugin = async (api) => {
  const base = pickBase(api.state.path.worktree, api.state.path.directory)
  let active = readActive(api)

  api.event.on("tui.session.select", (event) => {
    active = event.properties.sessionID
  })

  api.command.register(() => [
    {
      title: "Session tree",
      value: "session-tree.open",
      category: "Session",
      slash: { name: "tree" },
      onSelect() {
        void run(api, async () => openTree(api, base, active), "Could not open session tree")
      },
    },
    {
      title: "Branch from message",
      value: "session-tree.branch",
      category: "Session",
      slash: { name: "branch" },
      onSelect() {
        void run(api, async () => branchFromDialog(api, base, active), "Could not open branch dialog")
      },
    },
    {
      title: "Set branch label",
      value: "session-tree.label",
      category: "Session",
      slash: { name: "branch-label" },
      onSelect() {
        void run(api, async () => setLabel(api, base, active), "Could not set branch label")
      },
    },
    {
      title: "Set branch note",
      value: "session-tree.note",
      category: "Session",
      slash: { name: "branch-note" },
      onSelect() {
        void run(api, async () => setNote(api, base, active), "Could not set branch note")
      },
    },
    {
      title: "List branch handoffs",
      value: "session-tree.handoff-list",
      category: "Session",
      slash: { name: "handoff-list" },
      onSelect() {
        void run(api, async () => openHandoffList(api, base), "Could not list handoffs")
      },
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin

async function openTree(api: Parameters<TuiPlugin>[0], base: string, activeHint: string) {
  const current = activeHint || readActive(api)
  if (!current) {
    api.ui.toast({ variant: "warning", message: "No active session" })
    return
  }
  const state = await loadState(base)
  await ensureLineage(api.client as never, state, current)
  const rootID = rootFor(state, current)
  repairRoots(state, rootID)
  await saveState(base, state)
  const tree = await collectMetaTree(api.client as never, state, rootID, current)
  const view = buildTreeView(tree.sessions, state.nodes, rootID, current, tree.parent)
  const rows = flatten(view.nodes)
  if (!rows.length) {
    api.ui.toast({ variant: "warning", message: "No tracked branches yet. Use /branch first." })
    return
  }
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Session Tree",
      options: rows.map((node) => {
        const isActive = node.info.id === current
        const isPath = view.activePath.has(node.info.id)
        const label = node.meta.label ? ` [${node.meta.label}]` : ""
        const marker = isActive ? "◉" : isPath ? "•" : "○"
        return {
          title: `${"  ".repeat(node.depth)}${marker} ${node.info.title}${label}`,
          description: node.info.id,
          value: node.info.id,
        }
      }),
      onSelect(opt) {
        void run(api, async () => nodeActions(api, base, current, String(opt.value)), "Could not open node actions")
      },
    }),
  )
}

async function nodeActions(api: Parameters<TuiPlugin>[0], base: string, from: string, to: string) {
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Branch Action",
      options: [
        { title: "Switch branch", value: "switch" },
        { title: "Switch + share summary", value: "switch_summary" },
        { title: "Switch + share raw", value: "switch_raw" },
        { title: "Branch from message", value: "branch" },
      ],
      onSelect(opt) {
        const value = String(opt.value)
        if (value === "switch") {
          api.ui.dialog.clear()
          api.route.navigate("session", { sessionID: to })
          return
        }
        if (value === "switch_summary") {
          void run(api, async () => shareAndSwitch(api, base, from, to, "summary"), "Could not share summary")
          return
        }
        if (value === "switch_raw") {
          void run(api, async () => shareAndSwitch(api, base, from, to, "raw"), "Could not share raw context")
          return
        }
        if (value === "branch") {
          void run(api, async () => branchFromDialog(api, base, to), "Could not open branch dialog")
          return
        }
      },
    }),
  )
}

async function shareAndSwitch(
  api: Parameters<TuiPlugin>[0],
  base: string,
  from: string,
  to: string,
  mode: "summary" | "raw",
) {
  if (mode === "summary") {
    const state = await loadState(base)
    const sourceForkMessageID = state.nodes[from]?.forkMessageID
    const raw = await getMessages(api.client as never, from)
    const list = raw.map(toMessageLite).filter((x): x is NonNullable<typeof x> => !!x)
    const sourceSnapshot = buildSnapshot(list, sourceForkMessageID)
    api.ui.dialog.clear()
    api.route.navigate("session", { sessionID: to })
    await appendHandoff(base, {
      id: randomUUID(),
      fromSessionID: from,
      toSessionID: to,
      mode: "summary",
      sourceForkMessageID,
      sourceSnapshot,
      summaryStatus: "pending",
      createdAt: Date.now(),
      status: "pending",
    })
    api.ui.toast({
      variant: "info",
      message: "Summary queued. It will auto-inject on next prompt in target branch.",
    })
    return
  }

  const raw = await getMessages(api.client as never, from)
  const list = raw.map(toMessageLite).filter((x): x is NonNullable<typeof x> => !!x)
  if (!list.length) {
    api.ui.toast({ variant: "warning", message: "No source messages to share" })
    return
  }
  const draft = buildRaw(list)
  const tag = "[session-tree:raw]"
  const text = `${tag}\n${draft}`
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Share raw context to branch",
      value: text,
      placeholder: "Edit context before sending",
      onConfirm(input) {
        const note = (input || "").trim() || text.trim()
        api.ui.dialog.clear()
        api.route.navigate("session", { sessionID: to })
        if (!note) return
        void run(api, async () => {
          await appendHandoff(base, {
            id: randomUUID(),
            fromSessionID: from,
            toSessionID: to,
            text: note,
            mode: "raw",
            createdAt: Date.now(),
            status: "pending",
          })
          api.ui.toast({
            variant: "info",
            message: "Context queued. It will auto-inject on next prompt in target branch.",
          })
        }, "Switched, but could not queue shared context")
      },
      onCancel() {
        api.ui.dialog.clear()
      },
    }),
  )
}

async function branchFromDialog(api: Parameters<TuiPlugin>[0], base: string, activeHint: string) {
  const sessionID = activeHint || readActive(api)
  if (!sessionID) {
    api.ui.toast({ variant: "warning", message: "No active session" })
    return
  }
  const raw = await getMessages(api.client as never, sessionID)
  const rows = raw.map(toMessageLite).filter((x): x is NonNullable<typeof x> => !!x)
  if (!rows.length) {
    api.ui.toast({ variant: "warning", message: "No messages in session" })
    return
  }
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Fork from message",
      options: rows.map((m) => ({
        title: `${m.role}: ${short(m.text || "(no text)")}`,
        description: m.id,
        value: m.id,
      })),
      onSelect(opt) {
        const id = String(opt.value)
        const msg = rows.find((x) => x.id === id)
        if (!msg) return
        const cut = forkCut(rows, msg)
        void run(
          api,
          async () => createBranch(api, base, sessionID, msg.id, cut, msg.role, msg.text),
          "Could not create branch",
        )
      },
    }),
  )
}

async function createBranch(
  api: Parameters<TuiPlugin>[0],
  base: string,
  sourceSessionID: string,
  forkMessageID: string,
  cutID: string | undefined,
  role: string,
  text: string,
) {
  const state = await loadState(base)
  await ensureLineage(api.client as never, state, sourceSessionID)
  const rootID = rootFor(state, sourceSessionID)
  const child = await forkSession(api.client as never, sourceSessionID, cutID)
  const fork = nextFork(state, sourceSessionID)
  await updateTitle(api, child.id, await forkTitle(api, state, sourceSessionID, fork))
  state.nodes[child.id] = {
    sessionID: child.id,
    rootSessionID: rootID,
    parentSessionID: sourceSessionID,
    forkMessageID,
    forkMessageRole: role === "user" ? "user" : "assistant",
    lastVisitedAt: Date.now(),
  }
  await saveState(base, state)
  api.ui.dialog.clear()
  if (role === "user") {
    api.ui.dialog.replace(() =>
      api.ui.DialogPrompt({
        title: "First message in new branch",
        value: text,
        placeholder: "Edit and send first branch message",
        onConfirm(input) {
          api.ui.dialog.clear()
          api.route.navigate("session", { sessionID: child.id })
          void run(
            api,
            async () => sendPromptAsync(api.client as never, child.id, input),
            "Branch created, but sending first message failed",
          )
        },
        onCancel() {
          api.ui.dialog.clear()
          api.route.navigate("session", { sessionID: child.id })
        },
      }),
    )
    return
  }
  api.route.navigate("session", { sessionID: child.id })
}

async function setLabel(api: Parameters<TuiPlugin>[0], base: string, activeHint: string) {
  const sessionID = activeHint || readActive(api)
  if (!sessionID) {
    api.ui.toast({ variant: "warning", message: "No active session" })
    return
  }
  const state = await loadState(base)
  await ensureLineage(api.client as never, state, sessionID)
  await saveState(base, state)
  const cur = state.nodes[sessionID]
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Branch label",
      value: cur?.label ?? "",
      placeholder: "ex: investigate-race",
      onConfirm(value) {
        void upsertNode(base, {
          sessionID,
          rootSessionID: cur?.rootSessionID ?? sessionID,
          parentSessionID: cur?.parentSessionID,
          forkMessageID: cur?.forkMessageID,
          forkMessageRole: cur?.forkMessageRole,
          note: cur?.note,
          label: value.trim() || undefined,
          lastVisitedAt: Date.now(),
        }).then(() => {
          api.ui.dialog.clear()
          api.ui.toast({ variant: "success", message: "Branch label saved" })
        })
      },
      onCancel() {
        api.ui.dialog.clear()
      },
    }),
  )
}

async function setNote(api: Parameters<TuiPlugin>[0], base: string, activeHint: string) {
  const sessionID = activeHint || readActive(api)
  if (!sessionID) {
    api.ui.toast({ variant: "warning", message: "No active session" })
    return
  }
  const state = await loadState(base)
  await ensureLineage(api.client as never, state, sessionID)
  await saveState(base, state)
  const cur = state.nodes[sessionID]
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Branch note",
      value: cur?.note ?? "",
      placeholder: "Manual handoff/context note",
      onConfirm(value) {
        void patchNode(base, sessionID, {
          note: value.trim() || undefined,
          lastVisitedAt: Date.now(),
        }).then(() => {
          api.ui.dialog.clear()
          api.ui.toast({ variant: "success", message: "Branch note saved" })
        })
      },
      onCancel() {
        api.ui.dialog.clear()
      },
    }),
  )
}

async function openHandoffList(api: Parameters<TuiPlugin>[0], base: string) {
  const state = await loadState(base)
  const rows = [...state.handoffs].sort((a, b) => b.createdAt - a.createdAt)
  if (!rows.length) {
    api.ui.toast({ variant: "info", message: "No handoffs yet" })
    return
  }
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Handoffs",
      options: rows.map((h) => {
        const mode = h.mode ?? ((h.text || "").includes("[session-tree:summary]") ? "summary" : "raw")
        const state = h.summaryStatus ? `/${h.summaryStatus}` : ""
        const tag = `${h.status} · ${mode}${state}`
        return {
          title: `${tag} · ${new Date(h.createdAt).toLocaleString()}`,
          description: `${short(h.fromSessionID, 16)} → ${short(h.toSessionID, 16)} · ${h.id}`,
          value: h.id,
        }
      }),
      onSelect(opt) {
        const id = String(opt.value)
        const handoff = rows.find((x) => x.id === id)
        if (!handoff) return
        const mode = handoff.mode ?? ((handoff.text || "").includes("[session-tree:summary]") ? "summary" : "raw")
        const meta = detailMeta(handoff, mode)
        const body = detailBody(handoff, mode)
        api.ui.dialog.replace(() =>
          api.ui.DialogPrompt({
            title: "Handoff detail",
            value: `${meta}\n\n---\n\n${body}`,
            placeholder: "Press enter or esc to close",
            onConfirm() {
              api.ui.dialog.clear()
            },
            onCancel() {
              api.ui.dialog.clear()
            },
          }),
        )
      },
    }),
  )
}

function detailBody(
  handoff: {
    text?: string
    status: string
    summaryStatus?: string
    sourceSnapshot?: string
  },
  mode: "summary" | "raw",
) {
  if (handoff.text && handoff.text.length > 0) return clipBlock(handoff.text, 20, 1200)
  if (mode === "summary" && handoff.status === "pending") {
    const snap = (handoff.sourceSnapshot || "").trim()
    if (!snap) return "Summary pending. Will generate and inject on next prompt in target branch."
    return [
      "Summary pending. Will generate and inject on next prompt in target branch.",
      "",
      "Snapshot captured from source branch:",
      clipBlock(snap, 8, 600),
    ].join("\n")
  }
  return "(empty handoff)"
}

function detailMeta(
  handoff: {
    id: string
    status: string
    summaryStatus?: string
    summaryError?: string
    fromSessionID: string
    toSessionID: string
    createdAt: number
  },
  mode: "summary" | "raw",
) {
  const from = short(handoff.fromSessionID, 18)
  const to = short(handoff.toSessionID, 18)
  const at = new Date(handoff.createdAt).toISOString()
  const status = handoff.summaryStatus ? `${handoff.status}/${handoff.summaryStatus}` : handoff.status
  const base = [`${mode} · ${status}`, `from ${from} -> ${to}`, at, `id ${short(handoff.id, 24)}`]
  if (handoff.summaryError) base.push(`error ${short(handoff.summaryError, 80)}`)
  return base.join("\n")
}

function clipBlock(input: string, maxLines: number, maxChars: number) {
  const text = input.replace(/\r\n/g, "\n")
  const lines = text.split("\n")
  const take = lines.slice(0, Math.max(1, maxLines))
  let body = take.join("\n")
  if (body.length > maxChars) body = `${body.slice(0, maxChars - 1)}…`
  const cutLines = lines.length > maxLines
  const cutChars = text.length > body.length
  if (!cutLines && !cutChars) return body
  return `${body}\n\n…(truncated preview)`
}

function pickBase(worktree: string, directory: string) {
  if (worktree && worktree !== "/") return worktree
  return directory
}

function readActive(api: Parameters<TuiPlugin>[0]) {
  const cur = api.route.current
  if (cur.name !== "session") return ""
  return str((cur.params as Record<string, unknown> | undefined)?.sessionID) ?? ""
}

function short(input: string, max = 80) {
  if (input.length <= max) return input
  return `${input.slice(0, max - 1)}…`
}

function str(value: unknown) {
  if (typeof value !== "string") return
  return value
}

function nextFork(state: Awaited<ReturnType<typeof loadState>>, parent: string) {
  return Object.values(state.nodes).filter((x) => x.parentSessionID === parent).length + 1
}

async function updateTitle(api: Parameters<TuiPlugin>[0], sessionID: string, title: string) {
  const client = api.client as unknown as {
    session?: {
      update?: (input: unknown) => Promise<{ error?: unknown }>
    }
  }
  if (!client.session?.update) return
  const update = (input: unknown) => client.session!.update!(input)
  const first = await tryUpdate(update, { sessionID, title })
  const out = first.error
    ? await tryUpdate(update, { path: { id: sessionID, sessionID }, body: { title } })
    : first
  if (out?.error instanceof Error) throw out.error
  if (out?.error) throw new Error(String(out.error))
}

async function tryUpdate(fn: (input: unknown) => Promise<{ error?: unknown }>, input: unknown) {
  try {
    return await fn(input)
  } catch (error) {
    return { error }
  }
}

async function forkTitle(
  api: Parameters<TuiPlugin>[0],
  state: Awaited<ReturnType<typeof loadState>>,
  source: string,
  n: number,
) {
  const label = state.nodes[source]?.label?.trim()
  if (label) return `${short(label, 36)} · Fork #${n}`
  const title = await sourceTitle(api, source)
  if (title) return `${short(title, 36)} · Fork #${n}`
  return `Fork #${n}`
}

async function sourceTitle(api: Parameters<TuiPlugin>[0], sessionID: string) {
  try {
    const info = await getSession(api.client as never, sessionID)
    return info.title?.trim()
  } catch {
    return
  }
}

function buildRaw(list: Array<{ role: string; text: string }>) {
  const keep = list.slice(-12)
  const body = keep
    .map((m) => {
      const text = short((m.text || "(no text)").replace(/\s+/g, " "), 350)
      return `- ${m.role}: ${text}`
    })
    .join("\n")
  return [
    "Context transfer from another branch.",
    "Use this as reference only.",
    "",
    body,
  ].join("\n")
}

function buildSnapshot(list: Array<{ id: string; role: string; text: string }>, forkID?: string) {
  const i = forkID ? list.findIndex((x) => x.id === forkID) : -1
  const keep = i >= 0 ? list.slice(i + 1) : list
  const lines: string[] = []
  let used = 0
  for (const m of keep) {
    const row = `${m.role}: ${(m.text || "(no text)").replace(/\s+/g, " ").trim()}`
    if (used + row.length > 16000) break
    lines.push(row)
    used += row.length + 1
  }
  return lines.join("\n")
}

export function forkCut(list: Array<{ id: string; role: string }>, msg: { id: string; role: string }) {
  if (msg.role === "user") return msg.id
  const i = list.findIndex((x) => x.id === msg.id)
  if (i < 0) return msg.id
  return list[i + 1]?.id
}

function buildSummary(list: Array<{ role: string; text: string }>) {
  const keep = list.slice(-14)
  const users = keep.filter((x) => x.role === "user").slice(-4)
  const assists = keep.filter((x) => x.role === "assistant").slice(-4)
  const goals = users.map((x) => `- ${short((x.text || "").replace(/\s+/g, " "), 180)}`).join("\n") || "- (none)"
  const outs = assists.map((x) => `- ${short((x.text || "").replace(/\s+/g, " "), 180)}`).join("\n") || "- (none)"
  return [
    "Branch summary (manual heuristic):",
    "",
    "Recent user goals:",
    goals,
    "",
    "Recent assistant outputs:",
    outs,
    "",
    "Continue current branch with this context where relevant.",
  ].join("\n")
}

async function run(api: Parameters<TuiPlugin>[0], fn: () => Promise<void>, message: string) {
  try {
    await fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    api.ui.toast({
      variant: "error",
      title: message,
      message: short(text, 140),
    })
  }
}
