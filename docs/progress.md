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

## Credential-gated live acceptance

External secrets are intentionally not committed. The repository contains opt-in acceptance tests for the two external paths that public CI cannot execute without credentials:

```bash
npm run test:live:llm
npm run test:live:razorpay
```

`test:live:llm` calls the configured API model and drives the real MCP server on a new arbitrary shopping request. `test:live:razorpay` creates a real Razorpay Test Order through `cart → quote → approval → grant → Execution Guard → Razorpay` and asserts that Razorpay receives the verified quote amount.

The remaining environment-dependent acceptance step is to run those commands with a developer/judge `.env`, then complete a Razorpay Test Checkout success/failure in the browser. No fake payment success path is used by the product.
