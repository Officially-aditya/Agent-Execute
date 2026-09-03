import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MerchantRepository } from '@vac/merchant-core';
import { runAgent } from '../../apps/agent-service/src/agent.js';

const enabled = process.env.RUN_LIVE_LLM === '1';
const live = enabled ? describe : describe.skip;
const dir = mkdtempSync(join(tmpdir(), 'ae-live-llm-'));
const previousDb = process.env.DATABASE_URL;
process.env.DATABASE_URL = join(dir, 'live-agent.sqlite');

afterAll(() => {
  if (previousDb === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDb;
  rmSync(dir, { recursive: true, force: true });
});

live('live LLM + MCP shopping agent', () => {
  it('uses discovered MCP tools to build an arbitrary budget-constrained cart and pauses for approval', async () => {
    expect(process.env.LLM_API_KEY, 'LLM_API_KEY is required').toBeTruthy();
    const repo = new MerchantRepository(process.env.DATABASE_URL);
    const result = await runAgent({ repo, message: 'Buy milk and bread under ₹250. Prefer cheaper options.' });

    expect(result.session_id).toMatch(/^session_/);
    expect(result.state.phase).toBe('AWAITING_APPROVAL');
    expect(result.state.cartId).toBeTruthy();
    expect(result.state.activeQuoteId).toBeTruthy();
    expect(result.events.some(event => event.type === 'tool_call' && event.tool === 'search_products')).toBe(true);
    expect(result.events.some(event => event.type === 'tool_call' && event.tool === 'commit_quote')).toBe(true);

    const cart = repo.getCartSnapshot(result.state.cartId!);
    expect(cart.items.length).toBeGreaterThan(0);
    expect(cart.total).toBeLessThanOrEqual(25_000);
    expect(result.state.objective.maximumAmount).toBe(25_000);
  }, 90_000);
});
