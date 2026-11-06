import { open, constants } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"

export async function readAdapterKeyFile(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Invalid adapter key path")
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || ![0o400, 0o600].includes(stat.mode & 0o7777) || stat.size < 32 || stat.size > 514) throw new Error("Invalid adapter key file")
    const buffer = Buffer.alloc(515)
    try {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      const token = buffer.subarray(0, bytesRead).toString("utf8").trim()
      if (bytesRead > 514 || !/^[\x21-\x7e]{32,512}$/.test(token)) throw new Error("Invalid adapter key file")
      return token
    } finally { buffer.fill(0) }
  } finally { await file.close() }
}

async function main() {
  const args = process.argv.slice(2)
  const flags = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!["--location", "--port", "--key-file"].includes(name) || !value || flags.has(name)) throw new Error("Invalid configuration")
    flags.set(name, value)
  }
  const location = flags.get("--location")
  if (!location || !isAbsolute(location)) throw new Error("Explicit absolute location required")
  const token = await readAdapterKeyFile(flags.get("--key-file"))
  const { quotaAdapterConfig, startQuotaAdapter } = await import("../dist/quota-adapter.js")
  const config = quotaAdapterConfig(["--location", location, "--port", flags.get("--port") ?? "62366"], { QWENCLOUD_QUOTA_ADAPTER_KEY: token })
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  try {
    const adapter = await startQuotaAdapter({ ...config, signal: controller.signal })
    try {
      await new Promise(resolve => {
        if (controller.signal.aborted) resolve()
        else controller.signal.addEventListener("abort", resolve, { once: true })
      })
    } finally { await adapter.close() }
  } finally {
    process.removeListener("SIGTERM", stop)
    process.removeListener("SIGINT", stop)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("Quota adapter failed; check the private adapter key file, configuration and listener port.\n")
    process.exitCode = 1
  })
}
