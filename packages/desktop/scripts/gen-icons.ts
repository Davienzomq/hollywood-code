#!/usr/bin/env bun
// Generate the Hollycode icon set (gold clapperboard) for every channel from the
// landing favicon. Rasterizes the brand SVG with sharp and hand-packs .ico
// (Windows) and .icns (macOS) so no extra tooling is required.
// Needs sharp resolvable: `bun add -d sharp` here first, or run the copy at
// scripts/gen-icons.mjs standalone (outside the workspace) where bun auto-installs
// it. Run: bun scripts/gen-icons.ts   (then scripts/copy-icons.ts copies the
// active channel into resources/icons; predev/prebuild already do that).
import sharp from "sharp"
import { mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const iconsRoot = join(here, "..", "icons")

// Hollycode brand mark — gold clapperboard on a dark rounded square (matches
// landing/favicon.svg).
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#0c0c0e"/>
  <rect x="2" y="2" width="28" height="28" rx="6" fill="#1c1c1f" stroke="#38383a" stroke-width="1"/>
  <rect x="6" y="11" width="20" height="14" rx="2" fill="#e0b341"/>
  <rect x="6" y="8" width="20" height="5" rx="1.5" fill="#f3d27e"/>
  <rect x="8" y="8" width="3" height="5" fill="#0c0c0e" rx="0.5"/>
  <rect x="13" y="8" width="3" height="5" fill="#0c0c0e" rx="0.5"/>
  <rect x="18" y="8" width="3" height="5" fill="#0c0c0e" rx="0.5"/>
  <circle cx="16" cy="18" r="4" fill="#0c0c0e" opacity="0.35"/>
  <circle cx="16" cy="18" r="2" fill="#0c0c0e" opacity="0.5"/>
</svg>`

const cache = new Map<number, Promise<Buffer>>()
function render(size: number): Promise<Buffer> {
  if (!cache.has(size)) {
    cache.set(
      size,
      sharp(Buffer.from(SVG), { density: Math.max(72, Math.round(size * 2.25)) })
        .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer(),
    )
  }
  return cache.get(size)!
}

function buildIco(images: { size: number; buf: Buffer }[]): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = 6 + 16 * images.length
  const datas: Buffer[] = []
  images.forEach((img, i) => {
    const e = i * 16
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, e + 0)
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1)
    dir.writeUInt8(0, e + 2)
    dir.writeUInt8(0, e + 3)
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(img.buf.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += img.buf.length
    datas.push(img.buf)
  })
  return Buffer.concat([header, dir, ...datas])
}

function buildIcns(entries: { type: string; buf: Buffer }[]): Buffer {
  const chunks = entries.map(({ type, buf }) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, "ascii")
    head.writeUInt32BE(buf.length + 8, 4)
    return Buffer.concat([head, buf])
  })
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write("icns", 0, "ascii")
  header.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([header, body])
}

const pngFiles: Record<string, number> = {
  "32x32.png": 32,
  "64x64.png": 64,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "icon.png": 512,
  "dock.png": 1024,
  "Square30x30Logo.png": 30,
  "Square44x44Logo.png": 44,
  "Square71x71Logo.png": 71,
  "Square89x89Logo.png": 89,
  "Square107x107Logo.png": 107,
  "Square142x142Logo.png": 142,
  "Square150x150Logo.png": 150,
  "Square284x284Logo.png": 284,
  "Square310x310Logo.png": 310,
  "StoreLogo.png": 50,
}
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icnsTypes: [string, number][] = [
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
]

const channels = ["dev", "beta", "prod"]
for (const channel of channels) {
  const dir = join(iconsRoot, channel)
  mkdirSync(dir, { recursive: true })
  for (const [name, size] of Object.entries(pngFiles)) {
    await Bun.write(join(dir, name), await render(size))
  }
  const ico = buildIco(await Promise.all(icoSizes.map(async (s) => ({ size: s, buf: await render(s) }))))
  await Bun.write(join(dir, "icon.ico"), ico)
  const icns = buildIcns(await Promise.all(icnsTypes.map(async ([type, s]) => ({ type, buf: await render(s) }))))
  await Bun.write(join(dir, "icon.icns"), icns)
  console.log(`✓ ${channel}: ${Object.keys(pngFiles).length} png + icon.ico (${ico.length}b) + icon.icns (${icns.length}b)`)
}
console.log("Hollycode icons generated.")
