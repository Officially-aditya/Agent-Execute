# Implementation status

## Implemented and verified in repository CI

- persistent SQLite merchant/catalog/cart state with financial revisioning
- genuine MCP v2 server + stdio client transport; the LLM host does not bypass MCP for commerce actions
- runtime-discovered MCP tool schemas and model-generated tool sequences
- persisted structured agent task state and browser session resume
- deterministic cart canonicalization and SHA-256 digest
- persistent Ed25519 merchant signing identity, including Docker-volume persistence
- immutable quote expiry/nonce/signature commitment
- explicit trusted user approval bound to the exact quote
- persisted execution grants; `execute_payment` accepts only `grant_id`
- zero-LLM deterministic Execution Guard that reloads live merchant state before payment
- quote/approval/grant binding, signature, expiry, merchant, amount, currency, revision, digest and nonce checks
- concurrency-safe execution claiming and idempotent successful execution retries
- structured quote-integrity, authorization, replay and payment-rail error taxonomy
- dynamic LLM recovery policy for stale/changed/expired commerce state without a predefined recovery sequence
- Razorpay Test Mode adapter whose order amount is derived only from the verified persisted quote
- Razorpay Checkout success/failure handling and server-side HMAC signature verification
- payment lifecycle status exposed through MCP
- append-only audit trail for tool calls/results, quote/approval/execution and Razorpay states
- judge-facing chat/cart/activity/approval/payment UI and merchant world-state controls
- Docker/Compose startup path, persistent database/signing identity and GitHub Actions validation
- unit, MCP, integration and security suites covering mutation, tampering, expiry, merchant/currency binding, nonce replay, concurrent execution and idempotency

## Credential-gated release acceptance

Public CI intentionally does not execute external credentialed calls. Before recording or judging, run the final acceptance paths with a developer/judge `.env`:

```bash
npm run test:live:llm
npm run test:live:razorpay
```

`test:live:llm` calls the configured API model and drives the real MCP server on a new arbitrary shopping request. `test:live:razorpay` creates a real Razorpay Test Order through `cart → quote → approval → grant → Execution Guard → Razorpay` and asserts that Razorpay receives the verified quote amount.

These are release-acceptance checks for already-implemented external paths, not mock substitutes. The browser flow uses the same payment boundary: Razorpay Test Checkout returns the order/payment/signature fields, and the server records success only after signature verification.

For the strongest judge proof, complete at least one browser success flow and one merchant-state mutation flow before recording:

1. arbitrary request → MCP cart → signed quote → explicit approval → real Razorpay Test Order → Test Checkout → verified payment;
2. approved quote → merchant amount/state mutation → `QUOTE_CHANGED` before Razorpay → same LLM recovers through MCP → fresh approval.
