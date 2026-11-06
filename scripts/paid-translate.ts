import "dotenv/config";
import { randomUUID } from "node:crypto";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

const accountId = process.env.HEDERA_CLIENT_ACCOUNT_ID;
const privateKey = process.env.HEDERA_CLIENT_PRIVATE_KEY;
const endpoint = process.env.TRANSLATE_URL ?? "http://localhost:4021/translate";

async function main(): Promise<void> {
  if (!accountId || !/^0\.0\.\d+$/.test(accountId)) {
    throw new Error("HEDERA_CLIENT_ACCOUNT_ID must be a Hedera testnet account ID (0.0.x).");
  }
  if (!privateKey) {
    throw new Error("HEDERA_CLIENT_PRIVATE_KEY is required.");
  }

  const signer = createClientHederaSigner(
    accountId,
    PrivateKey.fromStringECDSA(privateKey),
    { network: "hedera:testnet" },
  );
  const client = new x402Client().register("hedera:*", new ExactHederaScheme(signer));
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const response = await fetchWithPayment(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({
      text: "नमस्ते, आप कैसे हैं?",
      sourceLanguage: "Hindi",
      targetLanguage: "English",
    }),
  });

  const body: unknown = await response.json();
  const settlement = new x402HTTPClient(client).getPaymentSettleResponse((name) =>
    response.headers.get(name),
  );

  if (!response.ok) {
    throw new Error(
      `Paid translation failed with HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  if (!settlement?.success) {
    throw new Error(`No successful x402 settlement was reported: ${JSON.stringify(settlement)}`);
  }

  console.log("Translation response:", JSON.stringify(body, null, 2));
  console.log("Verified x402 settlement response:", JSON.stringify(settlement, null, 2));
}

main().catch((error: unknown) => {
  console.error("Paid translation failed:", error);
  process.exitCode = 1;
});
