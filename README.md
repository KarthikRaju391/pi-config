# pi-config

Personal Pi coding-agent configuration.

## Contents

- `agent/settings.json` - portable Pi settings
- `agent/keybindings.json` - custom keybindings
- `agent/mcp.json` - MCP server config (no tokens)
- `agent/extensions/zellij-tools/` - custom Zellij tools for Pi
- `agent/extensions/pi-pool-cooldown.ts` - account-pool cooldown/status extension

Secrets and local state are intentionally excluded (`auth.json`, OAuth tokens, sessions, npm installs, account pool data).

## Install / sync to a machine

From the repo root:

```bash
mkdir -p ~/.pi/agent/extensions
cp agent/settings.json ~/.pi/agent/settings.json
cp agent/keybindings.json ~/.pi/agent/keybindings.json
cp agent/mcp.json ~/.pi/agent/mcp.json
rsync -a agent/extensions/ ~/.pi/agent/extensions/
```

Then restart Pi or run `/reload`.
