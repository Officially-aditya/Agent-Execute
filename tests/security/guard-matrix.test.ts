import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MerchantRepository } from '@vac/merchant-core';
import { approveQuote, commitQuote, loadOrCreateMerchantKeys, signQuotePayload } from '@vac/quote-integrity';
import { ExecutionGuard } from '@vac/execution-guard';
import type { CreateVerifiedOrderInput, PaymentRail } from '@vac/razorpay';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ae-guard-'));
  dirs.push(dir);
  return new MerchantRepository(join(dir, 'test.sqlite'));
}

class Rail implements PaymentRail {
  calls: CreateVerifiedOrderInput[] = [];
  constructor(private readonly delayMs = 0) {}
  async createOrder(input: CreateVerifiedOrderInput) {
    this.calls.push(input);
    if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    return { id: `order_${this.calls.length}`, amount: input.amount, currency: input.currency };
  }
}

function authorized(repo: MerchantRepository, product = 'milk_1l') {
  const cartId = repo.createCart();
  repo.addToCart(cartId, product, 1);
  const quote = commitQuote(repo, cartId, 300);
  const { approval, grant } = approveQuote(repo, quote.quoteId);
  return { cartId, quote, approval, grant };
}

describe('ExecutionGuard authorization matrix', () => {
  it('rejects an expired approval before the payment rail', async () => {
    const repo = makeRepo();
    const { approval, grant } = authorized(repo);
    repo.db.prepare('UPDATE approvals SET expires_at=? WHERE approval_id=?').run(new Date(0).toISOString(), approval.approvalId);
    const rail = new Rail();
    await expect(new ExecutionGuard(repo, rail).execute(grant.grantId)).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    expect(rail.calls).toHaveLength(0);
  });

  it('rejects cross-quote grant binding', async () => {
    const repo = makeRepo();
    const first = authorized(repo, 'milk_1l');
    const second = authorized(repo, 'bread_white');
    repo.db.prepare('UPDATE grants SET quote_id=? WHERE grant_id=?').run(second.quote.quoteId, first.grant.grantId);
    const rail = new Rail();
    await expect(new ExecutionGuard(repo, rail).execute(first.grant.grantId)).rejects.toMatchObject({ code: 'REPLAY_ATTEMPT' });
    expect(rail.calls).toHaveLength(0);
  });

  it('rejects currency tampering before the payment rail', async () => {
    const repo = makeRepo();
    const { grant } = authorized(repo);
    repo.db.prepare("UPDATE grants SET currency='USD' WHERE grant_id=?").run(grant.grantId);
    const rail = new Rail();
    await expect(new ExecutionGuard(repo, rail).execute(grant.grantId)).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
    expect(rail.calls).toHaveLength(0);
  });

  it('rejects a correctly re-signed quote for the wrong merchant', async () => {
    const repo = makeRepo();
    const { quote, grant } = authorized(repo);
    const forged = { ...quote, merchantId: 'merchant_other' };
    const { privateKey } = loadOrCreateMerchantKeys();
    const signature = signQuotePayload(forged, privateKey);
    repo.db.prepare('UPDATE quotes SET merchant_id=?, merchant_signature=? WHERE quote_id=?').run(forged.merchantId, signature, quote.quoteId);
    const rail = new Rail();
    await expect(new ExecutionGuard(repo, rail).execute(grant.grantId)).rejects.toMatchObject({ code: 'MERCHANT_MISMATCH' });
    expect(rail.calls).toHaveLength(0);
  });

  it('rejects a nonce already consumed by another grant', async () => {
    const repo = makeRepo();
    const { quote, grant } = authorized(repo);
    repo.db.prepare('INSERT INTO used_nonces(nonce,used_at,grant_id) VALUES(?,?,?)').run(quote.nonce, new Date().toISOString(), 'grant_other');
    const rail = new Rail();
    await expect(new ExecutionGuard(repo, rail).execute(grant.grantId)).rejects.toMatchObject({ code: 'REPLAY_ATTEMPT' });
    expect(rail.calls).toHaveLength(0);
  });

  it('allows only one concurrent rail call for the same grant', async () => {
    const repo = makeRepo();
    const { grant } = authorized(repo);
    const rail = new Rail(25);
    const guard = new ExecutionGuard(repo, rail);
    const first = guard.execute(grant.grantId);
    const second = guard.execute(grant.grantId);
    const results = await Promise.allSettled([first, second]);
    expect(rail.calls).toHaveLength(1);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'GRANT_ALREADY_USED' } });
  });

  it('returns the same order for an idempotent retry after success', async () => {
    const repo = makeRepo();
    const { grant } = authorized(repo);
    const rail = new Rail();
    const guard = new ExecutionGuard(repo, rail);
    const first = await guard.execute(grant.grantId);
    const second = await guard.execute(grant.grantId);
    expect(rail.calls).toHaveLength(1);
    expect(second.order.id).toBe(first.order.id);
  });
});
