import { neonConfig } from '@neondatabase/serverless';
import WebSocket from 'ws';
import { NeonMerchantRepository } from '../packages/merchant-core/src/neon.js';
import { createAgentApp } from '../apps/agent-service/src/app.js';
import { runWithMerchantMcpRepo } from '../apps/agent-service/src/mcp.js';

// Make Neon Pool/Client transport explicit instead of relying on runtime-global
// WebSocket support. This keeps the Vercel function stable across Node runtimes.
neonConfig.webSocketConstructor = WebSocket;

function waitForResponse(res: any): Promise<void> {
  if (res.writableEnded || res.finished) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      res.off?.('finish', done);
      res.off?.('close', done);
      resolve();
    };
    res.once('finish', done);
    res.once('close', done);
  });
}

/**
 * Explicit Vercel Function entrypoint.
 *
 * Neon Pool uses WebSockets for node-postgres compatibility. In serverless,
 * that pool must not be cached across invocations. Each request therefore
 * receives one repository/pool, shared by the Express app and in-memory MCP,
 * and the pool is closed before this invocation completes.
 */
export default async function handler(req: any, res: any) {
  let repo: NeonMerchantRepository | null = null;
  try {
    const rawPath = req.query?.__path;
    const path = Array.isArray(rawPath)
      ? (rawPath.find((p: string) => typeof p === 'string' && p !== '/api/agent-stream') || rawPath[0])
      : rawPath;

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

    repo = new NeonMerchantRepository();
    const app = createAgentApp(repo);
    const responseDone = waitForResponse(res);
    runWithMerchantMcpRepo(repo, () => app(req, res));
    await responseDone;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : undefined;
    console.error('Agent Execute Vercel invocation failed:', error);
    if (!res.headersSent && !res.writableEnded) {
      res.status(500).json({
        error: 'server_startup_failed',
        message,
        stack,
        diagnostics: {
          database_configured: Boolean(
            process.env.NEON_DATABASE_URL?.startsWith('postgres') ||
            process.env.DATABASE_URL?.startsWith('postgres') ||
            process.env.POSTGRES_URL?.startsWith('postgres')
          ),
          llm_configured: Boolean(process.env.LLM_API_KEY),
          llm_model: process.env.LLM_MODEL || null,
          llm_base_url_configured: Boolean(process.env.LLM_BASE_URL),
          razorpay_test_configured: Boolean(
            process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') && process.env.RAZORPAY_KEY_SECRET
          ),
          merchant_signing_keys_configured: Boolean(
            process.env.MERCHANT_SIGNING_PRIVATE_KEY && process.env.MERCHANT_SIGNING_PUBLIC_KEY
          ),
        },
      });
    }
  } finally {
    if (repo) {
      await repo.close().catch((error) => {
        console.error('Failed to close Neon pool:', error);
      });
    }
  }
}
