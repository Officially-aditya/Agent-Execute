import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MerchantRepository } from '@vac/merchant-core';
import { createAgentApp } from '../../apps/agent-service/src/app.js';

describe('/api/agent-stream route in createAgentApp', () => {
  let server: Server;
  let baseUrl: string;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ae-route-test-'));
    const repo = new MerchantRepository(join(tempDir, 'test.sqlite'));
    const app = createAgentApp(repo);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          baseUrl = `http://localhost:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects non-POST requests with 405 Method Not Allowed', async () => {
    const res = await fetch(`${baseUrl}/api/agent-stream`);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body).toEqual({ error: 'method_not_allowed' });
  });

  it('routes /api/agent-stream?__path=/api/agent/run to agent handler', async () => {
    const res = await fetch(`${baseUrl}/api/agent-stream?__path=/api/agent/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    // Body is empty, so should hit validation error 'message_required' with status 400
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('message_required');
  });

  it('routes /api/agent-stream?__path=/api/sessions/:sessionId/continue to continue handler', async () => {
    const res = await fetch(`${baseUrl}/api/agent-stream?__path=/api/sessions/nonexistent/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    // Session does not exist, so returns session_not_found with status 404 JSON
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('session_not_found');
  });

  it('returns 404 JSON for unsupported stream paths', async () => {
    const res = await fetch(`${baseUrl}/api/agent-stream?__path=/api/unknown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('stream_route_not_found');
  });
});
