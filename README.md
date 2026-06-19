# gliana-mcp-remote

Hosted **MCP server** for [GlianaAI](https://ai.glianalabs.com) — Streamable HTTP
on Cloudflare Workers. Exposes the free **discovery** tools so any MCP client (and
Smithery's hosted directory) can browse the catalog with zero setup.

| Tool | Description |
|------|-------------|
| `list_models` | All 70+ models: id, category, provider, per-call price. |
| `get_price` | Exact cost of one call (input affects it). |
| `get_schema` | A model's input fields. |
| `how_to_generate` | Install/config for the local server that does paid generation. |

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
