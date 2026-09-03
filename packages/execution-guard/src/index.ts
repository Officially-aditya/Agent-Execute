import { nowIso, DomainError, ERROR_CODES, type ErrorCode } from '@vac/shared';
import type { MerchantRepository } from '@vac/merchant-core';
import { digestCart, loadOrCreateMerchantKeys, verifyQuoteSignature } from '@vac/quote-integrity';
import type { PaymentRail, CreatedOrder } from '@vac/razorpay';
import { appendAudit } from '@vac/audit';

function knownErrorCode(value: unknown): value is ErrorCode { return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value); }

export class ExecutionGuard {
  constructor(private readonly repo: MerchantRepository, private readonly rail: PaymentRail) {}
  async execute(grantId: string): Promise<{ status: 'ORDER_CREATED'; order: CreatedOrder; grantId: string }> {
    const existing = this.repo.getExecution(grantId);
    if (existing?.state === 'ORDER_CREATED' && existing.orderId && existing.result?.order) return { status: 'ORDER_CREATED', order: existing.result.order, grantId };
    if (existing?.state === 'BLOCKED') { const code = knownErrorCode(existing.result?.error) ? existing.result.error : 'GRANT_ALREADY_USED'; throw new DomainError(code, existing.result?.message || 'Execution was previously blocked', { grant_id: grantId, previous: existing.result }); }
    const claim = this.repo.claimExecution(grantId);
    if (claim === 'EXISTING') throw new DomainError('GRANT_ALREADY_USED', 'Execution grant is already in progress or was previously attempted', { grant_id: grantId, state: existing?.state });
    appendAudit(this.repo.db, 'EXECUTION_REQUESTED', { grantId, retry: claim === 'RETRYABLE' });
    try {
      const grant = this.repo.getGrant(grantId); if (!grant) throw new DomainError('REPLAY_ATTEMPT', 'Execution grant does not exist', { grant_id: grantId }); if (grant.usedAt) throw new DomainError('GRANT_ALREADY_USED', 'Execution grant has already been consumed', { grant_id: grantId }); if (Date.parse(grant.expiresAt) <= Date.now()) throw new DomainError('APPROVAL_EXPIRED', 'Execution grant expired');
      const approval = this.repo.getApproval(grant.approvalId); if (!approval) throw new DomainError('REPLAY_ATTEMPT', 'Approval does not exist'); if (Date.parse(approval.expiresAt) <= Date.now()) throw new DomainError('APPROVAL_EXPIRED', 'Approval expired');
      const quote = this.repo.getQuote(grant.quoteId); if (!quote) throw new DomainError('REPLAY_ATTEMPT', 'Committed quote does not exist'); if (Date.parse(quote.validUntil) <= Date.now()) throw new DomainError('QUOTE_EXPIRED', 'Quote expired');
      const { publicKey } = loadOrCreateMerchantKeys(); if (!verifyQuoteSignature(quote, publicKey)) throw new DomainError('INVALID_SIGNATURE', 'Merchant quote signature is invalid');
      if (grant.quoteId !== approval.quoteId || approval.quoteId !== quote.quoteId || grant.approvalId !== approval.approvalId) throw new DomainError('REPLAY_ATTEMPT', 'Grant, approval and quote binding is invalid');
      if (grant.cartDigest !== approval.cartDigest || approval.cartDigest !== quote.cartDigest) throw new DomainError('QUOTE_CHANGED', 'Authorization digest binding is invalid');
      if (grant.amount !== approval.amount || approval.amount !== quote.amount) throw new DomainError('AMOUNT_MISMATCH', 'Authorization amount binding is invalid');
      if (grant.currency !== approval.currency || approval.currency !== quote.currency) throw new DomainError('CURRENCY_MISMATCH', 'Authorization currency binding is invalid');
      const current = this.repo.getCartSnapshot(quote.cartId); if (current.merchantId !== quote.merchantId) throw new DomainError('MERCHANT_MISMATCH', 'Current merchant does not match committed merchant');
      const currentDigest = digestCart(current);
      if (current.revision !== quote.cartRevision || currentDigest !== quote.cartDigest || current.total !== quote.amount) throw new DomainError('QUOTE_CHANGED', 'Merchant checkout state changed after approval', { approved: { amount: quote.amount, revision: quote.cartRevision, digest: quote.cartDigest }, current: { amount: current.total, revision: current.revision, digest: currentDigest }, recoverable: true });
      if (!this.repo.claimNonce(quote.nonce, grantId) || !this.repo.claimNonce(grant.nonce, grantId)) throw new DomainError('REPLAY_ATTEMPT', 'Quote or grant nonce has already been used by another execution');
      appendAudit(this.repo.db, 'EXECUTION_VERIFIED', { grantId, quoteId: quote.quoteId, amount: quote.amount });
      let order: CreatedOrder;
      try { order = await this.rail.createOrder({ amount: quote.amount, currency: quote.currency, quoteId: quote.quoteId, grantId: grant.grantId, cartDigest: quote.cartDigest, merchantId: quote.merchantId }); }
      catch (error) { if (error instanceof DomainError && error.code === 'RAZORPAY_NOT_CONFIGURED') throw error; const failure = new DomainError('PAYMENT_FAILED', 'Payment rail failed while creating the Razorpay order', { stage: 'PAYMENT_RAIL', quote_integrity: 'VERIFIED', retry_allowed: true, cause: error instanceof Error ? error.message : String(error) }); this.repo.saveExecution(grantId, 'PAYMENT_FAILED', null, failure.toJSON()); appendAudit(this.repo.db, 'PAYMENT_FAILED', { grantId, ...failure.toJSON() }); throw failure; }
      if (order.amount !== quote.amount || order.currency !== quote.currency) throw new DomainError('AMOUNT_MISMATCH', 'Payment rail returned an unexpected order amount/currency');
      const at = nowIso(); this.repo.markGrantUsed(grantId, at); this.repo.saveExecution(grantId, 'ORDER_CREATED', order.id, { order }); this.repo.savePaymentRecord(order.id, grantId, 'ORDER_CREATED', { order }); appendAudit(this.repo.db, 'RAZORPAY_ORDER_CREATED', { grantId, quoteId: quote.quoteId, orderId: order.id, amount: order.amount }); return { status: 'ORDER_CREATED', order, grantId };
    } catch (error) { if (error instanceof DomainError && error.code === 'PAYMENT_FAILED') throw error; const payload = error instanceof DomainError ? error.toJSON() : { error: 'REPLAY_ATTEMPT', message: error instanceof Error ? error.message : String(error) }; this.repo.saveExecution(grantId, 'BLOCKED', null, payload); appendAudit(this.repo.db, 'EXECUTION_BLOCKED', { grantId, ...payload }); throw error; }
  }
}