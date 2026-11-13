import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { make, LanguageModel } from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route"
import { ai } from "@opencode/ai/effect"
import { Effect, Stream } from "effect"
import { FetchHttpClient, HttpClientRequest } from "effect/http"
import { model } from "../src/driver.js"
import { API_BASE } from "../src/transport.js"
import { nativeModel, reconcileCatalog } from "../src/inventory.js"

const settings = { baseURL: API_BASE, apiKey: "sk-sp-fixture" }
const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: "fixture-id", object: "chat.completion.chunk", created: 1, model: "qwen3.8-max", choices: [{ index: 0, delta, finish_reason }] })
const frames = [
  chunk({ role: "assistant", reasoning_content: "Considering" }), chunk({ content: "Olá" }),
  chunk({ tool_calls: [{ index: 0, id: "fixture-tool", type: "function", function: { name: "lookup", arguments: '{"q":' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '"test"}' } }] }), chunk({}, "tool_calls"),
  { id: "fixture-id", object: "chat.completion.chunk", created: 1, model: "qwen3.8-max", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n"

test("published Qwen effort selections reach the secured wire while an unselected model keeps upstream defaults", async () => {
  for (const id of ["qwen4-max-preview", "qwen3.8-max", "qwen3.8-flash"]) {
    const native = nativeModel(reconcileCatalog({ fetchedAt: 1, models: [{ id }] })[0])
    assert.deepEqual(native.variants.map(variant => variant.id), ["none", "low", "medium", "xhigh"])
    for (const variant of [undefined, ...native.variants]) {
      let requests = 0
      const fetcher: typeof fetch = async input => {
        assert.ok(input instanceof Request)
        assert.equal(input.url, `${API_BASE}/chat/completions`)
        assert.equal(input.headers.get("authorization"), "Bearer sk-sp-fixture")
        const body = await input.json()
        assert.equal(body.model, id)
        assert.equal(body.reasoning_effort, variant?.id)
        assert.equal(Object.hasOwn(body, "reasoning_effort"), variant !== undefined)
        assert.equal(Object.hasOwn(body, "reasoningEffort"), false)
        assert.equal(Object.hasOwn(body, "thinking_budget"), false)
        assert.equal(Object.hasOwn(body, "enable_thinking"), false)
        requests++
        return new Response(frames, { headers: { "Content-Type": "text/event-stream" } })
      }
      const fixture = harness(fetcher)
      try {
        await fixture.run(model(id, { ...native.settings, ...variant?.settings, baseURL: API_BASE, apiKey: "sk-sp-fixture" }))
        assert.equal(requests, 1)
        assert.equal(fixture.roundtrips(), 1)
      } finally { await fixture.client.dispose() }
    }
  }
})

function harness(fetcher: typeof fetch, replacement?: (request: Request) => Promise<Request>) {
  let roundtrips = 0
  const client = make({ layer: RequestExecutor.middleware((request, handler) => Effect.gen(function* () {
    const web = yield* HttpClientRequest.toWeb(request)
    const secured = new Request(web, { redirect: "error", signal: AbortSignal.timeout(60_000) })
    const replaced = replacement ? yield* Effect.promise(() => replacement(secured)) : secured
    const converted = HttpClientRequest.fromWeb(replaced)
    const body = new Uint8Array(yield* Effect.promise(() => replaced.arrayBuffer()))
    roundtrips++
    return yield* handler(HttpClientRequest.bodyUint8Array(converted, body))
  })) })
  const run = (selected = model("qwen3.8-max", settings), signal?: AbortSignal) => client.run(Stream.runCollect(ai.stream({ model: selected, prompt: "fixture", tools: [{ name: "lookup", description: "Fixture tool", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }], toolChoice: "auto" })).pipe(Effect.provideService(FetchHttpClient.Fetch, fetcher)), { signal })
  return { client, run, roundtrips: () => roundtrips }
}

async function listening(server: Server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return `http://127.0.0.1:${address.port}`
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }

async function localhostFetch(origin: string, input: Parameters<typeof fetch>[0], init?: RequestInit) {
  assert.ok(input instanceof Request)
  assert.equal(init, undefined)
  return fetch(origin, { method: input.method, headers: input.headers, body: await input.arrayBuffer(), redirect: input.redirect, signal: input.signal })
}

test("native secured route survives lossy host hook conversion with real fragmented SSE/tools/reasoning/usage", async () => {
  let received = 0
  const server = createServer(async (request, response) => {
    received++
    assert.equal(request.headers.authorization, "Bearer sk-sp-fixture")
    assert.equal(request.headers["x-private"], undefined)
    let body = ""
    for await (const bytes of request) body += bytes
    const parsed = JSON.parse(body)
    assert.equal(parsed.stream, true)
    assert.deepEqual(parsed.stream_options, { include_usage: true })
    assert.equal(parsed.enable_thinking, true)
    assert.equal(parsed.thinking_budget, undefined)
    assert.equal(parsed.reasoning_effort, undefined)
    assert.equal(parsed.tools[0].function.name, "lookup")
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const byte of new TextEncoder().encode(frames)) response.write(Uint8Array.of(byte))
    response.end()
  })
  const origin = await listening(server)
  let calls = 0
  const h = harness(async (input, init) => {
    calls++
    assert.ok(input instanceof Request)
    const request = input
    assert.equal(request.url, `${API_BASE}/chat/completions`)
    assert.equal(request.redirect, "error")
    return localhostFetch(`${origin}/chat/completions`, input, init)
  }, async request => { request.headers.set("x-private", "must-strip"); return request })
  try {
    const events = await h.run(model("qwen3.8-max", { ...settings, body: { enable_thinking: true } }))
    assert.equal(h.roundtrips(), 1)
    assert.equal(calls, 1)
    assert.equal(received, 1)
    assert.ok(events.some(event => event.type === "text-delta" && event.text === "Olá"))
    assert.ok(events.some(event => event.type === "reasoning-delta"))
    assert.ok(events.some(event => event.type === "tool-call"))
    const finish = events.find(event => event.type === "finish")
    assert.ok(finish)
    assert.equal(finish.usage?.inputTokens, 10)
    assert.equal(finish.usage?.outputTokens, 5)
    assert.equal(finish.usage?.totalTokens, 15)
  } finally { await h.client.dispose(); await close(server) }
})

test("default native deadline allows reasoning responses beyond two minutes", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  let began!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  let signal!: AbortSignal
  let upstream!: ReadableStreamDefaultController<Uint8Array>
  const h = harness(async input => {
    assert.ok(input instanceof Request)
    signal = input.signal
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; began() } }), { headers: { "content-type": "text/event-stream" } })
  })
  const running = h.run().then(events => ({ events }), error => ({ error }))
  try {
    await started
    context.mock.timers.tick(180_000)
    assert.equal(signal.aborted, false)
    upstream.enqueue(new TextEncoder().encode(frames))
    upstream.close()
    const result = await running
    assert.ok("events" in result)
    assert.ok(result.events.some(event => event.type === "finish"))
  } finally {
    try { upstream.close() } catch {}
    await h.client.dispose()
  }
})

