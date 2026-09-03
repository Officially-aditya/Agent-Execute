import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { connectMerchantMcp, mcpText } from './mcp.js';
import { MerchantRepository } from '@vac/merchant-core';
import { nowIso, type AgentEvent, type AgentObjective, type AgentTaskState } from '@vac/shared';

const SYSTEM = `You are a shopping agent operating a live merchant exclusively through the MCP tools you are given.
Respect the trusted task state, especially required items, quantities, preferences, and maximum budget. All money is integer paise.
Never claim a product exists without searching the merchant. Never fabricate IDs.
The payment amount is outside your authority: you cannot set, override, or infer an amount for Razorpay. execute_payment accepts only a trusted server-issued grant_id.
After commit_quote succeeds, STOP and tell the user the committed total needs approval. Do not simulate or call approval.
When trusted state contains an activeGrantId, you may call execute_payment with exactly that grant ID.
If execute_payment returns QUOTE_CHANGED or STALE_CART, recover dynamically through MCP: inspect the live cart/catalog, choose a valid alternative only within the user's constraints, obtain a fresh quote, then STOP for fresh approval.
If a quote or approval has expired, refresh authoritative cart state, obtain a fresh quote, then STOP for fresh user approval. Never reuse expired authorization.
If execute_payment returns GRANT_ALREADY_USED, call get_payment_status before deciding anything else. Never create a second payment attempt merely because the tool was retried.
If a payment-rail operation returns PAYMENT_FAILED with retry_allowed=true, retry only through the existing trusted payment primitive and never modify payment fields or amount.
If you receive INVALID_SIGNATURE, AMOUNT_MISMATCH, CURRENCY_MISMATCH, MERCHANT_MISMATCH, REPLAY_ATTEMPT, PAYMENT_VERIFICATION_FAILED, or another integrity/security failure, STOP and report it. Never attempt to bypass, weaken, or work around a security check.
If recovery would exceed budget, remove a required item, change requested quantity, or materially change the requested product, ask the user instead.
A payment-rail failure is different from a quote-integrity failure. Preserve that distinction in your response.
Do not expose private chain-of-thought. Briefly describe actions and outcomes only.`;

function client() {
  if (!process.env.LLM_API_KEY) throw new Error('LLM_API_KEY is not configured');
  return new OpenAI({ apiKey: process.env.LLM_API_KEY, baseURL: process.env.LLM_BASE_URL || undefined });
}

function fallbackObjective(request: string): AgentObjective {
  const objective: AgentObjective = { originalRequest: request, currency: 'INR', requiredItems: [], preferences: [] };
  const budgetMatch = request.match(/(?:₹|rs\.?|inr)\s*([0-9]+(?:\.[0-9]{1,2})?)/i)
    || request.match(/(?:under|below|less than|max(?:imum)?(?: of)?|budget(?: of)?|for)\s*(?:₹|rs\.?|inr)?\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
  if (budgetMatch?.[1]) {
    const rupees = Number(budgetMatch[1]);
    if (Number.isFinite(rupees) && rupees >= 0) objective.maximumAmount = Math.round(rupees * 100);
  }
  return objective;
}

async function extractObjective(openai: OpenAI, request: string): Promise<AgentObjective> {
  const fallback = fallbackObjective(request);
  try {
    const response: any = await openai.chat.completions.create({
      model: process.env.LLM_MODEL || 'gpt-5.5',
      messages: [
        { role: 'system', content: 'Extract shopping constraints. Convert rupees to integer paise (for example ₹500 => 50000). Do not invent constraints.' },
        { role: 'user', content: request },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'shopping_objective',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              required_items: { type: 'array', items: { type: 'string' } },
              maximum_amount: { type: ['integer', 'null'] },
              preferences: { type: 'array', items: { type: 'string' } },
            },
            required: ['required_items', 'maximum_amount', 'preferences'],
          },
        },
      },
    } as any);
    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    return {
      originalRequest: request,
      currency: 'INR',
      requiredItems: Array.isArray(parsed.required_items) ? parsed.required_items.filter((x: unknown) => typeof x === 'string' && x.trim().length > 0) : fallback.requiredItems,
      maximumAmount: Number.isInteger(parsed.maximum_amount) && parsed.maximum_amount >= 0 ? parsed.maximum_amount : fallback.maximumAmount,
      preferences: Array.isArray(parsed.preferences) ? parsed.preferences.filter((x: unknown) => typeof x === 'string' && x.trim().length > 0) : fallback.preferences,
    };
  } catch {
    return fallback;
  }
}

