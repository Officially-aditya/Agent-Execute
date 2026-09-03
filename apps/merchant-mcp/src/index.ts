import 'dotenv/config';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { MerchantRepository } from '@vac/merchant-core';
import { NeonMerchantRepository, hasNeonDatabase } from '@vac/merchant-core/neon';
import { createMerchantMcpServer } from './server.js';

const repo = hasNeonDatabase() ? new NeonMerchantRepository() : new MerchantRepository();

void serveStdio(() => createMerchantMcpServer(repo));
console.error(`Verified Agent Merchant MCP running on stdio (${hasNeonDatabase() ? 'Neon' : 'SQLite'})`);
