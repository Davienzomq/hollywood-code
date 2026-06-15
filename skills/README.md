# Hollycode skill & MCP catalog (Phase F)

A starter set of skills in the [agentskills.io](https://agentskills.io)
`SKILL.md` format that opencode/Hollycode load natively, plus recommended MCP
servers. Skills are markdown — the model reads the relevant one on demand.

## Skills in this catalog
| Skill | When it triggers |
|---|---|
| `git-commit` | committing, staging, writing commit messages / PRs |
| `code-review` | reviewing a diff / PR before merging |
| `research` | investigating a topic, library, or codebase |

More are easy to add — drop any `<name>/SKILL.md` here.

## Install
Hollycode discovers skills matching `{skill,skills}/**/SKILL.md`. Make them
available by copying into either:

- **Per project**: `<your-project>/.opencode/skills/`
- **Globally (all projects)**: `~/.config/opencode/skills/`

```
# global install of this catalog
cp -r skills/* ~/.config/opencode/skills/
```

Then `/skills` (in the TUI or any gateway channel) lists them.

## Bulk-importing more skills
Any agentskills-format skill works. hermes-agent (MIT) ships ~170 skills as
`SKILL.md` files — the pure-markdown ones drop straight into the dirs above
(credit Nous Research; see ATTRIBUTION.md). Script-backed skills need their
helper scripts reviewed first.

## Recommended MCP servers
Hollycode supports MCP (Model Context Protocol) out of the box. High-value
servers to enable via `opencode.json` `mcp` / the `/mcps` UI:

| MCP | Use |
|---|---|
| **linear** | issue tracking — create/update Linear issues from chat |
| **n8n** | trigger automation workflows |
| **playwright / browser** | drive a real browser for web tasks |

Example `opencode.json` snippet:
```json
{
  "mcp": {
    "linear": { "type": "remote", "url": "https://mcp.linear.app/sse" }
  }
}
```
