import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Exit, Scope } from "effect"
import { parseOptions } from "../src/index.js"
import { acquireQuotaBridge } from "../src/quota-bridge-plugin.js"
import { startQuotaBridge } from "../src/quota-bridge.js"
import { quotaBridgeRegistry, serializeQuotaBridge } from "../src/quota-bridge-state.js"
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { join } from "node:path"
import { resolveBlExecutable } from "../src/quota-cli.js"

const envName = "QWENCLOUD_TEST_QUOTA_BRIDGE_KEY"
const token = "synthetic-quota-only-key-0000000000"
const sample = { per1MonthPercentage: 0.5715795927593333, per1MonthResetTime: 1794672000000 }

test("quota bridge options are optional and strictly validate port, environment name and optional autoKey", () => {
  assert.deepEqual(parseOptions({ quotaBridge: false }), { timeoutMs: 600_000 })
  assert.deepEqual(parseOptions({ quotaBridge: { port: 62366 } }), { timeoutMs: 600_000, quotaBridge: { port: 62366, apiKeyEnv: "QWENCLOUD_QUOTA_ADAPTER_KEY" } })
  assert.deepEqual(parseOptions({ quotaBridge: { port: 62366, apiKeyEnv: envName } }).quotaBridge, { port: 62366, apiKeyEnv: envName })
  for (const quotaBridge of [true, null, [], {}, { port: 0 }, { port: 65536 }, { port: 1.5 }, { port: 62366, apiKeyEnv: "bad-name" }, { port: 62366, apiKeyEnv: "" }, { port: 62366, token: "PRIVATE" }, { port: 62366, host: "0.0.0.0" }]) assert.throws(() => parseOptions({ quotaBridge }))
})

