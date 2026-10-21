import type { Env } from './env.js';
import { BodyError, clientAddress, json, problem, tooMany } from './lib/http.js';
import { forget, ping } from './routes/ping.js';
import { map, summary } from './routes/publicStats.js';
import { block, listInstalls, overview } from './routes/admin.js';

/**
 * Everything that is not a file. The page, its script, styles and MapLibre are
 * static assets that Cloudflare serves before this code runs (wrangler.jsonc
 * sends only /api/* and /health here), so a page view costs no Worker at all.
 */
export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Fastify answered HEAD wherever it answered GET, and monitors rely on it.
  if (request.method === 'HEAD') {
    const response = await handle(new Request(request, { method: 'GET' }), env, ctx);
    return new Response(null, response);
  }
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  try {
    if (path === '/health' && method === 'GET') {
      await env.DB.prepare('SELECT 1').first();
      return json({ ok: true, ts: new Date().toISOString() });
    }

    if (path.startsWith('/api/')) {
      // A backstop across the whole API. Each route that needs one has its
      // own tighter limit as well.
      const { success } = await env.BACKSTOP_LIMIT.limit({ key: clientAddress(request) });
      if (!success) return tooMany(60);
    }

    if (path === '/api/v1/ping' && method === 'POST') return await ping(request, env, ctx);
    if (path === '/api/v1/forget' && method === 'POST') return await forget(request, env);
    if (path === '/api/v1/public/summary' && method === 'GET') return await summary(request, env, ctx);
    if (path === '/api/v1/public/map' && method === 'GET') return await map(request, env, ctx);
    if (path === '/api/v1/admin/installs' && method === 'GET') return await listInstalls(request, env);
    if (path === '/api/v1/admin/overview' && method === 'GET') return await overview(request, env);
    const blockMatch = /^\/api\/v1\/admin\/installs\/([^/]+)\/block$/.exec(path);
    if (blockMatch && method === 'POST') return await block(request, env, decodeURIComponent(blockMatch[1]!));

    return problem(404, 'Nothing here', 'not_found');
  } catch (err) {
    if (err instanceof BodyError) return err.response;
    console.error(JSON.stringify({ path, err: String(err), stack: err instanceof Error ? err.stack : undefined }));
    return problem(500, 'Something went wrong on our side', 'internal');
  }
}
