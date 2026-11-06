# Local setup

This guide covers installing BhashaPay, running the dashboard and API, verifying the project, and the optional testnet configuration needed for paid services.

## 1. Prerequisites

- Node.js 20.9 or newer and npm.
- PowerShell on Windows (commands below use PowerShell syntax).
- A provider API key for the OpenAI-compatible API if you want to run the API. The API requires a non-empty `LLM_API_KEY` at startup.
- Testnet accounts and contracts only if you intend to make real paid requests.

The project uses SQLite and creates its local database automatically; a separate database server is not required. Foundry is included as a project dependency for contract tests and can be invoked with `npm exec -- forge`.

## 2. Install dependencies and configure the API

From the repository root:

```powershell
npm ci
Copy-Item .env.example .env
```

Edit `.env` and set at least:

| Variable | Required for | Value |
| --- | --- | --- |
| `PORT` | API | Leave `4021` unless that port is in use. |
| `HEDERA_PAY_TO_ACCOUNT_ID` | API startup | Your Hedera testnet merchant account ID in `0.0.x` format. |
| `LLM_API_KEY` | API startup and model calls | Your provider key. |
| `LLM_BASE_URL` | Non-default provider | OpenAI-compatible API base URL; defaults to `https://api.openai.com/v1`. |
| `LLM_MODEL` | Translation and agent selection | Model name supported by your provider. |
| `DATABASE_PATH` | API persistence | Defaults to `./data/bhashapay.sqlite`; parent folders are created automatically. |
| `FRONTEND_ORIGIN` | Browser-to-API requests | Dashboard origin, defaults to `http://localhost:3000`. |

`HEDERA_PAY_TO_ACCOUNT_ID` must have the right format for the API to start. For actual Hedera payments it must be a valid testnet merchant account associated with the testnet USDC token. Never use mainnet accounts or commit `.env`.

The API always needs `LLM_API_KEY` to start, even if you only want to inspect the dashboard. For read-only local browsing, a non-empty placeholder key can start the API, but provider-backed actions will not work until it is replaced with a valid key.

## 3. Start the API and dashboard

Open two PowerShell terminals at the repository root.

**Terminal 1 — API**

```powershell
npm run api:dev
```

Check that it is ready:

```powershell
Invoke-RestMethod http://localhost:4021/health
```

**Terminal 2 — web dashboard**

```powershell
npm run dev
```

Open <http://localhost:3000>. The dashboard routes are `/`, `/marketplace`, `/agent`, `/payments`, and `/audit`.

The browser API URL defaults to `http://localhost:4021`. If the API is hosted elsewhere, set `NEXT_PUBLIC_API_URL` in `apps/web/.env.local` (not the repository-root `.env`), or set it in the PowerShell terminal before starting Next.js:

```powershell
$env:NEXT_PUBLIC_API_URL = "http://localhost:4021"
npm run dev
```

The API initializes its SQLite schema on first launch. Until services are registered, the marketplace and agent service selector will be empty. The agent run form requires active services and a usable payment rail; deploying a registry and running the service seed in section 5 populates them.

## 4. Run checks

From the repository root:

```powershell
npm test
npm run lint
npx tsc --noEmit
npm run build
npm run contracts:test
```

These commands do not make testnet payments. To run the production dashboard locally after building:

```powershell
npm run start
```

## 5. Optional: deploy and register Whitechain services

This section is only needed for a populated registry and Whitechain settlement. It uses Whitechain Sepolia (chain ID `1874`), test USDT, and test WBT for gas. Obtain testnet funds from the network's official faucet before deployment.

1. In `.env`, configure `WHITECHAIN_RPC_URL`, `WHITECHAIN_USDT_ADDRESS`, `WHITECHAIN_DEPLOYER_ADDRESS`, `WHITECHAIN_DEPLOYER_PRIVATE_KEY`, `WHITECHAIN_RELAYER_ADDRESS`, and `WHITECHAIN_MAX_SETTLEMENT`. The included test token address and RPC URL are in `.env.example`; confirm they remain current before deploying.
2. Run the contract suite:

   ```powershell
   npm run contracts:test
   ```

3. Deploy the registry and settlement contracts:

   ```powershell
   $privateKeyLine = Get-Content .env | Where-Object { $_ -match '^WHITECHAIN_DEPLOYER_PRIVATE_KEY=' } | Select-Object -First 1
   if (-not $privateKeyLine) { throw "WHITECHAIN_DEPLOYER_PRIVATE_KEY is missing from .env." }
   $env:WHITECHAIN_DEPLOYER_PRIVATE_KEY = $privateKeyLine.Substring($privateKeyLine.IndexOf('=') + 1)
   npm exec -- forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.whitechain.io/ --private-key $env:WHITECHAIN_DEPLOYER_PRIVATE_KEY --broadcast
   $deployExitCode = $LASTEXITCODE
   Remove-Item Env:WHITECHAIN_DEPLOYER_PRIVATE_KEY
   Remove-Variable privateKeyLine
   if ($deployExitCode -ne 0) { throw "Foundry deployment failed with exit code $deployExitCode." }
   ```

   Foundry reads the remaining deployment settings from the root `.env`. Keep the deployment output. The deploy script does not automatically write addresses to configuration.
