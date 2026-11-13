import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { Schema, SchemaRepresentation } from "effect"
import { readAlibabaConsoleQuota, resolveBlExecutable, runQuotaProcess, type QuotaCliRunner } from "../src/quota-cli.js"
import { qwenCloudQuotaSchema, readQwenCloudQuota, toQwenCloudQuotaV1 } from "../src/quota.js"
import { quotaBridgeRegistry } from "../src/quota-bridge-state.js"

const sample = { per1MonthPercentage: 0.5715795927593333, per1MonthResetTime: 1794672000000 }
const runner = (value: unknown): QuotaCliRunner => async () => ({ ok: true, stdout: JSON.stringify(value) })

test("official bl JSON becomes independent personal percent quota without absolute balances or identity claims", async () => {
  const result = await readAlibabaConsoleQuota({ runner: runner({ ...sample, account: "PRIVATE", token: "PRIVATE" }) })
  assert.equal(result.state, "ready")
  assert.equal(result.source, "alibaba-console-cli")
  assert.equal(result.accountBinding, "unverified")
  assert.deepEqual(result.balances, [])
  assert.deepEqual(result.personalWindows, [{ period: "monthly", scope: "personal", usedFraction: sample.per1MonthPercentage, resetAt: new Date(sample.per1MonthResetTime).toISOString() }])
  assert.deepEqual(readQwenCloudQuota(result), result)
  const schema = SchemaRepresentation.fromJsonSchemaDocument({ dialect: "draft-2020-12", schema: qwenCloudQuotaSchema, definitions: {} })
  assert.deepEqual(Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)(result), result)
  const rows = toQwenCloudQuotaV1(result).entries
  assert.equal(rows[0].percentRemaining, 100 - sample.per1MonthPercentage * 100)
  assert.equal(rows[0].resetTimeIso, new Date(sample.per1MonthResetTime).toISOString())
  assert.match(rows[0].label, /Alibaba console/)
  assert.match(rows[0].label, /unverified/)
  assert.ok(!rows.some(row => row.resultType === "balance"))
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
})

test("CLI percentages preserve explicit zero and absence, reject invalid fractions and reset timestamps", async () => {
  for (const usedFraction of [0, 1]) {
    const result = await readAlibabaConsoleQuota({ runner: runner({ per1MonthPercentage: usedFraction }) })
    assert.equal(result.state, "ready")
    assert.equal(result.personalWindows?.[0].usedFraction, usedFraction)
  }
  const missing = await readAlibabaConsoleQuota({ runner: runner({ per1MonthResetTime: sample.per1MonthResetTime }) })
  assert.equal(missing.state, "unknown")
  assert.equal(missing.personalWindows, undefined)
  assert.deepEqual(readQwenCloudQuota(missing), missing)
  for (const value of [null, [], { error: "PRIVATE" }, { per1MonthPercentage: -0.1 }, { per1MonthPercentage: 1.1 }, { per1MonthPercentage: "0.5" }, { per1MonthPercentage: null }, { per1MonthPercentage: 0.5, per1MonthResetTime: -1 }, { per1MonthPercentage: 0.5, per1MonthResetTime: "1794672000000" }]) {
    const result = await readAlibabaConsoleQuota({ runner: runner(value) })
    assert.equal(result.state, "error")
    assert.equal(result.personalWindows, undefined)
    assert.deepEqual(readQwenCloudQuota(result), result)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
  }
})

