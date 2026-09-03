import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MerchantRepository } from '@vac/merchant-core';
import { approveQuote, commitQuote } from '@vac/quote-integrity';
import { ExecutionGuard } from '@vac/execution-guard';
import type { CreateVerifiedOrderInput, PaymentRail } from '@vac/razorpay';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function makeRepo() { const dir = mkdtempSync(join(tmpdir(), 'ae-mut-')); dirs.push(dir); return new MerchantRepository(join(dir, 'test.sqlite')); }
class Rail implements PaymentRail { calls = 0; async createOrder(input: CreateVerifiedOrderInput) { this.calls++; return { id: 'order_unexpected', amount: input.amount, currency: input.currency }; } }

async function expectBlocked(mutate: (repo: MerchantRepository, cartId: string) => void) {
  const repo = makeRepo();
  const cart = repo.createCart();
  repo.addToCart(cart, 'milk_1l', 1);
  const quote = commitQuote(repo, cart, 300);
  const { grant } = approveQuote(repo, quote.quoteId);
  mutate(repo, cart);
  const rail = new Rail();
  await expect(new ExecutionGuard(repo, rail).execute(grant.grantId)).rejects.toMatchObject({ code: expect.stringMatching(/QUOTE_CHANGED|STALE_CART/) });
  expect(rail.calls).toBe(0);
}

describe('financially meaningful merchant mutations', () => {
  it('blocks a discount mutation', () => expectBlocked((repo) => repo.setDiscount(0)));
  it('blocks a delivery fee mutation', () => expectBlocked((repo) => repo.setDelivery(9900)));
  it('blocks an inventory mutation that invalidates the cart', () => expectBlocked((repo) => repo.setInventory('milk_1l', 0)));
});
