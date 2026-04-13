import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export function stateDir(base: string) {
  return join(base, ".opencode", "plugins", "session-tree")
}

export function stateFile(base: string) {
  return join(stateDir(base), "state.json")
}

export async function readJson(path: string) {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

export async function writeJsonAtomic(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await writeFile(temp, content, "utf8")
  await rename(temp, path)
}
