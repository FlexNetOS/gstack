// Ark Home — HTTP API Server
// Resource orchestration daemon on port 7700. No terminal UI.
// JSON API for conversation, search, stats, resources, health.

import type { Conversation } from './conversation';
import type { ArkHomeConfig, Context } from './types';
import type { ResourceRegistry } from './providers/index';

export interface ServerHandle {
  port: number;
  stop: () => void;
}

export function startServer(
  conversation: Conversation,
  config: ArkHomeConfig,
  resources?: ResourceRegistry,
): ServerHandle {
  const port = config.mcpPort || 7700;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  const server = Bun.serve({
    port,
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      try {
        // GET /api/health
        if (path === '/api/health' && req.method === 'GET') {
          const stats = conversation.stats();
          const providerHealth = resources ? await resources.healthAll() : {};
          return Response.json({
            status: 'ok',
            uptime: process.uptime(),
            memory: stats,
            providers: providerHealth,
          }, { headers: corsHeaders });
        }

        // POST /api/message — send message, get response
        if (path === '/api/message' && req.method === 'POST') {
          const body = await req.json() as { content?: string; context?: Context };
          if (!body.content || typeof body.content !== 'string') {
            return Response.json(
              { error: 'Missing required field: content (string)' },
              { status: 400, headers: corsHeaders },
            );
          }

          if (body.context && ['personal', 'business', 'home'].includes(body.context)) {
            conversation.switchContext(body.context);
          }

          const response = await conversation.processInput(body.content);
          return Response.json({
            response,
            context: conversation.context,
            stats: conversation.stats(),
          }, { headers: corsHeaders });
        }

        // GET /api/search?q=query&context=business
        if (path === '/api/search' && req.method === 'GET') {
          const q = url.searchParams.get('q') || '';
          const ctx = url.searchParams.get('context') as Context | null;
          const validCtx = ctx && ['personal', 'business', 'home'].includes(ctx) ? ctx : undefined;

          if (!q) {
            return Response.json(
              { error: 'Missing required query parameter: q' },
              { status: 400, headers: corsHeaders },
            );
          }

          const results = await conversation.searchCombined(q, validCtx);
          return Response.json({ results, count: results.length }, { headers: corsHeaders });
        }

        // GET /api/stats
        if (path === '/api/stats' && req.method === 'GET') {
          return Response.json(conversation.stats(), { headers: corsHeaders });
        }

        // POST /api/context — switch context
        if (path === '/api/context' && req.method === 'POST') {
          const body = await req.json() as { context?: Context };
          if (!body.context || !['personal', 'business', 'home'].includes(body.context)) {
            return Response.json(
              { error: 'Invalid context. Must be: personal, business, or home' },
              { status: 400, headers: corsHeaders },
            );
          }
          conversation.switchContext(body.context);
          return Response.json({ context: body.context }, { headers: corsHeaders });
        }

        // GET /api/resources — list available resource providers
        if (path === '/api/resources' && req.method === 'GET') {
          if (!resources) {
            return Response.json({ providers: [] }, { headers: corsHeaders });
          }
          const list = resources.list();
          return Response.json({ providers: list }, { headers: corsHeaders });
        }

        // POST /api/resources/:provider/:action — execute a resource action
        const resourceMatch = path.match(/^\/api\/resources\/([^/]+)\/([^/]+)$/);
        if (resourceMatch && req.method === 'POST') {
          if (!resources) {
            return Response.json(
              { error: 'No resource providers configured' },
              { status: 404, headers: corsHeaders },
            );
          }
          const [, providerName, action] = resourceMatch;
          const body = req.headers.get('content-type')?.includes('json')
            ? await req.json() as Record<string, unknown>
            : {};

          const result = await resources.execute(providerName, action, body);
          return Response.json(result, { headers: corsHeaders });
        }

        // 404
        return Response.json({
          error: 'Not found',
          routes: [
            'GET  /api/health',
            'POST /api/message',
            'GET  /api/search?q=...',
            'GET  /api/stats',
            'POST /api/context',
            'GET  /api/resources',
            'POST /api/resources/:provider/:action',
          ],
        }, { status: 404, headers: corsHeaders });

      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal server error';
        return Response.json({ error: message }, { status: 500, headers: corsHeaders });
      }
    },
  });

  return {
    port: server.port,
    stop: () => server.stop(),
  };
}