test("CLI failures are sanitized and never replaced with management/team balances", async () => {
  for (const code of ["unauthorized", "cli-not-found", "cli-failed", "timeout", "body-too-large"] as const) {
    const result = await readAlibabaConsoleQuota({ runner: async () => ({ ok: false, code }) })
    assert.equal(result.state, "error")
    assert.equal(result.source, "alibaba-console-cli")
    assert.deepEqual(result.balances, [])
    assert.deepEqual(result.diagnostics, [{ action: "AlibabaTokenPlanUsage", code }])
    assert.deepEqual(readQwenCloudQuota(result), result)
  }
  const result = await readAlibabaConsoleQuota({ runner: async () => { throw new Error("PRIVATE") } })
  assert.equal(result.diagnostics[0].code, "cli-failed")
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
  let calls = 0
  const cancelled = await readAlibabaConsoleQuota({ runner: async () => { calls++; throw new Error() } }, AbortSignal.abort())
  assert.equal(calls, 0)
  assert.equal(cancelled.diagnostics[0].code, "cancelled")
})

test("native reader rejects forged CLI provenance, scopes, window counts and invalid state combinations", async () => {
  const result = await readAlibabaConsoleQuota({ runner: runner(sample) })
  for (const invalid of [
    { ...result, accountBinding: "verified" }, { ...result, source: "qwencloud-token-plan" },
    { ...result, personalWindows: [{ ...result.personalWindows![0], scope: "team" }] },
    { ...result, personalWindows: [result.personalWindows![0], result.personalWindows![0]] },
    { ...result, state: "error", diagnostics: [{ action: "AlibabaTokenPlanUsage", code: "cli-failed" }] },
    { ...result, balances: [{ id: "team-1", kind: "team", scope: "team-aggregate", status: "valid", unit: "Credits", action: "DescribeFrInstances", remaining: "0" }] },
  ]) assert.throws(() => readQwenCloudQuota(invalid))
})

