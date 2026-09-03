import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Product } from '@vac/shared';

export const MERCHANT_ID = 'merchant_demo';
export const CURRENCY = 'INR' as const;
export const SEED_PRODUCTS: Product[] = [
  { id:'milk_1l',name:'Full Cream Milk 1L',category:'dairy',price:7200,inventory:30,active:true },
  { id:'milk_toned_1l',name:'Toned Milk 1L',category:'dairy',price:6200,inventory:30,active:true },
  { id:'bread_white',name:'Classic White Bread',category:'bakery',price:4800,inventory:20,active:true },
  { id:'bread_wheat',name:'Whole Wheat Bread',category:'bakery',price:5800,inventory:20,active:true },
  { id:'eggs_6',name:'Farm Eggs 6 Pack',category:'breakfast',price:6500,inventory:24,active:true },
  { id:'eggs_12',name:'Farm Eggs 12 Pack',category:'breakfast',price:11000,inventory:16,active:true },
  { id:'cereal_basic',name:'Classic Cereal',category:'breakfast',price:23000,inventory:12,active:true },
  { id:'cereal_value',name:'Value Corn Flakes',category:'breakfast',price:16500,inventory:18,active:true },
  { id:'rice_1kg',name:'Everyday Rice 1kg',category:'staples',price:9800,inventory:25,active:true },
  { id:'coffee_100g',name:'Instant Coffee 100g',category:'beverages',price:14500,inventory:14,active:true },
  { id:'butter_100g',name:'Salted Butter 100g',category:'dairy',price:6200,inventory:18,active:true },
  { id:'juice_1l',name:'Orange Juice 1L',category:'beverages',price:9500,inventory:16,active:true },
  { id:'tea_250g',name:'Assam Tea 250g',category:'beverages',price:12500,inventory:15,active:true },
  { id:'biscuits_pack',name:'Tea Biscuits',category:'snacks',price:3500,inventory:40,active:true },
];

export function databasePath() { return resolve(process.cwd(), process.env.DATABASE_URL || '.data/agent-execute.sqlite'); }

export function openDatabase(path=databasePath()) {
  mkdirSync(dirname(path),{recursive:true});
  const db=new Database(path); db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); migrate(db); seed(db); return db;
}

function migrate(db:Database.Database){db.exec(`
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL,price INTEGER NOT NULL CHECK(price>=0),inventory INTEGER NOT NULL CHECK(inventory>=0),active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS merchant_state(merchant_id TEXT PRIMARY KEY,discount INTEGER NOT NULL DEFAULT 3500,delivery INTEGER NOT NULL DEFAULT 2500,tax INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS carts(id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cart_items(cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,product_id TEXT NOT NULL REFERENCES products(id),quantity INTEGER NOT NULL CHECK(quantity>0),PRIMARY KEY(cart_id,product_id));
CREATE TABLE IF NOT EXISTS quotes(quote_id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,cart_id TEXT NOT NULL,cart_revision INTEGER NOT NULL,amount INTEGER NOT NULL,currency TEXT NOT NULL,cart_digest TEXT NOT NULL,issued_at TEXT NOT NULL,valid_until TEXT NOT NULL,nonce TEXT NOT NULL UNIQUE,merchant_signature TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals(approval_id TEXT PRIMARY KEY,quote_id TEXT NOT NULL,cart_digest TEXT NOT NULL,amount INTEGER NOT NULL,currency TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grants(grant_id TEXT PRIMARY KEY,quote_id TEXT NOT NULL,approval_id TEXT NOT NULL,cart_digest TEXT NOT NULL,amount INTEGER NOT NULL,currency TEXT NOT NULL,expires_at TEXT NOT NULL,nonce TEXT NOT NULL UNIQUE,used_at TEXT);
CREATE TABLE IF NOT EXISTS executions(grant_id TEXT PRIMARY KEY,state TEXT NOT NULL,order_id TEXT,result_json TEXT,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS used_nonces(nonce TEXT PRIMARY KEY,used_at TEXT NOT NULL,grant_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payment_records(order_id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,payment_id TEXT,state TEXT NOT NULL,signature_verified INTEGER NOT NULL DEFAULT 0,payload_json TEXT,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_sessions(session_id TEXT PRIMARY KEY,state_json TEXT NOT NULL,messages_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY,type TEXT NOT NULL,at TEXT NOT NULL,data_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_quotes_cart ON quotes(cart_id); CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(type);`)}

export function seed(db:Database.Database){
  const {count}=db.prepare('SELECT COUNT(*) count FROM products').get() as {count:number};
  if(!count){const ins=db.prepare('INSERT INTO products(id,name,category,price,inventory,active) VALUES(@id,@name,@category,@price,@inventory,@active)');db.transaction(()=>SEED_PRODUCTS.forEach(p=>ins.run({...p,active:p.active?1:0})))();}
  db.prepare('INSERT OR IGNORE INTO merchant_state(merchant_id,discount,delivery,tax) VALUES(?,3500,2500,0)').run(MERCHANT_ID);
}
