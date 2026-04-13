import type { MessageLite, SessionLite } from "./types.js"

type Resp<T> = { data?: T }

type Out<T> = Resp<T> & { error?: unknown }

type SessionGetClient = {
  session: {
    get: (input: unknown) => Promise<Out<SessionLite>>
  }
}

type SessionChildrenClient = {
  session: {
    children: (input: unknown) => Promise<Out<SessionLite[]>>
  }
}

type SessionMessagesClient = {
  session: {
    messages: (input: unknown) => Promise<Out<unknown[]>>
  }
}

type SessionForkClient = {
  session: {
    fork: (input: unknown) => Promise<Out<SessionLite>>
  }
}

type SessionPromptClient = {
  session: {
    prompt: (input: unknown) => Promise<Out<unknown>>
    promptAsync?: (input: unknown) => Promise<Out<unknown>>
  }
}

type SessionCreateClient = {
  session: {
    create: (input?: unknown) => Promise<Out<SessionLite>>
    delete: (input: unknown) => Promise<Out<unknown>>
  }
}

export async function getSession(client: SessionGetClient, sessionID: string) {
  const out = await duo(
    (input) => client.session.get(input),
    { sessionID },
    { path: sid(sessionID) },
  )
  return must(out, `Session not found: ${sessionID}`)
}

export async function getChildren(client: SessionChildrenClient, sessionID: string) {
  const out = await duo(
    (input) => client.session.children(input),
    { sessionID },
    { path: sid(sessionID) },
  )
  if (out.error) throw new Error(errText(out.error, `Could not list children for ${sessionID}`))
  return out.data ?? []
}

export async function getMessages(client: SessionMessagesClient, sessionID: string) {
  const out = await duo(
    (input) => client.session.messages(input),
    { sessionID },
    { path: sid(sessionID) },
  )
  if (out.error) throw new Error(errText(out.error, `Could not read messages for ${sessionID}`))
  return out.data ?? []
}

export async function forkSession(client: SessionForkClient, sessionID: string, messageID?: string) {
  return must(
    await duo(
      (input) => client.session.fork(input),
      { sessionID, messageID },
      { path: sid(sessionID), body: messageID ? { messageID } : undefined },
    ),
    "Fork failed",
  )
}

export async function sendPrompt(client: SessionPromptClient, sessionID: string, text: string) {
  const out = await duo(
    (input) => client.session.prompt(input),
    { sessionID, parts: [{ type: "text", text }] },
    { path: sid(sessionID), body: { parts: [{ type: "text", text }] } },
  )
  if (out.error) throw new Error(errText(out.error, "Prompt failed"))
  failPrompt(out.data)
}

export async function promptText(
  client: SessionPromptClient & SessionMessagesClient,
  input: {
    sessionID: string
    text: string
    model?: { providerID: string; modelID: string }
    agent?: string
    tools?: Record<string, boolean>
    system?: string
  },
) {
  const parts = [{ type: "text" as const, text: input.text }]
  const out = await duo(
    (input) => client.session.prompt(input),
    {
      sessionID: input.sessionID,
      model: input.model,
      agent: input.agent,
      tools: input.tools,
      system: input.system,
      parts,
    },
    {
      path: sid(input.sessionID),
      body: {
        model: input.model,
        agent: input.agent,
        tools: input.tools,
        system: input.system,
        parts,
      },
    },
  )
  if (out.error) throw new Error(errText(out.error, "Prompt failed"))
  failPrompt(out.data)
  const msg = toMessageLite(out.data)
  if (msg?.text?.trim()) return msg.text
  const rows = await getMessages(client, input.sessionID)
  const last = rows
    .map(toMessageLite)
    .filter((x): x is NonNullable<typeof x> => !!x)
    .reverse()
    .find((x) => x.role === "assistant" && !!x.text?.trim())
  return last?.text ?? ""
}

export async function createSession(client: SessionCreateClient, title?: string) {
  return must(
    await duo(
      (input) => client.session.create(input),
      title ? { title } : undefined,
      title ? { body: { title } } : undefined,
    ),
    "Session create failed",
  )
}

