import { describe, expect, it } from 'vitest';
import { canonicalizeCart, digestCart } from '@vac/quote-integrity';
import type { CartSnapshot } from '@vac/shared';
const base: CartSnapshot = { merchantId:'merchant_demo',cartId:'cart_1',revision:4,currency:'INR',items:[{productId:'b',name:'B',quantity:1,unitPrice:200,lineTotal:200},{productId:'a',name:'A',quantity:2,unitPrice:100,lineTotal:200}],subtotal:400,discount:0,delivery:20,tax:0,total:420 };
describe('cart commitment',()=>{it('is deterministic regardless of input item order',()=>{const reordered={...base,items:[...base.items].reverse()};expect(canonicalizeCart(base)).toBe(canonicalizeCart(reordered));expect(digestCart(base)).toBe(digestCart(reordered))});it('changes if one paise changes',()=>{expect(digestCart({...base,total:421})).not.toBe(digestCart(base))})});
