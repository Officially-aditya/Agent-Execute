import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RazorpayAdapter } from '@vac/razorpay';

describe('Razorpay checkout verification', () => {
  it('accepts only the server-verifiable order|payment HMAC', () => {
    const secret = 'test_secret_only';
    const adapter = new RazorpayAdapter('rzp_test_public', secret);
    const orderId = 'order_test_123';
    const paymentId = 'pay_test_456';
    const signature = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
    expect(adapter.verifyCheckoutSignature(orderId, paymentId, signature)).toBe(true);
    expect(adapter.verifyCheckoutSignature(orderId, 'pay_tampered', signature)).toBe(false);
  });
});
