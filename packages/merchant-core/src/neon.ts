import { Pool } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { DomainError, nowIso, type AgentTaskState, type Approval, type CartSnapshot, type ExecutionGrant, type Product, type Quote } from '@vac/shared';
import { CURRENCY, MERCHANT_ID, SEED_PRODUCTS } from './catalog.js';

export type AuditEvent = { id: string; type: string; at: string; data: Record<string, unknown> };
type Queryable = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };

type ExecutionRecord = { grantId: string; state: string; orderId: string | null; result: any; updatedAt: string };
type PaymentRecord = { orderId: string; grantId: string; paymentId: string | null; state: string; signatureVerified: boolean; payload: any; updatedAt: string };

function connectionString(): string {
  const candidates = [process.env.NEON_DATABASE_URL, process.env.DATABASE_URL, process.env.POSTGRES_URL];
  const value = candidates.find((candidate) => candidate?.startsWith('postgres://') || candidate?.startsWith('postgresql://'));
  if (!value) throw new Error('Neon PostgreSQL is not configured. Set DATABASE_URL (or NEON_DATABASE_URL) to the Neon connection string.');
  return value;
}

export function hasNeonDatabase(): boolean {
  return [process.env.NEON_DATABASE_URL, process.env.DATABASE_URL, process.env.POSTGRES_URL]
    .some((candidate) => candidate?.startsWith('postgres://') || candidate?.startsWith('postgresql://'));
}

function jsonValue(value: unknown): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function mapProduct(row: any): Product {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    price: Number(row.price),
    inventory: Number(row.inventory),
    active: Boolean(row.active),
  };
}

function mapQuote(row: any): Quote {
  return {
    quoteId: row.quote_id,
    merchantId: row.merchant_id,
    cartId: row.cart_id,
    cartRevision: Number(row.cart_revision),
    amount: Number(row.amount),
    currency: row.currency,
    cartDigest: row.cart_digest,
    issuedAt: row.issued_at,
    validUntil: row.valid_until,
    nonce: row.nonce,
    merchantSignature: row.merchant_signature,
  };
}

async function withTransaction<T>(pool: Pool, fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client as unknown as Queryable);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function appendAuditWith(db: Queryable, type: string, data: Record<string, unknown>): Promise<AuditEvent> {
  const event: AuditEvent = { id: randomUUID(), type, at: nowIso(), data };
  await db.query(
    'INSERT INTO audit_events(id,type,at,data_json) VALUES($1,$2,$3,$4::jsonb)',
    [event.id, event.type, event.at, JSON.stringify(event.data)],
  );
  return event;
}

async function getProductWith(db: Queryable, id: string): Promise<Product | null> {
  const { rows } = await db.query('SELECT id,name,category,price,inventory,active FROM products WHERE id=$1', [id]);
  return rows[0] ? mapProduct(rows[0]) : null;
}

async function getCartSnapshotWith(db: Queryable, cartId: string): Promise<CartSnapshot> {
  const cartResult = await db.query('SELECT id,revision FROM carts WHERE id=$1', [cartId]);
  const cart = cartResult.rows[0];
  if (!cart) throw new Error('cart not found');

  const { rows } = await db.query(
    'SELECT p.id AS product_id,p.name,ci.quantity,p.price AS unit_price,p.inventory,p.active FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.cart_id=$1 ORDER BY p.id',
    [cartId],
  );
  for (const row of rows) {
    if (!row.active || Number(row.quantity) > Number(row.inventory)) {
      throw new DomainError('STALE_CART', 'Cart contains unavailable inventory', { product_id: row.product_id });
    }
  }
  const items = rows.map((row) => ({
    productId: row.product_id,
    name: row.name,
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    lineTotal: Number(row.unit_price) * Number(row.quantity),
  }));
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const stateResult = await db.query('SELECT discount,delivery,tax FROM merchant_state WHERE merchant_id=$1', [MERCHANT_ID]);
  const state = stateResult.rows[0];
  if (!state) throw new Error('merchant state not found');
  const discount = Math.min(Number(state.discount), subtotal);
  const delivery = items.length ? Number(state.delivery) : 0;
  const tax = Number(state.tax);
  const total = Math.max(0, subtotal - discount + delivery + tax);
  return {
    merchantId: MERCHANT_ID,
    cartId,
    revision: Number(cart.revision),
    currency: CURRENCY,
    items,
    subtotal,
    discount,
    delivery,
    tax,
    total,
  };
}

