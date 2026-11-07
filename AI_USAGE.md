# AI usage

BhashaPay was built with AI assistance during ETHGlobal Mumbai 2026.

**Tools:** Antigravity (AI coding agent) for code generation, and Claude (chat assistant) for planning the project and drafting prompts.

## How the build was directed

I worked in stages, giving the agent a written spec for each one rather than asking for the whole project at once.

1. **Initial spec.** A pay-per-call marketplace for Indic-language AI services (translation, speech-to-text, OCR) using the x402 payment protocol, plus an agent that discovers services, compares price and quality, and pays within a budget. Payments on Hedera testnet and on Whitechain Sepolia, with a Hedera Consensus Service audit log. Milestones were defined in order, with a stack chosen up front (Next.js, Express, SQLite, Foundry).
2. **Extension.** Solidity contracts (service registry, settlement with receipts and replay protection, onchain spend policy) with Foundry tests, a persistent backend with run, payment and approval endpoints, idempotency and rate limiting, and the dashboard pages.

Rules I set for the agent throughout:

- Read the partner documentation before writing integration code.
- Never fabricate a payment or a transaction ID.
- Keep secrets in `.env` only, and validate all payment results on the backend.
- Make small commits as work progresses.

## My role

- Chose the project direction, partner technologies and scope.
- Wrote the specs and constraints above and directed each stage.
- Set up the environment configuration and the repository.
- Reviewed and corrected the README and submission materials so they describe the project accurately.
- TODO: add anything else you really did (ran the build or tests, fixed an issue, edited code by hand).

## Pre-existing work

None. The repository was started during the hackathon.