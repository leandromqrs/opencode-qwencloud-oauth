import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join, relative, resolve, sep, basename, extname } from "node:path"
import type { QwenCloudQuota, QwenCloudQuotaDiagnostic } from "./quota.js"
import { quotaBridgeEnvironmentNames, quotaBridgeWorkspaceRoots, quotaBridgeStateDirectory } from "./quota-bridge-state.js"
import { readQuotaBridgeRoots } from "./quota-bridge-storage.js"

const MAX_BYTES = 262_144
const TIMEOUT_MS = 10_000
const ARGS = ["usage", "token-plan", "--output", "json"] as const
type FailureCode = QwenCloudQuotaDiagnostic["code"]
export type QuotaCliReply = { ok: true; stdout: string } | { ok: false; code: FailureCode }
export type QuotaCliRunner = (signal: AbortSignal) => Promise<QuotaCliReply>

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))
}

export async function resolveBlExecutable(options: { pathEnv?: string; workspaceRoot?: string; workspaceRoots?: readonly string[] } = {}): Promise<{ file: string; pathEnv: string } | undefined> {
  const home = resolve(homedir())
  const stateDirectory = quotaBridgeStateDirectory()
  const persistedRoots = stateDirectory ? await readQuotaBridgeRoots(stateDirectory) : []
  const roots = [resolve(process.cwd()) !== home ? process.cwd() : undefined, options.workspaceRoot, ...(options.workspaceRoots ?? []), ...quotaBridgeWorkspaceRoots(), ...persistedRoots].filter((value): value is string => !!value)
  const projects = [...roots.map(root => resolve(root)), ...await Promise.all(roots.map(async root => realpath(root).catch(() => resolve(root))))]
  const trusted: string[] = []
  for (const entry of (options.pathEnv ?? process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(entry) || projects.some(root => inside(root, resolve(entry)))) continue
    const directory = await realpath(entry).catch(() => undefined)
    if (directory && !projects.some(root => inside(root, directory)) && !trusted.includes(directory)) trusted.push(directory)
  }
  for (const directory of trusted) {
    const candidate = join(directory, "bl")
    const file = await realpath(candidate).catch(() => undefined)
    if (!file || projects.some(root => inside(root, file))) continue
    if (["sh", "bash", "dash", "zsh", "fish", "ksh", "cmd.exe", "powershell.exe", "pwsh"].includes(basename(file).toLowerCase()) || [".sh", ".bash", ".cmd", ".bat", ".ps1"].includes(extname(file).toLowerCase())) continue
    if (!(await stat(file).catch(() => undefined))?.isFile()) continue
    if (!(await access(file, constants.X_OK).then(() => true, () => false))) continue
    return { file, pathEnv: trusted.join(delimiter) }
  }
  return undefined
}

export function runQuotaProcess(file: string, args: readonly string[], options: { signal: AbortSignal; timeoutMs?: number; pathEnv?: string; omitEnvKeys?: readonly string[] }): Promise<QuotaCliReply> {
  if (options.signal.aborted) return Promise.resolve({ ok: false, code: "cancelled" })
  return new Promise(resolveResult => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(options.pathEnv !== undefined ? { PATH: options.pathEnv } : {}) }
    for (const name of ["QWENCLOUD_QUOTA_BRIDGE_KEY", ...quotaBridgeEnvironmentNames(), ...options.omitEnvKeys ?? []]) delete env[name]
    const child = spawn(file, [...args], {
      cwd: homedir(), env,
      shell: false, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    })
    const chunks: Buffer[] = []
    let stdoutBytes = 0, stderrBytes = 0
    let failure: FailureCode | undefined
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const signalGroup = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch {} }
    }
    const finish = (reply: QuotaCliReply) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(killTimer)
      options.signal.removeEventListener("abort", onAbort)
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      resolveResult(reply)
    }
    const stop = (code: FailureCode) => {
      if (failure || settled) return
      failure = code
      signalGroup("SIGTERM")
      killTimer = setTimeout(() => { signalGroup("SIGKILL"); finish({ ok: false, code }) }, 100)
    }
    const onAbort = () => stop("cancelled")
    const timeout = setTimeout(() => stop("timeout"), options.timeoutMs ?? TIMEOUT_MS)
    options.signal.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_BYTES) stop("body-too-large")
      else if (!failure && !settled) chunks.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_BYTES) stop("body-too-large") })
    child.on("error", () => finish({ ok: false, code: "cli-failed" }))
    child.on("close", code => {
      if (failure) {
        signalGroup("SIGKILL")
        finish({ ok: false, code: failure })
      } else if (code !== 0) finish({ ok: false, code: code === 3 ? "unauthorized" : "cli-failed" })
      else {
        try { finish({ ok: true, stdout: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) }) }
        catch { finish({ ok: false, code: "invalid-response" }) }
      }
    })
    if (options.signal.aborted) onAbort()
  })
}

async function runBlUsage(options: { workspaceRoot?: string; workspaceRoots?: readonly string[]; omitEnvKeys?: readonly string[] }, signal: AbortSignal): Promise<QuotaCliReply> {
  if (process.platform !== "linux" && process.platform !== "darwin") return { ok: false, code: "cli-unsupported" }
  const executable = await resolveBlExecutable(options)
  if (signal.aborted) return { ok: false, code: "cancelled" }
  if (!executable) return { ok: false, code: "cli-not-found" }
  return runQuotaProcess(executable.file, ARGS, { signal, pathEnv: executable.pathEnv, omitEnvKeys: options.omitEnvKeys })
}

export async function readAlibabaConsoleQuota(options: { runner?: QuotaCliRunner; workspaceRoot?: string; workspaceRoots?: readonly string[]; omitEnvKeys?: readonly string[] } = {}, signal?: AbortSignal): Promise<QwenCloudQuota> {
  const result: QwenCloudQuota = { state: "unknown", source: "alibaba-console-cli", accountBinding: "unverified", observedAt: new Date().toISOString(), balances: [], diagnostics: [] }
  const failure = (code: FailureCode): QwenCloudQuota => ({ ...result, state: "error", diagnostics: [{ action: "AlibabaTokenPlanUsage", code }] })
  if (signal?.aborted) return failure("cancelled")
  try {
    const reply = await (options.runner ?? (signal => runBlUsage(options, signal)))(signal ?? new AbortController().signal)
    if (signal?.aborted) return failure("cancelled")
    if (!reply.ok) return failure(reply.code)
    if (Buffer.byteLength(reply.stdout) > MAX_BYTES) return failure("body-too-large")
    const data: unknown = JSON.parse(reply.stdout)
    if (!data || typeof data !== "object" || Array.isArray(data) || "error" in data) return failure("invalid-response")
    const record = data as Record<string, unknown>
    const fraction = record.per1MonthPercentage
    if (fraction === undefined) return { ...result, diagnostics: [{ action: "AlibabaTokenPlanUsage", code: "missing-balance" }] }
    if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return failure("invalid-amount")
    const ms = record.per1MonthResetTime
    if (ms !== undefined && (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms <= 0 || ms > 253402300799999)) return failure("invalid-reset")
    return { ...result, state: "ready", observedAt: new Date().toISOString(), personalWindows: [{ period: "monthly", scope: "personal", usedFraction: fraction, ...(typeof ms === "number" ? { resetAt: new Date(ms).toISOString() } : {}) }] }
  } catch (error) { return failure(error instanceof SyntaxError ? "invalid-response" : "cli-failed") }
}
