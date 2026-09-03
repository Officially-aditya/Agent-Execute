export type Currency = 'INR';

export type Product = {
  id: string;
  name: string;
  category: string;
  price: number;
  inventory: number;
  active: boolean;
};

export type CartLine = {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

export type CartSnapshot = {
  merchantId: string;
  cartId: string;
  revision: number;
  currency: Currency;
  items: CartLine[];
  subtotal: number;
  discount: number;
  delivery: number;
  tax: number;
  total: number;
};

export type Quote = {
  quoteId: string;
  merchantId: string;
  cartId: string;
  cartRevision: number;
  amount: number;
  currency: Currency;
  cartDigest: string;
  issuedAt: string;
  validUntil: string;
  nonce: string;
  merchantSignature: string;
};

export type Approval = {
  approvalId: string;
  quoteId: string;
  cartDigest: string;
  amount: number;
  currency: Currency;
  expiresAt: string;
  createdAt: string;
};

export type ExecutionGrant = {
  grantId: string;
  quoteId: string;
  approvalId: string;
  cartDigest: string;
  amount: number;
  currency: Currency;
  expiresAt: string;
  nonce: string;
};

export type AgentObjective = {
  originalRequest: string;
  maximumAmount?: number;
  currency: Currency;
  requiredItems: string[];
  preferences: string[];
};

export type AgentTaskState = {
  sessionId: string;
  objective: AgentObjective;
  cartId?: string;
  activeQuoteId?: string;
  activeGrantId?: string;
  lastPaymentOrderId?: string;
  phase: 'SHOPPING' | 'AWAITING_APPROVAL' | 'APPROVED' | 'PAYMENT_READY' | 'PAYMENT_COMPLETE';
  createdAt: string;
  updatedAt: string;
};

export type AgentEvent = {
  type: 'model' | 'model_delta' | 'tool_call' | 'tool_result' | 'state';
  at: string;
  text?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  state?: AgentTaskState;
};

export const ERROR_CODES = [
  'QUOTE_CHANGED',
  'QUOTE_EXPIRED',
  'APPROVAL_EXPIRED',
  'INVALID_SIGNATURE',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'MERCHANT_MISMATCH',
  'STALE_CART',
  'REPLAY_ATTEMPT',
  'GRANT_ALREADY_USED',
  'PAYMENT_FAILED',
  'PAYMENT_VERIFICATION_FAILED',
  'RAZORPAY_NOT_CONFIGURED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }

  toJSON() {
    return { error: this.code, message: this.message, ...this.details };
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
