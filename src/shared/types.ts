export type SessionLite = {
  id: string
  parentID?: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export type MessageLite = {
  id: string
  role: string
  text: string
  time?: { created: number }
}

export type NodeMeta = {
  sessionID: string
  rootSessionID: string
  parentSessionID?: string
  forkMessageID?: string
  forkMessageRole?: "user" | "assistant"
  label?: string
  note?: string
  lastVisitedAt?: number
  lastVisitStartedAt?: number
}

export type HandoffMeta = {
  id: string
  fromSessionID: string
  toSessionID: string
  text?: string
  mode?: "summary" | "raw"
  sourceForkMessageID?: string
  sourceSnapshot?: string
  summaryStatus?: "pending" | "ready" | "failed"
  summaryError?: string
  createdAt: number
  status: "pending" | "consumed" | "dismissed"
}

export type TreeState = {
  version: 1
  nodes: Record<string, NodeMeta>
  handoffs: HandoffMeta[]
}

export type SessionNode = {
  info: SessionLite
  meta: NodeMeta
  depth: number
  children: SessionNode[]
}

export type TreeView = {
  rootID: string
  nodes: SessionNode[]
  activePath: Set<string>
}