4. Add the deployed registry and settlement addresses to `.env` as `WHITECHAIN_REGISTRY_ADDRESS` and `WHITECHAIN_SETTLEMENT_ADDRESS`.
5. To seed services and their local SQLite records, also configure `HEDERA_PAY_TO_ACCOUNT_ID`, then run:

   ```powershell
   npm run services:seed
   ```

   The seed is safe to rerun: existing on-chain service IDs are not registered twice, and local service rows are updated.
6. Restart the API. The dashboard should now show active services from the local database and the configured on-chain registry.

The seed registers translation, speech transcription, and OCR offers. Hedera prices are $0.01 for translation, $0.05 for transcription, and $0.03 for OCR. The agent currently uses Whitechain only for translation; STT and OCR use Hedera.

## 6. Optional: enable paid Hedera services

The server-side paid routes require testnet credentials and HCS audit configuration. Set these values in `.env`:

- `HEDERA_PAY_TO_ACCOUNT_ID`: merchant account, associated with testnet USDC (`0.0.429274`).
- `HEDERA_CLIENT_ACCOUNT_ID` and `HEDERA_CLIENT_PRIVATE_KEY`: funded testnet payer, also associated with that token.
- `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_PRIVATE_KEY`, and `HEDERA_AUDIT_TOPIC_ID`: testnet account and topic used for payment auditing.
- `LLM_API_KEY` and, as needed, `LLM_BASE_URL`, `LLM_MODEL`, `STT_MODEL`, and `OCR_MODEL`.

Restart `npm run api:dev` after changing environment variables. Once a service is seeded, the agent can run translation, transcription, or OCR from `/agent` with its corresponding text or uploaded media. The direct paid translation demo can be run in another terminal with:

```powershell
npm run demo:translate
```

The demo requires the Hedera payer settings above. It sends a real testnet payment; do not run it unless the configured payer and merchant are testnet accounts with the required token association and funds.

## 7. Optional: enable Whitechain translation settlement

The Whitechain facilitator holds the relayer key and must only be reachable by the API. Set these `.env` values after deploying contracts:

- `WHITECHAIN_REGISTRY_ADDRESS` and `WHITECHAIN_SETTLEMENT_ADDRESS`.
- `WHITECHAIN_RELAYER_PRIVATE_KEY` for the allowlisted relayer. Its account needs test WBT for gas.
- `WHITECHAIN_PAYER_PRIVATE_KEY` for a testnet USDT payer.
- `FACILITATOR_SHARED_SECRET` with at least 32 characters. Use the same value for API and facilitator configuration.
- `WHITECHAIN_RPC_URL` and `WHITECHAIN_USDT_ADDRESS` matching the deployed network and token.

Open two terminals at the repository root:

```powershell
# Terminal 1
npm run whitechain:dev
```

```powershell
# Terminal 2
npm run api:dev
```

The dashboard agent can use Whitechain for translation when the payer, facilitator secret, seeded service, and contract settings are available. Whitechain does not currently handle STT or OCR. Keep all private keys and the shared secret in server-side `.env`; never put them in `NEXT_PUBLIC_*` variables or browser code.

## Ports and useful scripts

| Service | Default address | Command |
| --- | --- | --- |
| Dashboard | `http://localhost:3000` | `npm run dev` |
| API | `http://localhost:4021` | `npm run api:dev` |
| Whitechain facilitator | `http://localhost:4030` | `npm run whitechain:dev` |

Other scripts:

- `npm run services:seed` — register the service offers after deploying the registry.
- `npm run demo:translate` — submit a paid Hedera testnet translation.
- `npm run agent:mcp` — start the agent's MCP server on standard input/output for an MCP client.

## Troubleshooting

- **API exits with a configuration error:** check that `.env` is in the repository root and that `HEDERA_PAY_TO_ACCOUNT_ID` and `LLM_API_KEY` are set.
- **Dashboard reports an API error:** confirm the API health check responds and that `FRONTEND_ORIGIN` matches the dashboard origin exactly. If using a non-default API URL, set `NEXT_PUBLIC_API_URL` in `apps/web/.env.local`.
- **No services appear:** the database starts empty. Deploy the registry, configure its address and the deployer key, and run `npm run services:seed`.
- **Paid calls fail:** check testnet token association and balance, service allowlisting and budget limits, HCS operator/topic configuration, LLM model access, and the relevant rail's keys and contract addresses. API and facilitator logs contain request IDs and failure details.
- **A port is already in use:** change `PORT` or `WHITECHAIN_FACILITATOR_PORT` in `.env`; update the dashboard's `NEXT_PUBLIC_API_URL` if the API port changes.
- **Do not copy deployment addresses from examples:** no registry or settlement deployment is included in this repository. Use addresses from your own confirmed testnet deployment.
