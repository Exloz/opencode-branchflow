import { TreeStateSchema } from "./schema.js"
import type { HandoffMeta, NodeMeta, TreeState } from "./types.js"
import { readJson, stateFile, writeJsonAtomic } from "./fs.js"

const empty = (): TreeState => ({
  version: 1,
  nodes: {},
  handoffs: [],
})

export async function loadState(base: string): Promise<TreeState> {
  const file = stateFile(base)
  const raw = await readJson(file)
  if (!raw) return empty()
  try {
    const parsed = JSON.parse(raw)
    return TreeStateSchema.parse(clean(parsed))
  } catch {
    return empty()
  }
}

export async function saveState(base: string, state: TreeState) {
  const file = stateFile(base)
  const next = TreeStateSchema.parse(clean(state))
  await writeJsonAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
}

export async function upsertNode(base: string, node: NodeMeta) {
  const state = await loadState(base)
  state.nodes[node.sessionID] = { ...state.nodes[node.sessionID], ...node }
  await saveState(base, state)
  return state.nodes[node.sessionID]
}

export async function patchNode(base: string, sessionID: string, patch: Partial<NodeMeta>) {
  const state = await loadState(base)
  const cur = state.nodes[sessionID]
  if (!cur) return undefined
  state.nodes[sessionID] = { ...cur, ...patch }
  await saveState(base, state)
  return state.nodes[sessionID]
}

export async function appendHandoff(base: string, handoff: HandoffMeta) {
  const state = await loadState(base)
  state.handoffs.push(handoff)
  await saveState(base, state)
}

export async function pendingHandoffs(base: string, sessionID: string) {
  const state = await loadState(base)
  return state.handoffs.filter((h) => h.toSessionID === sessionID && h.status === "pending")
}

export async function consumeHandoffs(base: string, sessionID: string, ids?: string[]) {
  const state = await loadState(base)
  const only = ids ? new Set(ids) : undefined
  let changed = false
  state.handoffs = state.handoffs.map((h) => {
    if (h.toSessionID !== sessionID || h.status !== "pending") return h
    if (only && !only.has(h.id)) return h
    changed = true
    return { ...h, status: "consumed" }
  })
  if (changed) await saveState(base, state)
}

function clean(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const state = input as { handoffs?: unknown }
  if (!Array.isArray(state.handoffs)) return input
  state.handoffs = state.handoffs.map((x) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) return x
    const h = { ...(x as Record<string, unknown>) }
    if (typeof h.text === "string" && h.text.trim().length === 0) delete h.text
    return h
  })
  return state
}
