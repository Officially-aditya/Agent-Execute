import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export async function connectMerchantMcp() {
  const client = new Client({ name: 'verified-agent-checkout-host', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'apps/merchant-mcp/src/index.ts'],
    env: { ...process.env } as Record<string, string>,
    stderr: 'pipe',
  });
  await client.connect(transport);
  return { client, transport };
}

export function mcpText(result: any): string {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') || JSON.stringify(result);
}