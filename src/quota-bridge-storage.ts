import { constants, type Stats } from "node:fs"
import { link, lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises"
import { createHash, randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const MAX_RECORDS = 1024
const MAX_BYTES = 1_048_576
const MAX_PATH = 4096
const MAX_RECORD = MAX_PATH * 2 + 128
// Append-only roots intentionally over-fence stale workspaces across owner takeover.
const unavailable = () => new Error("Shared quota bridge state unavailable.")

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
}

async function canonical(path: string): Promise<string> {
  try { return await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw unavailable()
    return join(await canonical(dirname(path)), basename(path))
  }
}

async function directory(path: string, create: boolean): Promise<void> {
  if (dirname(path) !== path) await directory(dirname(path), create)
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw unavailable() })
  const info = await lstat(path)
  const uid = process.getuid?.()
  if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== uid && info.uid !== 0) || ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000)))) throw unavailable()
}

async function privateDirectory(path: string): Promise<void> {
  await directory(path, false)
  const info = await lstat(path)
  if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw unavailable()
}

async function recoverPublication(stagingDirectory: string, published: Stats): Promise<void> {
  await privateDirectory(stagingDirectory)
  let count = 0
  for await (const entry of await opendir(stagingDirectory)) {
    if (++count > MAX_RECORDS + 3) throw unavailable()
    if (!/^\.pending-[a-f0-9]{32}$/.test(entry.name)) continue
    const staging = join(stagingDirectory, entry.name)
    const info = await lstat(staging).catch(error => {
      if (error.code !== "ENOENT") throw unavailable()
      return undefined
    })
    if (!info || info.dev !== published.dev || info.ino !== published.ino) continue
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 2) throw unavailable()
    // Only the private publisher's matching staging inode can explain a second link.
    await unlink(staging).catch(error => { if (error.code !== "ENOENT") throw unavailable() })
    return
  }
}

async function readPrivate(path: string, max: number, stagingDirectory = dirname(path)): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    let info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > max) throw unavailable()
    if (info.nlink === 2) {
      await recoverPublication(stagingDirectory, info)
      info = await file.stat()
    }
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size > max) throw unavailable()
    const buffer = Buffer.alloc(max + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > max) throw unavailable()
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))
  } finally { await file.close().catch(() => {}) }
}

async function publish(path: string, value: string, stagingDirectory = dirname(path)): Promise<void> {
  const temporary = join(stagingDirectory, `.pending-${randomBytes(16).toString("hex")}`)
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await file.writeFile(value)
    await file.sync()
    await file.close()
    await link(temporary, path).catch(error => { if (error.code !== "EEXIST") throw unavailable() })
  } finally {
    await file.close().catch(() => {})
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw unavailable() })
  }
}

export async function readQuotaBridgeRoots(stateDirectory: string): Promise<string[]> {
  await privateDirectory(stateDirectory)
  const rootDirectory = join(stateDirectory, "roots")
  await privateDirectory(rootDirectory)
  let bytes = 0, count = 0
  const roots: string[] = []
  for await (const entry of await opendir(rootDirectory)) {
    if (++count > MAX_RECORDS) throw unavailable()
    const name = entry.name
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw unavailable()
    const text = await readPrivate(join(rootDirectory, name), MAX_RECORD, stateDirectory)
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_BYTES || createHash("sha256").update(text).digest("hex") + ".json" !== name) throw unavailable()
    const record = JSON.parse(text) as { version?: unknown; lexical?: unknown; canonical?: unknown }
    if (record.version !== 1 || Object.keys(record).length !== 3) throw unavailable()
    for (const path of [record.lexical, record.canonical]) {
      if (typeof path !== "string" || path.length > MAX_PATH || path.includes("\0") || !isAbsolute(path) || resolve(path) !== path) throw unavailable()
      roots.push(path)
    }
  }
  if (roots.some(root => inside(root, stateDirectory))) throw unavailable()
  return roots
}

export async function prepareQuotaBridgeState(options: { stateDirectory?: string; workspaceRoots: readonly string[]; token?: string }): Promise<{ directory: string; token: string }> {
  const path = resolve(options.stateDirectory ?? join(homedir(), ".local", "state", "opencode-qwencloud-oauth", "quota-bridge-v1"))
  const pairs = await Promise.all(options.workspaceRoots.map(async root => ({ version: 1, lexical: resolve(root), canonical: await canonical(resolve(root)) })))
  const actual = await canonical(path)
  if (pairs.some(root => inside(root.lexical, path) || inside(root.canonical, actual))) throw unavailable()
  await directory(path, true)
  await privateDirectory(path)
  await directory(join(path, "roots"), true)
  await privateDirectory(join(path, "roots"))
  const keyPath = join(path, "bridge.key")
  await publish(keyPath, options.token ?? randomBytes(32).toString("hex"))
  const token = await readPrivate(keyPath, 512)
  if (!/^[\x21-\x7e]{32,512}$/.test(token) || (options.token !== undefined && options.token !== token)) throw unavailable()
  for (const pair of pairs) {
    if (pair.lexical.length > MAX_PATH || pair.canonical.length > MAX_PATH) throw unavailable()
    const text = JSON.stringify(pair)
    await publish(join(path, "roots", createHash("sha256").update(text).digest("hex") + ".json"), text, path)
  }
  await readQuotaBridgeRoots(path)
  return { directory: path, token }
}
