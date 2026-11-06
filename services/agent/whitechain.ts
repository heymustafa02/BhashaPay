import "dotenv/config";
import { randomBytes } from "node:crypto";
import { Wallet, getAddress, hexlify } from "ethers";
import { PaymentSettledActionError } from "../../packages/shared/payment-errors";

const domain = {
  name: "Tether USD",
  version: "1",
  chainId: 1874,
  verifyingContract:
    process.env.WHITECHAIN_USDT_ADDRESS ?? "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7",
};

const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export async function payForWhitechainTranslation(input: {
  serviceId: string;
  merchant: string;
  amount: string;
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  idempotencyKey: string;
  endpoint?: string;
}): Promise<unknown> {
  const payerPrivateKey = process.env.WHITECHAIN_PAYER_PRIVATE_KEY;
  if (!payerPrivateKey) {
    throw new Error("WHITECHAIN_PAYER_PRIVATE_KEY is required for Whitechain EIP-3009 payments.");
  }
  const wallet = new Wallet(payerPrivateKey);
  const now = Math.floor(Date.now() / 1000);
  const validAfter = String(now - 1);
  const validBefore = String(now + 120);
  const nonce = hexlify(randomBytes(32));
  const authorization = {
    from: wallet.address,
    to: getAddress(input.merchant),
    value: BigInt(input.amount),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  };

  const endpoint = input.endpoint ?? "http://localhost:4021/whitechain/translate";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({
      serviceId: input.serviceId,
      payer: wallet.address,
      amount: input.amount,
      validAfter,
      validBefore,
      nonce,
      signature: await wallet.signTypedData(domain, authorizationTypes, authorization),
      text: input.text,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
    }),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    if (
      typeof result === "object" &&
      result !== null &&
      "error" in result &&
      typeof result.error === "object" &&
      result.error !== null &&
      "code" in result.error &&
      result.error.code === "SETTLED_ACTION_FAILED" &&
      "payment" in result &&
      typeof result.payment === "object" &&
      result.payment !== null
    ) {
      const payment = result.payment;
      if (
        "transactionHash" in payment && typeof payment.transactionHash === "string" &&
        "explorerUrl" in payment && typeof payment.explorerUrl === "string" &&
        "receiptId" in payment && typeof payment.receiptId === "string" &&
        "payer" in payment && typeof payment.payer === "string" &&
        "receipt" in payment
      ) {
        throw new PaymentSettledActionError(
          "Whitechain payment settled but the protected action failed; another rail will not be attempted.",
          {
            txHash: payment.transactionHash,
            explorerUrl: payment.explorerUrl,
            receiptId: payment.receiptId,
            payer: payment.payer,
            receipt: payment.receipt,
          },
        );
      }
    }
    throw new Error(`Whitechain payment failed (${response.status}): ${JSON.stringify(result)}`);
  }
  return result;
}