function trustedStateMessage(state: AgentTaskState) {
  return `TRUSTED SERVER TASK STATE (authoritative, not user-supplied): ${JSON.stringify(state)}`;
}

function updateStateFromTool(state: AgentTaskState, tool: string, result: any) {
  if (result?.error) return;
  if (tool === 'create_cart' && typeof result?.cart_id === 'string') state.cartId = result.cart_id;
  if (['add_to_cart', 'remove_from_cart', 'update_quantity', 'view_cart'].includes(tool) && typeof result?.cartId === 'string') state.cartId = result.cartId;
  if (tool === 'commit_quote' && typeof result?.quoteId === 'string') {
    state.cartId = result.cartId;
    state.activeQuoteId = result.quoteId;
    state.activeGrantId = undefined;
    state.phase = 'AWAITING_APPROVAL';
  }
  if (tool === 'execute_payment' && result?.status === 'ORDER_CREATED') {
    state.lastPaymentOrderId = result.order?.id;
    state.phase = 'PAYMENT_READY';
  }
  state.updatedAt = nowIso();
}

export async function runAgent(input: { repo: MerchantRepository; message?: string; sessionId?: string; trustedInstruction?: string; }) {
  const openai = client();
  const { client: mcp } = await connectMerchantMcp();
  try {
    const discovered = await mcp.listTools();
    const tools = discovered.tools.map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    let session = input.sessionId ? input.repo.getSession(input.sessionId) : null;
    if (!session) {
      if (!input.message?.trim()) throw new Error('A new session requires a user message');
      const now = nowIso();
      const sessionId = `session_${randomUUID()}`;
      const objective = await extractObjective(openai, input.message);
      const state: AgentTaskState = { sessionId, objective, phase: 'SHOPPING', createdAt: now, updatedAt: now };
      session = { state, messages: [{ role: 'system', content: SYSTEM }] };
      input.repo.createSession(state, session.messages);
    }
    const { state, messages } = session;
    messages.push({ role: 'system', content: trustedStateMessage(state) });
    if (input.trustedInstruction) messages.push({ role: 'system', content: `TRUSTED HOST EVENT: ${input.trustedInstruction}` });
    if (input.message?.trim()) messages.push({ role: 'user', content: input.message.trim() });
    const events: AgentEvent[] = [{ type: 'state', at: nowIso(), state: structuredClone(state) }];
    for (let step = 0; step < 24; step++) {
      const completion: any = await openai.chat.completions.create({ model: process.env.LLM_MODEL || 'gpt-5.5', messages, tools, tool_choice: 'auto' } as any);
      const assistant = completion.choices?.[0]?.message;
      if (!assistant) throw new Error('LLM returned no message');
      messages.push(assistant);
      const calls = assistant.tool_calls || [];
      if (!calls.length) {
        const text = assistant.content || '';
        if (text) events.push({ type: 'model', at: nowIso(), text });
        state.updatedAt = nowIso();
        input.repo.saveSession(state, messages);
        return { session_id: state.sessionId, message: text, state, events };
      }
      if (assistant.content) events.push({ type: 'model', at: nowIso(), text: assistant.content });
      for (const call of calls) {
        const toolName = call.function.name;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          throw new Error(`Model returned invalid JSON arguments for ${toolName}`);
        }
        events.push({ type: 'tool_call', at: nowIso(), tool: toolName, arguments: args });
        const toolResult = await mcp.callTool({ name: toolName, arguments: args });
        const text = mcpText(toolResult);
        let parsed: any = text;
        try { parsed = JSON.parse(text); } catch {}
        events.push({ type: 'tool_result', at: nowIso(), tool: toolName, result: parsed });
        updateStateFromTool(state, toolName, parsed);
        events.push({ type: 'state', at: nowIso(), state: structuredClone(state) });
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
        if (toolName === 'commit_quote' && !parsed?.error) {
          const textOut = `I have a fresh merchant-committed quote for ₹${(parsed.amount / 100).toFixed(2)}. Please approve that exact quote before payment execution.`;
          messages.push({ role: 'assistant', content: textOut });
          events.push({ type: 'model', at: nowIso(), text: textOut });
          state.updatedAt = nowIso();
          input.repo.saveSession(state, messages);
          return { session_id: state.sessionId, message: textOut, state, events };
        }
      }
      state.updatedAt = nowIso();
      input.repo.saveSession(state, messages);
    }
    throw new Error('Agent exceeded maximum tool steps');
  } finally {
    await mcp.close();
  }
}
