import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MerchantRepository } from '@vac/merchant-core';
import { approveQuote, commitQuote } from '@vac/quote-integrity';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function makeRepo() { const dir = mkdtempSync(join(tmpdir(), 'ae-approval-')); dirs.push(dir); return new MerchantRepository(join(dir, 'test.sqlite')); }

function quote(repo: MerchantRepository) {
  const cart = repo.createCart();
  repo.addToCart(cart, 'milk_1l', 1);
  return commitQuote(repo, cart, 300);
}

describe('quote approval boundary', () => {
  it('refuses to approve an expired committed quote', () => {
    const repo = makeRepo();
    const committed = quote(repo);
    repo.db.prepare('UPDATE quotes SET valid_until=? WHERE quote_id=?').run(new Date(0).toISOString(), committed.quoteId);
    expect(() => approveQuote(repo, committed.quoteId)).toThrowError(expect.objectContaining({ code: 'QUOTE_EXPIRED' }));
  });

  it('refuses to approve a quote whose merchant signature was changed', () => {
    const repo = makeRepo();
    const committed = quote(repo);
    repo.db.prepare("UPDATE quotes SET merchant_signature='tampered' WHERE quote_id=?").run(committed.quoteId);
    expect(() => approveQuote(repo, committed.quoteId)).toThrowError(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
  });

  it('creates an approval and grant bound to the exact committed fields', () => {
    const repo = makeRepo();
    const committed = quote(repo);
    const { approval, grant } = approveQuote(repo, committed.quoteId);
    expect(approval).toMatchObject({ quoteId: committed.quoteId, cartDigest: committed.cartDigest, amount: committed.amount, currency: committed.currency, expiresAt: committed.validUntil });
    expect(grant).toMatchObject({ quoteId: committed.quoteId, approvalId: approval.approvalId, cartDigest: committed.cartDigest, amount: committed.amount, currency: committed.currency, expiresAt: committed.validUntil });
  });
});