test("native route rejects invalid credentials/settings before network and rejects hook destination/model substitution", async () => {
  for (const bad of [{ apiKey: undefined }, { apiKey: "management-token" }, { apiKey: "sk-payg-fixture" }, { baseURL: "https://evil.test" }, { timeout: 0 }]) assert.throws(() => model("qwen3.8-max", { ...settings, ...bad }))
  for (const invalid of ["", "bad\nmodel", "x".repeat(257)]) assert.throws(() => model(invalid, settings), /model/)
  let calls = 0
  for (const replace of [
    async (request: Request) => new Request("https://evil.test/chat/completions", request),
    async (request: Request) => new Request(request.url, { method: "POST", body: JSON.stringify({ model: "invented", messages: [] }) }),
  ]) {
    const h = harness(async () => { calls++; throw new Error("network forbidden") }, replace)
    try { await assert.rejects(h.run()) } finally { await h.client.dispose() }
  }
  assert.equal(calls, 0)
})

test("native route cannot follow 307 to a credential sink after host roundtrip", async () => {
  let leaked = 0
  const sink = createServer((_request, response) => { leaked++; response.end("leaked") })
  const sinkOrigin = await listening(sink)
  const source = createServer((_request, response) => { response.writeHead(307, { location: sinkOrigin }); response.end() })
  const origin = await listening(source)
  const h = harness(async (input, init) => localhostFetch(origin, input, init))
  try { await assert.rejects(h.run()); assert.equal(leaked, 0) }
  finally { await h.client.dispose(); await close(source); await close(sink) }
})

