import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MerchantRepository } from '@vac/merchant-core';
import { approveQuote, commitQuote } from '@vac/quote-integrity';
import { ExecutionGuard } from '@vac/execution-guard';
import { RazorpayAdapter } from '@vac/razorpay';

const enabled = process.env.RUN_LIVE_RAZORPAY === '1';
const live = enabled ? describe : describe.skip;
const dir = mkdtempSync(join(tmpdir(), 'ae-live-rzp-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

live('live Razorpay Test Mode order', () => {
  it('creates a real Test Order only from a verified quote amount', async () => {
    expect(process.env.RAZORPAY_KEY_ID, 'RAZORPAY_KEY_ID is required').toMatch(/^rzp_test_/);
    expect(process.env.RAZORPAY_KEY_SECRET, 'RAZORPAY_KEY_SECRET is required').toBeTruthy();

    const repo = new MerchantRepository(join(dir, 'live.sqlite'));
    const cartId = repo.createCart();
    repo.addToCart(cartId, 'milk_toned_1l', 1);
    const quote = commitQuote(repo, cartId, 300);
    const { grant } = approveQuote(repo, quote.quoteId);

    const result = await new ExecutionGuard(repo, new RazorpayAdapter()).execute(grant.grantId);
    expect(result.order.id).toMatch(/^order_/);
    expect(result.order.amount).toBe(quote.amount);
    expect(result.order.currency).toBe(quote.currency);

    const execution = repo.getExecution(grant.grantId);
    const payment = execution?.orderId ? repo.getPaymentRecord(execution.orderId) : null;
    expect(execution?.state).toBe('ORDER_CREATED');
    expect(payment?.state).toBe('ORDER_CREATED');
  }, 30_000);
});
