import type OpenAI from 'openai';
import { randomUUID } from 'node:crypto';

type ProviderExtraContent = Record<string, unknown>;

export type StreamedAssistant = {
  role: 'assistant';
  content: string | null;
  extra_content?: ProviderExtraContent;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
    extra_content?: ProviderExtraContent;
  }>;
};

type MutableToolCall = NonNullable<StreamedAssistant['tool_calls']>[number];

function nextToolIndex(toolCalls: Map<number, MutableToolCall>) {
  return toolCalls.size ? Math.max(...toolCalls.keys()) + 1 : 0;
}

function resolveToolIndex(toolCalls: Map<number, MutableToolCall>, delta: any) {
  if (Number.isInteger(delta?.index)) return delta.index as number;

  if (typeof delta?.id === 'string' && delta.id) {
    for (const [index, call] of toolCalls) {
      if (call.id === delta.id) return index;
    }
    return nextToolIndex(toolCalls);
  }

  if (toolCalls.size === 1) return toolCalls.keys().next().value as number;
  return nextToolIndex(toolCalls);
}

function mergeToolDelta(toolCalls: Map<number, MutableToolCall>, delta: any) {
  const index = resolveToolIndex(toolCalls, delta);
  const current = toolCalls.get(index) || {
    id: '',
    type: 'function' as const,
    function: { name: '', arguments: '' },
  };

  if (typeof delta?.id === 'string' && delta.id) current.id = delta.id;
  if (typeof delta?.function?.name === 'string') current.function.name += delta.function.name;
  if (typeof delta?.function?.arguments === 'string') current.function.arguments += delta.function.arguments;

  // Gemini 3's OpenAI-compatible API attaches its encrypted thought signature
  // here. It must be replayed verbatim with this assistant tool call on the
  // following request or Gemini rejects the conversation with HTTP 400.
  if (delta?.extra_content && typeof delta.extra_content === 'object') {
    current.extra_content = delta.extra_content as ProviderExtraContent;
  }

  toolCalls.set(index, current);
}

export async function streamedAssistantCompletion(
  openai: OpenAI,
  request: Record<string, unknown>,
  onDelta: (delta: string) => Promise<void>,
): Promise<StreamedAssistant> {
  let sawChunk = false;
  try {
    const stream: any = await openai.chat.completions.create({ ...request, stream: true } as any);
    let content = '';
    let extraContent: ProviderExtraContent | undefined;
    const toolCalls = new Map<number, MutableToolCall>();

    for await (const chunk of stream) {
      sawChunk = true;
      const delta = chunk?.choices?.[0]?.delta;
      if (!delta) continue;

      if (typeof delta.content === 'string' && delta.content.length) {
        content += delta.content;
        await onDelta(delta.content);
      }

      if (delta.extra_content && typeof delta.extra_content === 'object') {
        extraContent = delta.extra_content as ProviderExtraContent;
      }

      for (const toolDelta of delta.tool_calls || []) mergeToolDelta(toolCalls, toolDelta);
    }

    const calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({
        ...call,
        id: call.id || `call_${index}_${randomUUID()}`,
      }));

    if (!content && !calls.length) {
      throw new Error('LLM stream completed without text or tool calls. Check the configured Gemini model and OpenAI-compatible streaming support.');
    }

    return {
      role: 'assistant',
      content: content || null,
      ...(extraContent ? { extra_content: extraContent } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
    };
  } catch (error) {
    if (sawChunk) throw error;
    const completion: any = await openai.chat.completions.create(request as any);
    const assistant = completion.choices?.[0]?.message;
    if (!assistant) throw new Error('LLM returned no message');
    if (!assistant.content && !(assistant.tool_calls?.length)) {
      throw new Error('LLM returned an empty assistant response. Check the configured Gemini model and provider compatibility.');
    }
    // Keep the provider response intact in fallback mode too; Gemini's
    // extra_content thought signatures live on this object/tool calls.
    return assistant as StreamedAssistant;
  }
}
