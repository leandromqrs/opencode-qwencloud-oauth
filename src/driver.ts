import { model as compatibleModel, type Settings } from "@opencode/ai/providers/openai-compatible"
import { LanguageModel } from "@opencode/ai"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { API_BASE, isInferenceKey, prepareRequest } from "./transport.js"

/** Native Token Plan model with a deadline covering dispatch and streamed responses. */
export function model(modelID: string, settings: Settings): ReturnType<typeof compatibleModel> {
  // The host strips its own timeout setting before invoking provider modules.
  const { timeout: nativeTimeout, qwencloudTimeoutMs: configuredTimeout, transport: _transport, ...options } = settings
  const timeout = configuredTimeout ?? nativeTimeout ?? 120_000
  if (!Number.isSafeInteger(timeout) || Number(timeout) < 1000 || Number(timeout) > 600_000) throw new Error("QwenCloud timeout must be between 1000 and 600000.")
  if (settings.baseURL !== undefined && settings.baseURL !== API_BASE) throw new Error("Unsupported QwenCloud inference destination.")
  if (!isInferenceKey(settings.apiKey) || !settings.apiKey.startsWith("sk-sp-")) throw new Error("A separate Token Plan API key is required. Create one at https://home.qwencloud.com/api-keys (shown once). Management tokens and PAYG fallback are not supported.")
  if (typeof modelID !== "string" || !modelID || modelID.length > 256 || /[\s\x00-\x1f\x7f]/.test(modelID)) throw new Error("Invalid QwenCloud model.")
  const apiKey = settings.apiKey
  const native = compatibleModel(modelID, { ...options, apiKey, baseURL: API_BASE, provider: "qwencloud" })
  const transport = native.route.transport
  const route = native.route.with({ transport: { ...transport,
    execute: (...args) => Effect.gen(function* () {
      const fetcher = yield* FetchHttpClient.Fetch
      const lifetime = yield* Effect.acquireRelease(Effect.sync(() => {
        const controller = new AbortController()
        // Keep the deadline and request signals alive through response-body consumption, including GC.
        const timer = setTimeout(() => controller.abort(new DOMException("QwenCloud request timed out.", "TimeoutError")), Number(timeout))
        timer.unref()
        return { controller, timer, requests: new Set<Request>(), listeners: [] as (() => void)[] }
      }), state => Effect.sync(() => {
        clearTimeout(state.timer)
        state.controller.abort()
        for (const remove of state.listeners) remove()
        state.requests.clear()
      }))
      // Apply security after the host's HTTP hook conversion, immediately before fetch.
      const securedFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init)
        const abort = () => lifetime.controller.abort(request.signal.reason)
        if (request.signal.aborted) abort()
        else request.signal.addEventListener("abort", abort, { once: true })
        lifetime.listeners.push(() => request.signal.removeEventListener("abort", abort))
        const secured = await prepareRequest(request, apiKey, [modelID], { plan: "token-plan" }, Number(timeout), lifetime.controller.signal)
        lifetime.requests.add(secured)
        const response = await fetcher(secured)
        if (!response.body) return response
        const reader = response.body.getReader()
        const signal = lifetime.controller.signal
        let streamController: ReadableStreamDefaultController<Uint8Array>
        const cancel = () => {
          streamController.error(signal.reason)
          void reader.cancel(signal.reason).catch(() => {})
        }
        const remove = () => signal.removeEventListener("abort", cancel)
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller
            if (signal.aborted) cancel()
            else signal.addEventListener("abort", cancel, { once: true })
          },
          async pull(controller) {
            try {
              const next = await reader.read()
              if (signal.aborted) return
              if (next.done) { remove(); controller.close() }
              else controller.enqueue(next.value)
            } catch (error) { remove(); if (!signal.aborted) controller.error(error) }
          },
          async cancel(reason) { remove(); await reader.cancel(reason) },
        })
        lifetime.listeners.push(remove)
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      }
      return yield* transport.execute(...args).pipe(Effect.provideService(FetchHttpClient.Fetch, securedFetch))
    }),
  } })
  return LanguageModel.update(native, { route })
}
