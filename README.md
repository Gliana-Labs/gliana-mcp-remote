# gliana-mcp-remote

Hosted **MCP server** for [GlianaAI](https://ai.glianalabs.com) — Streamable HTTP
on Cloudflare Workers. Exposes the free **discovery** tools, and runs the free
Indonesian data tools, so any MCP client can browse the catalog and get real
answers with zero setup.

**Connect to it:** `https://mcp.glianalabs.com/mcp` — nothing to install.

| Tool | Description |
|------|-------------|
| `list_models` | Every sellable model: id, category, provider, per-call price. |
| `get_price` | Exact cost of one call (input affects it). |
| `get_schema` | A model's input fields. |
| `list_tools` | Utility and Indonesian data tools, with prices. |
| `run_free_tool` | Runs the free data tools (wilayah, prayer times, NIK/NPWP checks, QRIS decode) — no wallet, no key. |
| `how_to_generate` | Install/config for the local server that does paid generation. |

Counts are deliberately absent from this table: the catalog is served live at
`/v1/models` and grows without a redeploy here, so any number written down goes
stale silently. `list_models` is the answer to "how many".

**Paid generation is intentionally not hosted here.** A hosted server would have to
receive your wallet private key — unsafe. Generation runs in the local
[`gliana-ai-mcp`](https://www.npmjs.com/package/gliana-ai-mcp) npx server, where the
key never leaves your machine. `how_to_generate` returns the install steps.

## Endpoint

```
POST /mcp     # Streamable HTTP (recommended)
GET  /sse     # legacy SSE
```

## Develop

```bash
npm install
npm run dev          # wrangler dev — POST http://localhost:8787/mcp
```

## Deploy

```bash
npx wrangler deploy
```

Prints the URL, e.g. `https://gliana-mcp-remote.<subdomain>.workers.dev`. The MCP
endpoint is that URL + `/mcp` — use it when listing on Smithery / registries.

Config var `GLIANA_API_URL` (in `wrangler.jsonc`) points at the gateway; defaults
to `https://api.glianalabs.com`.

MIT © Gliana Labs
