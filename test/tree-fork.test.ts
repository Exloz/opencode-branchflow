import { describe, expect, test } from "bun:test"
import { repairRoots, rootFor } from "../src/shared/tree.js"
import { forkCut } from "../src/tui.js"
import type { TreeState } from "../src/shared/types.js"

describe("tree metadata", () => {
  test("repairs root ids from parent links", () => {
    const state: TreeState = {
      version: 1,
      nodes: {
        root: { sessionID: "root", rootSessionID: "root" },
        a: { sessionID: "a", rootSessionID: "a", parentSessionID: "root" },
        b: { sessionID: "b", rootSessionID: "b", parentSessionID: "a" },
      },
      handoffs: [],
    }

    const root = rootFor(state, "b")
    repairRoots(state, root)

    expect(root).toBe("root")
    expect(state.nodes.a.rootSessionID).toBe("root")
    expect(state.nodes.b.rootSessionID).toBe("root")
  })
})

describe("fork cut", () => {
  const list = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "u2", role: "user" },
    { id: "a2", role: "assistant" },
  ]

  test("branches from user by excluding selected user message", () => {
    expect(forkCut(list, list[0])).toBe("u1")
  })

  test("branches from assistant by including selected assistant message", () => {
    expect(forkCut(list, list[1])).toBe("u2")
  })

  test("branches from last assistant by keeping full history", () => {
    expect(forkCut(list, list[3])).toBeUndefined()
  })
})
