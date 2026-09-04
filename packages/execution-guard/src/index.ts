import { nowIso, DomainError, ERROR_CODES, type ErrorCode, type Approval, type CartSnapshot, type ExecutionGrant, type Quote } from '../../shared/src/index.js';
import { digestCart, loadOrCreateMerchantKeys, verifyQuoteSignature } from '../../quote-integrity/src/index.js';
import type { PaymentRail, CreatedOrder } from '../../razorpay/src/index.js';

type MaybePromise<T> = T | Promise<T>;
type ExecutionRecord = { state: string; orderId?: string | null; result?: any } | null;

type GuardRepository = {
  appendAudit(type: string, data: Record<string, unknown>): MaybePromise<unknown>;
  getExecution(grantId: string): MaybePromise<ExecutionRecord>;
  claimExecution(grantId: string): MaybePromise<'CLAIMED' | 'EXISTING' | 'RETRYABLE'>;
  getGrant(grantId: string): MaybePromise<(ExecutionGrant & { usedAt?: string }) | null>;
  getApproval(approvalId: string): MaybePromise<Approval | null>;
  getQuote(quoteId: string): MaybePromise<Quote | null>;
  getCartSnapshot(cartId: string): MaybePromise<CartSnapshot>;
  claimNonce(nonce: string, grantId: string): MaybePromise<boolean>;
  markGrantUsed(grantId: string, at: string): MaybePromise<unknown>;
  saveExecution(grantId: string, state: string, orderId: string | null, result: unknown): MaybePromise<unknown>;
  savePaymentRecord(orderId: string, grantId: string, state: string, payload: unknown, paymentId?: string, verified?: boolean): MaybePromise<unknown>;
};

function knownErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export class ExecutionGuard {
  constructor(private readonly repo: GuardRepository, private readonly rail: PaymentRail) {}

  async execute(grantId: string): Promise<{ status: 'ORDER_CREATED'; order: CreatedOrder; grantId: string }> {
    const existing = await this.repo.getExecution(grantId);
    if (existing?.state === 'ORDER_CREATED' && existing.orderId && existing.result?.order) {
      return { status: 'ORDER_CREATED', order: existing.result.order, grantId };
    }
    if (existing?.state === 'BLOCKED') {
      const code = knownErrorCode(existing.result?.error) ? existing.result.error : 'GRANT_ALREADY_USED';
      throw new DomainError(code, existing.result?.message || 'Execution was previously blocked', { grant_id: grantId, previous: existing.result });
    }

    const claim = await this.repo.claimExecution(grantId);
    if (claim === 'EXISTING') {
      throw new DomainError('GRANT_ALREADY_USED', 'Execution grant is already in progress or was previously attempted', { grant_id: grantId, state: existing?.state });
    }
    await this.repo.appendAudit('EXECUTION_REQUESTED', { grantId, retry: claim === 'RETRYABLE' });

    try {
      const grant = await this.repo.getGrant(grantId);
      if (!grant) throw new DomainError('REPLAY_ATTEMPT', 'Execution grant does not exist', { grant_id: grantId });
      if (grant.usedAt) throw new DomainError('GRANT_ALREADY_USED', 'Execution grant has already been consumed', { grant_id: grantId });
      const approval = await this.repo.getApproval(grant.approvalId);
      if (!approval) throw new DomainError('REPLAY_ATTEMPT', 'Approval does not exist');

      const quote = await this.repo.getQuote(grant.quoteId);
      if (!quote) throw new DomainError('REPLAY_ATTEMPT', 'Committed quote does not exist');

      const { publicKey } = loadOrCreateMerchantKeys();
      if (!verifyQuoteSignature(quote, publicKey)) throw new DomainError('INVALID_SIGNATURE', 'Merchant quote signature is invalid');
      if (grant.quoteId !== approval.quoteId || approval.quoteId !== quote.quoteId || grant.approvalId !== approval.approvalId) throw new DomainError('REPLAY_ATTEMPT', 'Grant, approval and quote binding is invalid');
      if (grant.cartDigest !== approval.cartDigest || approval.cartDigest !== quote.cartDigest) throw new DomainError('QUOTE_CHANGED', 'Authorization digest binding is invalid');
      if (grant.amount !== approval.amount || approval.amount !== quote.amount) throw new DomainError('AMOUNT_MISMATCH', 'Authorization amount binding is invalid');
      if (grant.currency !== approval.currency || approval.currency !== quote.currency) throw new DomainError('CURRENCY_MISMATCH', 'Authorization currency binding is invalid');

      const current = await this.repo.getCartSnapshot(quote.cartId);
      if (current.merchantId !== quote.merchantId) throw new DomainError('MERCHANT_MISMATCH', 'Current merchant does not match committed merchant');
      const currentDigest = digestCart(current);
      if (current.revision !== quote.cartRevision || currentDigest !== quote.cartDigest || current.total !== quote.amount) {
        const message = current.total !== quote.amount
          ? 'Transaction failed because amount updated'
          : 'Merchant checkout state changed after approval';
        throw new DomainError('QUOTE_CHANGED', message, {
          approved: { amount: quote.amount, revision: quote.cartRevision, digest: quote.cartDigest },
          current: { amount: current.total, revision: current.revision, digest: currentDigest },
          recoverable: true,
        });
      }

      if (Date.parse(grant.expiresAt) <= Date.now()) throw new DomainError('APPROVAL_EXPIRED', 'Execution grant expired');
      if (Date.parse(approval.expiresAt) <= Date.now()) throw new DomainError('APPROVAL_EXPIRED', 'Approval expired');
      if (Date.parse(quote.validUntil) <= Date.now()) throw new DomainError('QUOTE_EXPIRED', 'Quote expired');

      const quoteNonceOk = await this.repo.claimNonce(quote.nonce, grantId);
      const grantNonceOk = await this.repo.claimNonce(grant.nonce, grantId);
      if (!quoteNonceOk || !grantNonceOk) throw new DomainError('REPLAY_ATTEMPT', 'Quote or grant nonce has already been used by another execution');

      await this.repo.appendAudit('EXECUTION_VERIFIED', { grantId, quoteId: quote.quoteId, amount: quote.amount });

      let order: CreatedOrder;
      try {
        order = await this.rail.createOrder({
          amount: quote.amount,
          currency: quote.currency,
          quoteId: quote.quoteId,
          grantId: grant.grantId,
          cartDigest: quote.cartDigest,
          merchantId: quote.merchantId,
        });
      } catch (error) {
        if (error instanceof DomainError && error.code === 'RAZORPAY_NOT_CONFIGURED') throw error;
        const failure = new DomainError('PAYMENT_FAILED', 'Payment rail failed while creating the Razorpay order', {
          stage: 'PAYMENT_RAIL',
          quote_integrity: 'VERIFIED',
          retry_allowed: true,
          cause: error instanceof Error ? error.message : String(error),
        });
        await this.repo.saveExecution(grantId, 'PAYMENT_FAILED', null, failure.toJSON());
        await this.repo.appendAudit('PAYMENT_FAILED', { grantId, ...failure.toJSON() });
        throw failure;
      }

      if (order.amount !== quote.amount || order.currency !== quote.currency) {
        throw new DomainError('AMOUNT_MISMATCH', 'Payment rail returned an unexpected order amount/currency');
      }

      const at = nowIso();
      await this.repo.markGrantUsed(grantId, at);
      await this.repo.saveExecution(grantId, 'ORDER_CREATED', order.id, { order });
      await this.repo.savePaymentRecord(order.id, grantId, 'ORDER_CREATED', { order });
      await this.repo.appendAudit('RAZORPAY_ORDER_CREATED', { grantId, quoteId: quote.quoteId, orderId: order.id, amount: order.amount });
      return { status: 'ORDER_CREATED', order, grantId };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'PAYMENT_FAILED') throw error;
      const payload = error instanceof DomainError
        ? error.toJSON()
        : { error: 'REPLAY_ATTEMPT', message: error instanceof Error ? error.message : String(error) };
      await this.repo.saveExecution(grantId, 'BLOCKED', null, payload);
      await this.repo.appendAudit('EXECUTION_BLOCKED', { grantId, ...payload });
      throw error;
    }
  }
}
