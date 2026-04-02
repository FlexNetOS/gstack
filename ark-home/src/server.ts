// Ark Home — HTTP API Server
// Resource orchestration daemon on port 7700. Localhost-only by default.
// JSON API for conversation, search, stats, resources, health.

import type { Conversation } from './conversation';
import type { ArkHomeConfig, Context } from './types';
import type { ResourceRegistry } from './providers/index';
import type { PermissionManager } from './permissions';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

export interface ServerHandle {
  port: number;
  token: string;
  stop: () => void;
}

/** Load or generate a bearer token for API authentication. */
function loadOrCreateToken(configDir: string): string {
  const tokenPath = join(configDir, 'api-token');
  try {
    if (existsSync(tokenPath)) {
      return readFileSync(tokenPath, 'utf-8').trim();
    }
  } catch { /* regenerate */ }

  const token = randomBytes(32).toString('hex');
  const dir = dirname(tokenPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

export function startServer(
  conversation: Conversation,
  config: ArkHomeConfig,
  resources?: ResourceRegistry,
  permissions?: PermissionManager,
): ServerHandle {
  const port = config.mcpPort || 7700;
  const configDir = join(process.env.HOME || '/root', '.ark-home');
  const token = loadOrCreateToken(configDir);

  const corsHeaders = {
    'Access-Control-Allow-Origin': 'http://localhost',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  function checkAuth(req: Request): boolean {
    // Health endpoint is public
    const url = new URL(req.url);
    if (url.pathname === '/api/health') return true;

    const auth = req.headers.get('authorization');
    return auth === `Bearer ${token}`;
  }

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Auth check (health is public, everything else requires token)
      if (!checkAuth(req)) {
        return Response.json(
          { error: 'Unauthorized. Include Authorization: Bearer <token> header.' },
          { status: 401, headers: corsHeaders },
        );
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

          // Permission check
          if (permissions) {
            const provider = resources.get(providerName);
            if (provider) {
              const actionDef = provider.actions().find(a => a.name === action);
              const destructive = actionDef?.destructive ?? true;
              const check = permissions.check(providerName, action, conversation.context, destructive);
              if (!check.permitted) {
                return Response.json(
                  { error: `Permission denied: ${check.reason}` },
                  { status: 403, headers: corsHeaders },
                );
              }
            }
          }

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
        // Log details server-side, return generic error to client
        console.error('[ark-home] Request error:', err);
        return Response.json(
          { error: 'Internal server error' },
          { status: 500, headers: corsHeaders },
        );
      }
    },
  });

  return {
    port: server.port,
    token,
    stop: () => server.stop(),
  };
}
