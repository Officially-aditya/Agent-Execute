import 'dotenv/config';
import { NeonMerchantRepository } from '../packages/merchant-core/src/neon.js';
import { createAgentApp } from '../apps/agent-service/src/app.js';

const repo = new NeonMerchantRepository();
const app = createAgentApp(repo);

export default app;
