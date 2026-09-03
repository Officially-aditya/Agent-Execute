# Judge guide

## 2–3 minute setup

```bash
git clone https://github.com/Officially-aditya/Agent-Execute.git
cd Agent-Execute
cp .env.example .env
# Add LLM + Razorpay Test credentials
npm install
npm run setup
npm run dev
```

Open `http://localhost:3001`.

The merchant itself is simulated; the LLM call, MCP transport, merchant state, quote cryptography, approval/grant chain, Execution Guard, Razorpay Test Order creation, Test Checkout, payment verification, and audit trail are real runtime paths.

## Test A — arbitrary request

Enter: `Buy milk, bread and cereal under ₹400.`

Expected: model-generated MCP search/cart calls, live cart state, signed quote and explicit approval gate. Try different combinations; there is no predefined shopping sequence.

## Test B — stale quote race

1. Build and approve a quote.
2. Open **Judge Mode → Merchant controls**.
3. Change a product price, inventory, discount or delivery fee before execution.
4. Continue execution.

Expected: `QUOTE_CHANGED` or `STALE_CART`; **zero Razorpay Orders** are created for the rejected execution. The same model receives the structured failure and chooses its own MCP recovery steps. A fresh quote requires fresh approval.

## Test C — real Razorpay Test Checkout

Allow an unchanged approved quote to execute. The UI should display a real `order_...` from Razorpay and enable **Open Razorpay Test Checkout**. Complete a Test Mode success and inspect `RAZORPAY_PAYMENT_SUCCESS` and `PAYMENT_SIGNATURE_VERIFIED` in Audit trail. Use Razorpay Test Checkout failure behavior to verify that a payment-rail failure is represented separately from quote-integrity failure.

## Test D — replay/idempotency

Retry `execute_payment` for a grant that already created an order. Expected: existing order returned; no second order creation. Concurrent duplicate execution, nonce reuse and tampered authorization bindings are blocked before the rail.

## Optional command-line proof of the real paths

With `LLM_API_KEY` configured:

```bash
npm run test:live:llm
```

This sends a new arbitrary request to the configured API model, discovers MCP tools at runtime, executes them over the actual stdio MCP transport, builds a live cart and stops at the approval boundary.

With Razorpay **Test Mode** credentials configured:

```bash
npm run test:live:razorpay
```

This creates a real Razorpay Test Order through the complete `cart → signed quote → approval → grant → Execution Guard → Razorpay` path and verifies the returned amount is exactly the verified quote amount.

These live tests are intentionally opt-in and are skipped in normal public CI because repository secrets are not committed.

## Things to inspect

- Agent / MCP tab: tool name, arguments and structured results
- Current cart: authoritative cart revision and totals
- Quote card: amount, digest, signature status and expiry
- Audit trail: quote → approval → execution request/block/pass → Razorpay order/payment verification
- Merchant controls: world-state mutations only; no scenario/demo controller
- MCP `get_payment_status`: guarded execution plus later Razorpay Checkout/payment state
