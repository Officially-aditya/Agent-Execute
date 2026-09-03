import 'dotenv/config';
import { MerchantRepository } from '@vac/merchant-core';
import { NeonMerchantRepository, hasNeonDatabase } from '@vac/merchant-core/neon';
import { createAgentApp } from './app.js';

const repo = hasNeonDatabase() ? new NeonMerchantRepository() : new MerchantRepository();
const app = createAgentApp(repo);
const port = Number(process.env.AGENT_PORT || 3001);

app.listen(port, () => {
  console.log(`Agent Execute listening on http://localhost:${port} (${hasNeonDatabase() ? 'Neon' : 'SQLite'})`);
});
