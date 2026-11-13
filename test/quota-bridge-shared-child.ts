import { Effect, Exit, Scope } from "effect"
import { acquireQuotaBridge, type QuotaBridgeStatus } from "../src/quota-bridge-plugin.js"
import { resolveBlExecutable } from "../src/quota-cli.js"

let scope: Scope.Closeable | undefined
let status: QuotaBridgeStatus
let requests = 0
let envName = ""

process.on("message", async (message: { action: string; port?: number; directory?: string; root?: string; runner?: boolean; pathEnv?: string; explicitKey?: string }) => {
  try {
    if (message.action === "start") {
      scope = await Effect.runPromise(Scope.make())
      envName = "QWENCLOUD_SHARED_SYNTHETIC_KEY"
      if (message.explicitKey) process.env[envName] = message.explicitKey
      status = await Effect.runPromise(acquireQuotaBridge({ port: message.port!, apiKeyEnv: envName, autoKey: true, shared: true }, {
        workspaceRoot: message.root,
        stateDirectory: message.directory,
        ...(message.runner !== false ? { runner: async () => { requests++; return { ok: true as const, stdout: JSON.stringify({ per1MonthPercentage: 0.25 }) } } } : {}),
      }).pipe(Scope.provide(scope)))
      process.send?.({ action: "ready", running: status.running, requests, keyPresent: process.env[envName] !== undefined })
    } else if (message.action === "resolve") {
      process.send?.({ action: "resolve", found: !!await resolveBlExecutable({ pathEnv: message.pathEnv }) })
    } else if (message.action === "query") {
      if (!process.env[envName] || !status.url) process.send?.({ action: "query", ok: false })
      else {
        const response = await fetch(status.url, { headers: { Authorization: `Bearer ${process.env[envName]}` }, signal: AbortSignal.timeout(3000) })
        const body = await response.json() as { rows?: unknown[] }
        process.send?.({ action: "query", ok: response.ok, rows: body.rows?.length ?? 0 })
      }
    } else if (message.action === "stop") {
      if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
      process.send?.({ action: "stopped", keyPresent: process.env[envName] !== undefined })
      process.disconnect()
    }
  } catch { process.send?.({ action: message.action === "start" ? "ready" : message.action, ok: false, running: false }) }
})

process.on("disconnect", async () => {
  if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
  process.exit(0)
})
