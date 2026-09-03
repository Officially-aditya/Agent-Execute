# Threat model

## Protected assets

- user-approved amount and currency
- exact cart composition/pricing state
- merchant signing private key
- Razorpay secret
- LLM API key
- approval/grant/replay state
- payment/order provenance

## Main threats and controls

| Threat | Control |
|---|---|
| Model invents/changes payment amount | MCP execution primitive accepts only `grant_id`; guard derives amount from signed quote |
| Browser tampers with amount | browser never supplies order amount to server payment creation |
| Merchant price/fee/discount changes after approval | cart revision + fresh canonical digest + total are re-read and compared before Razorpay |
| Approval reused for another quote | approval/grant bind quote ID + digest + amount + currency + expiry |
| Forged merchant quote | Ed25519 signature verified by Execution Guard |
| Expired authorization | quote, approval and grant expiry checked deterministically |
| Replay/duplicate execution | unique quote/grant nonces + persisted execution idempotency record |
| Concurrent duplicate call | execution claim is persisted before rail invocation |
| Rail transient failure | explicit `PAYMENT_FAILED` state; retry allowed only after integrity passed and before grant consumption |
| Fake payment success in browser | server verifies Razorpay order/payment/signature HMAC and requires order created by this system |
| Admin/demo controller forces model action | admin surface only mutates merchant state; it has no agent control endpoint |
| Secrets leak to browser/model | Razorpay secret/signing key/LLM key remain server-side; only public Razorpay key ID is exposed |

## Non-goals for buildathon

Production user identity, real merchant integrations, PCI card handling, fraud/risk scoring, settlement/reconciliation and multi-merchant key management are outside this test product. Razorpay Checkout handles payment UI; Agent Execute never receives card data.
