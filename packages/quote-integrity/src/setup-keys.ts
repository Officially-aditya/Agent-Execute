import 'dotenv/config';
import { loadOrCreateMerchantKeys } from './index.js';
const keys = loadOrCreateMerchantKeys();
console.log(`Merchant signing keys ready. Public key length: ${keys.publicKey.length} bytes`);