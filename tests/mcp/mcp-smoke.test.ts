import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectMerchantMcp, mcpText } from '../../apps/agent-service/src/mcp.js';

const dir = mkdtempSync(join(tmpdir(), 'ae-mcp-'));
const previousDb = process.env.DATABASE_URL;
process.env.DATABASE_URL = join(dir, 'mcp.sqlite');

afterAll(() => {
  if (previousDb === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('real merchant MCP transport', () => {
  it('discovers genuine tools and executes them over stdio', async () => {
    const { client } = await connectMerchantMcp();
    try {
      const discovered = await client.listTools();
      const names = discovered.tools.map((tool: any) => tool.name);
      expect(names).toContain('search_products');
      expect(names).toContain('commit_quote');
      expect(names).toContain('execute_payment');
      const execute = discovered.tools.find((tool: any) => tool.name === 'execute_payment');
      expect(Object.keys(execute?.inputSchema?.properties || {})).toEqual(['grant_id']);
      const created: any = await client.callTool({ name: 'create_cart', arguments: {} });
      const cart = JSON.parse(mcpText(created));
      expect(cart.cart_id).toMatch(/^cart_/);
      const search: any = await client.callTool({ name: 'search_products', arguments: { query: 'milk' } });
      const products = JSON.parse(mcpText(search));
      expect(products.length).toBeGreaterThan(0);
      expect(products.some((p: any) => String(p.name).toLowerCase().includes('milk'))).toBe(true);
    } finally { await client.close(); }
  });
});
