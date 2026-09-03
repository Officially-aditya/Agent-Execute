const encoder = new TextEncoder();

type Repo = any;
type RunAgent = (input: any) => Promise<any>;
type RunWithRepo = <T>(repo: any, fn: () => T) => T;

function record(value: unknown) {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function errorPayload(error: unknown) {
  const maybeDomain = error as { toJSON?: () => unknown } | null;
  if (maybeDomain && typeof maybeDomain.toJSON === 'function') {
    try { return maybeDomain.toJSON(); } catch {}
  }
  return {
    error: 'agent_error',
    message: error instanceof Error ? error.message : String(error),
  };
}

function continueInstruction(session: any) {
  return session.state.activeGrantId
    ? `The user approved quote ${session.state.activeQuoteId}. The trusted execution grant is ${session.state.activeGrantId}. Continue the task using normal MCP tools.`
    : 'Continue the shopping task from the trusted persisted state.';
}

async function parseInput(request: Request, path: string, repo: Repo) {
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

async function loadRuntime(): Promise<{
  repo: Repo;
  runAgent: RunAgent;
  runWithMerchantMcpRepo: RunWithRepo;
}> {
  // Keep the Vercel function module itself dependency-free. Vercel evaluates
  // api/agent-stream.ts before invoking fetch(); a top-level failure in Neon,
  // ws, MCP, or the agent graph would otherwise become FUNCTION_INVOCATION_FAILED
  // and bypass every application error handler.
  const [neonPackage, wsPackage, merchantPackage, agentPackage, mcpPackage] = await Promise.all([
    import('@neondatabase/serverless'),
    import('ws'),
    import('../packages/merchant-core/src/neon.js'),
    import('../apps/agent-service/src/agent.js'),
    import('../apps/agent-service/src/mcp.js'),
  ]);

  const WebSocketCtor = (wsPackage as any).default || wsPackage;
  neonPackage.neonConfig.webSocketConstructor = WebSocketCtor as any;

  return {
    repo: new merchantPackage.NeonMerchantRepository(),
    runAgent: agentPackage.runAgent,
    runWithMerchantMcpRepo: mcpPackage.runWithMerchantMcpRepo,
  };
}

/**
 * Vercel Web Standard Function.
 *
 * Contract: https://vercel.com/docs/functions/functions-api-reference
 * Vercel supports a default export containing fetch(Request). The returned
 * Response owns a native ReadableStream, so each NDJSON record can be flushed
 * independently without passing through Express.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    let repo: Repo | null = null;

    try {
      if (request.method !== 'POST') {
        return Response.json({ error: 'method_not_allowed' }, { status: 405 });
      }

      const url = new URL(request.url);
      const path = url.searchParams.get('__path') || '';

      const runtime = await loadRuntime();
      repo = runtime.repo;

      const parsed = await parseInput(request, path, repo);
      if ('error' in parsed) {
        await repo.close().catch(() => {});
        repo = null;
        return Response.json(parsed.error, { status: parsed.status });
      }

      const activeRepo = repo;
      const { runAgent, runWithMerchantMcpRepo } = runtime;
      let cancelled = false;
      let closed = false;

      const closeRepo = async () => {
        if (closed) return;
        closed = true;
        await activeRepo.close().catch((error: unknown) => {
          console.error('Failed to close Neon pool:', error);
        });
      };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let streamOpen = true;

          const send = (value: unknown) => {
            if (!streamOpen || cancelled) return false;
            try {
              controller.enqueue(record(value));
              return true;
            } catch {
              streamOpen = false;
              cancelled = true;
              return false;
            }
          };

          const finish = () => {
            if (!streamOpen || cancelled) return;
            streamOpen = false;
            try { controller.close(); } catch {}
          };

          // Commit the response body immediately. The browser receives this
          // before objective extraction, MCP discovery, or provider tokens.
          send({ type: 'ready' });

          void (async () => {
            try {
              const result = await runWithMerchantMcpRepo(activeRepo, () => runAgent({
                ...parsed.input,
                onEvent: async (event: unknown) => {
                  send({ type: 'event', event });
                },
              }));

              send({ type: 'result', result });
            } catch (error) {
              console.error('Agent Execute native stream failed:', error);
              send({ type: 'error', error: errorPayload(error) });
            } finally {
              await closeRepo();
              finish();
            }
          })();
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
          'x-content-type-options': 'nosniff',
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
