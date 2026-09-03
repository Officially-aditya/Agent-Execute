export default function handler(_req: any, res: any) {
  res.status(200).json({
    ok: true,
    service: 'agent-execute',
    runtime: 'vercel-node',
    database_configured: Boolean(
      process.env.NEON_DATABASE_URL?.startsWith('postgres') ||
      process.env.DATABASE_URL?.startsWith('postgres') ||
      process.env.POSTGRES_URL?.startsWith('postgres')
    ),
    llm_configured: Boolean(process.env.LLM_API_KEY),
    llm_model: process.env.LLM_MODEL || null,
    llm_base_url_configured: Boolean(process.env.LLM_BASE_URL),
    razorpay_test_configured: Boolean(
      process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') && process.env.RAZORPAY_KEY_SECRET
    ),
    merchant_signing_keys_configured: Boolean(
      process.env.MERCHANT_SIGNING_PRIVATE_KEY && process.env.MERCHANT_SIGNING_PUBLIC_KEY
    ),
  });
}
