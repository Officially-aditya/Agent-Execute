# Judge guide

## Setup

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

## Test A — arbitrary request

Enter: `Buy milk, bread and cereal under ₹400.`

Expected: model-generated MCP search/cart calls, live cart state, signed quote and explicit approval gate.

## Test B — stale quote race

1. Build and approve a quote.
2. Open **Judge Mode → Merchant controls**.
3. Change a product price, discount or delivery fee before execution.
4. Continue execution.

Expected: `QUOTE_CHANGED`; no Razorpay Order is created. The same model receives the structured failure and chooses its own MCP recovery steps. A fresh quote requires fresh approval.

## Test C — real Razorpay Test Checkout

Allow an unchanged approved quote to execute. The UI should display a real `order_...` from Razorpay and enable **Open Razorpay Test Checkout**. Complete a Test Mode success and inspect `PAYMENT_SIGNATURE_VERIFIED` in Audit trail.

## Test D — replay/idempotency

Retry `execute_payment` for a grant that already created an order. Expected: existing order returned; no second order creation. Reusing/tampering authorization bindings is blocked.

## Things to inspect

- Agent / MCP tab: tool name, arguments and structured results
- Current cart: authoritative cart revision and totals
- Quote card: amount, digest and expiry
- Audit trail: quote → approval → execution request/block/pass → Razorpay order/payment verification
- Merchant controls: world-state mutations only; no scenario/demo controller
