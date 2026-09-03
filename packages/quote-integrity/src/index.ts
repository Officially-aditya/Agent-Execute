import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Approval, CartSnapshot, ExecutionGrant, Quote } from '../../shared/src/index.js';
import { DomainError, nowIso } from '../../shared/src/index.js';
import type { MerchantRepository } from '../../merchant-core/src/index.js';

type MaybePromise<T> = T | Promise<T>;
export type AsyncQuoteRepository = {
  getCartSnapshot(cartId: string): MaybePromise<CartSnapshot>;
  saveQuote(quote: Quote): MaybePromise<unknown>;
  getQuote(quoteId: string): MaybePromise<Quote | null>;
  saveApproval(approval: Approval): MaybePromise<unknown>;
  saveGrant(grant: ExecutionGrant): MaybePromise<unknown>;
  saveApprovalAndGrant?: (approval: Approval, grant: ExecutionGrant) => MaybePromise<unknown>;
};

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
const keyDir = () => resolve(process.cwd(), process.env.MERCHANT_KEY_DIR || '.data');
const privatePath = () => resolve(keyDir(), 'merchant-private.pem');
const publicPath = () => resolve(keyDir(), 'merchant-public.pem');

export function loadOrCreateMerchantKeys(): MerchantKeys {
  const envPrivate = process.env.MERCHANT_SIGNING_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const envPublic = process.env.MERCHANT_SIGNING_PUBLIC_KEY?.replace(/\\n/g, '\n');
  if (envPrivate && envPublic) return { privateKey: envPrivate, publicKey: envPublic };
  if (process.env.VERCEL) {
    throw new Error('MERCHANT_SIGNING_PRIVATE_KEY and MERCHANT_SIGNING_PUBLIC_KEY are required on Vercel. Generate them once with npm run setup and add both as Vercel environment variables.');
  }

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

function createQuote(snapshot: CartSnapshot, ttlSeconds: number): Quote {
  if (snapshot.items.length === 0) throw new DomainError('STALE_CART', 'Cannot commit an empty cart', { cart_id: snapshot.cartId });
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new DomainError('QUOTE_EXPIRED', 'Quote TTL must be positive');
  const issuedAt = nowIso();
  const validUntil = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const base = { quoteId: `quote_${randomUUID()}`, merchantId: snapshot.merchantId, cartId: snapshot.cartId, cartRevision: snapshot.revision, amount: snapshot.total, currency: snapshot.currency, cartDigest: digestCart(snapshot), issuedAt, validUntil, nonce: randomUUID() };
  const keys = loadOrCreateMerchantKeys();
  return { ...base, merchantSignature: signQuotePayload(base, keys.privateKey) };
}

function createApprovalAndGrant(quote: Quote): { approval: Approval; grant: ExecutionGrant } {
  if (Date.parse(quote.validUntil) <= Date.now()) throw new DomainError('QUOTE_EXPIRED', 'Committed quote expired', { quote_id: quote.quoteId, valid_until: quote.validUntil });
  const { publicKey } = loadOrCreateMerchantKeys();
  if (!verifyQuoteSignature(quote, publicKey)) throw new DomainError('INVALID_SIGNATURE', 'Merchant quote signature is invalid', { quote_id: quote.quoteId });
  const createdAt = nowIso();
  const approval: Approval = { approvalId: `approval_${randomUUID()}`, quoteId: quote.quoteId, cartDigest: quote.cartDigest, amount: quote.amount, currency: quote.currency, expiresAt: quote.validUntil, createdAt };
  const grant: ExecutionGrant = { grantId: `grant_${randomUUID()}`, quoteId: quote.quoteId, approvalId: approval.approvalId, cartDigest: quote.cartDigest, amount: quote.amount, currency: quote.currency, expiresAt: quote.validUntil, nonce: randomUUID() };
  return { approval, grant };
}

export function commitQuote(repo: MerchantRepository, cartId: string, ttlSeconds = Number(process.env.QUOTE_TTL_SECONDS || 60)): Quote {
  const quote = createQuote(repo.getCartSnapshot(cartId), ttlSeconds);
  repo.saveQuote(quote);
  return quote;
}

export async function commitQuoteAsync(repo: AsyncQuoteRepository, cartId: string, ttlSeconds = Number(process.env.QUOTE_TTL_SECONDS || 60)): Promise<Quote> {
  const snapshot = await repo.getCartSnapshot(cartId);
  const quote = createQuote(snapshot, ttlSeconds);
  await repo.saveQuote(quote);
  return quote;
}

export function approveQuote(repo: MerchantRepository, quoteId: string): { approval: Approval; grant: ExecutionGrant } {
  const quote = repo.getQuote(quoteId);
  if (!quote) throw new DomainError('REPLAY_ATTEMPT', 'Committed quote does not exist', { quote_id: quoteId });
  const result = createApprovalAndGrant(quote);
  repo.saveApproval(result.approval);
  repo.saveGrant(result.grant);
  return result;
}

export async function approveQuoteAsync(repo: AsyncQuoteRepository, quoteId: string): Promise<{ approval: Approval; grant: ExecutionGrant }> {
  const quote = await repo.getQuote(quoteId);
  if (!quote) throw new DomainError('REPLAY_ATTEMPT', 'Committed quote does not exist', { quote_id: quoteId });
  const result = createApprovalAndGrant(quote);
  if (repo.saveApprovalAndGrant) await repo.saveApprovalAndGrant(result.approval, result.grant);
  else {
    await repo.saveApproval(result.approval);
    await repo.saveGrant(result.grant);
  }
  return result;
}
