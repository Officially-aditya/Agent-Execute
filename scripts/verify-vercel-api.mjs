import { build } from 'esbuild';

const result = await build({
  entryPoints: ['api/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
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

const forbiddenInputs = [
  'packages/merchant-core/src/db.ts',
  'better-sqlite3',
];

for (const forbidden of forbiddenInputs) {
  if (inputs.some((input) => input.includes(forbidden))) {
    throw new Error(`Vercel API bundle unexpectedly includes local SQLite dependency: ${forbidden}`);
  }
}

const outputText = result.outputFiles?.map((file) => file.text).join('\n') || '';
if (outputText.includes("from '@vac/") || outputText.includes('from "@vac/')) {
  throw new Error('Vercel API output still contains an @vac/* runtime import.');
}

console.log(`Vercel API graph verified: ${inputs.length} internal source modules bundled, ${externalImports.length} npm/runtime imports externalized, 0 @vac/* runtime imports.`);
