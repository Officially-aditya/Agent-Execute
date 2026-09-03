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
      return { error: { error: 'message_required', message: 'A shopping request is required.' }, status: 400 } as const;
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
  if (!match?.[1]) return { error: { error: 'stream_route_not_found', message: `Unsupported stream route: ${path || '(empty)'}` }, status: 404 } as const;

  const sessionId = decodeURIComponent(match[1]);
  const session = await repo.getSession(sessionId);
  if (!session) return { error: { error: 'session_not_found', message: 'The checkout session no longer exists.' }, status: 404 } as const;

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
 * The Response is created immediately and all runtime/database work happens
 * inside the ReadableStream after the first record has been emitted.
 */
export default {
  fetch(request: Request): Response {
    if (request.method !== 'POST') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    }

    const path = new URL(request.url).searchParams.get('__path') || '';
    let repo: Repo | null = null;
    let closed = false;
    let cancelled = false;

    const closeRepo = async () => {
      if (closed || !repo) return;
      closed = true;
      const active = repo;
      repo = null;
      await active.close().catch((error: unknown) => console.error('Failed to close Neon pool:', error));
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
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
          if (!streamOpen) return;
          streamOpen = false;
          try { controller.close(); } catch {}
        };

        // This is deliberately the first operation. It proves that Vercel has
        // opened the response before imports, Neon, MCP, or the LLM can block.
        send({ type: 'ready', phase: 'runtime_starting' });

        try {
          const runtime = await loadRuntime();
          repo = runtime.repo;
          send({ type: 'ready', phase: 'runtime_ready' });

          const parsed = await parseInput(request, path, repo);
          if ('error' in parsed) {
            send({ type: 'error', error: parsed.error });
            return;
          }
          send({ type: 'ready', phase: 'agent_starting' });

          const result = await runtime.runWithMerchantMcpRepo(repo, () => runtime.runAgent({
            ...parsed.input,
            onEvent: async (event: unknown) => {
              send({ type: 'event', event });
            },
          }));

          if (!result || typeof result !== 'object') {
            throw new Error('Agent completed without a result object.');
          }
          send({ type: 'result', result });
        } catch (error) {
          console.error('Agent Execute native stream failed:', error);
          send({ type: 'error', error: errorPayload(error) });
        } finally {
          await closeRepo();
          finish();
        }
      },
      async cancel() {
        cancelled = true;
        await closeRepo();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache, no-store, no-transform',
        'x-content-type-options': 'nosniff',
      },
    });
  },
};