export async function deleteSession(client: SessionCreateClient, sessionID: string) {
  const out = await duo(
    (input) => client.session.delete(input),
    { sessionID },
    { path: sid(sessionID) },
  )
  if (out.error) throw new Error(errText(out.error, `Could not delete session ${sessionID}`))
}

export async function sendPromptAsync(client: SessionPromptClient, sessionID: string, text: string) {
  if (client.session.promptAsync) {
    const out = await duo(
      (input) => client.session.promptAsync?.(input) ?? Promise.resolve({ error: "missing-session-method" }),
      { sessionID, parts: [{ type: "text", text }] },
      { path: sid(sessionID), body: { parts: [{ type: "text", text }] } },
    )
    if (out.error) throw new Error(errText(out.error, "Prompt failed"))
    return
  }
  await sendPrompt(client, sessionID, text)
}

export function toMessageLite(input: unknown): MessageLite | undefined {
  const info = messageInfo(input)
  const id = readString(info, "id")
  const role = readString(info, "role")
  if (!id || !role) return undefined
  const text = extractText(input)
  const time = readTime(info)
  return { id, role, text, time }
}

function extractText(input: unknown) {
  const wrap = messageWrap(input)
  if (!wrap) return ""
  const parts = wrap.parts
  if (!Array.isArray(parts)) return ""
  return parts
    .map((p) => {
      if (!isRec(p)) return ""
      if (p.type !== "text") return ""
      if (typeof p.text !== "string") return ""
      return p.text
    })
    .filter(Boolean)
    .join("\n")
}

function messageID(input: unknown) {
  return readString(messageInfo(input), "id")
}

function messageInfo(input: unknown) {
  const wrap = messageWrap(input)
  if (!wrap) return
  if (isRec(wrap.info)) return wrap.info
  if (isRec(wrap)) return wrap
}

function messageWrap(input: unknown) {
  if (!isRec(input)) return
  if (isRec(input.info) && Array.isArray(input.parts)) return input
  if (Array.isArray(input.parts) && typeof input.role === "string") {
    return {
      info: input,
      parts: input.parts,
    }
  }
}

function readString(input: unknown, key: string) {
  if (!isRec(input)) return
  const value = input[key]
  if (typeof value !== "string") return
  return value
}

function readTime(input: unknown): { created: number } | undefined {
  if (!isRec(input)) return
  const time = input.time
  if (!isRec(time)) return
  const created = time.created
  if (typeof created !== "number") return
  return { created }
}

function isRec(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

function sid(sessionID: string) {
  return { id: sessionID, sessionID }
}

async function duo<T>(
  fn: ((input: unknown) => Promise<Out<T>>) | undefined,
  first: unknown,
  second: unknown,
) {
  if (!fn) return { error: "missing-session-method" } satisfies Out<T>
  const a = await once(fn, first)
  if (a.data !== undefined || !a.error) return a
  const b = await once(fn, second)
  if (b.data !== undefined || !b.error) return b
  return b
}

async function once<T>(fn: (input: unknown) => Promise<Out<T>>, input: unknown): Promise<Out<T>> {
  try {
    return await fn(input)
  } catch (error) {
    return { error }
  }
}

function must<T>(out: Resp<T> & { error?: unknown }, fallback: string) {
  if (out.error) throw new Error(errText(out.error, fallback))
  if (!out.data) throw new Error(fallback)
  return out.data
}

function failPrompt(input: unknown) {
  const msg = readErr(isRec(input) && isRec(input.info) ? input.info.error : undefined)
  if (msg) throw new Error(msg)
}

function errText(input: unknown, fallback: string) {
  return readErr(input) || fallback
}

function readErr(input: unknown) {
  if (typeof input === "string") return input
  if (!isRec(input)) return
  const data = isRec(input.data) ? input.data : undefined
  return readString(data, "message") || readString(input, "message") || readString(input, "name")
}
