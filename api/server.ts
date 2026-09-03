let app: any = null;

async function getApp() {
  if (app) return app;

  const [{ NeonMerchantRepository }, { createAgentApp }] = await Promise.all([
    import('@vac/merchant-core/neon'),
    import('../apps/agent-service/src/app.js'),
  ]);

  const repo = new NeonMerchantRepository();
  app = createAgentApp(repo);
  return app;
}

/**
 * Explicit Vercel Function entrypoint.
 *
 * Keep this module dependency-free at evaluation time. Heavy application,
 * MCP, provider and database modules are loaded only inside the handler so
 * Vercel runtime/import failures can be returned as useful JSON instead of
 * FUNCTION_INVOCATION_FAILED.
 */
export default async function handler(req: any, res: any) {
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

    const expressApp = await getApp();
    return expressApp(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : undefined;
    console.error('Agent Execute Vercel invocation failed:', error);
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
}
