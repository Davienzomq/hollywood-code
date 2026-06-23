import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "ai.hollycode.desktop" : `ai.hollycode.desktop.${channel}`
const productName = channel === "prod" ? "Hollycode" : `Hollycode ${channel.charAt(0).toUpperCase() + channel.slice(1)}`
const summary = `Open source AI coding agent${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="app.hollycode">
    <name>Hollycode</name>
  </developer>

  <description>
    <p>
      Hollycode is an open source AI coding agent that casts the right model for every task.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://github.com/Davienzomq/hollywood-code/issues</url>
  <url type="homepage">https://hollycode.vercel.app</url>
  <url type="vcs-browser">https://github.com/Davienzomq/hollywood-code</url>

  <screenshots>
    <screenshot type="default">
      <image>https://hollycode.vercel.app/social-share.png</image>
    </screenshot>
  </screenshots>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