test("scoped bridge reads CLI quota only after authenticated GET and releases its listener for reload", async () => {
  const previous = process.env[envName]
  process.env[envName] = token
  const scope = await Effect.runPromise(Scope.make())
  let requests = 0
  let status
  try {
    status = await Effect.runPromise(acquireQuotaBridge({ port: 0, apiKeyEnv: envName }, { workspaceRoot: "/synthetic", runner: async () => { requests++; return { ok: true, stdout: JSON.stringify(sample) } } }).pipe(Scope.provide(scope)))
    assert.equal(status.running, true)
    assert.equal(status.management, "plugin")
    assert.equal(requests, 0)
    assert.equal((await fetch(status.url!)).status, 401)
    assert.equal(requests, 0)
    const response = await fetch(status.url!, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(response.status, 200)
    const body = await response.json() as { entries: { percentRemaining: number; label: string }[] }
    assert.equal(body.entries[0].percentRemaining, 100 - sample.per1MonthPercentage * 100)
    assert.match(body.entries[0].label, /account unverified/)
    assert.equal(requests, 1)
    assert.doesNotMatch(JSON.stringify(status), new RegExp(token))
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
  try {
    await assert.rejects(fetch(status!.url!))
    const port = Number(new URL(status!.url!).port)
    await Effect.runPromise(Effect.scoped(acquireQuotaBridge({ port, apiKeyEnv: envName }, { runner: async () => { throw new Error("must not query on reload") } }).pipe(Effect.tap(next => Effect.sync(() => assert.equal(next.running, true))))))
  } finally { if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous }
})

test("missing or invalid bridge keys and occupied ports fail closed without disabling native discovery", async () => {
  const previous = process.env[envName]
  try {
    delete process.env[envName]
    const missing = await Effect.runPromise(Effect.scoped(acquireQuotaBridge({ port: 62366, apiKeyEnv: envName })))
    assert.deepEqual(missing, { enabled: true, management: "plugin", running: false, diagnostic: "missing-key" })
    process.env[envName] = "PRIVATE invalid"
    const invalid = await Effect.runPromise(Effect.scoped(acquireQuotaBridge({ port: 62366, apiKeyEnv: envName })))
    assert.deepEqual(invalid, { enabled: true, management: "plugin", running: false, diagnostic: "invalid-key" })
    assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE/)
    process.env[envName] = token
    const occupied = await startQuotaBridge({ port: 0, token, getQuota: async () => { throw new Error("not requested") } })
    try {
      const failed = await Effect.runPromise(Effect.scoped(acquireQuotaBridge({ port: Number(new URL(occupied.url).port), apiKeyEnv: envName })))
      assert.deepEqual(failed, { enabled: true, management: "plugin", running: false, diagnostic: "start-failed" })
    } finally { await occupied.close() }
  } finally { if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous }
})

test("scope disposal cancels an active CLI quota request and closes its response", async () => {
  const previous = process.env[envName]
  process.env[envName] = token
  const scope = await Effect.runPromise(Scope.make())
  let signal: AbortSignal | undefined
  let started!: () => void
  const pending = new Promise<void>(resolve => { started = resolve })
  try {
    const status = await Effect.runPromise(acquireQuotaBridge({ port: 0, apiKeyEnv: envName }, { runner: async current => {
      signal = current
      started()
      return new Promise(resolve => current.addEventListener("abort", () => resolve({ ok: false, code: "cancelled" }), { once: true }))
    } }).pipe(Scope.provide(scope)))
    const response = fetch(status.url!, { headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
    await pending
    await Effect.runPromise(Scope.close(scope, Exit.void))
    assert.equal(signal?.aborted, true)
    await response
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous
  }
})

test("autoKey shares one listener across concurrent leases and dynamically authenticates an unchanged env consumer", async () => {
  assert.equal(process.env[envName], undefined)
  const config = { port: 0, apiKeyEnv: envName, autoKey: true }
  const scopes = await Promise.all([Effect.runPromise(Scope.make()), Effect.runPromise(Scope.make())])
  let callsA = 0, callsB = 0
  const acquire = (index: number) => Effect.runPromise(acquireQuotaBridge(config, { workspaceRoot: `/synthetic/${index}`, runner: async () => {
    if (index === 0) callsA++; else callsB++
    return { ok: true, stdout: JSON.stringify(sample) }
  } }).pipe(Scope.provide(scopes[index])))
  let url = ""
  try {
    const [a, b] = await Promise.all([acquire(0), acquire(1)])
    assert.equal(a.running, true)
    assert.equal(b.url, a.url)
    url = a.url!
    const key = process.env[envName]!
    assert.match(key, /^[a-f0-9]{64}$/)
    assert.doesNotMatch(JSON.stringify([a, b]), new RegExp(key))
    assert.equal(callsA + callsB, 0)
    const consumer = () => fetch(url, { headers: { Authorization: `Bearer ${process.env[envName]}` } })
    assert.equal((await consumer()).status, 200)
    assert.equal(callsA, 1)
    await Effect.runPromise(Scope.close(scopes[0], Exit.void))
    assert.equal(process.env[envName], key)
    assert.equal((await consumer()).status, 200)
    assert.equal(callsA, 1)
    assert.equal(callsB, 1)
    for (const incompatible of [{ ...config, port: 1 }, { ...config, apiKeyEnv: "QWENCLOUD_OTHER_SYNTHETIC_KEY" }, { ...config, autoKey: false }]) {
      const rejected = await Effect.runPromise(Effect.scoped(acquireQuotaBridge(incompatible)))
      assert.equal(rejected.diagnostic, "incompatible-config")
      assert.equal(process.env["QWENCLOUD_OTHER_SYNTHETIC_KEY"], undefined)
    }
  } finally { await Promise.all(scopes.map(scope => Effect.runPromise(Scope.close(scope, Exit.void)))) }
  assert.equal(process.env[envName], undefined)
  await assert.rejects(fetch(url))
})

test("last release and reacquisition are serialized and preserve replacement or preexisting keys", async () => {
  const config = { port: 0, apiKeyEnv: envName, autoKey: true }
  const first = await Effect.runPromise(Scope.make())
  const second = await Effect.runPromise(Scope.make())
  try {
    const a = await Effect.runPromise(acquireQuotaBridge(config).pipe(Scope.provide(first)))
    const old = process.env[envName]
    process.env[envName] = token
    const mismatch = await Effect.runPromise(Effect.scoped(acquireQuotaBridge(config)))
    assert.equal(mismatch.diagnostic, "incompatible-config")
    const closing = Effect.runPromise(Scope.close(first, Exit.void))
    const b = await Effect.runPromise(acquireQuotaBridge({ ...config, port: Number(new URL(a.url!).port) }).pipe(Scope.provide(second)))
    await closing
    assert.equal(b.running, true)
    assert.notEqual(old, token)
    assert.equal(process.env[envName], token)
  } finally {
    await Effect.runPromise(Scope.close(first, Exit.void))
    await Effect.runPromise(Scope.close(second, Exit.void))
    assert.equal(process.env[envName], token)
    delete process.env[envName]
  }
})

test("autoKey startup failure rolls back its owned key, empty preexisting keys are not overwritten, and registry mismatch fails closed", async () => {
  const occupied = await startQuotaBridge({ port: 0, token, getQuota: async () => { throw new Error("unused") } })
  try {
    const failed = await Effect.runPromise(Effect.scoped(acquireQuotaBridge({ port: Number(new URL(occupied.url).port), apiKeyEnv: envName, autoKey: true })))
    assert.equal(failed.diagnostic, "start-failed")
    assert.equal(process.env[envName], undefined)
    process.env[envName] = ""
    const invalid = await Effect.runPromise(Effect.scoped(acquireQuotaBridge({ port: 0, apiKeyEnv: envName, autoKey: true })))
    assert.equal(invalid.diagnostic, "invalid-key")
    assert.equal(process.env[envName], "")
    delete process.env[envName]
    const registry = quotaBridgeRegistry()
    const mutable = registry as unknown as { version: number }
    mutable.version = 2
    try {
      const mismatch = await Effect.runPromise(Effect.scoped(acquireQuotaBridge({ port: 0, apiKeyEnv: envName, autoKey: true })))
      assert.equal(mismatch.diagnostic, "start-failed")
      assert.equal(process.env[envName], undefined)
    } finally { mutable.version = 1 }
    assert.throws(() => parseOptions({ quotaBridge: { port: 62366, autoKey: "true" } }))
    assert.equal(parseOptions({ quotaBridge: { port: 62366, autoKey: true } }).quotaBridge?.autoKey, true)
  } finally { await occupied.close(); delete process.env[envName] }
})

test("module copies share the registry and bridge and native reads fence all live locations", async () => {
  const root = await mkdtemp("/tmp/opencode/quota-bridge-locations-")
  const scopes = await Promise.all([Effect.runPromise(Scope.make()), Effect.runPromise(Scope.make())])
  const oldPath = process.env.PATH
  try {
    const first = join(root, "first"), second = join(root, "second"), alias = join(root, "alias"), trusted = join(root, "trusted")
    for (const directory of [first, second, trusted]) await mkdir(directory)
    await symlink(second, alias, "dir")
    await writeFile(join(second, "bl"), `#!${process.execPath}\nprocess.exitCode=1\n`, { mode: 0o755 })
    await writeFile(join(trusted, "bl"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(sample))})\n`, { mode: 0o755 })
    process.env.PATH = `${second}:${trusted}`
    const config = { port: 0, apiKeyEnv: envName, autoKey: true }
    const a = await Effect.runPromise(acquireQuotaBridge(config, { workspaceRoot: first }).pipe(Scope.provide(scopes[0])))
    const copy = await import(new URL("../src/quota-bridge-plugin.ts?synthetic-copy", import.meta.url).href) as typeof import("../src/quota-bridge-plugin.js")
    const b = await Effect.runPromise(copy.acquireQuotaBridge(config, { workspaceRoot: alias }).pipe(Scope.provide(scopes[1])))
    assert.equal(b.url, a.url)
    const response = await fetch(a.url!, { headers: { Authorization: `Bearer ${process.env[envName]}` } })
    assert.equal(response.status, 200)
    const body = await response.json() as { entries: unknown[] }
    assert.equal(body.entries.length, 1)
    assert.deepEqual(await resolveBlExecutable(), { file: join(trusted, "bl"), pathEnv: trusted })
  } finally {
    await Promise.all(scopes.map(scope => Effect.runPromise(Scope.close(scope, Exit.void))))
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath
    await rm(root, { recursive: true, force: true })
  }
})

test("interruption during queued acquisition releases the eventual lease and generated key", async () => {
  const registry = quotaBridgeRegistry()
  let unblock!: () => void
  const gate = new Promise<void>(resolve => { unblock = resolve })
  const blocker = serializeQuotaBridge(registry, () => gate)
  const controller = new AbortController()
  const pending = Effect.runPromise(Effect.scoped(acquireQuotaBridge({ port: 0, apiKeyEnv: envName, autoKey: true })), { signal: controller.signal }).then(() => false, () => true)
  controller.abort()
  unblock()
  await blocker
  assert.equal(await pending, true)
  await registry.queue
  assert.equal(registry.entry, undefined)
  assert.equal(process.env[envName], undefined)
})
