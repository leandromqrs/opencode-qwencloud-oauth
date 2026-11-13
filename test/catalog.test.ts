import { test } from "node:test"
import assert from "node:assert/strict"
import { discoverCatalog, parseListing, sanitizeSavedModels } from "../src/catalog.js"
import { nativeModel, reconcileCatalog, METADATA_SOURCE } from "../src/inventory.js"

const wire = (items: unknown[]) => ({ code: "200", data: { Data: [{ Items: items }] } })
test("native Qwen names are readable without changing catalog or routing IDs", () => {
  for (const [id, name] of [
    ["qwen3.8-27b", "Qwen3.8 27B"],
    ["qwen3.8-max", "Qwen3.8 Max"],
    ["qwen3.8-flash", "Qwen3.8 Flash"],
    ["qwen3.8-max-0902", "Qwen3.8 Max 0902"],
    ["qwen3.8-2.4t-a95b", "Qwen3.8 2.4T A95B"],
    ["qwen3.8-omni-flash", "Qwen3.8 Omni Flash"],
    ["qwen3.8-omni-flash-realtime", "Qwen3.8 Omni Flash Realtime"],
    ["qwen3.8-livetranslate-flash-realtime", "Qwen3.8 LiveTranslate Flash Realtime"],
    ["qwen3.7-max-2026-06-08", "Qwen3.7 Max 2026-06-08"],
  ]) {
    const account = reconcileCatalog({ fetchedAt: 1, models: [{ id }] })[0]
    const native = nativeModel(account)
    assert.equal(native.name, name)
    assert.equal(native.id, id)
    assert.equal(native.modelID, id)
    assert.equal(account.id, id)
  }
})

test("observed DeepSeek Flash name is readable without changing catalog or routing IDs", () => {
  const id = "deepseek-v4.1-flash-1017"
  const account = reconcileCatalog({ fetchedAt: 1, models: [{ id }] })[0]
  const native = nativeModel(account)
  assert.equal(native.name, "DeepSeek V4.1 Flash 1017")
  assert.equal(native.id, id)
  assert.equal(native.modelID, id)
  assert.equal(account.id, id)
})

