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

test("speech transcription and OCR send inline media to Gemini", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  const requests: Array<{ url: string; apiKey: string | null; body: Record<string, unknown> }> = [];
  process.env.GEMINI_API_KEY = "test-gemini-key";
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      apiKey: new Headers(init?.headers).get("x-goog-api-key"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "recognized text" }] } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const audioBase64 = Buffer.from("audio bytes").toString("base64");
    const imageBase64 = Buffer.from("image bytes").toString("base64");
    assert.equal(
      await transcribeAudio({ audioBase64, fileName: "clip.webm", mimeType: "audio/webm" }),
      "recognized text",
    );
    assert.equal(
      await extractDocumentText({ imageBase64, mimeType: "image/png", sourceLanguage: "Hindi" }),
      "recognized text",
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[0].apiKey, "test-gemini-key");
    assert.equal(requests[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    const audioContents = requests[0].body.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    assert.deepEqual(audioContents[0].parts[1].inlineData, { mimeType: "audio/webm", data: audioBase64 });
    const imageContents = requests[1].body.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    assert.deepEqual(imageContents[0].parts[1].inlineData, { mimeType: "image/png", data: imageBase64 });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalApiKey;
  }
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
