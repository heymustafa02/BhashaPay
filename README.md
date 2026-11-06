# BhashaPay

BhashaPay is a pay-per-call marketplace for Indic-language AI services, with an autonomous agent that discovers registered services and pays through x402 on Hedera or EIP-3009 USDT settlement on Whitechain Sepolia.

For complete prerequisites and local run instructions, see [setup.md](./setup.md).

## M1: Hedera testnet translation

The current M1 implementation protects `POST /translate` with the official x402 `exact` scheme on Hedera testnet. It asks for 0.01 test USDC (`0.0.429274`, 10,000 units at six decimals), settles through the public x402 facilitator, and only then calls the configured OpenAI-compatible translation API.

### Project layout

```text
apps/web/app/           Next.js dashboard routes
services/api/           Express x402-protected API and run persistence
services/agent/         Agent runner and payment clients
services/facilitator-whitechain/  Whitechain EIP-3009 relayer
packages/shared/        Payment and spend-policy helpers
contracts/              Whitechain registry and settlement contracts
```

### Setup and run

1. Copy `.env.example` to `.env`.
2. Set `HEDERA_PAY_TO_ACCOUNT_ID` to a Hedera testnet account that is associated with testnet USDC.
3. Set `HEDERA_CLIENT_ACCOUNT_ID` and `HEDERA_CLIENT_PRIVATE_KEY` for a funded Hedera testnet payer. The payer must hold testnet USDC and be associated with `0.0.429274`.
4. Configure `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_PRIVATE_KEY`, and `HEDERA_AUDIT_TOPIC_ID` for HCS payment auditing.
5. Set `LLM_API_KEY` (and optionally `LLM_BASE_URL` and `LLM_MODEL`) for an OpenAI-compatible translation provider.
6. Install dependencies with `npm install`.
7. In separate terminals run `npm run api:dev`, `npm run dev`, then use `npm run demo:translate` for the paid client.

The x402 client signs the requested transfer using the payer's key. The facilitator verifies and settles it, paying the network fee. The API returns the translation only after x402 accepts the payment. Do not expose `.env` or use mainnet credentials for this demo.

### M1 acceptance proof

**Pending:** no transaction has been submitted from this workspace. Add the actual facilitator settlement response and a link to its Hedera testnet transaction on HashScan here only after running the paid client with funded testnet accounts. No transaction ID is fabricated.

### Limitations

- The direct x402 demo is translation-only; the agent also supports Hedera speech transcription and document OCR. Whitechain settlement currently supports translation only.
- Translation requires an OpenAI-compatible provider key.
- The HTTP API, SQLite run/payment state, agent runner, and HCS audit integration are implemented, but paid runs require configured accounts, HCS topic access, a seeded service registry, and provider credentials.
- Service prices for the agent are seeded after deploying the Whitechain registry; STT/OCR use Hedera and require a funded Hedera payer.

## Whitechain contracts (Part A)

Whitechain Sepolia is chain ID `1874`, uses WBT for gas, and exposes the RPC at `https://rpc.testnet.whitechain.io/`. The USDT address is `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`. Its explorer-verified proxy implementation is `0x26425662d126412128967ecf0a02ec48573026f7`; the verified ABI includes EIP-3009 `transferWithAuthorization`, EIP-2612 `permit`, `authorizationState`, and six-decimal USDT metadata. The settlement design uses EIP-3009, so payer authorization is signed offchain and only the allowlisted relayer pays WBT gas.

`BhashaRegistry`, `BhashaSettlement`, and `AgentSpendPolicy` are under `contracts/`. The settlement stores receipts, enforces one-use request hashes, relayer amount limits, pause controls, merchant refunds, and optional per-payer spend policies. No deployment has been made from this workspace yet; see [`packages/shared/deployments.json`](./packages/shared/deployments.json) for the explicitly empty deployment fields. No addresses or transaction IDs are placeholders for real deployments.

```powershell
npm run contracts:test
```

