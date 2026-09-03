import 'dotenv/config';
import express from 'express';
import { resolve } from 'node:path';
import { runAgent } from './agent.js';
import { MerchantRepository } from '@vac/merchant-core';
import { approveQuote, loadOrCreateMerchantKeys, verifyQuoteSignature } from '@vac/quote-integrity';
import { RazorpayAdapter } from '@vac/razorpay';
import { DomainError } from '@vac/shared';
import { appendAudit } from '@vac/audit';

const app = express();
app.use(express.json({ limit: '256kb' }));
const repo = new MerchantRepository();
const razorpay = new RazorpayAdapter();

app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'agent-execute',
  llm_configured: Boolean(process.env.LLM_API_KEY),
  razorpay_test_configured: Boolean(process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') && process.env.RAZORPAY_KEY_SECRET),
}));

app.post('/api/agent/run', async (req, res) => {
  try {
    const { message, session_id } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message_required' });
    res.json(await runAgent({ repo, message, sessionId: typeof session_id === 'string' ? session_id : undefined }));
  } catch (e) {
    res.status(500).json(e instanceof DomainError ? e.toJSON() : { error: 'agent_error', message: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/sessions/:sessionId/continue', async (req, res) => {
  try {
    const session = repo.getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    const instruction = session.state.activeGrantId
      ? `The user approved quote ${session.state.activeQuoteId}. The trusted execution grant is ${session.state.activeGrantId}. Continue the task using normal MCP tools.`
      : 'Continue the shopping task from the trusted persisted state.';
    res.json(await runAgent({ repo, sessionId: req.params.sessionId, trustedInstruction: instruction }));
  } catch (e) {
    res.status(500).json(e instanceof DomainError ? e.toJSON() : { error: 'agent_error', message: e instanceof Error ? e.message : String(e) });
  }
});

// Trusted UI/server action. Deliberately not exposed to the LLM as an MCP tool.
app.post('/api/quotes/:quoteId/approve', (req, res) => {
  try {
    const { session_id } = req.body || {};
    if (typeof session_id !== 'string') return res.status(400).json({ error: 'session_id_required' });
    const session = repo.getSession(session_id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    if (session.state.activeQuoteId !== req.params.quoteId || session.state.phase !== 'AWAITING_APPROVAL') {
      throw new DomainError('REPLAY_ATTEMPT', 'Session is not awaiting approval for this exact quote');
    }
    const quote = repo.getQuote(req.params.quoteId);
    if (!quote) return res.status(404).json({ error: 'quote_not_found' });
    if (session.state.objective.maximumAmount !== undefined && quote.amount > session.state.objective.maximumAmount) {
      throw new DomainError('AMOUNT_MISMATCH', 'Committed quote exceeds the persisted user budget', {
        maximum_amount: session.state.objective.maximumAmount,
        quote_amount: quote.amount,
      });
    }
    const result = approveQuote(repo, req.params.quoteId);
    session.state.activeGrantId = result.grant.grantId;
    session.state.phase = 'APPROVED';
    repo.saveSession(session.state, session.messages);
    res.json({ ...result, state: session.state });
  } catch (e) {
    res.status(400).json(e instanceof DomainError ? e.toJSON() : { error: 'approval_failed', message: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/quotes/:quoteId', (req, res) => {
  const quote = repo.getQuote(req.params.quoteId);
  if (!quote) return res.status(404).json({ error: 'quote_not_found' });
  const { publicKey } = loadOrCreateMerchantKeys();
  res.json({ ...quote, signatureValid: verifyQuoteSignature(quote, publicKey) });
});

app.get('/api/sessions/:sessionId', (req, res) => {
  const session = repo.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  const execution = session.state.activeGrantId ? repo.getExecution(session.state.activeGrantId) : null;
  const payment = execution?.orderId ? repo.getPaymentRecord(execution.orderId) : null;
  res.json({ state: session.state, execution, payment });
});

app.get('/api/audit', (req, res) => res.json(repo.audit(Math.min(Number(req.query.limit || 200), 500))));

app.get('/api/carts/:cartId', (req, res) => {
  try {
    res.json(repo.getCartSnapshot(req.params.cartId));
  } catch (e) {
    res.status(404).json(e instanceof DomainError ? e.toJSON() : { error: 'cart_not_found', message: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/payments/opened', (req, res) => {
  const { order_id } = req.body || {};
  const record = typeof order_id === 'string' ? repo.getPaymentRecord(order_id) : null;
  if (!record) return res.status(404).json({ error: 'order_not_found' });
  repo.savePaymentRecord(record.orderId, record.grantId, 'CHECKOUT_OPENED', record.payload);
  appendAudit(repo.db, 'RAZORPAY_CHECKOUT_OPENED', { orderId: record.orderId, grantId: record.grantId });
  res.json({ ok: true });
});

app.post('/api/payments/failure', (req, res) => {
  const { order_id, error } = req.body || {};
  const record = typeof order_id === 'string' ? repo.getPaymentRecord(order_id) : null;
  if (!record) return res.status(404).json({ error: 'order_not_found' });
  const failure = {
    error: 'PAYMENT_FAILED',
    stage: 'PAYMENT_RAIL',
    quote_integrity: 'VERIFIED',
    order_id: record.orderId,
    retry_allowed: true,
    rail_error: error,
  };
  repo.savePaymentRecord(record.orderId, record.grantId, 'PAYMENT_FAILED', failure);
  appendAudit(repo.db, 'RAZORPAY_PAYMENT_FAILED', { orderId: record.orderId, grantId: record.grantId, ...failure });
  res.json(failure);
});

app.post('/api/payments/verify', (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (![razorpay_order_id, razorpay_payment_id, razorpay_signature].every(v => typeof v === 'string' && v.length)) {
      throw new DomainError('PAYMENT_VERIFICATION_FAILED', 'Missing Razorpay checkout verification fields');
    }
    const record = repo.getPaymentRecord(razorpay_order_id);
    if (!record) throw new DomainError('PAYMENT_VERIFICATION_FAILED', 'Order was not created by this verified checkout');
    const valid = razorpay.verifyCheckoutSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    if (!valid) throw new DomainError('PAYMENT_VERIFICATION_FAILED', 'Razorpay payment signature did not verify');

    repo.savePaymentRecord(razorpay_order_id, record.grantId, 'PAYMENT_SUCCESS', { verified: true }, razorpay_payment_id, true);
    appendAudit(repo.db, 'RAZORPAY_PAYMENT_SUCCESS', { orderId: razorpay_order_id, paymentId: razorpay_payment_id, grantId: record.grantId });
    appendAudit(repo.db, 'PAYMENT_SIGNATURE_VERIFIED', { orderId: razorpay_order_id, paymentId: razorpay_payment_id });

    const sessionRows = repo.db.prepare('SELECT state_json,messages_json FROM agent_sessions').all() as Array<{ state_json: string; messages_json: string }>;
    for (const row of sessionRows) {
      const state = JSON.parse(row.state_json);
      if (state.activeGrantId === record.grantId) {
        state.phase = 'PAYMENT_COMPLETE';
        state.lastPaymentOrderId = razorpay_order_id;
        repo.saveSession(state, JSON.parse(row.messages_json));
      }
    }
    res.json({ status: 'PAYMENT_SUCCESS', order_id: razorpay_order_id, payment_id: razorpay_payment_id });
  } catch (e) {
    res.status(400).json(e instanceof DomainError ? e.toJSON() : { error: 'PAYMENT_VERIFICATION_FAILED', message: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/config/public', (_req, res) => res.json({ razorpay_key_id: razorpay.publicKeyId() || null }));

const webRoot = resolve(process.cwd(), 'apps/web/public');
app.use(express.static(webRoot));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(resolve(webRoot, 'index.html'));
});

const port = Number(process.env.AGENT_PORT || 3001);
app.listen(port, () => console.log(`Agent Execute listening on http://localhost:${port}`));
