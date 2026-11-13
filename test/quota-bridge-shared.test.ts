import { test } from "node:test"
import assert from "node:assert/strict"
import { fork, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { once } from "node:events"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { createServer as createHttpServer } from "node:http"
import { prepareQuotaBridgeState, readQuotaBridgeRoots } from "../src/quota-bridge-storage.js"
import { startSharedQuotaBridge } from "../src/quota-bridge-shared.js"
import { startQuotaBridge, quotaBridgeProof } from "../src/quota-bridge.js"
import { parseQuotaBridge } from "../src/quota-bridge-plugin.js"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

async function unusedPort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

function exchange(child: ChildProcess, message: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener("message", receive); reject(new Error("Synthetic bridge child timed out")) }, 8000)
    const receive = (reply: any) => { clearTimeout(timer); resolve(reply) }
    child.once("message", receive)
    child.send(message)
  })
}

function childProcess(home: string) {
  return fork(fileURLToPath(new URL("./quota-bridge-shared-child.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: { HOME: home, PATH: "" }, stdio: ["ignore", "ignore", "ignore", "ipc"],
  })
}

test("two processes share a persistent bridge key and the follower takes over after owner exit", { timeout: 20_000 }, async () => {
  const home = await mkdtemp("/tmp/opencode/qwen-shared-process-")
  const first = childProcess(home), second = childProcess(home)
  try {
    const port = await unusedPort()
    const directory = join(home, "state")
    const owner = await exchange(first, { action: "start", port, directory, root: join(home, "project-a") })
    assert.equal(owner.running, true)
    assert.equal(owner.requests, 0)
    const follower = await exchange(second, { action: "start", port, directory, root: join(home, "project-b") })
    assert.equal(follower.running, true)
    assert.equal(follower.requests, 0)
    const bin = join(home, "project-b", "bin")
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, "bl"), "synthetic", { mode: 0o700 })
    assert.equal((await exchange(first, { action: "resolve", pathEnv: bin })).found, false)
    assert.equal((await exchange(second, { action: "query" })).ok, true)
    const stopped = await exchange(first, { action: "stop" })
    assert.equal(stopped.keyPresent, false)
    let recovered = false
    for (let attempt = 0; attempt < 20 && !recovered; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 150))
      recovered = (await exchange(second, { action: "query" })).ok
    }
    assert.equal(recovered, true)
    assert.equal((await exchange(second, { action: "stop" })).keyPresent, false)
  } finally {
    if (first.connected) first.kill()
    if (second.connected) second.kill()
    await rm(home, { recursive: true, force: true })
  }
})

test("concurrent child processes initialize one key without startup quota reads", { timeout: 20_000 }, async () => {
  const home = await mkdtemp("/tmp/opencode/qwen-shared-concurrent-")
  const children = [childProcess(home), childProcess(home)]
  try {
    const port = await unusedPort()
    const replies = await Promise.all(children.map((child, index) => exchange(child, { action: "start", port, directory: join(home, "state"), root: join(home, `project-${index}`) })))
    assert.deepEqual(replies.map(reply => [reply.running, reply.requests]), [[true, 0], [true, 0]])
    assert.equal((await exchange(children[1]!, { action: "query" })).ok, true)
    for (const child of children) assert.equal((await exchange(child, { action: "stop" })).keyPresent, false)
  } finally { for (const child of children) if (child.connected) child.kill(); await rm(home, { recursive: true, force: true }) }
})

