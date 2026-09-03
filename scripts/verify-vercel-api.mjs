import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['api/server.ts', 'api/agent-stream.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  outdir: '.vercel-verify',
  write: false,
  metafile: true,
  logLevel: 'silent',
});

const outputs = Object.values(result.metafile.outputs);
const externalImports = outputs.flatMap((output) => output.imports || []);
const unresolvedWorkspaceImports = externalImports.filter((entry) => entry.path.startsWith('@vac/'));

if (unresolvedWorkspaceImports.length) {
  throw new Error(`Vercel API bundle still contains unresolved workspace imports: ${unresolvedWorkspaceImports.map((entry) => entry.path).join(', ')}`);
}

const inputs = Object.keys(result.metafile.inputs).map((path) => path.replaceAll('\\', '/'));
const requiredInputs = [
  'api/server.ts',
  'api/agent-stream.ts',
  'packages/merchant-core/src/neon.ts',
  'packages/shared/src/index.ts',
  'apps/agent-service/src/app.ts',
  'apps/agent-service/src/agent.ts',
  'apps/agent-service/src/mcp.ts',
  'apps/merchant-mcp/src/server.ts',
  'packages/quote-integrity/src/index.ts',
  'packages/execution-guard/src/index.ts',
  'packages/razorpay/src/index.ts',
];

for (const required of requiredInputs) {
  if (!inputs.some((input) => input.endsWith(required))) {
    throw new Error(`Vercel API dependency graph did not bundle required source: ${required}`);
  }
}

for (const forbidden of ['packages/merchant-core/src/db.ts', 'better-sqlite3']) {
  if (inputs.some((input) => input.includes(forbidden))) {
    throw new Error(`Vercel API bundle unexpectedly includes local SQLite dependency: ${forbidden}`);
  }
}

const outputText = result.outputFiles?.map((file) => file.text).join('\n') || '';
if (outputText.includes("from '@vac/") || outputText.includes('from "@vac/')) {
  throw new Error('Vercel API output still contains an @vac/* runtime import.');
}

const streamSource = await readFile('api/agent-stream.ts', 'utf8');
if (!/export\s+default\s*\{[\s\S]*?fetch\s*\(request:\s*Request\):\s*Response/.test(streamSource)) {
  throw new Error('api/agent-stream.ts must use Vercel\'s documented default { fetch(request: Request): Response } Web handler.');
}
if (/^\s*import\s/m.test(streamSource)) {
  throw new Error('api/agent-stream.ts must not have top-level imports; runtime dependencies must load after the response stream opens.');
}
if (!streamSource.includes("import('@neondatabase/serverless')") || !streamSource.includes("import('../apps/agent-service/src/agent.js')")) {
  throw new Error('api/agent-stream.ts must load Neon and the agent graph lazily.');
}
if (!streamSource.includes('new ReadableStream<Uint8Array>')) {
  throw new Error('api/agent-stream.ts is not returning a native Web ReadableStream.');
}
if (!streamSource.includes('async start(controller)')) {
  throw new Error('api/agent-stream.ts must keep agent execution bound to the ReadableStream lifecycle.');
}
if (!streamSource.includes("send({ type: 'ready', phase: 'runtime_starting' })")) {
  throw new Error('api/agent-stream.ts must emit runtime_starting before loading runtime dependencies.');
}
const firstReady = streamSource.indexOf("send({ type: 'ready', phase: 'runtime_starting' })");
const runtimeLoad = streamSource.indexOf('const runtime = await loadRuntime()');
if (firstReady < 0 || runtimeLoad < 0 || firstReady > runtimeLoad) {
  throw new Error('The first stream record must be emitted before Neon/MCP/Gemini runtime loading begins.');
}

const clientSource = await readFile('apps/web/public/chat-stream.js', 'utf8');
if (!clientSource.includes('/api/agent-stream?__path=')) {
  throw new Error('The browser must call the agent stream function directly instead of relying on a rewrite for live transport.');
}
if (!clientSource.includes("error: 'empty_agent_response'")) {
  throw new Error('The browser must surface empty final agent responses instead of silently rendering nothing.');
}

console.log(`Vercel stream graph verified: ${inputs.length} internal source modules bundled, direct client transport enabled, 0 @vac/* runtime imports, 0 SQLite leakage.`);
