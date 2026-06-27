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
  server = new McpServer(
    {
      name: 'gliana-ai',
      version: '0.1.0',
      title: 'GlianaAI',
      websiteUrl: 'https://ai.glianalabs.com',
      icons: [
        { src: 'https://ai.glianalabs.com/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
        { src: 'https://ai.glianalabs.com/logo.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
      ],
    },
    {
      instructions:
        'GlianaAI — pay-per-call generative AI across 60+ models (image, video, music, speech). ' +
        'No signup or API key; each call is paid from your own wallet over MPP/x402. Use list_models to ' +
        'browse the catalog, get_price to quote a call, get_schema for a model’s inputs. Paid generation runs ' +
        'in the local npx server (see how_to_generate) so your wallet key never leaves your machine.',
    },
  );

  private api() {
    return (this.env.GLIANA_API_URL || 'https://api.glianalabs.com').replace(/\/+$/, '');
  }

  private async getJson<T>(path: string): Promise<T> {
    const r = await fetch(`${this.api()}${path}`, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  async init() {
    const out = (s: string, structured: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: s }],
      structuredContent: structured,
    });

    const modelShape = {
      id: z.string(),
      provider: z.string(),
      category: z.string(),
      unit: z.string(),
      priceLabel: z.string(),
    };

    this.server.registerTool(
      'list_models',
      {
        description:
          'List every GlianaAI model (id, category, provider, per-call price). Free. Pick a model before get_price / generation.',
        inputSchema: {},
        outputSchema: {
          count: z.number().describe('Number of models.'),
          models: z.array(z.object(modelShape)).describe('Every available model.'),
        },
        annotations: { title: 'List models', readOnlyHint: true, openWorldHint: true },
      },
      async () => {
        const { models } = await this.getJson<{ models: CatalogModel[] }>('/v1/models');
        const byCat: Record<string, CatalogModel[]> = {};
        for (const m of models) (byCat[m.category] ??= []).push(m);
        const pretty = Object.entries(byCat)
          .map(([cat, ms]) => `## ${cat}\n` + ms.map((m) => `- ${m.id} (${m.provider}) — ${m.priceLabel}`).join('\n'))
          .join('\n\n');
        return out(`${models.length} models on GlianaAI:\n\n${pretty}`, { count: models.length, models });
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
        outputSchema: {
          model: z.string(),
          costMicroUsd: z.number().describe('Cost in micro-USD (1e-6 USD).'),
          costUsd: z.string().describe('Cost formatted in USD.'),
          unit: z.string().describe('Billing unit (e.g. second, character, image).'),
          units: z.number().describe('Number of billed units.'),
        },
        annotations: { title: 'Get price', readOnlyHint: true, openWorldHint: true },
      },
      async ({ model, input }) => {
        const qs = new URLSearchParams({ model });
        if (input) for (const [k, v] of Object.entries(input)) qs.set(k, String(v));
        const p = await this.getJson<Price>(`/v1/price?${qs.toString()}`);
        return out(`${p.model}: ${usd(p.costMicroUsd)} (${p.units} ${p.unit}${p.units === 1 ? '' : 's'}).`, {
          model: p.model,
          costMicroUsd: p.costMicroUsd,
          costUsd: usd(p.costMicroUsd),
          unit: p.unit,
          units: p.units,
        });
      },
    );

    this.server.registerTool(
      'get_schema',
      {
        description: 'Get a model’s input fields (names, types, required, defaults). Free.',
        inputSchema: { model: z.string().describe('Model id from list_models.') },
        outputSchema: {
          model: z.string(),
          category: z.string(),
          required: z.array(z.string()).describe('Required field names.'),
          props: z.record(z.any()).describe('Field definitions keyed by name.'),
        },
        annotations: { title: 'Get input schema', readOnlyHint: true, openWorldHint: true },
      },
      async ({ model }) => {
        const s = await this.getJson<{ model: string; category: string; required: string[]; props: Record<string, unknown> }>(
          `/v1/schema?model=${encodeURIComponent(model)}`,
        );
        return out(
          `${s.model} (${s.category})\nrequired: ${s.required.join(', ') || '—'}\n\nfields:\n${JSON.stringify(s.props, null, 2)}`,
          { model: s.model, category: s.category, required: s.required, props: s.props },
        );
      },
    );

    this.server.registerTool(
      'how_to_generate',
      {
        description:
          'How to actually RUN a model (paid). Generation is done locally so your wallet key stays on your machine — this returns the install + config for the gliana-ai-mcp local server.',
        inputSchema: {},
        outputSchema: {
          package: z.string(),
          command: z.string(),
          rails: z.array(z.string()),
          config: z.record(z.any()).describe('MCP client config snippet.'),
          docs: z.string(),
        },
        annotations: { title: 'How to generate (paid)', readOnlyHint: true, openWorldHint: false },
      },
      async () => {
        const config = {
          mcpServers: {
            'gliana-ai': { command: 'npx', args: ['-y', 'gliana-ai-mcp'], env: { GLIANA_WALLET_KEY: '0xYOUR_KEY' } },
          },
        };
        const txt =
          'Paid generation runs in the LOCAL GlianaAI MCP server (your wallet key never leaves your machine).\n\n' +
          'Add to your MCP client config:\n\n' +
          JSON.stringify(config, null, 2) +
          '\n\nRails: base (default) / tempo via GLIANA_WALLET_KEY (USDC), solana via GLIANA_SOLANA_KEY. ' +
          'Fund a low-balance wallet; you pay only the per-call price.\n\n' +
          'File inputs (image/video/audio — e.g. image-to-video, or video-to-video `video_uri`) take a public ' +
          'URL. Upload a local file with POST https://api.glianalabs.com/v1/media (raw body + Content-Type, ≤40MB) ' +
          'to get one. Array file fields (e.g. `images`, `reference_images` for multi-reference models) take an ' +
          'ARRAY of such URLs. Docs: https://ai.glianalabs.com/docs';
        return out(txt, {
          package: 'gliana-ai-mcp',
          command: 'npx -y gliana-ai-mcp',
          rails: ['base', 'tempo', 'solana'],
          config,
          docs: 'https://ai.glianalabs.com/docs',
        });
      },
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
