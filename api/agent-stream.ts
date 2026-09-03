import { neonConfig } from '@neondatabase/serverless';
import WebSocket from 'ws';
import { NeonMerchantRepository } from '../packages/merchant-core/src/neon.js';
import { runAgent } from '../apps/agent-service/src/agent.js';
import { runWithMerchantMcpRepo } from '../apps/agent-service/src/mcp.js';
import { DomainError } from '../packages/shared/src/index.js';

neonConfig.webSocketConstructor = WebSocket;

const encoder = new TextEncoder();

export const config = {
  maxDuration: 60,
};

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
  if (!match?.[1]) return { error: { error: 'stream_route_not_found' }, status: 404 } as const;

  const sessionId = decodeURIComponent(match[1]);
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
 * Native Vercel Web Standard handler for live agent output.
 *
 * Vercel's Functions API supports a default export containing fetch(Request).
 * Returning a Response backed by a Web ReadableStream lets each model/tool
 * record reach the browser as it is produced, without the Express bridge.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    let repo: NeonMerchantRepository | null = null;

    try {
      if (request.method !== 'POST') {
        return Response.json({ error: 'method_not_allowed' }, { status: 405 });
      }

      const url = new URL(request.url);
      const path = url.searchParams.get('__path') || '';

      repo = new NeonMerchantRepository();
      const parsed = await parseInput(request, path, repo);

      if ('error' in parsed) {
        await repo.close().catch(() => {});
        repo = null;
        return Response.json(parsed.error, { status: parsed.status });
      }

      const activeRepo = repo;
      let cancelled = false;
      let closed = false;

      const closeRepo = async () => {
        if (closed) return;
        closed = true;
        await activeRepo.close().catch((error) => {
          console.error('Failed to close Neon pool:', error);
        });
      };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Commit headers/body immediately so the browser can render the
          // working state before objective extraction or provider tokens land.
          controller.enqueue(record({ type: 'ready' }));

          const execute = async () => {
            try {
              const result = await runWithMerchantMcpRepo(activeRepo, () => runAgent({
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
              await closeRepo();
              if (!cancelled) controller.close();
            }
          };

          void execute();
        },
        async cancel() {
          cancelled = true;
          await closeRepo();
        },
      });

      // The stream now owns the repository lifecycle.
      repo = null;

      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-cache, no-store, no-transform',
          'x-accel-buffering': 'no',
        },
      });
    } catch (error) {
      console.error('Agent Execute stream startup failed:', error);
      if (repo) await repo.close().catch(() => {});
      return Response.json(
        {
          error: 'agent_stream_startup_failed',
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }
  },
};
