import type { NodeMeta, SessionLite, SessionNode, TreeState, TreeView } from "./types.js"
import { getChildren, getSession } from "./client.js"

type ClientLike = {
  session: {
    get(input: unknown): Promise<{ data?: SessionLite; error?: unknown }>
    children(input: unknown): Promise<{ data?: SessionLite[]; error?: unknown }>
  }
}

export async function ensureLineage(client: ClientLike, state: TreeState, sessionID: string) {
  const path: SessionLite[] = []
  let cur = await getSession(client, sessionID)
  path.unshift(cur)
  while (cur.parentID) {
    cur = await getSession(client, cur.parentID)
    path.unshift(cur)
  }
  const rootID = path[0].id
  for (let i = 0; i < path.length; i++) {
    const item = path[i]
    const parent = i === 0 ? undefined : path[i - 1].id
    const existing = state.nodes[item.id]
    state.nodes[item.id] = {
      sessionID: item.id,
      rootSessionID: existing?.rootSessionID ?? rootID,
      parentSessionID: existing?.parentSessionID ?? parent,
      forkMessageID: existing?.forkMessageID,
      forkMessageRole: existing?.forkMessageRole,
      label: existing?.label,
      note: existing?.note,
      lastVisitedAt: existing?.lastVisitedAt,
    }
  }
  return rootID
}

export function rootFor(state: TreeState, sessionID: string) {
  const seen = new Set<string>()
  let id = sessionID
  while (true) {
    if (seen.has(id)) return sessionID
    seen.add(id)
    const parent = state.nodes[id]?.parentSessionID
    if (!parent) return id
    id = parent
  }
}

export function repairRoots(state: TreeState, rootID: string) {
  const ids = subtree(state, rootID)
  ids.add(rootID)
  for (const id of ids) {
    const cur = state.nodes[id]
    if (!cur) continue
    cur.rootSessionID = rootID
  }
}

export async function collectTree(client: ClientLike, rootID: string) {
  const map = new Map<string, SessionLite>()
  const stack = [rootID]
  while (stack.length) {
    const id = stack.pop()!
    if (map.has(id)) continue
    const item = await getSession(client, id)
    map.set(id, item)
    const kids = await getChildren(client, id)
    for (const kid of kids) {
      map.set(kid.id, kid)
      stack.push(kid.id)
    }
  }
  return map
}

export async function collectMetaTree(client: ClientLike, state: TreeState, rootID: string, currentID: string) {
  // Collect all IDs: root + current + ancestors of current + descendants of root
  const ids = new Set<string>()
  ids.add(rootID)
  ids.add(currentID)

  // Add all ancestors from current up to root
  let cur = currentID
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const meta = state.nodes[cur]
    if (!meta?.parentSessionID) break
    ids.add(meta.parentSessionID)
    cur = meta.parentSessionID
  }

  // Add all descendants of root
  for (const id of subtree(state, rootID)) {
    ids.add(id)
  }

  const parent = new Map<string, string | undefined>()
  const sessions = new Map<string, SessionLite>()

  for (const id of ids) {
    const cur = state.nodes[id]
    if (cur?.parentSessionID) parent.set(id, cur.parentSessionID)
  }

  for (const id of ids) {
    try {
      const info = await getSession(client, id)
      sessions.set(id, info)
      if (!parent.has(id)) parent.set(id, info.parentID)
    } catch {
      // stale metadata; skip missing session
    }
  }

  return { sessions, parent }
}

function subtree(state: TreeState, rootID: string) {
  const ids = new Set<string>()
  const stack = [rootID]
  while (stack.length) {
    const id = stack.pop()!
    for (const node of Object.values(state.nodes)) {
      if (node.parentSessionID !== id || ids.has(node.sessionID)) continue
      ids.add(node.sessionID)
      stack.push(node.sessionID)
    }
  }
  return ids
}

export function buildTreeView(
  sessions: Map<string, SessionLite>,
  metas: Record<string, NodeMeta>,
  rootID: string,
  activeID: string,
  parent?: Map<string, string | undefined>,
) {
  const byParent = new Map<string, SessionLite[]>()
  for (const item of sessions.values()) {
    const key = parent?.get(item.id) ?? item.parentID ?? ""
    const list = byParent.get(key) ?? []
    list.push(item)
    byParent.set(key, list)
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.time.created - b.time.created)
    list.sort((a, b) => Number(b.id === activeID) - Number(a.id === activeID))
  }

  const activePath = buildActivePath(sessions, activeID)

  const walk = (id: string, depth: number): SessionNode[] => {
    const item = sessions.get(id)
    if (!item) return []
    const link = parent?.get(id) ?? item.parentID
    const meta = metas[id] ?? {
      sessionID: id,
      rootSessionID: rootID,
      parentSessionID: link,
    }
    const kids = (byParent.get(id) ?? []).flatMap((x) => walk(x.id, depth + 1))
    return [{ info: item, meta, depth, children: kids }]
  }

  const nodes = walk(rootID, 0)
  const view: TreeView = {
    rootID,
    nodes,
    activePath,
  }
  return view
}

function buildActivePath(sessions: Map<string, SessionLite>, activeID: string) {
  const set = new Set<string>()
  let cur = sessions.get(activeID)
  while (cur) {
    set.add(cur.id)
    if (!cur.parentID) break
    cur = sessions.get(cur.parentID)
  }
  return set
}

export function flatten(nodes: SessionNode[]) {
  const out: SessionNode[] = []
  const walk = (node: SessionNode) => {
    out.push(node)
    for (const kid of node.children) walk(kid)
  }
  for (const node of nodes) walk(node)
  return out
}
