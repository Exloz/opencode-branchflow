import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/server.js"
import { loadState, saveState } from "../src/shared/store.js"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("server summary handoff", () => {
  test("uses summary agent and injects real summary text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-tree-test-"))
    dirs.push(dir)

    const calls: Array<Record<string, unknown>> = []
    const temp = "ses_temp"
    const source = "ses_source"
    const target = "ses_target"
    const client = {
      session: {
        async create() {
          return { data: { id: temp, title: "tmp", time: { created: 1, updated: 1 } } }
        },
        async delete() {
          return { data: true }
        },
        async prompt(input: Record<string, unknown>) {
          calls.push(input)
          if (!input.path || !input.body) {
            return { error: { message: "NotFoundError" } }
          }
          return {
            data: {
              info: { id: "msg_sum", role: "assistant" },
              parts: [],
            },
          }
        },
        async messages(input: { path: { id: string } }) {
          if (input.path.id === source) {
            return {
              data: [
                { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "shared root" }] },
                { info: { id: "m2", role: "user" }, parts: [{ type: "text", text: "delta request" }] },
                { info: { id: "m3", role: "assistant" }, parts: [{ type: "text", text: "delta result" }] },
              ],
            }
          }
          if (input.path.id === temp) {
            return {
              data: [
                { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "prompt" }] },
                {
                  info: { id: "a1", role: "assistant" },
                  parts: [{ type: "text", text: "## Goal\nReal AI summary\n\n## Next Steps\n1. Continue." }],
                },
              ],
            }
          }
          return { data: [] }
        },
      },
    }

    await saveState(dir, {
      version: 1,
      nodes: {
        [source]: { sessionID: source, rootSessionID: source, forkMessageID: "m1" },
        [target]: { sessionID: target, rootSessionID: target },
      },
      handoffs: [
        {
          id: "h1",
          fromSessionID: source,
          toSessionID: target,
          mode: "summary",
          sourceForkMessageID: "m1",
          summaryStatus: "pending",
          createdAt: Date.now(),
          status: "pending",
        },
      ],
    })

    const hooks = await plugin.server(
      {
        client: client as never,
        project: {} as never,
        directory: dir,
        worktree: dir,
        serverUrl: new URL("http://localhost"),
        $: {} as never,
      },
      {
        summaryModelProviderID: "opencode-go",
        summaryModelID: "minimax-m2.7",
      },
    )

    const out = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]?.(
      {
        sessionID: target,
        model: { providerID: "opencode-go", id: "minimax-m2.7", modelID: "minimax-m2.7" } as never,
      },
      out,
    )

    expect(calls).toHaveLength(2)
    expect(calls[0].sessionID).toBe(temp)
    expect(calls[1].path).toEqual({ id: temp, sessionID: temp })
    expect(calls[1].body).toMatchObject({
      agent: "summary",
      tools: { "*": false },
      model: { providerID: "opencode-go", modelID: "minimax-m2.7" },
    })
    expect(out.system).toHaveLength(1)
    expect(out.system[0]).toContain("Real AI summary")

    const state = await loadState(dir)
    expect(state.handoffs[0].summaryStatus).toBe("ready")
    expect(state.handoffs[0].status).toBe("consumed")
    expect(state.handoffs[0].text).toContain("Real AI summary")
  })

  test("uses captured snapshot instead of rereading drifting source branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-tree-test-"))
    dirs.push(dir)

    const calls: Array<Record<string, unknown>> = []
    const temp = "ses_temp"
    const source = "ses_source"
    const target = "ses_target"
    const client = {
      session: {
        async create() {
          return { data: { id: temp, title: "tmp", time: { created: 1, updated: 1 } } }
        },
        async delete() {
          return { data: true }
        },
        async prompt(input: Record<string, unknown>) {
          calls.push(input)
          if (!input.path || !input.body) {
            return { error: { message: "NotFoundError" } }
          }
          return {
            data: {
              info: { id: "msg_sum", role: "assistant" },
              parts: [],
            },
          }
        },
        async messages(input: { path: { id: string } }) {
          if (input.path.id === source) {
            return {
              data: [
                { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "live drifted branch" }] },
              ],
            }
          }
          if (input.path.id === temp) {
            return {
              data: [
                {
                  info: { id: "a1", role: "assistant" },
                  parts: [{ type: "text", text: "## Goal\nSnapshot summary\n\n## Next Steps\n1. Continue." }],
                },
              ],
            }
          }
          return { data: [] }
        },
      },
    }

    await saveState(dir, {
      version: 1,
      nodes: {
        [source]: { sessionID: source, rootSessionID: source, forkMessageID: "m0" },
        [target]: { sessionID: target, rootSessionID: target },
      },
      handoffs: [
        {
          id: "h1",
          fromSessionID: source,
          toSessionID: target,
          mode: "summary",
          sourceForkMessageID: "m0",
          sourceSnapshot: "user: captured snapshot text",
          summaryStatus: "pending",
          createdAt: Date.now(),
          status: "pending",
        },
      ],
    })

    const hooks = await plugin.server(
      {
        client: client as never,
        project: {} as never,
        directory: dir,
        worktree: dir,
        serverUrl: new URL("http://localhost"),
        $: {} as never,
      },
      {
        summaryModelProviderID: "opencode-go",
        summaryModelID: "minimax-m2.7",
      },
    )

    await hooks["experimental.chat.system.transform"]?.(
      {
        sessionID: target,
        model: { providerID: "opencode-go", id: "minimax-m2.7", modelID: "minimax-m2.7" } as never,
      },
      { system: [] },
    )

    expect(calls).toHaveLength(2)
    const body = calls[1].body as Record<string, unknown>
    expect(JSON.stringify(body.parts)).toContain("captured snapshot text")
    expect(JSON.stringify(body.parts)).not.toContain("live drifted branch")
  })
})
