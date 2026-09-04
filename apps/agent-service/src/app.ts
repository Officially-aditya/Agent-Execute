import express from 'express';
import { resolve } from 'node:path';
import { runAgent } from './agent.js';
import { approveQuoteAsync, loadOrCreateMerchantKeys, verifyQuoteSignature } from '../../../packages/quote-integrity/src/index.js';
import { RazorpayAdapter } from '../../../packages/razorpay/src/index.js';
import { DomainError } from '../../../packages/shared/src/index.js';

function agentErrorPayload(error: unknown) {
  return error instanceof DomainError
    ? error.toJSON()
    : { error: 'agent_error', message: error instanceof Error ? error.message : String(error) };
}

function wantsAgentStream(req: express.Request): boolean {
  return String(req.headers.accept || '').includes('application/x-ndjson');
}

async function respondWithAgent(req: express.Request, res: express.Response, input: Parameters<typeof runAgent>[0]) {
  if (!wantsAgentStream(req)) {
    res.json(await runAgent(input));
    return;
  }

  res.status(200);
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();

  const write = (record: unknown) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(record)}\n`);
  };

  try {
    write({ type: 'ready', phase: 'runtime_ready' });
    const result = await runAgent({
      ...input,
      onEvent: (event) => write({ type: 'event', event }),
    });
    write({ type: 'result', result });
  } catch (error) {
    write({ type: 'error', error: agentErrorPayload(error) });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

export function createAgentApp(repo: any) {
  const app = express();
  const razorpay = new RazorpayAdapter();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', async (_req, res) => {
    try {
      await repo.merchantState();
      res.json({
        ok: true,
        service: 'agent-execute',
        llm_configured: Boolean(process.env.LLM_API_KEY),
        razorpay_test_configured: Boolean(process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') && process.env.RAZORPAY_KEY_SECRET),
        database: process.env.VERCEL ? 'neon' : 'local-or-neon',
      });
    } catch (error) {
      res.status(503).json({ ok: false, error: 'database_unavailable', message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.all('/api/agent-stream', async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const rawPath = req.query?.__path;
    const targetPath = Array.isArray(rawPath)
      ? (rawPath.find((p) => typeof p === 'string' && p !== '/api/agent-stream') || rawPath[0])
      : rawPath;

    if (targetPath === '/api/agent/run') {
      try {
        const { message, session_id } = req.body || {};
        if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message_required' });
        await respondWithAgent(req, res, { repo, message, sessionId: typeof session_id === 'string' ? session_id : undefined });
      } catch (error) {
        if (!res.headersSent) res.status(500).json(agentErrorPayload(error));
      }
      return;
    }

    const sessionMatch = typeof targetPath === 'string' ? targetPath.match(/^\/api\/sessions\/([^/]+)\/continue$/) : null;
    if (sessionMatch?.[1]) {
      try {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const session = await repo.getSession(sessionId);
        if (!session) return res.status(404).json({ error: 'session_not_found' });
        const instruction = session.state.activeGrantId
          ? `The user approved quote ${session.state.activeQuoteId}. The trusted execution grant is ${session.state.activeGrantId}. Continue the task using normal MCP tools.`
          : 'Continue the shopping task from the trusted persisted state.';
        await respondWithAgent(req, res, { repo, sessionId, trustedInstruction: instruction });
      } catch (error) {
        if (!res.headersSent) res.status(500).json(agentErrorPayload(error));
      }
      return;
    }

    res.status(404).json({ error: 'stream_route_not_found', message: `Unsupported stream route: ${targetPath || '(empty)'}` });
  });

  app.post('/api/agent/run', async (req, res) => {
    try {
      const { message, session_id } = req.body || {};
      if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message_required' });
      await respondWithAgent(req, res, { repo, message, sessionId: typeof session_id === 'string' ? session_id : undefined });
    } catch (error) {
      if (!res.headersSent) res.status(500).json(agentErrorPayload(error));
    }
  });

  app.post('/api/sessions/:sessionId/continue', async (req, res) => {
    try {
      const session = await repo.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'session_not_found' });
      const instruction = session.state.activeGrantId
        ? `The user approved quote ${session.state.activeQuoteId}. The trusted execution grant is ${session.state.activeGrantId}. Continue the task using normal MCP tools.`
        : 'Continue the shopping task from the trusted persisted state.';
      await respondWithAgent(req, res, { repo, sessionId: req.params.sessionId, trustedInstruction: instruction });
    } catch (error) {
      if (!res.headersSent) res.status(500).json(agentErrorPayload(error));
    }
  });

  // Trusted UI/server action. Deliberately not exposed to the LLM as an MCP tool.
  app.post('/api/quotes/:quoteId/approve', async (req, res) => {
    try {
      const { session_id } = req.body || {};
      if (typeof session_id !== 'string') return res.status(400).json({ error: 'session_id_required' });
      const session = await repo.getSession(session_id);
      if (!session) return res.status(404).json({ error: 'session_not_found' });
      if (session.state.activeQuoteId !== req.params.quoteId || session.state.phase !== 'AWAITING_APPROVAL') {
        throw new DomainError('REPLAY_ATTEMPT', 'Session is not awaiting approval for this exact quote');
      }
      const quote = await repo.getQuote(req.params.quoteId);
      if (!quote) return res.status(404).json({ error: 'quote_not_found' });
      if (session.state.objective.maximumAmount !== undefined && quote.amount > session.state.objective.maximumAmount) {
        throw new DomainError('AMOUNT_MISMATCH', 'Committed quote exceeds the persisted user budget', {
          maximum_amount: session.state.objective.maximumAmount,
          quote_amount: quote.amount,
        });
      }
      const result = await approveQuoteAsync(repo, req.params.quoteId);
      session.state.activeGrantId = result.grant.grantId;
      session.state.phase = 'APPROVED';
      await repo.saveSession(session.state, session.messages);
      res.json({ ...result, state: session.state });
    } catch (error) {
      res.status(400).json(error instanceof DomainError ? error.toJSON() : { error: 'approval_failed', message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/quotes/:quoteId/cancel', async (req, res) => {
    try {
      const { session_id } = req.body || {};
      if (typeof session_id !== 'string') return res.status(400).json({ error: 'session_id_required' });
      const session = await repo.getSession(session_id);
      if (!session) return res.status(404).json({ error: 'session_not_found' });
      if (session.state.activeQuoteId === req.params.quoteId) {
        session.state.activeQuoteId = undefined;
        session.state.phase = 'SHOPPING';
        await repo.saveSession(session.state, session.messages);
        await repo.appendAudit('QUOTE_CANCELLED', { quoteId: req.params.quoteId, sessionId: session_id });
      }
      res.json({ ok: true, state: session.state });
    } catch (error) {
      res.status(400).json({ error: 'cancel_failed', message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/quotes/:quoteId', async (req, res) => {
    try {
      const quote = await repo.getQuote(req.params.quoteId);
      if (!quote) return res.status(404).json({ error: 'quote_not_found' });
      const { publicKey } = loadOrCreateMerchantKeys();
      res.json({ ...quote, signatureValid: verifyQuoteSignature(quote, publicKey) });
    } catch (error) {
      res.status(500).json({ error: 'quote_read_failed', message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/sessions/:sessionId', async (req, res) => {
    const session = await repo.getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    const execution = session.state.activeGrantId ? await repo.getExecution(session.state.activeGrantId) : null;
    const payment = execution?.orderId ? await repo.getPaymentRecord(execution.orderId) : null;
    res.json({ state: session.state, execution, payment });
  });

  app.get('/api/audit', async (req, res) => {
    res.json(await repo.audit(Math.min(Number(req.query.limit || 200), 500)));
  });

  app.get('/api/carts/:cartId', async (req, res) => {
    try {
      res.json(await repo.getCartSnapshot(req.params.cartId));
    } catch (error) {
      res.status(404).json(error instanceof DomainError ? error.toJSON() : { error: 'cart_not_found', message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/payments/opened', async (req, res) => {
    const { order_id } = req.body || {};
    const record = typeof order_id === 'string' ? await repo.getPaymentRecord(order_id) : null;
    if (!record) return res.status(404).json({ error: 'order_not_found' });
    await repo.savePaymentRecord(record.orderId, record.grantId, 'CHECKOUT_OPENED', record.payload);
    await repo.appendAudit('RAZORPAY_CHECKOUT_OPENED', { orderId: record.orderId, grantId: record.grantId });
    res.json({ ok: true });
  });

  app.post('/api/payments/failure', async (req, res) => {
    const { order_id, error } = req.body || {};
    const record = typeof order_id === 'string' ? await repo.getPaymentRecord(order_id) : null;
    if (!record) return res.status(404).json({ error: 'order_not_found' });
    const failure = {
      error: 'PAYMENT_FAILED',
      stage: 'PAYMENT_RAIL',
      quote_integrity: 'VERIFIED',
      order_id: record.orderId,
      retry_allowed: true,
      rail_error: error,
    };
    await repo.savePaymentRecord(record.orderId, record.grantId, 'PAYMENT_FAILED', failure);
    await repo.appendAudit('RAZORPAY_PAYMENT_FAILED', { orderId: record.orderId, grantId: record.grantId, ...failure });
    res.json(failure);
  });

  app.post('/api/payments/verify', async (req, res) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
      if (![razorpay_order_id, razorpay_payment_id, razorpay_signature].every(value => typeof value === 'string' && value.length)) {
        throw new DomainError('PAYMENT_VERIFICATION_FAILED', 'Missing Razorpay checkout verification fields');
      }
      const record = await repo.getPaymentRecord(razorpay_order_id);
      if (!record) throw new DomainError('PAYMENT_VERIFICATION_FAILED', 'Order was not created by this verified checkout');
      const valid = razorpay.verifyCheckoutSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
      if (!valid) throw new DomainError('PAYMENT_VERIFICATION_FAILED', 'Razorpay payment signature did not verify');

      await repo.savePaymentRecord(razorpay_order_id, record.grantId, 'PAYMENT_SUCCESS', { verified: true }, razorpay_payment_id, true);
      await repo.appendAudit('RAZORPAY_PAYMENT_SUCCESS', { orderId: razorpay_order_id, paymentId: razorpay_payment_id, grantId: record.grantId });
      await repo.appendAudit('PAYMENT_SIGNATURE_VERIFIED', { orderId: razorpay_order_id, paymentId: razorpay_payment_id });
      await repo.markSessionPaymentComplete(record.grantId, razorpay_order_id);
      res.json({ status: 'PAYMENT_SUCCESS', order_id: razorpay_order_id, payment_id: razorpay_payment_id });
    } catch (error) {
      res.status(400).json(error instanceof DomainError ? error.toJSON() : { error: 'PAYMENT_VERIFICATION_FAILED', message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/config/public', (_req, res) => res.json({ razorpay_key_id: razorpay.publicKeyId() || null }));

  // Judge Mode merchant controls use the same persistent store as MCP.
  app.get('/api/admin/state', async (_req, res) => res.json({ merchant: await repo.merchantState(), products: await repo.listProducts() }));
  app.get('/api/admin/products', async (_req, res) => res.json(await repo.listProducts()));
  app.patch('/api/admin/products/:id/price', async (req, res) => {
    try { await repo.setProductPrice(req.params.id, Number(req.body.price)); res.json(await repo.getProduct(req.params.id)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.patch('/api/admin/products/:id/inventory', async (req, res) => {
    try { await repo.setInventory(req.params.id, Number(req.body.inventory)); res.json(await repo.getProduct(req.params.id)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.patch('/api/admin/products/:id/active', async (req, res) => {
    try { await repo.setProductActive(req.params.id, Boolean(req.body.active)); res.json(await repo.getProduct(req.params.id)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.patch('/api/admin/merchant/discount', async (req, res) => {
    try { await repo.setDiscount(Number(req.body.discount)); res.json(await repo.merchantState()); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.patch('/api/admin/merchant/delivery', async (req, res) => {
    try { await repo.setDelivery(Number(req.body.delivery)); res.json(await repo.merchantState()); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post('/api/admin/reset', async (_req, res) => { await repo.reset(); res.json({ ok: true }); });

  if (process.env.VERCEL) {
    app.get('/', (_req, res) => res.redirect('/index.html'));
  } else {
    const webRoot = resolve(process.cwd(), 'apps/web/public');
    app.use(express.static(webRoot));
    app.use((req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(resolve(webRoot, 'index.html'));
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: 'internal_server_error' });
  });

  return app;
}
