import { neonConfig } from '@neondatabase/serverless';
import WebSocket from 'ws';
import { NeonMerchantRepository } from '../packages/merchant-core/src/neon.js';
import { runAgent } from '../apps/agent-service/src/agent.js';
import { runWithMerchantMcpRepo } from '../apps/agent-service/src/mcp.js';
import { DomainError } from '../packages/shared/src/index.js';

neonConfig.webSocketConstructor = WebSocket;

const encoder = new TextEncoder();

function errorPayload(error: unknown) {
  return error instanceof DomainError
    ? error.toJSON()
    : { error: 'agent_error', message: error instanceof Error ? error.message : String(error) };
}

function record(value: unknown) {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function continueInstruction(session: any) {
  return session.state.activeGrantId
    ? `The user approved quote ${session.state.activeQuoteId}. The trusted execution grant is ${session.state.activeGrantId}. Continue the task using normal MCP tools.`
    : 'Continue the shopping task from the trusted persisted state.';
}

async function parseInput(request: Request, path: string, repo: NeonMerchantRepository) {
  if (path === '/api/agent/run') {
    const body: any = await request.json().catch(() => ({}));
    if (typeof body?.message !== 'string' || !body.message.trim()) {
      return { error: { error: 'message_required' }, status: 400 } as const;
    }
    return {
      input: {
        repo,
        message: body.message,
        sessionId: typeof body.session_id === 'string' ? body.session_id : undefined,
      },
    } as const;
  }

  const match = path.match(/^\/api\/sessions\/([^/]+)\/continue$/);
  const encodedSessionId = match?.[1];
  if (!encodedSessionId) return { error: { error: 'stream_route_not_found' }, status: 404 } as const;

  const sessionId = decodeURIComponent(encodedSessionId);
  const session = await repo.getSession(sessionId);
  if (!session) return { error: { error: 'session_not_found' }, status: 404 } as const;

  return {
    input: {
      repo,
      sessionId,
      trustedInstruction: continueInstruction(session),
    },
  } as const;
}

/**
 * Native Vercel Web Handler for live agent output.
 *
 * This deliberately bypasses the Express response bridge used by the rest of
 * the API. Returning a Response backed by a Web ReadableStream lets Vercel
 * forward each model/tool chunk as it is produced instead of buffering the
 * invocation and releasing the body at the end.
 */
export default {
  async fetch(request: Request) {
    if (request.method !== 'POST') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    }

    const url = new URL(request.url);
    const path = url.searchParams.get('__path') || '';
    const repo = new NeonMerchantRepository();

    let parsed: Awaited<ReturnType<typeof parseInput>>;
    try {
      parsed = await parseInput(request, path, repo);
    } catch (error) {
      await repo.close().catch(() => {});
      return Response.json(errorPayload(error), { status: 500 });
    }

    if ('error' in parsed) {
      await repo.close().catch(() => {});
      return Response.json(parsed.error, { status: parsed.status });
    }

    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Emit one harmless record immediately so headers/body are committed
        // before objective extraction or the first provider token arrives.
        controller.enqueue(record({ type: 'ready' }));

        const execute = async () => {
          try {
            const result = await runWithMerchantMcpRepo(repo, () => runAgent({
              ...parsed.input,
              onEvent: async (event) => {
                if (!cancelled) controller.enqueue(record({ type: 'event', event }));
              },
            }));
            if (!cancelled) controller.enqueue(record({ type: 'result', result }));
          } catch (error) {
            console.error('Agent Execute native stream failed:', error);
            if (!cancelled) controller.enqueue(record({ type: 'error', error: errorPayload(error) }));
          } finally {
            await repo.close().catch((error) => console.error('Failed to close Neon pool:', error));
            if (!cancelled) controller.close();
          }
        };

        void execute();
      },
      async cancel() {
        cancelled = true;
        await repo.close().catch(() => {});
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'content-encoding': 'identity',
        'x-accel-buffering': 'no',
      },
    });
  },
};