test("executable discovery ignores relative/workspace paths, workspace symlinks and shell launchers", async () => {
  const root = await mkdtemp("/tmp/opencode/quota-cli-")
  try {
    const workspace = join(root, "project"), trusted = join(root, "trusted")
    await mkdir(workspace); await mkdir(trusted)
    await writeFile(join(workspace, "bl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    assert.equal(await resolveBlExecutable({ pathEnv: `.:${workspace}`, workspaceRoot: workspace }), undefined)
    await symlink(join(workspace, "bl"), join(trusted, "bl"))
    assert.equal(await resolveBlExecutable({ pathEnv: trusted, workspaceRoot: workspace }), undefined)
    await rm(join(trusted, "bl"))
    await writeFile(join(trusted, "launcher.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    await symlink(join(trusted, "launcher.sh"), join(trusted, "bl"))
    assert.equal(await resolveBlExecutable({ pathEnv: trusted, workspaceRoot: workspace }), undefined)
    await rm(join(trusted, "bl"))
    await writeFile(join(trusted, "bl"), "#!/usr/bin/env node\n", { mode: 0o755 })
    const resolved = await resolveBlExecutable({ pathEnv: `.:${workspace}:${trusted}`, workspaceRoot: workspace })
    assert.equal(resolved?.file, join(trusted, "bl"))
    assert.equal(resolved?.pathEnv, trusted)
    await symlink(trusted, join(workspace, "outside"), "dir")
    assert.equal(await resolveBlExecutable({ pathEnv: join(workspace, "outside"), workspaceRoot: workspace }), undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("production runner uses fixed quota argv and home cwd without passing plugin credentials", async () => {
  const root = await mkdtemp("/tmp/opencode/quota-cli-argv-")
  const originalPath = process.env.PATH
  try {
    const source = `#!${process.execPath}\nconst ok=JSON.stringify(process.argv.slice(2))===JSON.stringify(['usage','token-plan','--output','json'])&&process.cwd()===${JSON.stringify(homedir())};if(!ok)process.exitCode=1;else process.stdout.write(${JSON.stringify(JSON.stringify(sample))});\n`
    await writeFile(join(root, "bl"), source, { mode: 0o755 })
    process.env.PATH = root
    const result = await readAlibabaConsoleQuota()
    assert.equal(result.state, "ready")
    assert.equal(result.personalWindows?.[0].usedFraction, sample.per1MonthPercentage)
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    await rm(root, { recursive: true, force: true })
  }
})

test("subprocess bounds stdout, discarded stderr, duration and cancellation without exposing output on failure", { timeout: 10000 }, async () => {
  const root = await mkdtemp("/tmp/opencode/quota-cli-process-")
  try {
    for (const [source, expected] of [
      ["process.stdout.write('PRIVATE'); process.exitCode=3", "unauthorized"],
      ["process.stderr.write('PRIVATE'); process.exitCode=1", "cli-failed"],
      ["process.stdout.write('x'.repeat(262145))", "body-too-large"],
      ["process.stderr.write('x'.repeat(262145))", "body-too-large"],
      ["setInterval(()=>{},1000)", "timeout"],
    ] as const) {
      const file = join(root, "fixture.cjs")
      await writeFile(file, source)
      const result = await runQuotaProcess(process.execPath, [file], { timeoutMs: expected === "timeout" ? 50 : 2000, signal: new AbortController().signal })
      assert.deepEqual(result, { ok: false, code: expected })
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
    }
    const file = join(root, "fixture.cjs")
    await writeFile(file, `process.stdout.write(${JSON.stringify(JSON.stringify(sample))})`)
    const result = await runQuotaProcess(process.execPath, [file], { timeoutMs: 1000, signal: new AbortController().signal })
    assert.deepEqual(result, { ok: true, stdout: JSON.stringify(sample) })
    await writeFile(file, "setInterval(()=>{},1000)")
    const controller = new AbortController()
    const pending = runQuotaProcess(process.execPath, [file], { timeoutMs: 1000, signal: controller.signal })
    controller.abort()
    assert.deepEqual(await pending, { ok: false, code: "cancelled" })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("aggregate workspace fencing rejects every lexical and canonical location while preserving trusted PATH", async () => {
  const root = await mkdtemp("/tmp/opencode/quota-cli-roots-")
  try {
    const first = join(root, "first"), second = join(root, "second"), trusted = join(root, "trusted"), alias = join(root, "alias")
    for (const directory of [first, second, trusted]) {
      await mkdir(directory)
      await writeFile(join(directory, "bl"), `#!${process.execPath}\n`, { mode: 0o755 })
    }
    await symlink(second, alias, "dir")
    const resolved = await resolveBlExecutable({ pathEnv: [first, second, alias, trusted].join(":"), workspaceRoot: first, workspaceRoots: [alias] })
    assert.deepEqual(resolved, { file: join(trusted, "bl"), pathEnv: trusted })
    await rm(join(trusted, "bl"))
    await symlink(join(second, "bl"), join(trusted, "bl"))
    assert.equal(await resolveBlExecutable({ pathEnv: trusted, workspaceRoots: [first, alias] }), undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("CLI children omit dedicated, active custom and explicit bridge keys without changing parent environment", async () => {
  const names = ["QWENCLOUD_QUOTA_BRIDGE_KEY", "QWENCLOUD_SYNTHETIC_ACTIVE_KEY", "QWENCLOUD_SYNTHETIC_EXPLICIT_KEY"]
  const previous = names.map(name => process.env[name])
  const registry = quotaBridgeRegistry()
  const root = await mkdtemp("/tmp/opencode/quota-cli-env-")
  try {
    names.forEach(name => { process.env[name] = "synthetic-bridge-key-only" })
    registry.pendingEnvName = names[1]
    const source = `if(${JSON.stringify(names)}.some(name=>process.env[name]!==undefined))process.exitCode=1;else process.stdout.write('safe');`
    const result = await runQuotaProcess(process.execPath, ["-e", source], { signal: new AbortController().signal, omitEnvKeys: [names[2]] })
    assert.deepEqual(result, { ok: true, stdout: "safe" })
    assert.deepEqual(names.map(name => process.env[name]), names.map(() => "synthetic-bridge-key-only"))
  } finally {
    delete registry.pendingEnvName
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index] })
    await rm(root, { recursive: true, force: true })
  }
})