for (const streaming of [false, true]) for (const mode of ["caller", "timeout"] as const) test(`native ${mode} cancellation closes the upstream socket ${streaming ? "during SSE" : "before headers"} after host roundtrip`, { timeout: 8000 }, async context => {
  let began!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  let ended!: () => void
  const endedPromise = new Promise<void>(resolve => { ended = resolve })
  const server = createServer((request, response) => {
    request.socket.once("close", ended)
    if (streaming) { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders() }
    began()
  })
  const origin = await listening(server)
  const controller = new AbortController()
  const h = harness(async (input, init) => localhostFetch(origin, input, init))
  let cleanupPromise: Promise<void> | undefined
  const cleanup = () => cleanupPromise ??= (async () => { controller.abort(); await close(server); await h.client.dispose() })()
  context.after(cleanup)
  context.signal.addEventListener("abort", () => { void cleanup().catch(() => {}) }, { once: true })
  try {
    const running = h.run(model("qwen3.8-max", { ...settings, qwencloudTimeoutMs: mode === "timeout" ? 1000 : 60_000 }), controller.signal)
    const rejection = assert.rejects(running)
    await started
    if (mode === "caller") controller.abort()
    await rejection
    await endedPromise
  } finally { await cleanup() }
})

test("native deadlines survive forced garbage collection across pending fetch and SSE", { timeout: 25_000 }, async () => {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--expose-gc", "--import", "data:text/javascript,setInterval(()=>globalThis.gc(),25).unref()", "--import", "tsx", "--test",
    "--test-name-pattern", "native timeout cancellation", fileURLToPath(import.meta.url),
  ], { timeout: 22_000, env })
  assert.match(stdout, /# pass 2\b/)
  assert.match(stdout, /# fail 0\b/)
})

test("compiled file-URL provider loaded with an isolated Effect copy shares the host Fetch service contract", { timeout: 30_000 }, async () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const directory = await mkdtemp("/tmp/opencode/qwencloud-provider-loader-")
  try {
    await writeFile(`${directory}/package.json`, JSON.stringify({ type: "module" }))
    await mkdir(`${directory}/node_modules`, { recursive: true })
    await cp(`${root}/node_modules/effect`, `${directory}/node_modules/effect`, { recursive: true })
    await mkdir(`${directory}/node_modules/@opencode`)
    await cp(`${root}/node_modules/@opencode/ai`, `${directory}/node_modules/@opencode/ai`, { recursive: true })
    await symlink(`${root}/node_modules/@opencode/schema`, `${directory}/node_modules/@opencode/schema`)
    await promisify(execFile)(`${root}/node_modules/.bin/tsc`, ["src/driver.ts", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", "--strict", "--rootDir", "src", "--outDir", directory], { cwd: root })
    const loaded = await import(pathToFileURL(`${directory}/driver.js`).href) as typeof import("../src/driver.js")
    const isolated = await import(pathToFileURL(`${directory}/node_modules/effect/dist/http/FetchHttpClient.js`).href)
    assert.notEqual(isolated.Fetch, FetchHttpClient.Fetch)
    assert.equal(isolated.Fetch.key, FetchHttpClient.Fetch.key)
    let calls = 0
    const h = harness(async (input, init) => {
      calls++
      const request = new Request(input, init)
      assert.equal(request.redirect, "error")
      assert.equal(request.headers.get("authorization"), "Bearer sk-sp-fixture")
      return new Response(frames, { headers: { "content-type": "text/event-stream" } })
    })
    try {
      const isolatedModel = loaded.model("qwen3.8-max", settings)
      assert.equal(isolatedModel instanceof LanguageModel, false)
      const events = await h.run(LanguageModel.update(isolatedModel, { provider: "qwencloud" }))
      assert.equal(calls, 1)
      assert.equal(h.roundtrips(), 1)
      assert.ok(events.some(event => event.type === "finish"))
    } finally { await h.client.dispose() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
