import { describe, expect, it } from 'vitest';
import { canonicalizeCart, digestCart, normalizePem } from '@vac/quote-integrity';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { CartSnapshot } from '@vac/shared';
const base: CartSnapshot = { merchantId:'merchant_demo',cartId:'cart_1',revision:4,currency:'INR',items:[{productId:'b',name:'B',quantity:1,unitPrice:200,lineTotal:200},{productId:'a',name:'A',quantity:2,unitPrice:100,lineTotal:200}],subtotal:400,discount:0,delivery:20,tax:0,total:420 };
describe('cart commitment',()=>{it('is deterministic regardless of input item order',()=>{const reordered={...base,items:[...base.items].reverse()};expect(canonicalizeCart(base)).toBe(canonicalizeCart(reordered));expect(digestCart(base)).toBe(digestCart(reordered))});it('changes if one paise changes',()=>{expect(digestCart({...base,total:421})).not.toBe(digestCart(base))})});

describe('PEM normalizer', () => {
  it('handles quotes, escaped newlines, and dirty environment formatting without OpenSSL decoder errors', () => {
    const rawPrivWithQuotes = '"-----BEGIN PRIVATE KEY-----\\nMC4CAQAwBQYDK2VwBCIEIJQMEES6pV9IB9A10KndeVa5arXMIhUSVWFE4Mn16Pqq\\n-----END PRIVATE KEY-----\\n"';
    const rawPubWithQuotes = '"-----BEGIN PUBLIC KEY-----\\nMCowBQYDK2VwAyEABGr9I7msT48f/cVu71hL8WnNWJMbl8BloLkvJZ5Cj/0=\\n-----END PUBLIC KEY-----\\n"';
    const normPriv = normalizePem(rawPrivWithQuotes, 'PRIVATE KEY');
    const normPub = normalizePem(rawPubWithQuotes, 'PUBLIC KEY');
    expect(normPriv).toContain('-----BEGIN PRIVATE KEY-----');
    expect(normPriv).not.toContain('"');
    expect(normPub).not.toContain('"');

    const priv = createPrivateKey(normPriv);
    const pub = createPublicKey(normPub);
    const data = Buffer.from('test quote');
    const signature = sign(null, data, priv);
    expect(verify(null, data, pub, signature)).toBe(true);
  });
});