test("persistent private state retains lexical/canonical roots and rejects conflicts, corruption and unsafe files", async () => {
  const home = await mkdtemp("/tmp/opencode/qwen-shared-state-")
  try {
    const directory = join(home, "state"), root = join(home, "project"), alias = join(home, "alias")
    await mkdir(root)
    await symlink(root, alias)
    const state = await prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [alias] })
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(join(directory, "bridge.key"))).mode & 0o777, 0o600)
    assert.deepEqual(new Set(await readQuotaBridgeRoots(directory)), new Set([alias, root]))
    const again = await prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [root] })
    assert.equal(again.token === state.token, true)
    await assert.rejects(prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [root], token: "different-synthetic-key-".repeat(3) }))
    await chmod(join(directory, "bridge.key"), 0o644)
    await assert.rejects(prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [root] }))
    await chmod(join(directory, "bridge.key"), 0o600)
    await writeFile(join(directory, "roots", "0".repeat(64) + ".json"), "{}", { mode: 0o600 })
    await assert.rejects(readQuotaBridgeRoots(directory))
    const bytesDirectory = join(home, "bytes-state")
    await prepareQuotaBridgeState({ stateDirectory: bytesDirectory, workspaceRoots: [] })
    await Promise.all(Array.from({ length: 180 }, async (_, index) => {
      const root = "/" + "p".repeat(3000) + index
      const text = JSON.stringify({ version: 1, lexical: root, canonical: root })
      await writeFile(join(bytesDirectory, "roots", createHash("sha256").update(text).digest("hex") + ".json"), text, { mode: 0o600 })
    }))
    await assert.rejects(readQuotaBridgeRoots(bytesDirectory))
    await assert.rejects(prepareQuotaBridgeState({ stateDirectory: join(root, "state"), workspaceRoots: [root] }))
    await symlink(directory, join(home, "state-link"))
    await assert.rejects(prepareQuotaBridgeState({ stateDirectory: join(home, "state-link"), workspaceRoots: [] }))
    assert.equal((await readFile(join(directory, "bridge.key"), "utf8")) === state.token, true)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("unknown occupied listener never receives bearer credentials and cannot attach", async () => {
  let requests = 0
  const server = createHttpServer((request, response) => {
    requests++
    assert.equal(request.headers.authorization, undefined)
    response.writeHead(204, { "X-Qwencloud-Protocol": "1", "X-Qwencloud-Proof": "0".repeat(64) }); response.end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  try {
    await assert.rejects(startSharedQuotaBridge({ port: address.port, token: "synthetic-private-key-".repeat(3), getQuota: async () => { throw Error("must not run") } }))
    assert.equal(requests, 2)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test("health handshake rejects unauthenticated and browser requests without quota reads", async () => {
  const token = "synthetic-private-key-".repeat(3), nonce = "1".repeat(64)
  const bridge = await startQuotaBridge({ port: 0, token, sharedHealth: true, getQuota: async () => { throw Error("must not run") } })
  const url = bridge.url.replace("/quota", "/quota-bridge-health")
  const challenge = `${new URL(url).port}:${nonce}`
  const headers = { "X-Qwencloud-Nonce": nonce, "X-Qwencloud-Proof": quotaBridgeProof(token, "request", challenge) }
  try {
    assert.equal((await fetch(url)).status, 401)
    assert.equal((await fetch(url, { headers: { ...headers, Origin: "https://invalid.example" } })).status, 403)
    const response = await fetch(url, { headers })
    assert.equal(response.status, 204)
    assert.equal(response.headers.get("x-qwencloud-proof"), quotaBridgeProof(token, "response", challenge))
    assert.throws(() => parseQuotaBridge({ port: 62367, shared: true }))
    assert.equal(parseQuotaBridge({ port: 62367, shared: true, autoKey: true })?.shared, true)
  } finally { await bridge.close() }
})

test("root record limits fail closed without pruning and key symlinks are rejected", async () => {
  const home = await mkdtemp("/tmp/opencode/qwen-shared-limits-")
  const directory = join(home, "state")
  try {
    await prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] })
    await unlink(join(directory, "bridge.key"))
    await writeFile(join(home, "external-key"), "synthetic-private-key-".repeat(3), { mode: 0o600 })
    await symlink(join(home, "external-key"), join(directory, "bridge.key"))
    await assert.rejects(prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] }))
    await unlink(join(directory, "bridge.key"))
    await prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] })
    const records = Array.from({ length: 1025 }, (_, index) => JSON.stringify({ version: 1, lexical: join(home, `project-${index}`), canonical: join(home, `project-${index}`) }))
    await Promise.all(records.map(text => writeFile(join(directory, "roots", createHash("sha256").update(text).digest("hex") + ".json"), text, { mode: 0o600 })))
    await assert.rejects(readQuotaBridgeRoots(directory))
    await unlink(join(directory, "roots", createHash("sha256").update(records.pop()!).digest("hex") + ".json"))
    assert.equal((await readQuotaBridgeRoots(directory)).length, 2048)
    const oversized = JSON.stringify({ version: 1, lexical: "/" + "x".repeat(4097), canonical: "/safe" })
    await writeFile(join(directory, "roots", createHash("sha256").update(oversized).digest("hex") + ".json"), oversized, { mode: 0o600 })
    await assert.rejects(readQuotaBridgeRoots(directory))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("conflicting explicit child keys are preserved and a closed follower cannot take over", { timeout: 20_000 }, async () => {
  const home = await mkdtemp("/tmp/opencode/qwen-shared-cleanup-")
  const children = [childProcess(home), childProcess(home), childProcess(home)]
  try {
    const port = await unusedPort(), directory = join(home, "state")
    assert.equal((await exchange(children[0]!, { action: "start", port, directory })).running, true)
    assert.equal((await exchange(children[1]!, { action: "start", port, directory })).running, true)
    const conflict = await exchange(children[2]!, { action: "start", port, directory, explicitKey: "conflicting-synthetic-key-".repeat(3) })
    assert.equal(conflict.running, false)
    assert.equal(conflict.keyPresent, true)
    assert.equal((await exchange(children[2]!, { action: "stop" })).keyPresent, true)
    assert.equal((await exchange(children[1]!, { action: "stop" })).keyPresent, false)
    assert.equal((await exchange(children[0]!, { action: "stop" })).keyPresent, false)
    await new Promise(resolve => setTimeout(resolve, 650))
    const listener = createServer()
    listener.listen(port, "127.0.0.1")
    await once(listener, "listening")
    await new Promise<void>(resolve => listener.close(() => resolve()))
    assert.ok((await stat(join(directory, "bridge.key"))).isFile())
  } finally { for (const child of children) if (child.connected) child.kill(); await rm(home, { recursive: true, force: true }) }
})

test("shared scope closes active requests and a disposed follower never restarts the listener", async () => {
  const port = await unusedPort(), token = "synthetic-private-key-".repeat(3)
  let started!: () => void
  let signal: AbortSignal | undefined
  const active = new Promise<void>(resolve => { started = resolve })
  const owner = await startSharedQuotaBridge({ port, token, getQuota: async current => {
    signal = current
    started()
    return new Promise((_resolve, reject) => current.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }))
  } })
  const follower = await startSharedQuotaBridge({ port, token, getQuota: async () => { throw Error("disposed follower") } })
  try {
    const response = fetch(owner.url, { headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
    await active
    await follower.close()
    await owner.close()
    assert.equal(signal?.aborted, true)
    await response
    await new Promise(resolve => setTimeout(resolve, 650))
    const replacement = createServer()
    replacement.listen(port, "127.0.0.1")
    await once(replacement, "listening")
    await new Promise<void>(resolve => replacement.close(() => resolve()))
  } finally { await follower.close(); await owner.close() }
})
