import 'dotenv/config';
import { NeonMerchantRepository } from '@vac/merchant-core/neon';
import { createAgentApp } from '../apps/agent-service/src/app.js';

const repo = new NeonMerchantRepository();
const app = createAgentApp(repo);

/**
 * Explicit Vercel Function entrypoint.
 *
 * Vercel rewrites the public /health and /api/* paths here while preserving
 * the original path in __path. Rehydrate req.url before passing the request
 * to Express so the exact same application routes are used in production.
 */
export default function handler(req: any, res: any) {
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
  return app(req, res);
}
