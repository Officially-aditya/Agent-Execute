import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { commitQuoteAsync } from '../../../packages/quote-integrity/src/index.js';
import { ExecutionGuard } from '../../../packages/execution-guard/src/index.js';
import { RazorpayAdapter } from '../../../packages/razorpay/src/index.js';
import { DomainError } from '../../../packages/shared/src/index.js';

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function failure(error: unknown) {
  const payload = error instanceof DomainError
    ? error.toJSON()
    : { error: 'TOOL_ERROR', message: error instanceof Error ? error.message : String(error) };
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true };
}

export function createMerchantMcpServer(repo: any): McpServer {
  const guard = new ExecutionGuard(repo, new RazorpayAdapter());
  const server = new McpServer({ name: 'verified-agent-merchant', version: '0.4.0' });

  const tool = (
    name: string,
    description: string,
    inputSchema: z.ZodObject<any>,
    handler: (args: any) => unknown | Promise<unknown>,
  ) => {
    server.registerTool(name, { description, inputSchema }, async (args: any) => {
      await repo.appendAudit('AGENT_TOOL_CALLED', { tool: name, arguments: args as Record<string, unknown> });
      try {
        const value = await handler(args);
        await repo.appendAudit('AGENT_TOOL_RESULT', { tool: name, ok: true });
        return result(value);
      } catch (error) {
        const payload = error instanceof DomainError
          ? error.toJSON()
          : { error: 'TOOL_ERROR', message: error instanceof Error ? error.message : String(error) };
        await repo.appendAudit('AGENT_TOOL_RESULT', { tool: name, ok: false, result: payload });
        return failure(error);
      }
    });
  };

  tool('create_cart', 'Create a fresh shopping cart.', z.object({}), async () => ({ cart_id: await repo.createCart() }));
  tool('search_products', 'Search the live merchant catalog by product/category text. Prices are integer paise.', z.object({ query: z.string().min(1) }), async ({ query }) => repo.searchProducts(query));
  tool('get_product', 'Get one live product by exact product ID.', z.object({ product_id: z.string().min(1) }), async ({ product_id }) => repo.getProduct(product_id));
  tool('view_cart', 'Read authoritative current cart state and total.', z.object({ cart_id: z.string().min(1) }), async ({ cart_id }) => repo.getCartSnapshot(cart_id));
  tool('add_to_cart', 'Add a product to the cart.', z.object({ cart_id: z.string(), product_id: z.string(), quantity: z.number().int().positive() }), async ({ cart_id, product_id, quantity }) => repo.addToCart(cart_id, product_id, quantity));
  tool('remove_from_cart', 'Remove a product from the cart.', z.object({ cart_id: z.string(), product_id: z.string() }), async ({ cart_id, product_id }) => repo.removeFromCart(cart_id, product_id));
  tool('update_quantity', 'Set exact product quantity. Set zero to remove.', z.object({ cart_id: z.string(), product_id: z.string(), quantity: z.number().int().min(0) }), async ({ cart_id, product_id, quantity }) => repo.updateQuantity(cart_id, product_id, quantity));
  tool('commit_quote', 'Cryptographically commit the exact current cart. This does not approve payment.', z.object({ cart_id: z.string() }), async ({ cart_id }) => commitQuoteAsync(repo, cart_id));
  tool('execute_payment', 'Request guarded payment execution using only a server-issued grant_id. There is intentionally no amount parameter.', z.object({ grant_id: z.string().min(1) }), async ({ grant_id }) => guard.execute(grant_id));
  tool('get_payment_status', 'Read the guarded execution state plus any Razorpay Checkout/payment state for a grant.', z.object({ grant_id: z.string().min(1) }), async ({ grant_id }) => {
    const execution = await repo.getExecution(grant_id);
    const payment = execution?.orderId ? await repo.getPaymentRecord(execution.orderId) : null;
    return { grant_id, execution, payment };
  });

  return server;
}
