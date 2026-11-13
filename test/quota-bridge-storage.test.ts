import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { prepareQuotaBridgeState, readQuotaBridgeRoots } from "../src/quota-bridge-storage.js"

const token = "synthetic-crash-recovery-bridge-key-000000"

for (const target of ["key", "root"] as const) {
  test(`startup recovers a crash after publishing the ${target} hardlink before staging unlink`, async () => {
    const home = await mkdtemp("/tmp/opencode/qwen-publication-crash-")
    try {
      const directory = join(home, "state"), root = join(home, "workspace")
      await mkdir(join(directory, "roots"), { recursive: true, mode: 0o700 })
      const text = target === "key" ? token : JSON.stringify({ version: 1, lexical: root, canonical: root })
      const staging = join(directory, ".pending-" + "1".repeat(32))
      const published = target === "key" ? join(directory, "bridge.key") : join(directory, "roots", createHash("sha256").update(text).digest("hex") + ".json")
      await writeFile(staging, text, { mode: 0o600, flush: true })
      await link(staging, published)
      assert.equal((await lstat(published)).nlink, 2)
      const state = await prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] })
      if (target === "key") assert.equal(state.token === token, true)
      else assert.deepEqual(await readQuotaBridgeRoots(directory), [root, root])
      assert.equal((await lstat(published)).nlink, 1)
      await assert.rejects(lstat(staging), { code: "ENOENT" })
      assert.equal((await readFile(published, "utf8")) === text, true)
      assert.equal((await prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] })).token === state.token, true)
    } finally { await rm(home, { recursive: true, force: true }) }
  })
}

for (const target of ["key", "root"] as const) {
  test(`unrecognized ${target} hardlinks and unsafe staging files fail closed without unlinking`, async () => {
    const home = await mkdtemp("/tmp/opencode/qwen-publication-hostile-")
    try {
      const directory = join(home, "state"), root = join(home, "workspace")
      await prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: target === "root" ? [root] : [] })
      const text = JSON.stringify({ version: 1, lexical: root, canonical: root })
      const published = target === "key" ? join(directory, "bridge.key") : join(directory, "roots", createHash("sha256").update(text).digest("hex") + ".json")
      const unrecognized = join(directory, "unrecognized-hardlink")
      const staging = join(directory, ".pending-" + "2".repeat(32))
      await link(published, unrecognized)
      await symlink(unrecognized, staging)
      await assert.rejects(prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] }))
      assert.equal((await lstat(published)).nlink, 2)
      assert.equal((await lstat(staging)).isSymbolicLink(), true)
      assert.ok((await lstat(unrecognized)).isFile())
      await rm(staging)
      await writeFile(staging, "unrelated-staging-inode", { mode: 0o600 })
      await assert.rejects(prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] }))
      assert.equal(await readFile(staging, "utf8"), "unrelated-staging-inode")
      assert.equal((await lstat(published)).nlink, 2)
      await rm(staging)
      await link(published, staging)
      await assert.rejects(prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] }))
      assert.equal((await lstat(staging)).nlink, 3)
      await rm(unrecognized)
      await chmod(staging, 0o644)
      await assert.rejects(prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] }))
      assert.equal((await lstat(staging)).nlink, 2)
      assert.equal((await lstat(published)).nlink, 2)
    } finally { await rm(home, { recursive: true, force: true }) }
  })
}
