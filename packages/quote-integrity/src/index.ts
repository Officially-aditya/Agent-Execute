import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Approval, CartSnapshot, ExecutionGrant, Quote } from '@vac/shared';
import { DomainError, nowIso } from '@vac/shared';
import type { MerchantRepository } from '@vac/merchant-core';

export function canonicalizeCart(snapshot: CartSnapshot): string {
  const lines = [
    `merchant=${snapshot.merchantId}`,
    `cart=${snapshot.cartId}`,
    `revision=${snapshot.revision}`,
    `currency=${snapshot.currency}`,
    ...[...snapshot.items]
      .sort((a, b) => a.productId.localeCompare(b.productId))
      .map(i => `item=${i.productId}:${i.quantity}:${i.unitPrice}:${i.lineTotal}`),
    `subtotal=${snapshot.subtotal}`,
    `discount=${snapshot.discount}`,
    `delivery=${snapshot.delivery}`,
    `tax=${snapshot.tax}`,
    `total=${snapshot.total}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function digestCart(snapshot: CartSnapshot): string {
  return `sha256:${createHash('sha256').update(canonicalizeCart(snapshot), 'utf8').digest('hex')}`;
}

export type MerchantKeys = { privateKey: string; publicKey: string };
const privatePath = () => resolve(process.cwd(), '.data/merchant-private.pem');
const publicPath = () => resolve(process.cwd(), '.data/merchant-public.pem');

export function loadOrCreateMerchantKeys(): MerchantKeys {
  const envPrivate = process.env.MERCHANT_SIGNING_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const envPublic = process.env.MERCHANT_SIGNING_PUBLIC_KEY?.replace(/\\n/g, '\n');
  if (envPrivate && envPublic) return { privateKey: envPrivate, publicKey: envPublic };

  const derivePublic = (privateKey: string) => createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const readWinner = (): MerchantKeys => {
    const privateKey = readFileSync(privatePath(), 'utf8');
    const publicKey = derivePublic(privateKey);
    if (!existsSync(publicPath()) || readFileSync(publicPath(), 'utf8') !== publicKey) {
      writeFileSync(publicPath(), publicKey, { mode: 0o644 });
    }
    return { privateKey, publicKey };
  };

  mkdirSync(dirname(privatePath()), { recursive: true });
  if (existsSync(privatePath())) return readWinner();

  const pair = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  try {
    writeFileSync(privatePath(), pair.privateKey, { mode: 0o600, flag: 'wx' });
    writeFileSync(publicPath(), pair.publicKey, { mode: 0o644 });
    return { privateKey: pair.privateKey, publicKey: pair.publicKey };
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    return readWinner();
  }
}

function signingPayload(quote: Pick<Quote, 'quoteId'|'merchantId'|'cartDigest'|'amount'|'currency'|'validUntil'|'nonce'>): string {
  return JSON.stringify({ quote_id: quote.quoteId, merchant_id: quote.merchantId, cart_digest: quote.cartDigest, amount: quote.amount, currency: quote.currency, valid_until: quote.validUntil, nonce: quote.nonce });
}
export function signQuotePayload(quote: Pick<Quote, 'quoteId'|'merchantId'|'cartDigest'|'amount'|'currency'|'validUntil'|'nonce'>, privateKey: string): string { return sign(null, Buffer.from(signingPayload(quote)), privateKey).toString('base64url'); }
export function verifyQuoteSignature(quote: Quote, publicKey: string): boolean { return verify(null, Buffer.from(signingPayload(quote)), publicKey, Buffer.from(quote.merchantSignature, 'base64url')); }

export function commitQuote(repo: MerchantRepository, cartId: string, ttlSeconds = Number(process.env.QUOTE_TTL_SECONDS || 60)): Quote {
  const snapshot = repo.getCartSnapshot(cartId);
  if (snapshot.items.length === 0) throw new DomainError('STALE_CART', 'Cannot commit an empty cart', { cart_id: cartId });
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new DomainError('QUOTE_EXPIRED', 'Quote TTL must be positive');
  const issuedAt = nowIso();
  const validUntil = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const base = { quoteId: `quote_${randomUUID()}`, merchantId: snapshot.merchantId, cartId: snapshot.cartId, cartRevision: snapshot.revision, amount: snapshot.total, currency: snapshot.currency, cartDigest: digestCart(snapshot), issuedAt, validUntil, nonce: randomUUID() };
  const keys = loadOrCreateMerchantKeys();
  const quote: Quote = { ...base, merchantSignature: signQuotePayload(base, keys.privateKey) };
  repo.saveQuote(quote);
  return quote;
}

export function approveQuote(repo: MerchantRepository, quoteId: string): { approval: Approval; grant: ExecutionGrant } {
  const quote = repo.getQuote(quoteId);
  if (!quote) throw new DomainError('REPLAY_ATTEMPT', 'Committed quote does not exist', { quote_id: quoteId });
  if (Date.parse(quote.validUntil) <= Date.now()) throw new DomainError('QUOTE_EXPIRED', 'Committed quote expired', { quote_id: quoteId, valid_until: quote.validUntil });
  const { publicKey } = loadOrCreateMerchantKeys();
  if (!verifyQuoteSignature(quote, publicKey)) throw new DomainError('INVALID_SIGNATURE', 'Merchant quote signature is invalid', { quote_id: quoteId });
  const createdAt = nowIso();
  const approval: Approval = { approvalId: `approval_${randomUUID()}`, quoteId: quote.quoteId, cartDigest: quote.cartDigest, amount: quote.amount, currency: quote.currency, expiresAt: quote.validUntil, createdAt };
  const grant: ExecutionGrant = { grantId: `grant_${randomUUID()}`, quoteId: quote.quoteId, approvalId: approval.approvalId, cartDigest: quote.cartDigest, amount: quote.amount, currency: quote.currency, expiresAt: quote.validUntil, nonce: randomUUID() };
  repo.saveApproval(approval);
  repo.saveGrant(grant);
  return { approval, grant };
}
