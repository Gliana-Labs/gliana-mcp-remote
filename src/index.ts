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
import { createMcpHandler } from 'agents/mcp';
import { z } from 'zod';

interface Env {
  GLIANA_API_URL: string;
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;

type CatalogModel = { id: string; provider: string; category: string; unit: string; priceLabel: string };
type Price = { model: string; costMicroUsd: number; unit: string; units: number };

/**
 * A utility tool as the gateway describes itself at GET /v1/tools. Read live, so a
 * new endpoint shows up here the moment it deploys — this file used to carry a
 * hardcoded prose list and it had drifted by six endpoints.
 */
type UtilityTool = {
  name: string;
  method?: 'GET' | 'POST';
  priceMicroUsd: number;
  example?: Record<string, unknown>;
  guidance?: string;
};

/**
 * One server per request, stateless. It used to be an McpAgent, which made a
 * Durable Object for every MCP session and never deleted it: 6.67k objects and
 * 680 MB of session rows by 2026-10-25, for a server that keeps no state —
 * every tool is a live GET against the gateway. (wrangler.jsonc migration v2
 * deletes the old class and its storage.)
 */
class GlianaTools {
  constructor(private readonly env: Env) {}

  server = new McpServer(
    {
      name: 'gliana-ai',
      version: '0.2.0',
      title: 'GlianaAI',
      websiteUrl: 'https://ai.glianalabs.com',
      icons: [
        { src: 'https://ai.glianalabs.com/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
        { src: 'https://ai.glianalabs.com/logo.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
      ],
    },
    {
      instructions:
        'GlianaAI — pay-per-call generative AI across 100+ models (LLM chat/text, image, video, music, speech) plus ' +
        'utility and data tools. No signup or API key; paid calls settle from your own wallet over MPP/x402. ' +
        'list_models to browse the catalog, get_price to quote, get_schema for a model’s inputs, list_tools for the ' +
        'utility tools. Some of those are FREE and run right here via run_free_tool (Indonesian wilayah, prayer times, ' +
        'NIK verification). Paid generation runs in the local npx server (see how_to_generate) so your wallet key never ' +
        'leaves your machine.',
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

  private async utilityTools(): Promise<UtilityTool[]> {
    const { tools } = await this.getJson<{ tools: UtilityTool[] }>('/v1/tools');
    return tools;
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
          input: z.record(z.string(), z.any()).optional().describe('Optional input affecting price, e.g. { duration: 8 }.'),
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
          props: z.record(z.string(), z.any()).describe('Field definitions keyed by name.'),
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
      'list_tools',
      {
        description:
          'List every GlianaAI utility tool (name, HTTP method, per-call price, example input, usage guidance), read live ' +
          'from the gateway so it is never out of date. Free. Tools reported at priceMicroUsd 0 are free to call and can be ' +
          'run right here with run_free_tool; the paid ones need a wallet and run in the local server (see how_to_generate).',
        inputSchema: {},
        outputSchema: {
          tools: z.array(
            z.object({
              name: z.string(),
              method: z.string(),
              priceMicroUsd: z.number().describe('0 means free — runnable here via run_free_tool.'),
              priceUsd: z.string(),
              free: z.boolean(),
              example: z.record(z.string(), z.any()),
              guidance: z.string(),
            }),
          ),
        },
        annotations: { title: 'List utility tools', readOnlyHint: true, openWorldHint: false },
      },
      async () => {
        const all = await this.utilityTools();
        const tools = all.map((t) => ({
          name: t.name,
          method: t.method ?? 'POST',
          priceMicroUsd: t.priceMicroUsd,
          priceUsd: usd(t.priceMicroUsd),
          free: t.priceMicroUsd === 0,
          example: t.example ?? {},
          guidance: t.guidance ?? '',
        }));
        const lines = tools.map(
          (t) => `- ${t.name} (${t.method}, ${t.free ? 'FREE — run here' : t.priceUsd + ' — local server'}) ${t.guidance}`.trim(),
        );
        return out(`${tools.length} utility tools:\n${lines.join('\n')}`, { tools });
      },
    );

    /**
     * The free reference endpoints, callable from this hosted server.
     *
     * Safe to host precisely because they take no payment: there is no wallet key
     * here and never should be (that's why `generate` lives in the local server).
     * The allowed set is read from the gateway and checked on every call — a tool
     * must report priceMicroUsd 0 AND method GET — so this can never become a way
     * to trigger a paid call, or an open proxy for arbitrary POSTs.
     */
    this.server.registerTool(
      'run_free_tool',
      {
        description:
          'Run one of the FREE GlianaAI data tools right here — no wallet, no signup, no payment. Currently the Indonesian ' +
          'reference endpoints: `wilayah` (38 provinsi + 514 kabupaten/kota with official Kepmendagri codes, coordinates, ' +
          'timezone, area, population), `prayer-times` (jadwal sholat for any Indonesian city or coordinate, up to 31 days ' +
          'in one call), `verify-nik` (structurally verify an Indonesian NIK against official region data). Call list_tools ' +
          'for the live set and each one\'s input shape. Paid tools are refused here — use the local server for those.',
        inputSchema: {
          name: z.string().describe('A tool name that list_tools reports as free, e.g. wilayah, prayer-times, verify-nik.'),
          args: z.record(z.string(), z.any()).optional().describe('Query parameters, as shown in the tool\'s `example`.'),
        },
        outputSchema: { tool: z.string(), result: z.any() },
        annotations: { title: 'Run a free data tool', readOnlyHint: true, openWorldHint: true },
      },
      async ({ name, args }) => {
        const all = await this.utilityTools();
        const found = all.find((t) => t.name === name);
        if (!found) {
          return {
            content: [{ type: 'text' as const, text: `Unknown tool "${name}". Call list_tools for the current set.` }],
            isError: true,
          };
        }
        if (found.priceMicroUsd !== 0 || (found.method ?? 'POST') !== 'GET') {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `"${name}" costs ${usd(found.priceMicroUsd)} per call and cannot run on this hosted server — it has no ` +
                  'wallet by design. Use the local gliana-ai-mcp server (see how_to_generate), where your key stays on your machine.',
              },
            ],
            isError: true,
          };
        }
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(args ?? {})) {
          if (v !== undefined && v !== null) qs.set(k, String(v));
        }
        const r = await fetch(`${this.api()}/v1/tools/${name}?${qs}`, { headers: { accept: 'application/json' } });
        const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        if (!r.ok) {
          return {
            content: [{ type: 'text' as const, text: String(j.detail ?? j.error ?? `Request failed (HTTP ${r.status})`) }],
            isError: true,
          };
        }
        return out(`${name} (free):\n${JSON.stringify(j, null, 2)}`, { tool: name, result: j });
      },
    );

