# 5-minute Buildathon demo script

The goal of the recording is to prove that Agent Execute is a real agentic product with a deterministic payment boundary, not a scripted commerce demo.

## 0:00–0:30 — Problem

Opening line:

> AI agents can shop against live merchant state, but that state can change between what the agent saw, what the user approved, and what finally reaches the payment rail.

Show the product briefly, then state the failure mode: price, discount, fee, inventory, or cart state can change after the agent formed its plan.

## 0:30–1:00 — Core idea

Show the README architecture diagram.

Say:

> Agent Execute lets AI decide commerce actions, but deterministic software authorizes money movement. The LLM can choose what to buy; it can never choose what Razorpay charges.

Highlight:

```text
SEEN = COMMITTED = APPROVED = CHARGED
```

and the critical API shape:

```text
execute_payment(grant_id)
```

There is no model-controlled amount argument.

## 1:00–2:00 — Prove it is a real agent

Enter an arbitrary supported request, for example:

```text
Buy milk, eggs and cereal under ₹500.
```

Show live activity/Judge Mode while the actual model:

- discovers MCP tools;
- searches live products;
- compares options;
- creates and mutates the real server cart;
- checks the authoritative total;
- commits the cart.

Do not narrate every tool call. Let the tool stream prove the sequence is model-generated.

## 2:00–2:40 — Commitment and approval

Show the committed cart card:

- exact total;
- cart revision;
- digest;
- signature status;
- quote expiry.

Explicitly click the approval action.

Say:

> This approval is a trusted UI/server action. The LLM cannot create it. Approval is bound to this exact signed quote, digest, amount, currency, and expiry.

## 2:40–3:30 — Killer failure case

Before execution, open Judge Mode merchant controls and change a financially meaningful value, such as a price, discount, or delivery fee.

Continue the same session.

Show that `execute_payment(grant_id)` reaches the deterministic Execution Guard, which reloads current merchant state and rejects the transaction before Razorpay.

Highlight:

```text
QUOTE_CHANGED
Transaction failed because amount updated
```

Then show the same LLM receiving the structured failure and recovering through normal MCP tools. It should inspect current state and choose a valid recovery dynamically rather than following a predefined replacement sequence.

## 3:30–4:30 — Real Razorpay rail

After recovery:

1. show the fresh committed quote;
2. explicitly approve it again;
3. continue execution;
4. show `EXECUTION_VERIFIED`;
5. show the real Razorpay `order_...`;
6. open Razorpay Test Checkout;
7. complete a Test Mode success;
8. show server-side payment signature verification.

Say:

> The amount sent to Razorpay came only from the verified persisted quote. It did not come from the model, browser state, or a client request body.

## 4:30–5:00 — Audit proof and close

Open the audit trail and quickly show the chain:

```text
AGENT_TOOL_CALLED
QUOTE_COMMITTED
QUOTE_APPROVED
EXECUTION_REQUESTED
EXECUTION_BLOCKED / QUOTE_CHANGED
AGENT_TOOL_CALLED
QUOTE_COMMITTED
QUOTE_APPROVED
EXECUTION_VERIFIED
RAZORPAY_ORDER_CREATED
RAZORPAY_CHECKOUT_OPENED
RAZORPAY_PAYMENT_SUCCESS
PAYMENT_SIGNATURE_VERIFIED
```

Close with:

> AI decides commerce actions. Deterministic software authorizes money movement.

Optional final line:

> The recorded scenario is not special. Judges can clone the repo, enter a different supported shopping request, create their own merchant-state race condition, and run the same code path themselves.

## Recording rules

- Keep Judge Mode visible only when it proves a claim; keep the normal product UI dominant.
- Never expose private chain-of-thought. Show tool name, arguments, result, persisted state, guard result, and audit evidence.
- Do not spend time explaining cryptographic primitives in depth; show what guarantee they create.
- Use a fresh session and a fresh merchant reset before recording.
- Verify Razorpay Test Mode credentials and the public key configuration before starting the take.
- Keep a second arbitrary prompt ready in case you want a final unscripted proof after the primary flow.
