import 'dotenv/config';
import { NeonMerchantRepository } from '@vac/merchant-core/neon';
import { createAgentApp } from '../apps/agent-service/src/app.js';

let app: ReturnType<typeof createAgentApp> | null = null;

function getApp() {
  if (app) return app;
  const repo = new NeonMerchantRepository();
  app = createAgentApp(repo);
  return app;
}

/**
 * Explicit Vercel Function entrypoint.
 *
 * Vercel rewrites the public /health and /api/* paths here while preserving
 * the original path in __path. Rehydrate req.url before passing the request
 * to Express so the exact same application routes are used in production.
 *
 * The application is initialized lazily so a missing/invalid deployment
 * environment variable is returned as JSON instead of crashing the function
 * during module evaluation and leaving the browser with an opaque HTTP 500.
 */
export default function handler(req: any, res: any) {
  try {
    const rawPath = req.query?.__path;
    const path = Array.isArray(rawPath) ? rawPath[0] : rawPath;

    if (typeof path !== 'string' || !path.startsWith('/')) {
      res.status(400).json({ error: 'invalid_proxy_path' });
      return;
    }

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query || {})) {
      if (key === '__path' || value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, String(item));
      } else {
        params.set(key, String(value));
      }
    }

    const query = params.toString();
    req.url = query ? `${path}?${query}` : path;
    return getApp()(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Agent Execute Vercel startup failed:', error);
    res.status(500).json({
      error: 'server_startup_failed',
      message,
      hint: 'Check DATABASE_URL/NEON_DATABASE_URL and server-side deployment environment variables.',
    });
  }
}