    this.server.registerTool(
      'how_to_generate',
      {
        description:
          'How to actually RUN a model, UTILITY TOOL, or RECIPE (all paid). Done locally so your wallet key stays on your machine — this returns the install + config for the gliana-ai-mcp local server (tools: generate, tool, recipe).',
        inputSchema: {},
        outputSchema: {
          package: z.string(),
          command: z.string(),
          rails: z.array(z.string()),
          config: z.record(z.string(), z.any()).describe('MCP client config snippet.'),
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
          'The local server also has `tool` (every paid utility endpoint — call list_tools here for the live list with ' +
          'prices and input shapes, rather than trusting a list written into this text) and `recipe` (multi-model ' +
          'pipelines: image-to-video[-hd|-audio]) — same wallet, pay-per-call.\n\n' +
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      // McpServer binds to one transport, so each request gets its own.
      const tools = new GlianaTools(env);
      await tools.init();
      return createMcpHandler(tools.server, { route: '/mcp' })(request, env, ctx);
    }
    if (url.pathname === '/sse' || url.pathname.startsWith('/sse/')) {
      // The old SSE transport needs a session held between requests, which is
      // what the per-session Durable Objects were for. Streamable HTTP replaced it.
      return new Response('The SSE transport is retired. Connect to https://mcp.glianalabs.com/mcp (Streamable HTTP).', {
        status: 410,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return new Response(
      'GlianaAI MCP server. Connect an MCP client to /mcp (Streamable HTTP). Tools: list_models, get_price, get_schema, how_to_generate. Paid generation: npx gliana-ai-mcp. https://ai.glianalabs.com',
      { status: 200, headers: { 'content-type': 'text/plain' } },
    );
  },
};
