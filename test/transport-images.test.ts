import { test } from "node:test"
import assert from "node:assert/strict"
import { crc32 } from "node:zlib"
import { API_BASE, prepareRequest } from "../src/transport.js"

// The exact 1x1 PNG a Penpot export_shape returned into a live session context.
const LIVE_1X1_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAA1JREFUCJlj+Pbjz38ACbwD6tEDwfEAAAAASUVORK5CYII="

const chunk = (type: string, payload: Buffer): Buffer => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length)
  const typed = Buffer.concat([Buffer.from(type, "ascii"), payload])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typed) >>> 0)
  return Buffer.concat([length, typed, checksum])
}

const png = (width: number, height: number): string => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))])
  return `data:image/png;base64,${bytes.toString("base64")}`
}

const gif = (width: number, height: number): string => {
  const bytes = Buffer.alloc(14)
  bytes.write("GIF89a", 0, "ascii")
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  bytes[13] = 0x3b
  return `data:image/gif;base64,${bytes.toString("base64")}`
}

const bmp = (width: number, height: number): string => {
  const bytes = Buffer.alloc(30)
  bytes.write("BM", 0, "ascii")
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(width, 18)
  bytes.writeInt32LE(height, 22)
  return `data:image/bmp;base64,${bytes.toString("base64")}`
}

const webp = (width: number, height: number): string => {
  const vp8l = Buffer.alloc(5)
  vp8l[0] = 0x2f
  vp8l.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1)
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), Buffer.from("VP8L", "ascii"), (() => { const l = Buffer.alloc(4); l.writeUInt32LE(vp8l.length); return l })(), vp8l])
  const riff = Buffer.concat([Buffer.from("RIFF", "ascii"), (() => { const l = Buffer.alloc(4); l.writeUInt32LE(body.length); return l })(), body])
  return `data:image/webp;base64,${riff.toString("base64")}`
}

const webpExtended = (width: number, height: number): string => {
  const vp8x = Buffer.alloc(10)
  vp8x.writeUIntLE(width - 1, 4, 3)
  vp8x.writeUIntLE(height - 1, 7, 3)
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), Buffer.from("VP8X", "ascii"), (() => { const l = Buffer.alloc(4); l.writeUInt32LE(vp8x.length); return l })(), vp8x])
  const riff = Buffer.concat([Buffer.from("RIFF", "ascii"), (() => { const l = Buffer.alloc(4); l.writeUInt32LE(body.length); return l })(), body])
  return `data:image/webp;base64,${riff.toString("base64")}`
}

const jpeg = (width: number, height: number): string => {
  const sof = Buffer.alloc(17)
  sof.writeUInt16BE(17, 0)
  sof[2] = 8
  sof.writeUInt16BE(height, 3)
  sof.writeUInt16BE(width, 5)
  sof[7] = 3
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0]), sof, Buffer.from([0xff, 0xd9])])
  return `data:image/jpeg;base64,${bytes.toString("base64")}`
}

const imagePart = (url: string) => ({ type: "image_url", image_url: { url } })

const secure = async (messages: unknown[]) => {
  const body = { model: "fixture", messages, stream: true }
  const request = new Request(`${API_BASE}/chat/completions`, { method: "POST", body: JSON.stringify(body) })
  const secured = await prepareRequest(request, "sk-sp-fixture", ["fixture"], { plan: "token-plan" })
  return await secured.json() as { model: string; messages: { role: string; content: unknown[] }[] }
}

test("degenerate inline images become an explicit omission note instead of failing the request", async () => {
  const lowered = await secure([
    { role: "user", content: [{ type: "text", text: "look" }, imagePart(LIVE_1X1_PNG), imagePart(png(10, 10)), imagePart(png(1, 500))] },
  ])
  const content = lowered.messages[0]!.content
  assert.equal(lowered.model, "fixture")
  assert.deepEqual(content[0], { type: "text", text: "look" })
  for (const [index, size] of [[1, "1x1"], [2, "10x10"], [3, "1x500"]] as const) {
    const part = content[index] as { type: string; text: string }
    assert.equal(part.type, "text")
    assert.match(part.text, /omitted/iu)
    assert.ok(part.text.includes(size), `note names the rejected size ${size}`)
  }
})

test("images at or above the provider minimum pass through byte-identical", async () => {
  const urls = [png(11, 11), png(4096, 4096), jpeg(16, 16), gif(32, 32), webp(64, 64), webpExtended(128, 128), bmp(20, 20)]
  const messages = [{ role: "user", content: [{ type: "text", text: "keep" }, ...urls.map(imagePart)] }]
  const lowered = await secure(messages)
  assert.deepEqual(lowered.messages, messages)
})

test("small GIF, WebP, BMP and JPEG rasters are screened like PNG", async () => {
  const lowered = await secure([{ role: "user", content: [gif(1, 1), webp(2, 2), webpExtended(10, 10), bmp(10, 3), jpeg(1, 1)].map(imagePart) }])
  for (const part of lowered.messages[0]!.content as { type: string; text: string }[]) {
    assert.equal(part.type, "text")
    assert.match(part.text, /omitted/iu)
  }
})

test("remote URLs, non-base64 and unparseable payloads are left untouched", async () => {
  const urls = [
    "https://files.example/chart.png",
    "data:image/png,not-base64",
    "data:image/png;base64,!!!!not-decodable!!!!",
    "data:application/octet-stream;base64,AAAA",
  ]
  const messages = [{ role: "user", content: urls.map(imagePart) }]
  const lowered = await secure(messages)
  assert.deepEqual(lowered.messages, messages)
})

test("screening covers tool and assistant messages, not only user turns", async () => {
  const lowered = await secure([
    { role: "tool", tool_call_id: "call_1", content: [imagePart(LIVE_1X1_PNG)] },
    { role: "assistant", content: [imagePart(png(1, 1))] },
  ])
  for (const message of lowered.messages) {
    const part = message.content[0] as { type: string; text: string }
    assert.equal(part.type, "text")
    assert.match(part.text, /omitted/iu)
  }
})

test("string content and absent messages stay valid", async () => {
  const lowered = await secure([{ role: "user", content: "plain text" }])
  assert.deepEqual(lowered.messages, [{ role: "user", content: "plain text" }])
  const request = new Request(`${API_BASE}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "fixture" }) })
  const secured = await prepareRequest(request, "sk-sp-fixture", ["fixture"], { plan: "token-plan" })
  assert.deepEqual(await secured.json(), { model: "fixture" })
})