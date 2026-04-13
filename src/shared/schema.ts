import { z } from "zod"

export const NodeMetaSchema = z.object({
  sessionID: z.string().min(1),
  rootSessionID: z.string().min(1),
  parentSessionID: z.string().min(1).optional(),
  forkMessageID: z.string().min(1).optional(),
  forkMessageRole: z.enum(["user", "assistant"]).optional(),
  label: z.string().optional(),
  note: z.string().optional(),
  lastVisitedAt: z.number().int().nonnegative().optional(),
})

export const HandoffMetaSchema = z.object({
  id: z.string().min(1),
  fromSessionID: z.string().min(1),
  toSessionID: z.string().min(1),
  text: z.string().min(1).optional(),
  mode: z.enum(["summary", "raw"]).optional(),
  sourceForkMessageID: z.string().min(1).optional(),
  sourceSnapshot: z.string().optional(),
  summaryStatus: z.enum(["pending", "ready", "failed"]).optional(),
  summaryError: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  status: z.enum(["pending", "consumed", "dismissed"]),
})

export const TreeStateSchema = z.object({
  version: z.literal(1),
  nodes: z.record(NodeMetaSchema),
  handoffs: z.array(HandoffMetaSchema),
})
