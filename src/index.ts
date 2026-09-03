import 'dotenv/config';
import { NeonMerchantRepository } from '@vac/merchant-core/neon';
import { createAgentApp } from '../apps/agent-service/src/app.js';

const repo = new NeonMerchantRepository();
const app = createAgentApp(repo);

export default app;
