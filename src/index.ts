/**
 * GlianaAI hosted MCP server (Cloudflare Workers, Streamable HTTP).
 *
 * Exposes the FREE discovery tools — list_models, get_price, get_schema — so any
 * MCP client (and Smithery's hosted directory) can browse the catalog with no
 * setup. Paid generation is NOT here on purpose: a hosted server would have to
 * receive the user's wallet private key, which is unsafe. `generate` lives in the
 * local npx server (gliana-ai-mcp), where the key never leaves the machine —
 * the how_to_generate tool points users there.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';

interface Env {
  GLIANA_MCP: DurableObjectNamespace;
  GLIANA_API_URL: string;
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;

type CatalogModel = { id: string; provider: string; category: string; unit: string; priceLabel: string };
type Price = { model: string; costMicroUsd: number; unit: string; units: number };

export class GlianaMCP extends McpAgent<Env> {
  server = new McpServer({
    name: 'gliana-ai',
    version: '0.1.0',
  });

  private api() {
    return (this.env.GLIANA_API_URL || 'https://api.glianalabs.com').replace(/\/+$/, '');
  }

  private async getJson<T>(path: string): Promise<T> {
    const r = await fetch(`${this.api()}${path}`, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  async init() {
    const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

    this.server.registerTool(
      'list_models',
      {
        description:
          'List every GlianaAI model (id, category, provider, per-call price). Free. Pick a model before get_price / generation.',
        inputSchema: {},
      },
      async () => {
        const { models } = await this.getJson<{ models: CatalogModel[] }>('/v1/models');
        const byCat: Record<string, CatalogModel[]> = {};
        for (const m of models) (byCat[m.category] ??= []).push(m);
        const out = Object.entries(byCat)
          .map(([cat, ms]) => `## ${cat}\n` + ms.map((m) => `- ${m.id} (${m.provider}) — ${m.priceLabel}`).join('\n'))
          .join('\n\n');
        return text(`${models.length} models on GlianaAI:\n\n${out}`);
      },
    );

    this.server.registerTool(
      'get_price',
      {
        description:
          'Quote the exact cost of one call for a model (optionally with input that affects price, e.g. video duration). Free.',
        inputSchema: {
          model: z.string().describe('Model id from list_models.'),
          input: z.record(z.any()).optional().describe('Optional input affecting price, e.g. { duration: 8 }.'),
        },
      },
      async ({ model, input }) => {
        const qs = new URLSearchParams({ model });
        if (input) for (const [k, v] of Object.entries(input)) qs.set(k, String(v));
        const p = await this.getJson<Price>(`/v1/price?${qs.toString()}`);
        return text(`${p.model}: ${usd(p.costMicroUsd)} (${p.units} ${p.unit}${p.units === 1 ? '' : 's'}).`);
      },
    );

    this.server.registerTool(
      'get_schema',
      {
        description: 'Get a model’s input fields (names, types, required, defaults). Free.',
        inputSchema: { model: z.string().describe('Model id from list_models.') },
      },
      async ({ model }) => {
        const s = await this.getJson<{ model: string; category: string; required: string[]; props: Record<string, unknown> }>(
          `/v1/schema?model=${encodeURIComponent(model)}`,
        );
        return text(
          `${s.model} (${s.category})\nrequired: ${s.required.join(', ') || '—'}\n\nfields:\n${JSON.stringify(s.props, null, 2)}`,
        );
      },
    );

    this.server.registerTool(
      'how_to_generate',
      {
        description:
          'How to actually RUN a model (paid). Generation is done locally so your wallet key stays on your machine — this returns the install + config for the gliana-ai-mcp local server.',
        inputSchema: {},
      },
      async () =>
        text(
          'Paid generation runs in the LOCAL GlianaAI MCP server (your wallet key never leaves your machine).\n\n' +
            'Add to your MCP client config:\n\n' +
            '{\n  "mcpServers": {\n    "gliana-ai": {\n      "command": "npx",\n      "args": ["-y", "gliana-ai-mcp"],\n' +
            '      "env": { "GLIANA_WALLET_KEY": "0xYOUR_KEY" }\n    }\n  }\n}\n\n' +
            'Rails: base (default) / tempo via GLIANA_WALLET_KEY (USDC), solana via GLIANA_SOLANA_KEY. ' +
            'Fund a low-balance wallet; you pay only the per-call price. Docs: https://ai.glianalabs.com/docs',
        ),
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      return GlianaMCP.serve('/mcp', { binding: 'GLIANA_MCP' }).fetch(request, env, ctx);
    }
    if (url.pathname === '/sse' || url.pathname.startsWith('/sse/')) {
      return GlianaMCP.serveSSE('/sse', { binding: 'GLIANA_MCP' }).fetch(request, env, ctx);
    }
    return new Response(
      'GlianaAI MCP server. Connect an MCP client to /mcp (Streamable HTTP). Tools: list_models, get_price, get_schema, how_to_generate. Paid generation: npx gliana-ai-mcp. https://ai.glianalabs.com',
      { status: 200, headers: { 'content-type': 'text/plain' } },
    );
  },
};
