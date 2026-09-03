import { AsyncLocalStorage } from 'node:async_hooks';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { NeonMerchantRepository, hasNeonDatabase } from '../../../packages/merchant-core/src/neon.js';
import { createMerchantMcpServer } from '../../merchant-mcp/src/server.js';

const requestRepo = new AsyncLocalStorage<any>();

export function runWithMerchantMcpRepo<T>(repo: any, fn: () => T): T {
  return requestRepo.run(repo, fn);
}

export async function connectMerchantMcp(sharedRepo?: any) {
  const client = new Client({ name: 'verified-agent-checkout-host', version: '0.4.0' });
  const useInMemory = Boolean(process.env.VERCEL) || hasNeonDatabase() || process.env.MCP_TRANSPORT === 'inmemory';

  if (useInMemory) {
    const contextualRepo = sharedRepo || requestRepo.getStore();
    if (!contextualRepo && !hasNeonDatabase()) {
      throw new Error('Vercel/in-memory MCP requires Neon PostgreSQL. Set DATABASE_URL to the Neon connection string.');
    }

    // Reuse the request-scoped repository when available. AsyncLocalStorage
    // keeps this safe even if a warm Vercel instance handles concurrent calls.
    const ownsRepo = !contextualRepo;
    const repo = contextualRepo || new NeonMerchantRepository();
    const server = createMerchantMcpServer(repo);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
        if (ownsRepo) await repo.close();
      },
      transport: 'inmemory' as const,
    };
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'apps/merchant-mcp/src/index.ts'],
    env: { ...process.env } as Record<string, string>,
    stderr: 'pipe',
  });
  await client.connect(transport);
  return { client, close: async () => client.close(), transport: 'stdio' as const };
}

export function mcpText(result: any): string {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') || JSON.stringify(result);
}
