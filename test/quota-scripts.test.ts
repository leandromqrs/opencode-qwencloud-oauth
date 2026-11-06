import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

test("runner accepts only an owner-private regular adapter key file", async () => {
  const modulePath = new URL("../scripts/quota-adapter-run.mjs", import.meta.url).href
  const { readAdapterKeyFile } = await import(modulePath)
  const directory = await mkdtemp(join(tmpdir(), "qwen-quota-key-test-"))
  const path = join(directory, "synthetic.key")
  const token = "synthetic-test-adapter-key-01234567890123456789"
  try {
    await writeFile(path, token + "\n", { mode: 0o600 })
    assert.equal(await readAdapterKeyFile(path), token)
    await chmod(path, 0o400)
    assert.equal(await readAdapterKeyFile(path), token)
    await chmod(path, 0o644)
    await assert.rejects(readAdapterKeyFile(path))
    await chmod(path, 0o600)
    await symlink(path, join(directory, "link"))
    await assert.rejects(readAdapterKeyFile(join(directory, "link")))
    await assert.rejects(readAdapterKeyFile(directory))
    await writeFile(path, "short")
    await assert.rejects(readAdapterKeyFile(path))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("management script rejects unrelated units and never manages Junie", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qwen-quota-manager-test-"))
  const script = new URL("../scripts/quota-adapter.sh", import.meta.url)
  try {
    await writeFile(join(directory, "systemctl"), "#!/bin/sh\n[ \"$3\" = opencode-qwen-code-quota-adapter.service ] || exit 98\ncase \"$*\" in\n*--property=LoadState*) echo loaded;;\n*--property=Description*) echo unrelated;;\n*--property=Transient*) echo yes;;\n*) exit 99;;\nesac\n", { mode: 0o700 })
    const result = spawnSync("bash", [script.pathname, "stop"], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, encoding: "utf8" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /unrelated unit/)
    assert.equal(spawnSync("bash", [script.pathname, "run"], { encoding: "utf8" }).status, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