test("published catalog families have readable names without changing any routing IDs", async context => {
  const families = {
    qwen: [
      ["qwen3.7-max-preview", "Qwen3.7 Max Preview"],
      ["qwen3.7-plus-2026-05-26", "Qwen3.7 Plus 2026-05-26"],
      ["qwen3.5-omni-plus-realtime-2026-03-15", "Qwen3.5 Omni Plus Realtime 2026-03-15"],
      ["qwen-max", "Qwen Max"], ["qwen-plus-latest", "Qwen Plus Latest"],
      ["qwen-plus-2025-12-01", "Qwen Plus 2025-12-01"],
      ["qwen-plus-character-ja", "Qwen Plus Character JA"],
      ["qwen-flash-character", "Qwen Flash Character"],
      ["qwen-flash-2025-07-28", "Qwen Flash 2025-07-28"],
      ["qwen3-vl-plus", "Qwen3 VL Plus"],
      ["qwen-vl-ocr-2025-11-20", "Qwen VL OCR 2025-11-20"],
      ["qwen3-coder-flash-2025-07-28", "Qwen3 Coder Flash 2025-07-28"],
      ["qwen3.7-text-embedding", "Qwen3.7 Text Embedding"],
      ["qwen3-rerank", "Qwen3 Rerank"],
      ["qwen-mt-lite", "Qwen MT Lite"], ["qwen-mt-plus", "Qwen MT Plus"],
      ["qwen-mt-flash", "Qwen MT Flash"], ["qwen-mt-image-2.0", "Qwen MT Image 2.0"],
      ["qwen-image-3.0", "Qwen Image 3.0"], ["qwen-image-3.0-pro", "Qwen Image 3.0 Pro"],
      ["qwen-image-2.1-turbo", "Qwen Image 2.1 Turbo"],
      ["qwen-image-2.0-pro-2026-06-22", "Qwen Image 2.0 Pro 2026-06-22"],
      ["qwen-audio-3.0-asr-flash-filetrans", "Qwen Audio 3.0 ASR Flash FileTrans"],
      ["qwen-audio-3.0-asr-flash-streaming", "Qwen Audio 3.0 ASR Flash Streaming"],
      ["qwen-audio-3.1-asr-flash-message", "Qwen Audio 3.1 ASR Flash Message"],
      ["qwen-audio-3.1-tts-next", "Qwen Audio 3.1 TTS Next"],
      ["qwen-audio-3.1-tts-plus", "Qwen Audio 3.1 TTS Plus"],
      ["qwen-audio-3.0-realtime-flash", "Qwen Audio 3.0 Realtime Flash"],
      ["qwen-audio-3.1-realtime-plus", "Qwen Audio 3.1 Realtime Plus"],
      ["qwen3-asr-flash-realtime", "Qwen3 ASR Flash Realtime"],
      ["qwen3-asr-flash-filetrans", "Qwen3 ASR Flash FileTrans"],
      ["qwen3-tts-flash-realtime", "Qwen3 TTS Flash Realtime"],
      ["qwen-voice-enrollment", "Qwen Voice Enrollment"],
    ],
    deepseek: [
      ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
      ["deepseek-v4-pro-0813", "DeepSeek V4 Pro 0813"],
      ["deepseek-v4-pro", "DeepSeek V4 Pro"],
    ],
    glm: [
      ["glm-5.2-fast-preview", "GLM-5.2 Fast Preview"],
      ["glm-5.3-prime", "GLM-5.3 Prime"],
      ["glm-5.3", "GLM-5.3"], ["glm-5.2", "GLM-5.2"], ["glm-5.1", "GLM-5.1"],
      ["ZHIPU/GLM-5.3", "Zhipu / GLM-5.3"], ["ZHIPU/GLM-5.2", "Zhipu / GLM-5.2"],
    ],
    kimi: [
      ["kimi-k3.1-pro", "Kimi K3.1 Pro"], ["kimi-k3", "Kimi K3"],
      ["kimi-k2.7-code", "Kimi K2.7 Code"], ["kimi/kimi-k3", "Kimi / Kimi K3"],
    ],
    wan: [
      ["wan3.0-video-prime", "Wan3.0 Video Prime"], ["wan3.0-video", "Wan3.0 Video"],
      ["wan2.7-t2v", "Wan2.7 T2V"], ["wan2.5-t2v-preview", "Wan2.5 T2V Preview"],
      ["wan2.1-t2v-plus", "Wan2.1 T2V Plus"], ["wan2.1-t2v-turbo", "Wan2.1 T2V Turbo"],
      ["wan2.7-t2v-2026-06-12", "Wan2.7 T2V 2026-06-12"],
      ["wan2.7-t2v-2026-04-25", "Wan2.7 T2V 2026-04-25"],
      ["wan2.7-i2v", "Wan2.7 I2V"], ["wan2.6-i2v-flash", "Wan2.6 I2V Flash"],
      ["wan2.7-i2v-2026-04-25", "Wan2.7 I2V 2026-04-25"],
      ["wan2.2-animate-move", "Wan2.2 Animate Move"], ["wan2.2-animate-mix", "Wan2.2 Animate Mix"],
      ["wan2.2-kf2v-flash", "Wan2.2 KF2V Flash"], ["wan2.1-kf2v-plus", "Wan2.1 KF2V Plus"],
      ["wan2.7-r2v-2026-06-12", "Wan2.7 R2V 2026-06-12"],
      ["wan2.6-r2v-flash", "Wan2.6 R2V Flash"], ["wan2.7-videoedit", "Wan2.7 VideoEdit"],
      ["wan2.7-image-pro", "Wan2.7 Image Pro"], ["wan2.6-image", "Wan2.6 Image"],
      ["wan2.5-i2i-preview", "Wan2.5 I2I Preview"], ["wan2.6-t2i", "Wan2.6 T2I"],
      ["wan2.2-t2i-flash", "Wan2.2 T2I Flash"], ["wan2.1-vace-plus", "Wan2.1 VACE Plus"],
    ],
    speech: [
      ["fun-asr-realtime", "FunASR Realtime"], ["fun-asr", "FunASR"],
      ["fun-asr-flash-2026-06-15", "FunASR Flash 2026-06-15"],
      ["cosyvoice-v3-plus", "CosyVoice V3 Plus"], ["cosyvoice-v3-flash", "CosyVoice V3 Flash"],
      ["voice-enrollment", "Voice Enrollment"],
    ],
    imageAndEmbedding: [
      ["z-image-turbo", "Z-Image Turbo"],
      ["tongyi-embedding-vision-plus", "Tongyi Embedding Vision Plus"],
      ["tongyi-embedding-vision-flash", "Tongyi Embedding Vision Flash"],
      ["text-embedding-v4", "Text Embedding V4"], ["text-embedding-v3", "Text Embedding V3"],
    ],
    videoAndDecision: [
      ["happyhorse-1.1-t2v", "HappyHorse 1.1 T2V"], ["happyhorse-1.1-i2v", "HappyHorse 1.1 I2V"],
      ["happyhorse-1.1-r2v", "HappyHorse 1.1 R2V"], ["happyhorse-1.0-video-edit", "HappyHorse 1.0 Video Edit"],
      ["happyoyster-1.0-adventure", "HappyOyster 1.0 Adventure"],
      ["happyoyster-1.0-directing", "HappyOyster 1.0 Directing"],
      ["pixverse/pixverse-v6-t2v", "PixVerse / PixVerse V6 T2V"],
      ["pixverse/pixverse-v6-it2v", "PixVerse / PixVerse V6 IT2V"],
      ["pixverse/pixverse-v6-kf2v", "PixVerse / PixVerse V6 KF2V"],
      ["pixverse/pixverse-v6-r2v", "PixVerse / PixVerse V6 R2V"],
      ["vidu/vidu-image_reference2image", "Vidu / Vidu Image Reference to Image"],
      ["vidu/viduq2-pro-fast_img2video", "Vidu / Vidu Q2 Pro Fast Image to Video"],
      ["vidu/viduq3-mix_reference2video", "Vidu / Vidu Q3 Mix Reference to Video"],
      ["vidu/viduq3-drama_reference2video", "Vidu / Vidu Q3 Drama Reference to Video"],
      ["vidu/viduq3-ad_reference2video", "Vidu / Vidu Q3 Ad Reference to Video"],
      ["decision-model-preview", "Decision Model Preview"],
    ],
  }
  for (const [family, cases] of Object.entries(families)) await context.test(family, () => {
    for (const [id, name] of cases) {
      const account = reconcileCatalog({ fetchedAt: 1, models: [{ id }] })[0]
      const native = nativeModel(account)
      assert.equal(native.name, name, id)
      assert.equal(native.id, id)
      assert.equal(native.modelID, id)
      assert.equal(account.id, id)
    }
  })
})

