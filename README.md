# Agent Execute

**Agent Execute** is a working agentic checkout that lets an LLM decide commerce actions while deterministic software controls the payment boundary.

> **The AI can choose what to buy. It can never choose what Razorpay charges.**

Core invariant:

```text
SEEN = COMMITTED = APPROVED = CHARGED
```

The merchant economy is simulated; the agent loop, MCP calls, mutable server state, quote commitment, approval/grant chain, Execution Guard, Razorpay Test Order creation, Test Checkout, payment signature verification, and audit trail are real code paths.

## Architecture

```text
User
  ↓
Real LLM shopping agent
  ↓ structured tool calls
MCP client
  ↓ stdio MCP
Merchant MCP server
  ↓
Mutable SQLite merchant/cart state
  ↓
Signed immutable quote (SHA-256 + Ed25519 + expiry + nonce)
  ↓
User approval → server execution grant
  ↓
Execution Guard (zero LLM calls)
  ↓
Razorpay Test Order → Test Checkout → server signature verification
```

`execute_payment` has exactly one authority-bearing input:

```json
{ "grant_id": "grant_..." }
```

There is deliberately **no amount argument**. The guard reloads the persisted grant, approval, signed quote, and current merchant cart; it then derives the Razorpay amount only from the verified quote.

## What is real

- API-based LLM with native structured tool calls
- model-generated shopping/recovery sequence
- MCP v2 client/server transport
- server-side catalog, inventory, pricing, discounts, delivery fees and carts
- cart revisioning on financially meaningful changes
- canonical cart serialization + SHA-256 commitment
- Ed25519 merchant signature and verification
- quote expiry and nonce replay protection
- trusted user approval bound to the exact quote
- execution grants persisted in SQLite
- deterministic Execution Guard with no LLM access
- idempotent Razorpay Order creation boundary
- real Razorpay Test Mode Order API adapter
- real Razorpay Checkout browser integration
- server-side Razorpay checkout signature verification
- payment-rail failure separated from quote-integrity failure
- persistent agent sessions / structured task state
- append-only audit events
- merchant/judge mutation controls

## Run locally

Requirements: Node.js 20+ (22 recommended), an LLM API key, and Razorpay **Test Mode** credentials.

```bash
git clone https://github.com/Officially-aditya/Agent-Execute.git
cd Agent-Execute
cp .env.example .env
# fill LLM_API_KEY, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
npm install
npm run setup
npm run dev
```

Open `http://localhost:3001`.

`npm run dev` starts:

- Agent/web service: `http://localhost:3001`
- Merchant admin service: `http://localhost:3002`
- Merchant MCP: spawned over real stdio MCP by the agent host, and independently runnable with `npm run dev:mcp`

### Docker

```bash
cp .env.example .env
# fill credentials
docker compose up --build
```

No external database setup is required; Compose uses a persistent shared SQLite volume.

## Judge flow

1. Enter any supported request, e.g. `Buy milk, eggs and cereal under ₹500.`
2. Watch the model discover and invoke live MCP tools.
3. Inspect the real cart and committed quote.
4. Approve the exact quote in the UI.
5. Before execution, optionally use **Merchant controls** to change a price, stock, discount, or delivery fee.
6. Continue the same session. If the quote changed, Execution Guard returns `QUOTE_CHANGED` **before Razorpay** and the same LLM dynamically recovers through MCP.
7. Approve the fresh quote.
8. Guard verifies it and creates a real Razorpay Test Order.
9. Open Razorpay Test Checkout and complete success/failure testing.
10. Inspect the full audit trail.

There are no `/run-demo`, `scenarioId`, hardcoded product sequences, or forced recovery products.

## Security rules

The LLM may search, compare, choose products, mutate carts, refresh state, commit quotes, recover from stale state, and call `execute_payment(grant_id)`.

It may **not** create approvals, set a payment amount, forge or edit a quote, override signatures/expiry/replay checks, access Razorpay credentials, or call Razorpay directly.

See [docs/threat-model.md](docs/threat-model.md) and [docs/architecture.md](docs/architecture.md).

## Tests

```bash
npm run typecheck
npm test
```

Coverage targets include:

- one-paise/cart mutation invalidates the commitment
- changed merchant state never reaches the payment rail
- tampered approval amount/signature is blocked
- amount is derived from verified quote only
- duplicate execution cannot duplicate orders
- payment-rail failure is retryable only after integrity verification
- quote/grant nonce replay protection

## Independent MCP inspection

```bash
npm run dev:mcp
```

Or connect a generic MCP inspector/client to:

```bash
npx tsx apps/merchant-mcp/src/index.ts
```

## Environment

See `.env.example`. Secrets stay server-side; browser JavaScript receives only the public Razorpay Test key ID.
