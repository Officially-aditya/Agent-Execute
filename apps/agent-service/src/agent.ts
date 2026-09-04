import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { connectMerchantMcp, mcpText } from './mcp.js';
import { streamedAssistantCompletion } from './streamed-completion.js';
import { nowIso, type AgentEvent, type AgentObjective, type AgentTaskState } from '../../../packages/shared/src/index.js';

type MaybePromise<T> = T | Promise<T>;
type AgentRepository = {
  getSession(id: string): MaybePromise<{ state: AgentTaskState; messages: any[] } | null>;
  createSession(state: AgentTaskState, messages: unknown[]): MaybePromise<unknown>;
  saveSession(state: AgentTaskState, messages: unknown[]): MaybePromise<unknown>;
};

type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

const SYSTEM = `You are a shopping agent operating a live merchant exclusively through the MCP tools you are given.
Respect the trusted task state, especially required items, quantities, preferences, and maximum budget. All money is integer paise.
Never claim a product exists without searching the merchant. Never fabricate IDs.
The payment amount is outside your authority: you cannot set, override, or infer an amount for Razorpay. execute_payment accepts only a trusted server-issued grant_id.
Before calling commit_quote, verify via view_cart that the final cart total (including delivery, discounts, and taxes) does NOT exceed the user's maximum budget (maximumAmount). Never commit a quote or present a cart for approval if the total exceeds the user's maximum budget. When a shopping cart satisfies the user's request and is within budget, call commit_quote instead of stopping at an informal cart summary. After commit_quote succeeds within budget, STOP and tell the user the committed total needs approval. Do not simulate or call approval. If the cart total exceeds the user's budget, do not present it for approval; explain that the total exceeds their threshold and ask how they wish to proceed.
When trusted state contains an activeGrantId, you may call execute_payment with exactly that grant ID. When execute_payment succeeds with ORDER_CREATED, explain to the user that quote integrity verification passed, a trusted Razorpay Order has been generated with the exact approved amount locked in, and invite them to complete payment using the Razorpay Checkout button below.
When the cart value changes or execute_payment returns QUOTE_CHANGED or STALE_CART: do NOT say that the execution expired or that authorization expired. You must explicitly state to the user: "Transaction failed because amount updated". Then recover dynamically through MCP: inspect the live cart/catalog, choose a valid alternative only within the user's constraints, obtain a fresh quote, then STOP for fresh approval.
If a quote or approval has expired without any cart value or price change, refresh authoritative cart state, obtain a fresh quote, then STOP for fresh user approval. Never reuse expired authorization. Under no circumstances say that execution or authorization expired when the cart amount or value has updated.
If execute_payment returns GRANT_ALREADY_USED, call get_payment_status before deciding anything else. Never create a second payment attempt merely because the tool was retried.
If a payment-rail operation returns PAYMENT_FAILED with retry_allowed=true, retry only through the existing trusted payment primitive and never modify payment fields or amount.
If you receive INVALID_SIGNATURE, AMOUNT_MISMATCH, CURRENCY_MISMATCH, MERCHANT_MISMATCH, REPLAY_ATTEMPT, GRANT_ALREADY_USED, PAYMENT_VERIFICATION_FAILED, or another integrity/security failure, STOP and report it. Never attempt to bypass, weaken, or work around a security check.
If recovery would exceed budget, remove a required item, change requested quantity, or materially change the requested product, ask the user instead.
A payment-rail failure is different from a quote-integrity failure. Preserve that distinction in your response.
Do not write user-facing prose in the same turn in which you invoke tools; when a tool is needed, emit the tool call only.
For user-facing responses, use concise Markdown that is easy to scan. Prefer a short lead sentence, bullets for selected items, and a compact price summary. Use the authoritative merchant/cart/quote totals returned by tools instead of recomputing them yourself. If a non-zero discount affects the total, always show it explicitly. Keep commentary such as budget headroom on its own line instead of attaching it to the Total value.
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
      requiredItems: Array.isArray(parsed.required_items) ? parsed.required_items.filter((value: unknown) => typeof value === 'string' && value.trim().length > 0) : fallback.requiredItems,
      maximumAmount: Number.isInteger(parsed.maximum_amount) && parsed.maximum_amount >= 0 ? parsed.maximum_amount : fallback.maximumAmount,
      preferences: Array.isArray(parsed.preferences) ? parsed.preferences.filter((value: unknown) => typeof value === 'string' && value.trim().length > 0) : fallback.preferences,
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
    if (state.objective.maximumAmount !== undefined && typeof result?.amount === 'number' && result.amount > state.objective.maximumAmount) {
      state.activeQuoteId = undefined;
      state.activeGrantId = undefined;
      state.phase = 'SHOPPING';
    } else {
      state.activeQuoteId = result.quoteId;
      state.activeGrantId = undefined;
      state.phase = 'AWAITING_APPROVAL';
    }
  }
  if (tool === 'execute_payment' && result?.status === 'ORDER_CREATED') {
    state.lastPaymentOrderId = result.order?.id;
    state.phase = 'PAYMENT_READY';
  }
  state.updatedAt = nowIso();
}

function normalizeMessagesForCompletion(messages: any[]): any[] {
  const normalized = [...messages];
  const last = normalized[normalized.length - 1];
  if (!last || last.role === 'assistant') {
    normalized.push({ role: 'user', content: 'Continue the shopping task from the trusted persisted state.' });
  } else if (last.role === 'system' && normalized.length > 1) {
    normalized[normalized.length - 1] = { ...last, role: 'user' };
  }
  return normalized;
}

export async function runAgent(input: {
  repo: AgentRepository;
  message?: string;
  sessionId?: string;
  trustedInstruction?: string;
  onEvent?: AgentEventSink;
}) {
  const openai = client();
  const mcpConnection = await connectMerchantMcp();
  const mcp = mcpConnection.client;
  const events: AgentEvent[] = [];
  const emit = async (event: AgentEvent) => {
    events.push(event);
    if (input.onEvent) await input.onEvent(event);
  };
  const emitTransient = async (event: AgentEvent) => {
    if (input.onEvent) await input.onEvent(event);
  };

  try {
    const discovered = await mcp.listTools();
    const tools = discovered.tools.map((tool: any) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
    let session = input.sessionId ? await input.repo.getSession(input.sessionId) : null;
    if (!session) {
      if (!input.message?.trim()) throw new Error('A new session requires a user message');
      const now = nowIso();
      const sessionId = `session_${randomUUID()}`;
      const objective = await extractObjective(openai, input.message);
      const state: AgentTaskState = { sessionId, objective, phase: 'SHOPPING', createdAt: now, updatedAt: now };
      session = { state, messages: [{ role: 'system', content: SYSTEM }] };
      await input.repo.createSession(state, session.messages);
    }

    const { state, messages } = session;
    messages.push({ role: 'system', content: trustedStateMessage(state) });
    if (input.trustedInstruction) {
      const role = input.message?.trim() ? 'system' : 'user';
      messages.push({ role, content: `TRUSTED HOST EVENT: ${input.trustedInstruction}` });
    }
    if (input.message?.trim()) messages.push({ role: 'user', content: input.message.trim() });
    await emit({ type: 'state', at: nowIso(), state: structuredClone(state) });

    for (let step = 0; step < 24; step++) {
      const request = {
        model: process.env.LLM_MODEL || 'gpt-5.5',
        messages: normalizeMessagesForCompletion(messages),
        tools,
        tool_choice: 'auto',
      };

      let assistant: any;
      if (input.onEvent) {
        assistant = await streamedAssistantCompletion(openai, request, async (delta) => {
          await emitTransient({ type: 'model_delta', at: nowIso(), text: delta });
        });
      } else {
        const completion: any = await openai.chat.completions.create(request as any);
        assistant = completion.choices?.[0]?.message;
      }

      if (!assistant) throw new Error('LLM returned no message');
      messages.push(assistant);
      const calls = assistant.tool_calls || [];

      if (!calls.length) {
        const text = assistant.content || '';
        if (!text) throw new Error('LLM returned an empty final assistant response.');
        await emit({ type: 'model', at: nowIso(), text });
        state.updatedAt = nowIso();
        await input.repo.saveSession(state, messages);
        return { session_id: state.sessionId, message: text, state, events };
      }

      if (assistant.content) await emit({ type: 'model', at: nowIso(), text: assistant.content });
      for (const call of calls) {
        const toolName = call.function.name;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          throw new Error(`Model returned invalid JSON arguments for ${toolName}`);
        }

        await emit({ type: 'tool_call', at: nowIso(), tool: toolName, arguments: args });
        const toolResult = await mcp.callTool({ name: toolName, arguments: args });
        const text = mcpText(toolResult);
        let parsed: any = text;
        try { parsed = JSON.parse(text); } catch {}
        await emit({ type: 'tool_result', at: nowIso(), tool: toolName, result: parsed });
        updateStateFromTool(state, toolName, parsed);
        let toolMessageContent = text;
        if (toolName === 'commit_quote' && state.objective.maximumAmount !== undefined && typeof parsed?.amount === 'number' && parsed.amount > state.objective.maximumAmount) {
          toolMessageContent = JSON.stringify({
            ...parsed,
            error: 'OVER_BUDGET',
            message: `Committed quote total of ₹${(parsed.amount/100).toFixed(2)} exceeds the user's budget threshold of ₹${(state.objective.maximumAmount/100).toFixed(2)}. The cart cannot be approved. Do not ask the user to approve this cart. Explain to the user that the cart total exceeds their budget threshold and ask them how they wish to proceed.`,
          });
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolMessageContent });
      }

      state.updatedAt = nowIso();
      await input.repo.saveSession(state, messages);
    }
    throw new Error('Agent exceeded maximum tool steps');
  } finally {
    await mcpConnection.close();
  }
}
