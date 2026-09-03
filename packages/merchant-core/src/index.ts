import type Database from 'better-sqlite3';
import { appendAudit, listAudit } from '@vac/audit';
import type { AgentTaskState, Approval, ExecutionGrant, Quote } from '@vac/shared';
import { openDatabase, SEED_PRODUCTS, MERCHANT_ID } from './db.js';
import * as commerce from './commerce.js';
import * as sec from './security-state.js';

export class MerchantRepository {
  readonly db: Database.Database;
  constructor(path?: string) { this.db = openDatabase(path); }

  appendAudit = (type: string, data: Record<string, unknown>) => appendAudit(this.db, type, data);
  audit = (limit = 200) => listAudit(this.db, limit);

  reset() {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM cart_items;DELETE FROM carts;DELETE FROM quotes;DELETE FROM approvals;DELETE FROM grants;DELETE FROM executions;DELETE FROM used_nonces;DELETE FROM payment_records;DELETE FROM agent_sessions;DELETE FROM audit_events;DELETE FROM products;');
      const insert = this.db.prepare('INSERT INTO products(id,name,category,price,inventory,active) VALUES(@id,@name,@category,@price,@inventory,@active)');
      SEED_PRODUCTS.forEach(product => insert.run({ ...product, active: product.active ? 1 : 0 }));
      this.db.prepare('UPDATE merchant_state SET discount=3500,delivery=2500,tax=0 WHERE merchant_id=?').run(MERCHANT_ID);
    })();
    appendAudit(this.db, 'MERCHANT_RESET', {});
  }

  merchantState = () => commerce.merchantState(this.db);
  listProducts = () => commerce.listProducts(this.db);
  searchProducts = (query: string) => commerce.searchProducts(this.db, query);
  getProduct = (id: string) => commerce.getProduct(this.db, id);
  createCart = () => commerce.createCart(this.db);
  addToCart = (cartId: string, productId: string, quantity: number) => commerce.addToCart(this.db, cartId, productId, quantity);
  updateQuantity = (cartId: string, productId: string, quantity: number) => commerce.updateQuantity(this.db, cartId, productId, quantity);
  removeFromCart = (cartId: string, productId: string) => commerce.removeFromCart(this.db, cartId, productId);
  getCartSnapshot = (cartId: string) => commerce.getCartSnapshot(this.db, cartId);
  setProductPrice = (id: string, price: number) => commerce.setProductPrice(this.db, id, price);
  setInventory = (id: string, inventory: number) => commerce.setInventory(this.db, id, inventory);
  setProductActive = (id: string, active: boolean) => commerce.setProductActive(this.db, id, active);
  setDiscount = (discount: number) => commerce.setDiscount(this.db, discount);
  setDelivery = (delivery: number) => commerce.setDelivery(this.db, delivery);

  saveQuote = (quote: Quote) => sec.saveQuote(this.db, quote);
  getQuote = (id: string) => sec.getQuote(this.db, id);
  saveApproval = (approval: Approval) => sec.saveApproval(this.db, approval);
  getApproval = (id: string) => sec.getApproval(this.db, id);
  saveGrant = (grant: ExecutionGrant) => sec.saveGrant(this.db, grant);
  getGrant = (id: string) => sec.getGrant(this.db, id);
  markGrantUsed = (id: string, at: string) => sec.markGrantUsed(this.db, id, at);
  claimExecution = (id: string) => sec.claimExecution(this.db, id);
  claimNonce = (nonce: string, grantId: string) => sec.claimNonce(this.db, nonce, grantId);
  getExecution = (id: string) => sec.getExecution(this.db, id);
  saveExecution = (id: string, state: string, orderId: string | null, result: unknown) => sec.saveExecution(this.db, id, state, orderId, result);
  savePaymentRecord = (orderId: string, grantId: string, state: string, payload: unknown, paymentId?: string, verified = false) => sec.savePaymentRecord(this.db, orderId, grantId, state, payload, paymentId, verified);
  getPaymentRecord = (orderId: string) => sec.getPaymentRecord(this.db, orderId);
  createSession = (state: AgentTaskState, messages: unknown[]) => sec.createSession(this.db, state, messages);
  getSession = (id: string) => sec.getSession(this.db, id);
  saveSession = (state: AgentTaskState, messages: unknown[]) => sec.saveSession(this.db, state, messages);

  markSessionPaymentComplete(grantId: string, orderId: string) {
    const rows = this.db.prepare('SELECT state_json,messages_json FROM agent_sessions').all() as Array<{ state_json: string; messages_json: string }>;
    for (const row of rows) {
      const state = JSON.parse(row.state_json) as AgentTaskState;
      if (state.activeGrantId === grantId) {
        state.phase = 'PAYMENT_COMPLETE';
        state.lastPaymentOrderId = orderId;
        this.saveSession(state, JSON.parse(row.messages_json));
      }
    }
  }
}
