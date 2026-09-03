import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { MerchantRepository } from '@vac/merchant-core';
import { commitQuote } from '@vac/quote-integrity';
import { ExecutionGuard } from '@vac/execution-guard';
import { RazorpayAdapter } from '@vac/razorpay';
import { appendAudit } from '@vac/audit';
import { DomainError } from '@vac/shared';
const repo = new MerchantRepository(); const guard = new ExecutionGuard(repo, new RazorpayAdapter());
function result(value: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }; }
function failure(error: unknown) { const payload = error instanceof DomainError ? error.toJSON() : { error: 'TOOL_ERROR', message: error instanceof Error ? error.message : String(error) }; return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true }; }
function createServer(): McpServer {
  const server = new McpServer({ name: 'verified-agent-merchant', version: '0.1.0' });
  const tool = <T extends z.ZodTypeAny>(name: string, description: string, inputSchema: T, handler: (args: z.infer<T>) => unknown | Promise<unknown>) => { server.registerTool(name, { description, inputSchema }, async (args: z.infer<T>) => { appendAudit(repo.db, 'AGENT_TOOL_CALLED', { tool: name, arguments: args as Record<string, unknown> }); try { return result(await handler(args)); } catch (e) { return failure(e); } }); };
  tool('create_cart','Create a fresh shopping cart.',z.object({}),()=>({cart_id:repo.createCart()}));
  tool('search_products','Search the live merchant catalog by product/category text. Prices are integer paise.',z.object({query:z.string().min(1)}),({query})=>repo.searchProducts(query));
  tool('get_product','Get one live product by exact product ID.',z.object({product_id:z.string().min(1)}),({product_id})=>repo.getProduct(product_id));
  tool('view_cart','Read authoritative current cart state and total.',z.object({cart_id:z.string().min(1)}),({cart_id})=>repo.getCartSnapshot(cart_id));
  tool('add_to_cart','Add a product to the cart.',z.object({cart_id:z.string(),product_id:z.string(),quantity:z.number().int().positive()}),({cart_id,product_id,quantity})=>repo.addToCart(cart_id,product_id,quantity));
  tool('remove_from_cart','Remove a product from the cart.',z.object({cart_id:z.string(),product_id:z.string()}),({cart_id,product_id})=>repo.removeFromCart(cart_id,product_id));
  tool('update_quantity','Set exact product quantity. Set zero to remove.',z.object({cart_id:z.string(),product_id:z.string(),quantity:z.number().int().min(0)}),({cart_id,product_id,quantity})=>repo.updateQuantity(cart_id,product_id,quantity));
  tool('commit_quote','Cryptographically commit the exact current cart. This does not approve payment.',z.object({cart_id:z.string()}),({cart_id})=>commitQuote(repo,cart_id));
  tool('execute_payment','Request guarded payment execution using only a server-issued grant_id. There is intentionally no amount parameter.',z.object({grant_id:z.string().min(1)}),({grant_id})=>guard.execute(grant_id));
  tool('get_payment_status','Read idempotent execution status for a grant.',z.object({grant_id:z.string().min(1)}),({grant_id})=>repo.getExecution(grant_id));
  return server;
}
void serveStdio(createServer); console.error('Verified Agent Merchant MCP running on stdio');