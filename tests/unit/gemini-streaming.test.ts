import { describe, expect, it } from 'vitest';
import { streamedAssistantCompletion } from '../../apps/agent-service/src/streamed-completion.js';

function fakeOpenAI(chunks: any[]) {
  return {
    chat: {
      completions: {
        create: async (request: any) => {
          if (!request.stream) throw new Error('unexpected non-stream fallback');
          return {
            async *[Symbol.asyncIterator]() {
              for (const chunk of chunks) yield chunk;
            },
          };
        },
      },
    },
  } as any;
}

describe('Gemini OpenAI-compatible streaming', () => {
  it('preserves thought_signature on reconstructed tool calls', async () => {
    const thoughtSignature = 'encrypted-provider-signature';
    const openai = fakeOpenAI([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_search',
              type: 'function',
              function: { name: 'search_products', arguments: '{"query":"eggs"' },
              extra_content: { google: { thought_signature: thoughtSignature } },
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '}' },
            }],
          },
        }],
      },
    ]);

    const assistant = await streamedAssistantCompletion(openai, {
      model: 'gemini-test',
      messages: [],
      tools: [],
    }, async () => {});

    expect(assistant).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_search',
        type: 'function',
        function: { name: 'search_products', arguments: '{"query":"eggs"}' },
        extra_content: { google: { thought_signature: thoughtSignature } },
      }],
    });
  });

  it('keeps separate signatures for parallel tool calls', async () => {
    const openai = fakeOpenAI([{
      choices: [{
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_a',
              type: 'function',
              function: { name: 'search_products', arguments: '{}' },
              extra_content: { google: { thought_signature: 'sig-a' } },
            },
            {
              index: 1,
              id: 'call_b',
              type: 'function',
              function: { name: 'view_cart', arguments: '{}' },
              extra_content: { google: { thought_signature: 'sig-b' } },
            },
          ],
        },
      }],
    }]);

    const assistant = await streamedAssistantCompletion(openai, { model: 'gemini-test' }, async () => {});

    expect(assistant.tool_calls?.[0]?.extra_content).toEqual({ google: { thought_signature: 'sig-a' } });
    expect(assistant.tool_calls?.[1]?.extra_content).toEqual({ google: { thought_signature: 'sig-b' } });
  });
});