async function bumpAffected(db: Queryable, productId?: string): Promise<void> {
  if (productId) {
    await db.query('UPDATE carts SET revision=revision+1 WHERE id IN (SELECT cart_id FROM cart_items WHERE product_id=$1)', [productId]);
  } else {
    await db.query('UPDATE carts SET revision=revision+1 WHERE EXISTS (SELECT 1 FROM cart_items WHERE cart_id=carts.id)');
  }
}

async function initialize(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS products(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        price INTEGER NOT NULL CHECK(price>=0),
        inventory INTEGER NOT NULL CHECK(inventory>=0),
        active BOOLEAN NOT NULL DEFAULT TRUE
      );
      CREATE TABLE IF NOT EXISTS merchant_state(
        merchant_id TEXT PRIMARY KEY,
        discount INTEGER NOT NULL DEFAULT 3500,
        delivery INTEGER NOT NULL DEFAULT 2500,
        tax INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS carts(
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cart_items(
        cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL REFERENCES products(id),
        quantity INTEGER NOT NULL CHECK(quantity>0),
        PRIMARY KEY(cart_id,product_id)
      );
      CREATE TABLE IF NOT EXISTS quotes(
        quote_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        cart_id TEXT NOT NULL,
        cart_revision INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        cart_digest TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        nonce TEXT NOT NULL UNIQUE,
        merchant_signature TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals(
        approval_id TEXT PRIMARY KEY,
        quote_id TEXT NOT NULL,
        cart_digest TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS grants(
        grant_id TEXT PRIMARY KEY,
        quote_id TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        cart_digest TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        nonce TEXT NOT NULL UNIQUE,
        used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS executions(
        grant_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        order_id TEXT,
        result_json JSONB,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS used_nonces(
        nonce TEXT PRIMARY KEY,
        used_at TEXT NOT NULL,
        grant_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payment_records(
        order_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        payment_id TEXT,
        state TEXT NOT NULL,
        signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
        payload_json JSONB,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_sessions(
        session_id TEXT PRIMARY KEY,
        state_json JSONB NOT NULL,
        messages_json JSONB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events(
        seq BIGSERIAL UNIQUE,
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        data_json JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quotes_cart ON quotes(cart_id);
      CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(type);
      CREATE INDEX IF NOT EXISTS idx_sessions_grant ON agent_sessions ((state_json->>'activeGrantId'));
    `);

    for (const product of SEED_PRODUCTS) {
      await client.query(
        'INSERT INTO products(id,name,category,price,inventory,active) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',
        [product.id, product.name, product.category, product.price, product.inventory, product.active],
      );
    }
    await client.query(
      'INSERT INTO merchant_state(merchant_id,discount,delivery,tax) VALUES($1,3500,2500,0) ON CONFLICT(merchant_id) DO NOTHING',
      [MERCHANT_ID],
    );
  });
}

export class NeonMerchantRepository {
  readonly pool: Pool;
  private readonly readyPromise: Promise<void>;

  constructor(url = connectionString()) {
    this.pool = new Pool({ connectionString: url });
    this.readyPromise = initialize(this.pool);
  }

  private async ready(): Promise<void> { await this.readyPromise; }

  async appendAudit(type: string, data: Record<string, unknown>): Promise<AuditEvent> {
    await this.ready();
    return appendAuditWith(this.pool as unknown as Queryable, type, data);
  }

  async audit(limit = 200): Promise<AuditEvent[]> {
    await this.ready();
    const { rows } = await this.pool.query('SELECT id,type,at,data_json FROM audit_events ORDER BY seq DESC LIMIT $1', [limit]);
    return rows.map((row) => ({ id: row.id, type: row.type, at: row.at, data: jsonValue(row.data_json) }));
  }

  async reset(): Promise<void> {
    await this.ready();
    await withTransaction(this.pool, async (client) => {
      await client.query('TRUNCATE TABLE cart_items,carts,quotes,approvals,grants,executions,used_nonces,payment_records,agent_sessions,audit_events,products RESTART IDENTITY CASCADE');
      for (const product of SEED_PRODUCTS) {
        await client.query('INSERT INTO products(id,name,category,price,inventory,active) VALUES($1,$2,$3,$4,$5,$6)', [product.id, product.name, product.category, product.price, product.inventory, product.active]);
      }
      await client.query('UPDATE merchant_state SET discount=3500,delivery=2500,tax=0 WHERE merchant_id=$1', [MERCHANT_ID]);
      await appendAuditWith(client, 'MERCHANT_RESET', {});
    });
  }

  async merchantState() {
    await this.ready();
    const { rows } = await this.pool.query('SELECT merchant_id,discount,delivery,tax FROM merchant_state WHERE merchant_id=$1', [MERCHANT_ID]);
    const row = rows[0];
    return row ? { merchantId: row.merchant_id, discount: Number(row.discount), delivery: Number(row.delivery), tax: Number(row.tax) } : null;
  }

  async listProducts(): Promise<Product[]> {
    await this.ready();
    const { rows } = await this.pool.query('SELECT id,name,category,price,inventory,active FROM products ORDER BY category,name');
    return rows.map(mapProduct);
  }

  async searchProducts(query: string): Promise<Product[]> {
    await this.ready();
    const value = `%${query.trim().toLowerCase()}%`;
    const { rows } = await this.pool.query('SELECT id,name,category,price,inventory,active FROM products WHERE active=TRUE AND inventory>0 AND (lower(name) LIKE $1 OR lower(category) LIKE $1 OR lower(id) LIKE $1) ORDER BY price ASC LIMIT 20', [value]);
    return rows.map(mapProduct);
  }

  async getProduct(id: string): Promise<Product | null> {
    await this.ready();
    return getProductWith(this.pool as unknown as Queryable, id);
  }

  async createCart(): Promise<string> {
    await this.ready();
    const id = `cart_${randomUUID()}`;
    await withTransaction(this.pool, async (client) => {
      await client.query('INSERT INTO carts(id,revision,created_at) VALUES($1,0,$2)', [id, nowIso()]);
      await appendAuditWith(client, 'CART_CREATED', { cartId: id });
    });
    return id;
  }

  async addToCart(cartId: string, productId: string, quantity: number): Promise<CartSnapshot> {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('quantity must be a positive integer');
    await this.ready();
    return withTransaction(this.pool, async (client) => {
      const cart = await client.query('SELECT id FROM carts WHERE id=$1 FOR UPDATE', [cartId]);
      if (!cart.rows[0]) throw new Error('cart not found');
      const productResult = await client.query('SELECT id,name,category,price,inventory,active FROM products WHERE id=$1 FOR UPDATE', [productId]);
      const product = productResult.rows[0] ? mapProduct(productResult.rows[0]) : null;
      if (!product || !product.active) throw new Error('product not found');
      const old = await client.query('SELECT quantity FROM cart_items WHERE cart_id=$1 AND product_id=$2', [cartId, productId]);
      const next = Number(old.rows[0]?.quantity || 0) + quantity;
      if (next > product.inventory) throw new Error('insufficient inventory');
      await client.query('INSERT INTO cart_items(cart_id,product_id,quantity) VALUES($1,$2,$3) ON CONFLICT(cart_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity', [cartId, productId, next]);
      await client.query('UPDATE carts SET revision=revision+1 WHERE id=$1', [cartId]);
      await appendAuditWith(client, 'CART_UPDATED', { cartId, productId, quantity: next });
      return getCartSnapshotWith(client, cartId);
    });
  }

  async updateQuantity(cartId: string, productId: string, quantity: number): Promise<CartSnapshot> {
    if (!Number.isInteger(quantity) || quantity < 0) throw new Error('quantity must be non-negative integer');
    if (quantity === 0) return this.removeFromCart(cartId, productId);
    await this.ready();
    return withTransaction(this.pool, async (client) => {
      const cart = await client.query('SELECT id FROM carts WHERE id=$1 FOR UPDATE', [cartId]);
      if (!cart.rows[0]) throw new Error('cart not found');
      const productResult = await client.query('SELECT id,name,category,price,inventory,active FROM products WHERE id=$1 FOR UPDATE', [productId]);
      const product = productResult.rows[0] ? mapProduct(productResult.rows[0]) : null;
      if (!product || !product.active || quantity > product.inventory) throw new Error('product unavailable or insufficient inventory');
      const updated = await client.query('UPDATE cart_items SET quantity=$1 WHERE cart_id=$2 AND product_id=$3 RETURNING product_id', [quantity, cartId, productId]);
      if (!updated.rows[0]) throw new Error('product is not in cart');
      await client.query('UPDATE carts SET revision=revision+1 WHERE id=$1', [cartId]);
      await appendAuditWith(client, 'CART_UPDATED', { cartId, productId, quantity });
      return getCartSnapshotWith(client, cartId);
    });
  }

  async removeFromCart(cartId: string, productId: string): Promise<CartSnapshot> {
    await this.ready();
    return withTransaction(this.pool, async (client) => {
      const cart = await client.query('SELECT id FROM carts WHERE id=$1 FOR UPDATE', [cartId]);
      if (!cart.rows[0]) throw new Error('cart not found');
      const deleted = await client.query('DELETE FROM cart_items WHERE cart_id=$1 AND product_id=$2 RETURNING product_id', [cartId, productId]);
      if (deleted.rows[0]) {
        await client.query('UPDATE carts SET revision=revision+1 WHERE id=$1', [cartId]);
        await appendAuditWith(client, 'CART_UPDATED', { cartId, productId, removed: true });
      }
      return getCartSnapshotWith(client, cartId);
    });
  }

  async getCartSnapshot(cartId: string): Promise<CartSnapshot> {
    await this.ready();
    return getCartSnapshotWith(this.pool as unknown as Queryable, cartId);
  }

  async setProductPrice(id: string, price: number): Promise<void> {
    if (!Number.isInteger(price) || price < 0) throw new Error('price must be integer paise');
    await this.ready();
    await withTransaction(this.pool, async (client) => {
      const updated = await client.query('UPDATE products SET price=$1 WHERE id=$2 RETURNING id', [price, id]);
      if (!updated.rows[0]) throw new Error('product not found');
      await bumpAffected(client, id);
      await appendAuditWith(client, 'MERCHANT_STATE_CHANGED', { kind: 'PRICE', productId: id, price });
    });
  }

  async setInventory(id: string, inventory: number): Promise<void> {
    if (!Number.isInteger(inventory) || inventory < 0) throw new Error('inventory must be non-negative integer');
    await this.ready();
    await withTransaction(this.pool, async (client) => {
      const updated = await client.query('UPDATE products SET inventory=$1 WHERE id=$2 RETURNING id', [inventory, id]);
      if (!updated.rows[0]) throw new Error('product not found');
      await bumpAffected(client, id);
      await appendAuditWith(client, 'MERCHANT_STATE_CHANGED', { kind: 'INVENTORY', productId: id, inventory });
    });
  }

  async setProductActive(id: string, active: boolean): Promise<void> {
    await this.ready();
    await withTransaction(this.pool, async (client) => {
      const updated = await client.query('UPDATE products SET active=$1 WHERE id=$2 RETURNING id', [active, id]);
      if (!updated.rows[0]) throw new Error('product not found');
      await bumpAffected(client, id);
      await appendAuditWith(client, 'MERCHANT_STATE_CHANGED', { kind: 'AVAILABILITY', productId: id, active });
    });
  }

  async setDiscount(discount: number): Promise<void> {
    if (!Number.isInteger(discount) || discount < 0) throw new Error('discount must be non-negative integer paise');
    await this.ready();
    await withTransaction(this.pool, async (client) => {
      await client.query('UPDATE merchant_state SET discount=$1 WHERE merchant_id=$2', [discount, MERCHANT_ID]);
      await bumpAffected(client);
      await appendAuditWith(client, 'MERCHANT_STATE_CHANGED', { kind: 'DISCOUNT', discount });
    });
  }

  async setDelivery(delivery: number): Promise<void> {
    if (!Number.isInteger(delivery) || delivery < 0) throw new Error('delivery must be non-negative integer paise');
    await this.ready();
    await withTransaction(this.pool, async (client) => {
      await client.query('UPDATE merchant_state SET delivery=$1 WHERE merchant_id=$2', [delivery, MERCHANT_ID]);
      await bumpAffected(client);
      await appendAuditWith(client, 'MERCHANT_STATE_CHANGED', { kind: 'DELIVERY', delivery });
    });
  }

  async saveQuote(quote: Quote): Promise<void> {
    await this.ready();
    await withTransaction(this.pool, async (client) => {
      await client.query('INSERT INTO quotes(quote_id,merchant_id,cart_id,cart_revision,amount,currency,cart_digest,issued_at,valid_until,nonce,merchant_signature) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [quote.quoteId, quote.merchantId, quote.cartId, quote.cartRevision, quote.amount, quote.currency, quote.cartDigest, quote.issuedAt, quote.validUntil, quote.nonce, quote.merchantSignature]);
      await appendAuditWith(client, 'QUOTE_COMMITTED', { quoteId: quote.quoteId, cartId: quote.cartId, amount: quote.amount, revision: quote.cartRevision, digest: quote.cartDigest });
    });
  }

  async getQuote(id: string): Promise<Quote | null> {
    await this.ready();
    const { rows } = await this.pool.query('SELECT * FROM quotes WHERE quote_id=$1', [id]);
    return rows[0] ? mapQuote(rows[0]) : null;
  }

  async saveApproval(approval: Approval): Promise<void> {
    await this.ready();
    await this.pool.query('INSERT INTO approvals(approval_id,quote_id,cart_digest,amount,currency,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [approval.approvalId, approval.quoteId, approval.cartDigest, approval.amount, approval.currency, approval.expiresAt, approval.createdAt]);
    await this.appendAudit('QUOTE_APPROVED', { approvalId: approval.approvalId, quoteId: approval.quoteId, amount: approval.amount });
  }

  async saveGrant(grant: ExecutionGrant): Promise<void> {
    await this.ready();
    await this.pool.query('INSERT INTO grants(grant_id,quote_id,approval_id,cart_digest,amount,currency,expires_at,nonce,used_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)', [grant.grantId, grant.quoteId, grant.approvalId, grant.cartDigest, grant.amount, grant.currency, grant.expiresAt, grant.nonce]);
  }

  async saveApprovalAndGrant(approval: Approval, grant: ExecutionGrant): Promise<void> {
    await this.ready();
    await withTransaction(this.pool, async (client) => {
      await client.query('INSERT INTO approvals(approval_id,quote_id,cart_digest,amount,currency,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [approval.approvalId, approval.quoteId, approval.cartDigest, approval.amount, approval.currency, approval.expiresAt, approval.createdAt]);
      await client.query('INSERT INTO grants(grant_id,quote_id,approval_id,cart_digest,amount,currency,expires_at,nonce,used_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)', [grant.grantId, grant.quoteId, grant.approvalId, grant.cartDigest, grant.amount, grant.currency, grant.expiresAt, grant.nonce]);
      await appendAuditWith(client, 'QUOTE_APPROVED', { approvalId: approval.approvalId, quoteId: approval.quoteId, amount: approval.amount });
    });
  }

  async getApproval(id: string): Promise<Approval | null> {
    await this.ready();
    const { rows } = await this.pool.query('SELECT * FROM approvals WHERE approval_id=$1', [id]);
    const row = rows[0];
    return row ? { approvalId: row.approval_id, quoteId: row.quote_id, cartDigest: row.cart_digest, amount: Number(row.amount), currency: row.currency, expiresAt: row.expires_at, createdAt: row.created_at } : null;
  }

  async getGrant(id: string): Promise<(ExecutionGrant & { usedAt?: string }) | null> {
    await this.ready();
    const { rows } = await this.pool.query('SELECT * FROM grants WHERE grant_id=$1', [id]);
    const row = rows[0];
    return row ? { grantId: row.grant_id, quoteId: row.quote_id, approvalId: row.approval_id, cartDigest: row.cart_digest, amount: Number(row.amount), currency: row.currency, expiresAt: row.expires_at, nonce: row.nonce, usedAt: row.used_at || undefined } : null;
  }

  async markGrantUsed(id: string, at: string): Promise<void> {
    await this.ready();
    await this.pool.query('UPDATE grants SET used_at=$1 WHERE grant_id=$2 AND used_at IS NULL', [at, id]);
  }

  async getExecution(id: string): Promise<ExecutionRecord | null> {
    await this.ready();
    const { rows } = await this.pool.query('SELECT * FROM executions WHERE grant_id=$1', [id]);
    const row = rows[0];
    return row ? { grantId: row.grant_id, state: row.state, orderId: row.order_id, result: jsonValue(row.result_json), updatedAt: row.updated_at } : null;
  }

  async saveExecution(id: string, state: string, orderId: string | null, result: unknown): Promise<void> {
    await this.ready();
    await this.pool.query('INSERT INTO executions(grant_id,state,order_id,result_json,updated_at) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(grant_id) DO UPDATE SET state=EXCLUDED.state,order_id=EXCLUDED.order_id,result_json=EXCLUDED.result_json,updated_at=EXCLUDED.updated_at', [id, state, orderId, result == null ? null : JSON.stringify(result), nowIso()]);
  }

  async claimExecution(id: string): Promise<'CLAIMED' | 'EXISTING' | 'RETRYABLE'> {
    await this.ready();
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query("INSERT INTO executions(grant_id,state,order_id,result_json,updated_at) VALUES($1,'VERIFYING',NULL,NULL,$2) ON CONFLICT(grant_id) DO NOTHING RETURNING grant_id", [id, nowIso()]);
      if (inserted.rows[0]) return 'CLAIMED';
      const retry = await client.query("UPDATE executions SET state='VERIFYING',order_id=NULL,result_json=jsonb_build_object('retry_of',result_json),updated_at=$2 WHERE grant_id=$1 AND state='PAYMENT_FAILED' RETURNING grant_id", [id, nowIso()]);
      return retry.rows[0] ? 'RETRYABLE' : 'EXISTING';
    });
  }

  async claimNonce(nonce: string, grantId: string): Promise<boolean> {
    await this.ready();
    const inserted = await this.pool.query('INSERT INTO used_nonces(nonce,used_at,grant_id) VALUES($1,$2,$3) ON CONFLICT(nonce) DO NOTHING RETURNING grant_id', [nonce, nowIso(), grantId]);
    if (inserted.rows[0]) return true;
    const existing = await this.pool.query('SELECT grant_id FROM used_nonces WHERE nonce=$1', [nonce]);
    return existing.rows[0]?.grant_id === grantId;
  }

  async savePaymentRecord(orderId: string, grantId: string, state: string, payload: unknown, paymentId?: string, verified = false): Promise<void> {
    await this.ready();
    await this.pool.query('INSERT INTO payment_records(order_id,grant_id,payment_id,state,signature_verified,payload_json,updated_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(order_id) DO UPDATE SET payment_id=EXCLUDED.payment_id,state=EXCLUDED.state,signature_verified=EXCLUDED.signature_verified,payload_json=EXCLUDED.payload_json,updated_at=EXCLUDED.updated_at', [orderId, grantId, paymentId || null, state, verified, JSON.stringify(payload ?? {}), nowIso()]);
  }

  async getPaymentRecord(orderId: string): Promise<PaymentRecord | null> {
    await this.ready();
    const { rows } = await this.pool.query('SELECT * FROM payment_records WHERE order_id=$1', [orderId]);
    const row = rows[0];
    return row ? { orderId: row.order_id, grantId: row.grant_id, paymentId: row.payment_id, state: row.state, signatureVerified: Boolean(row.signature_verified), payload: jsonValue(row.payload_json), updatedAt: row.updated_at } : null;
  }

  async createSession(state: AgentTaskState, messages: unknown[]): Promise<void> {
    await this.ready();
    await this.pool.query('INSERT INTO agent_sessions(session_id,state_json,messages_json,created_at,updated_at) VALUES($1,$2::jsonb,$3::jsonb,$4,$5)', [state.sessionId, JSON.stringify(state), JSON.stringify(messages), state.createdAt, state.updatedAt]);
  }

  async getSession(id: string): Promise<{ state: AgentTaskState; messages: any[] } | null> {
    await this.ready();
    const { rows } = await this.pool.query('SELECT state_json,messages_json FROM agent_sessions WHERE session_id=$1', [id]);
    const row = rows[0];
    return row ? { state: jsonValue(row.state_json) as AgentTaskState, messages: jsonValue(row.messages_json) as any[] } : null;
  }

  async saveSession(state: AgentTaskState, messages: unknown[]): Promise<void> {
    await this.ready();
    state.updatedAt = nowIso();
    await this.pool.query('INSERT INTO agent_sessions(session_id,state_json,messages_json,created_at,updated_at) VALUES($1,$2::jsonb,$3::jsonb,$4,$5) ON CONFLICT(session_id) DO UPDATE SET state_json=EXCLUDED.state_json,messages_json=EXCLUDED.messages_json,updated_at=EXCLUDED.updated_at', [state.sessionId, JSON.stringify(state), JSON.stringify(messages), state.createdAt, state.updatedAt]);
  }

  async markSessionPaymentComplete(grantId: string, orderId: string): Promise<void> {
    await this.ready();
    const updatedAt = nowIso();
    await this.pool.query(`
      UPDATE agent_sessions
      SET state_json = jsonb_set(jsonb_set(state_json, '{phase}', '"PAYMENT_COMPLETE"'::jsonb, true), '{lastPaymentOrderId}', to_jsonb($2::text), true),
          updated_at = $3
      WHERE state_json->>'activeGrantId' = $1
    `, [grantId, orderId, updatedAt]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
