import assert from "node:assert/strict";
import test from "node:test";
import { extractDocumentText, transcribeAudio } from "../services/api/providers";
import { PaymentSettledActionError } from "../packages/shared/payment-errors";

test("speech-to-text rejects malformed media before contacting a provider", async () => {
  await assert.rejects(
    transcribeAudio({
      audioBase64: "not-valid-base64!",
      fileName: "clip.webm",
      mimeType: "audio/webm",
    }),
    /valid base64/,
  );
});

test("OCR rejects malformed media before contacting a provider", async () => {
  await assert.rejects(
    extractDocumentText({
      imageBase64: "not-valid-base64!",
      mimeType: "image/png",
    }),
    /valid base64/,
  );
});

test("settled-action failures remain distinguishable for safe rail handling", () => {
  const payment = {
    txHash: `0x${"11".repeat(32)}`,
    explorerUrl: "https://explorer.testnet.whitechain.io/tx/0x123",
    receiptId: "7",
    payer: "0x0000000000000000000000000000000000000001",
    receipt: { amount: "10000" },
  };
  const error = new PaymentSettledActionError("translation failed after settlement", payment);
  assert.equal(error instanceof PaymentSettledActionError, true);
  assert.equal(error.payment.txHash, payment.txHash);
});
