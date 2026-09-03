# Architecture

## Trust boundaries

Agent Execute separates **commerce intent** from **money authorization**.

1. The LLM host discovers merchant tools through a real MCP client.
2. Merchant operations run in a separate MCP server process and persist to SQLite.
3. `commit_quote(cart_id)` snapshots authoritative current cart state, canonicalizes it, hashes it with SHA-256, adds expiry + nonce, and signs the binding with an Ed25519 merchant key.
4. Approval is a trusted HTTP/UI action and is intentionally absent from the MCP tool set.
5. Approval creates a persisted grant bound to quote ID, digest, amount, currency and expiry.
6. MCP exposes `execute_payment(grant_id)`—never `execute_payment(amount)`.
7. Execution Guard runs deterministic checks only and reloads live merchant state before payment.
8. Only the guard can call the Razorpay adapter. Its amount parameter is sourced from `verified_quote.amount`.
9. Razorpay Checkout returns order/payment/signature fields to the server; the server verifies the HMAC before recording payment success.

## Structured agent state

Each agent session persists an explicit `AgentTaskState` in SQLite alongside model messages. The state includes the original objective, extracted required items/preferences/budget, cart ID, active quote/grant, order ID and phase. Trusted approval data is inserted by the host, not accepted from user-provided state.

## Dynamic recovery

When merchant state changes after approval, the guard compares current revision, canonical digest and amount with the signed quote and returns `QUOTE_CHANGED`. The failure travels back through the real MCP tool result into the same model session. The LLM decides which normal merchant tools to call next. A new committed quote always requires fresh user approval.

## Payment failure

A Razorpay/order rail failure occurs only after quote integrity verification. It is recorded as `PAYMENT_FAILED` with `stage=PAYMENT_RAIL`, `quote_integrity=VERIFIED` and `retry_allowed=true`. The same unconsumed grant may retry while still valid. A created order consumes the grant; later duplicate execution returns the already-created order idempotently.
