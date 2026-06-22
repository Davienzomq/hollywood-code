#!/usr/bin/env bun
// Publish Hollycode to npm. Run AFTER script/build.ts has produced ./dist/* —
// it publishes each per-platform package (hollycode-<os>-<arch>...) and then the
// main `hollycode` package, whose bin shim (bin/hollycode) resolves the matching
// platform binary via optionalDependencies. Result: `npm i -g hollycode` and
// `bun install -g hollycode` install only the right platform binary.
//
// Internal package names stay "opencode"; only the PUBLISHED npm names are
// hollycode (set by build.ts BRAND + here). Needs NODE_AUTH_TOKEN / a configured
// ~/.npmrc with the npm token.
import { $ } from "bun"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const MAIN = "hollycode"

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(cwd: string, name: string, version: string, maxAttempts = 6) {
  // GitHub artifact downloads can drop the executable bit.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(cwd)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`bun pm pack`.cwd(cwd)
  // New npm accounts rate-limit publishing many large packages quickly (E429).
  // Retry with backoff, and re-check after each try since a 429 response can
  // still have landed the publish.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(cwd).nothrow()
    if (res.exitCode === 0) {
      console.log(`published ${name}@${version}`)
      return
    }
    if (await published(name, version)) {
      console.log(`published ${name}@${version} (confirmed after rate-limit)`)
      return
    }
    if (attempt === maxAttempts) break
    const wait = Math.min(60, attempt * 15)
    console.warn(`publish ${name} failed (attempt ${attempt}/${maxAttempts}) — retrying in ${wait}s`)
    await Bun.sleep(wait * 1000)
  }
  throw new Error(`failed to publish ${name}@${version} after ${maxAttempts} attempts (npm rate limit?)`)
}

// Per-platform packages produced by build.ts (dist/hollycode-<platform>/package.json).
const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const pkg = await Bun.file(`./dist/${filepath}`).json()
  binaries[pkg.name] = pkg.version
}
console.log("platform packages:", binaries)
const version = Object.values(binaries)[0]
if (!version) throw new Error("no built platform packages found in ./dist — run script/build.ts first")

// Assemble the main `hollycode` package: the JS shim + optionalDependencies on
// every platform package (npm installs only the one matching the user's os/cpu).
await $`rm -rf ./dist/${MAIN}`
await $`mkdir -p ./dist/${MAIN}/bin`
await $`cp ./bin/hollycode ./dist/${MAIN}/bin/hollycode`
await Bun.file(`./dist/${MAIN}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`./dist/${MAIN}/README.md`).write(
  [
    "# Hollycode 🎬",
    "",
    "The open-source AI coding agent that casts the right model for every task — a fork of opencode (MIT).",
    "",
    "```sh",
    "npm i -g hollycode    # or: bun install -g hollycode",
    "```",
    "",
    "Website: https://hollycode.vercel.app",
    "Source: https://github.com/Davienzomq/hollywood-code",
    "",
  ].join("\n"),
)
await Bun.file(`./dist/${MAIN}/package.json`).write(
  JSON.stringify(
    {
      name: MAIN,
      version,
      description: "The AI coding agent that casts the right model for every task — a fork of opencode.",
      homepage: "https://hollycode.vercel.app",
      repository: { type: "git", url: "git+https://github.com/Davienzomq/hollywood-code.git" },
      license: "MIT",
      bin: { [MAIN]: "./bin/hollycode" },
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

// Publish every platform package, spaced out to stay under a new account's
// publish rate limit. A failure on a NICHE platform (e.g. windows-arm64) must
// NOT block the main `hollycode` package — that's the one `npm i -g hollycode`
// needs. So collect platform failures and continue; re-run to fill them in.
const names = Object.keys(binaries)
const failed: string[] = []
for (let i = 0; i < names.length; i++) {
  try {
    await publish(`./dist/${names[i]}`, names[i], binaries[names[i]], 3)
  } catch (e) {
    console.warn(`⚠️ ${names[i]} failed: ${e instanceof Error ? e.message : e}`)
    failed.push(names[i])
  }
  await Bun.sleep(8000)
}

// Always publish the main package (throws → fails the run only if THIS fails).
await publish(`./dist/${MAIN}`, MAIN, version)

if (failed.length) {
  console.warn(
    `\n⚠️ published ${MAIN}@${version}, but ${failed.length} platform package(s) still pending: ` +
      `${failed.join(", ")} — re-run the release to publish them.`,
  )
} else {
  console.log(`\n✅ published ${MAIN}@${version} + all ${names.length} platform packages`)
}