For testnet funding, environment setup, contract deployment, and service registration steps, see [setup.md](./setup.md#5-optional-deploy-and-register-whitechain-services).

Whitechain's documented Foundry verification endpoint is `https://explorer.testnet.whitechain.io/api/`. Deployment requires test WBT from the official faucet. No deployment or explorer verification is claimed until a funded signer is configured and the deployment is confirmed.

## Whitechain rail (Part B)

The private facilitator in `services/facilitator-whitechain/` accepts authenticated requests from the API only. It reads the live service price and active flag from `BhashaRegistry`, verifies the EIP-712 signature against the live Whitechain USDT domain (`Tether USD`, version `1`, chain ID `1874`), checks the authorization nonce, verifies any attached onchain spend policy, and calls `BhashaSettlement`. It waits for one confirmation and checks the emitted settlement receipt before returning a transaction hash and explorer URL. The API independently validates those fields before running translation. The relayer private key is read only by the facilitator and is never returned.

The facilitator limits requests by source IP, service, and payer per minute. Contract-level allowlisting, request-hash replay protection, per-payment maximums, and pausing are enforced independently of the HTTP layer. The idempotency hash binds the API idempotency key and payload hash to the onchain receipt. Repeating an already-settled request retrieves its existing receipt rather than charging again.

With the registry and settlement deployed and environment set, run the API and facilitator in separate terminals with `npm run api:dev` and `npm run whitechain:dev`. The agent signs a short-lived EIP-3009 authorization locally and posts it to `/whitechain/translate`; it does not sign a contract transaction or hold WBT. This flow is implemented but has **not** been submitted on testnet from this workspace: no deployment, USDT payer key, or funded relayer is configured, so no successful or rejected onchain transaction link is claimed.

## API persistence and agent runs (Part C)

The API persists services, runs, payments, receipts, run events, and HCS audit references in SQLite at `DATABASE_PATH` (default `./data/bhashapay.sqlite`). `GET /registry` merges local metadata with live Whitechain registry entries. Run the paid service seed only after deploying the Whitechain registry and setting its address and the merchant/payer configuration:

```powershell
npm run services:seed
npm run api:dev
```

The API exposes `GET /health`, `GET /registry`, `POST /runs`, `GET /runs/:id`, `GET /runs/:id/events` (SSE), `GET /payments`, `GET /receipts/:id`, `POST /approvals/:paymentId`, and `GET /audit`. A run request uses decimal USDC/USDT amounts as strings:

```json
{
  "task": "Translate this Marathi text to English",
  "budget": "0.50",
  "policy": {
    "perMerchantLimit": "0.25",
    "merchantAllowlist": ["0.0.12345"],
    "approvalThreshold": "0.10"
  },
  "input": {
    "text": "नमस्कार",
    "sourceLanguage": "Marathi",
    "targetLanguage": "English"
  }
}
```

Idempotency keys are required for direct paid requests. Whitechain settlement keys are bound to the payer, service, and request payload; Hedera requests are persisted before payment middleware and reuse returns the recorded result instead of settling again. Payment attempts are blocked unless an HCS topic and operator credentials are configured, and the audit API reads messages from the Hedera testnet mirror node. Configure `FRONTEND_ORIGIN` to the exact dashboard origin before exposing the API. No HCS messages or paid run are claimed from this workspace because the required operator, topic, and funded payer credentials are not configured.

## Dashboard (Part D)

The Next.js dashboard lives in `apps/web/`. Run it with `npm run dev` after setting `NEXT_PUBLIC_API_URL` if the API is not at `http://localhost:4021`. The pages are `/` (overview), `/marketplace`, `/agent` (run form, SSE timeline, and approval modal), `/payments`, and `/audit`. The app uses the configured backend origin and contains no wallet or server keys. It shows explicit loading, empty, API error, denied, and approval states. The production dashboard build is verified locally; no testnet transaction has been produced from the UI.