test("unrecognized model naming conventions retain their exact display and routing IDs", () => {
  for (const id of [
    "DeepSeek-V3.2", "DeepSeek V4.1 Flash 1017", "deepseek-v4.1-experimental-1017", "deepseek-v4.1-flash-custom",
    "GLM-4.7-FP8", "vendor/qwen3.8-max", "qwen3.8-newAPI", "qwen3.8-custom", "qwen3.8-max-2026-06",
    "Qwen3.8 Max", "Qwen Audio 3.0 ASR Flash", "qwen3.8-constructor", "qwen3.8-max-",
    "wan2.7-newmode", "wan2.7-", "glm-5.3-custom", "kimi-k3-custom", "ZHIPU/GLM-5.3-custom", "other/GLM-5.3",
    "pixverse/unknown-v6-t2v", "vidu/viduq3-unknown_reference2video", "happyhorse-1.1-unknown",
    "happyoyster-1.0-custom", "fun-asr-custom", "cosyvoice-v3-custom", "z-image-custom",
    "tongyi-embedding-custom", "text-embedding-v4-custom", "decision-model-custom", "voice-enrollment-custom",
    "unknown-model-preview",
  ]) {
    const native = nativeModel(reconcileCatalog({ fetchedAt: 1, models: [{ id }] })[0])
    assert.equal(native.name, id)
    assert.equal(native.id, id)
    assert.equal(native.modelID, id)
  }
})

test("catalog sanitizes actual management metadata and never embeds subscription assumptions", () => {
  assert.deepEqual(parseListing(wire([{ Model: "new-model" }, { Model: "new-model" }])), [{ id: "new-model" }])
  assert.throws(() => parseListing(wire([{ Model: "bad\nmodel" }])))
  assert.deepEqual(parseListing(wire([])), [])
  assert.throws(() => parseListing({ data: [] }))
  const model = reconcileCatalog({ fetchedAt: 1, models: [{ id: "qwen3.8-max" }] })[0]
  assert.equal(model.context, null)
  assert.deepEqual(model.efforts, [])
  assert.deepEqual(nativeModel(model).limit, { context: 0, output: 0 })
  assert.deepEqual(nativeModel(model).cost, [])
  assert.deepEqual(nativeModel(model).variants, [])
  assert.match(METADATA_SOURCE, /QwenCloud\/qwencloud-cli/)
})

test("rich catalog limits and modalities are sanitized without claiming tools or entitlement", () => {
  const listing = parseListing(wire([{ Model: "vision-model", ModelInfo: { ContextWindow: 65536, MaxInputTokens: 60000, MaxOutputTokens: 4096 }, InferenceMetadata: { RequestModality: ["Text", "Image", "PRIVATE"], ResponseModality: ["Text"] }, email: "PRIVATE" }]))
  const native = nativeModel(reconcileCatalog({ fetchedAt: 1, models: listing })[0])
  assert.equal(native.limit.context, 65536)
  assert.equal(native.limit.output, 4096)
  assert.deepEqual(native.capabilities.input, ["text", "image"])
  assert.equal(native.capabilities.tools, false)
  assert.doesNotMatch(JSON.stringify(listing), /PRIVATE/)
  assert.deepEqual(sanitizeSavedModels([{ id: "model", context: -1, output: Infinity, secret: "PRIVATE" }]), [{ id: "model" }])
})

test("discovery rejects redirects, oversized bodies and preserves HTTP and business denials", async () => {
  for (const status of [401, 403]) {
    await assert.rejects(discoverCatalog("fixture", async () => Response.json({ message: "PRIVATE" }, { status })), error => error instanceof Error && "status" in error && error.status === status && !error.message.includes("PRIVATE"))
    await assert.rejects(discoverCatalog("fixture", async () => Response.json({ code: String(status), message: "PRIVATE" })), error => error instanceof Error && "status" in error && error.status === status)
  }
  await assert.rejects(discoverCatalog("fixture", async () => new Response("x".repeat(1024 * 1024 + 1))), /invalid_response/)
  await assert.rejects(discoverCatalog("fixture", async () => { throw new TypeError("redirect secret") }), /network_error/)
})
