import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { Contract, Interface, JsonRpcProvider, getAddress, isAddress } from "ethers";
import { HTTPFacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { calculateWhitechainRequestHash, hashPayload } from "../../packages/shared/payment";
import { dollarsToUnits } from "../../packages/shared/spend-policy";
import { resolveApproval } from "../agent/approvals";
import { runAgent } from "../agent/runner";
import { writeAuditEvent, readHcsMessages } from "./audit";
import { openDatabase } from "./database";
import { getRegistry } from "./registry";
import { extractDocumentText, transcribeAudio } from "./providers";
import { generateGeminiContent, getGeminiModel } from "./gemini";
import { z } from "zod";

type TranslateRequest = {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
};

class TranslationProviderError extends Error {}
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

const whitechainRequestSchema = z.object({
  serviceId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  payer: z.string().refine(isAddress),
  amount: z.string().regex(/^(0|[1-9]\d*)$/),
  validAfter: z.string().regex(/^(0|[1-9]\d*)$/),
  validBefore: z.string().regex(/^(0|[1-9]\d*)$/),
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  text: z.string().min(1).max(10_000),
  sourceLanguage: z.string().min(1).max(100),
  targetLanguage: z.string().min(1).max(100),
});

const whitechainSettlementSchema = z.object({
  success: z.literal(true),
  receiptId: z.string().regex(/^\d+$/),
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  explorerUrl: z.string().url(),
  receipt: z.object({
    serviceId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    payer: z.string().refine(isAddress),
    merchant: z.string().refine(isAddress),
    amount: z.string().regex(/^(0|[1-9]\d*)$/),
    timestamp: z.string().regex(/^\d+$/),
    requestHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
});
const hederaSettlementSchema = z.object({
  success: z.literal(true),
  transaction: z.string().regex(/^0\.0\.\d+@\d+\.\d+$/),
  network: z.literal("hedera:testnet"),
  payer: z.string().optional(),
  amount: z.string().optional(),
});
const whitechainReceiptAbi = [
  "function getReceipt(uint256) view returns (tuple(bytes32 serviceId,address payer,address merchant,uint256 amount,uint64 timestamp,bytes32 requestHash,bool refunded))",
  "event PaymentSettled(uint256 indexed receiptId,bytes32 indexed serviceId,address indexed payer,address merchant,uint256 amount,bytes32 requestHash)",
];
const whitechainSettlementInterface = new Interface(whitechainReceiptAbi);
const sttRequestSchema = z.object({
  audioBase64: z.string().min(1).max(15_000_000),
  fileName: z.string().min(1).max(200).default("audio.webm"),
  mimeType: z.string().min(1).max(100).default("audio/webm"),
  language: z.string().min(1).max(100).optional(),
});
const ocrRequestSchema = z.object({
  imageBase64: z.string().min(1).max(15_000_000),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  sourceLanguage: z.string().min(1).max(100).optional(),
});

const port = Number(process.env.PORT ?? "4021");
const facilitatorUrl = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const payToAccountId = process.env.HEDERA_PAY_TO_ACCOUNT_ID;
const geminiApiKey = process.env.GEMINI_API_KEY;
const testnetUsdc = "0.0.429274";
const database = openDatabase();
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
const paymentAttemptBuckets = new Map<string, { count: number; resetAt: number }>();
const runInputSchema = z.object({
  task: z.string().min(1).max(2_000),
  budget: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/),
  policy: z.object({
    perMerchantLimit: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/),
    merchantAllowlist: z.array(
      z.string().refine((value) => /^0\.0\.\d+$/.test(value) || isAddress(value)),
    ).max(50),
    approvalThreshold: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/),
  }),
  input: z.object({
    text: z.string().max(10_000).optional(),
    sourceLanguage: z.string().max(100).optional(),
    targetLanguage: z.string().max(100).optional(),
    audioBase64: z.string().max(15_000_000).optional(),
    imageBase64: z.string().max(15_000_000).optional(),
    fileName: z.string().min(1).max(200).optional(),
    mimeType: z.string().min(1).max(100).optional(),
  }).default({}),
});
const approvalSchema = z.object({ decision: z.enum(["approve", "reject"]) });

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
if (!payToAccountId || !/^0\.0\.\d+$/.test(payToAccountId)) {
  throw new Error("HEDERA_PAY_TO_ACCOUNT_ID must be a Hedera testnet account ID (0.0.x).");
}
if (!geminiApiKey) {
  throw new Error("GEMINI_API_KEY is required; translation must be available before payment is accepted.");
}

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const resourceServer = new x402ResourceServer(facilitatorClient).register(
  "hedera:testnet",
  new ExactHederaScheme(),
);

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  const origin = req.header("origin");
  if (origin && origin !== frontendOrigin) {
    res.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Frontend origin is not allowed." } });
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", frontendOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Idempotency-Key, Payment-Signature, X-Payment",
    );
    res.setHeader("Access-Control-Expose-Headers", "Payment-Required, Payment-Response");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: "20mb" }));
app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestId = randomUUID();
  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () => {
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      level: res.statusCode >= 500 ? "error" : "info",
      event: "http_request",
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    }));
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    network: "hedera:testnet",
    persistence: "sqlite",
    hcsAuditConfigured: Boolean(
      process.env.HEDERA_AUDIT_TOPIC_ID &&
      process.env.HEDERA_OPERATOR_ID &&
      process.env.HEDERA_OPERATOR_PRIVATE_KEY
    ),
    whitechainConfigured: Boolean(process.env.WHITECHAIN_SETTLEMENT_ADDRESS),
  });
});

app.get("/registry", async (_req, res, next) => {
  try {
    res.json(await getRegistry(database));
  } catch (error) {
    next(error);
  }
});

app.post("/runs", (req, res) => {
  const parsed = runInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "INVALID_RUN",
        message: "Invalid agent run request.",
        details: parsed.error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
      },
    });
    return;
  }

  try {
    const input = parsed.data;
    const runId = randomUUID();
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO runs (id, task, budget, policy_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    ).run(runId, input.task, dollarsToUnits(input.budget).toString(), JSON.stringify(input), now, now);
    void runAgent(database, runId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      database.prepare(
        "UPDATE runs SET status = 'failed', error_json = ?, updated_at = ?, finished_at = ? WHERE id = ?",
      ).run(JSON.stringify({ message }), new Date().toISOString(), new Date().toISOString(), runId);
      console.error(JSON.stringify({ level: "error", event: "agent_run_failed", runId, message }));
    });
    res.status(202).json({ runId, status: "running" });
  } catch (error) {
    sendError(res, 400, "INVALID_AMOUNT", error instanceof Error ? error.message : String(error));
  }
});

app.get("/runs/:id", (req, res) => {
  const run = database.prepare(
    `SELECT id, task, budget, status, chosen_service_id, result_json, error_json,
            spent, created_at, updated_at, finished_at
     FROM runs WHERE id = ?`,
  ).get(req.params.id);
  if (!run) {
    sendError(res, 404, "RUN_NOT_FOUND", "Agent run was not found.");
    return;
  }
  res.json(run);
});

app.get("/runs/:id/events", (req, res) => {
  const run = database.prepare("SELECT id FROM runs WHERE id = ?").get(req.params.id);
  if (!run) {
    sendError(res, 404, "RUN_NOT_FOUND", "Agent run was not found.");
    return;
  }

  const requestedCursor = Number(req.header("last-event-id") ?? req.query.after ?? 0);
  if (!Number.isSafeInteger(requestedCursor) || requestedCursor < 0) {
    sendError(res, 400, "INVALID_EVENT_CURSOR", "Event cursor must be a non-negative integer.");
    return;
  }
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  let cursor = requestedCursor;
  const timer = setInterval(() => {
    const events = database.prepare(
      "SELECT id, type, message, data_json, created_at FROM run_events WHERE run_id = ? AND id > ? ORDER BY id",
    ).all(req.params.id, cursor) as Array<{
      id: number;
      type: string;
      message: string;
      data_json: string;
      created_at: string;
    }>;
    for (const event of events) {
      cursor = event.id;
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({
        message: event.message,
        data: JSON.parse(event.data_json),
        createdAt: event.created_at,
      })}\n\n`);
    }
    if (events.length === 0) res.write(": keep-alive\n\n");
  }, 500);
  res.on("close", () => clearInterval(timer));
});

app.get("/payments", (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    sendError(res, 400, "INVALID_LIMIT", "limit must be an integer from 1 to 500.");
    return;
  }
  const payments = database.prepare(
    `SELECT id, run_id, service_id, rail, amount, payer, merchant, status, idempotency_key,
            tx_hash, explorer_url, receipt_id, error_json, created_at, updated_at
     FROM payments ORDER BY created_at DESC LIMIT ?`,
  ).all(limit);
  res.json({ payments });
});

app.get("/receipts/:id", (req, res) => {
  const receipt = database.prepare("SELECT * FROM receipts WHERE id = ?").get(req.params.id);
  if (!receipt) {
    sendError(res, 404, "RECEIPT_NOT_FOUND", "Payment receipt was not found.");
    return;
  }
  res.json(receipt);
});

app.post("/approvals/:paymentId", (req, res) => {
  const parsed = approvalSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "INVALID_APPROVAL", "decision must be approve or reject.");
    return;
  }
  const payment = database.prepare("SELECT id, status FROM payments WHERE id = ?").get(req.params.paymentId) as
    | { id: string; status: string }
    | undefined;
  if (!payment || payment.status !== "awaiting_approval") {
    sendError(res, 409, "APPROVAL_NOT_PENDING", "Payment is not waiting for approval.");
    return;
  }
  const approved = parsed.data.decision === "approve";
  if (!resolveApproval(payment.id, approved)) {
    sendError(res, 409, "APPROVAL_EXPIRED", "The agent is no longer waiting for this approval.");
    return;
  }
  database.prepare("UPDATE payments SET status = ?, updated_at = ? WHERE id = ?")
    .run(approved ? "approved" : "denied", new Date().toISOString(), payment.id);
  res.json({ paymentId: payment.id, decision: parsed.data.decision });
});

app.get("/audit", async (req, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      sendError(res, 400, "INVALID_LIMIT", "limit must be an integer from 1 to 100.");
      return;
    }
    res.json({ messages: await readHcsMessages(limit) });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/translate",
  (req, res, next) => {
    if (!isTranslateRequest(req.body)) {
      sendError(res, 400, "INVALID_REQUEST", "Expected text, sourceLanguage, and targetLanguage strings.");
      return;
    }
    res.locals.translateInput = req.body;
    next();
  },
  async (req, res, next) => {
    try {
      const key = z.string().min(8).max(200).safeParse(req.header("idempotency-key"));
      if (!key.success) {
        sendError(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required.");
        return;
      }
      const input = req.body as TranslateRequest;
      const requestHash = hashPayload(input);
      const hasPaymentPayload = Boolean(req.header("payment-signature") || req.header("x-payment"));
      const prior = database.prepare(
        "SELECT * FROM payments WHERE idempotency_key = ?",
      ).get(key.data) as {
        id: string;
        request_hash: string | null;
        status: string;
        response_json: string | null;
        payment_response_json: string | null;
      } | undefined;
      if (prior) {
        if (prior.request_hash?.toLowerCase() !== requestHash.toLowerCase()) {
          sendError(res, 409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different request.");
          return;
        }
        if (prior.status === "settled" && prior.response_json && prior.payment_response_json) {
          res.setHeader("PAYMENT-RESPONSE", prior.payment_response_json);
          res.setHeader("Idempotency-Replayed", "true");
          res.json(JSON.parse(prior.response_json) as unknown);
          return;
        }
        if (
          (prior.status === "settled" || prior.status === "settled_action_failed") &&
          prior.payment_response_json
        ) {
          const translated = await translate(input);
          const responseBody = {
            sourceLanguage: input.sourceLanguage,
            targetLanguage: input.targetLanguage,
            translation: translated,
          };
          database.prepare("UPDATE payments SET response_json = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(responseBody), new Date().toISOString(), prior.id);
          res.setHeader("PAYMENT-RESPONSE", prior.payment_response_json);
          res.setHeader("Idempotency-Replayed", "true");
          res.json(responseBody);
          return;
        }
        sendError(res, 409, "IDEMPOTENCY_IN_PROGRESS", "This idempotent payment attempt has already been processed.");
        return;
      }

      if (!hasPaymentPayload) {
        next();
        return;
      }
      if (!allowPaymentAttempt(req.ip ?? "unknown")) {
        sendError(res, 429, "PAYMENT_ATTEMPT_RATE_LIMITED", "Too many signed payment attempts from this IP.");
        return;
      }

      const paymentId = randomUUID();
      const createdAt = new Date().toISOString();
      const inserted = database.prepare(
        `INSERT OR IGNORE INTO payments
          (id, service_id, rail, amount, merchant, status, idempotency_key, request_hash, created_at, updated_at)
         VALUES (?, 'translate', 'hedera', '10000', ?, 'attempting', ?, ?, ?, ?)`,
      ).run(paymentId, payToAccountId, key.data, requestHash, createdAt, createdAt);
      if (inserted.changes !== 1) {
        sendError(res, 409, "IDEMPOTENCY_IN_PROGRESS", "This idempotent payment attempt has already been processed.");
        return;
      }

      res.locals.hederaPaymentId = paymentId;
      res.once("finish", () => {
        const row = database.prepare("SELECT status FROM payments WHERE id = ?").get(paymentId) as
          | { status: string }
          | undefined;
        if (row?.status !== "attempting") return;
        const responseHeader = responseHeaderString(res.getHeader("PAYMENT-RESPONSE"));
        let settlement: z.infer<typeof hederaSettlementSchema> | undefined;
        if (responseHeader) {
          try {
            settlement = readHederaSettlement(responseHeader);
          } catch (error) {
            console.error("Could not validate x402 settlement response after request failure:", error);
          }
        }
        const status = settlement ? "settled_action_failed" : "denied";
        const finishedAt = new Date().toISOString();
        database.prepare(
          `UPDATE payments
           SET status = ?, payer = ?, tx_hash = ?, explorer_url = ?, receipt_id = ?,
               payment_response_json = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          status,
          settlement?.payer ?? null,
          settlement?.transaction ?? null,
          settlement
            ? `https://hashscan.io/testnet/transaction/${encodeURIComponent(settlement.transaction)}`
            : null,
          settlement?.transaction ?? null,
          responseHeader,
          finishedAt,
          paymentId,
        );
        if (settlement) storeHederaReceipt(database, paymentId, settlement, finishedAt);
        void writeAuditEvent(database, {
          eventId: randomUUID(),
          paymentId,
          rail: "hedera",
          status,
          serviceId: "translate",
          amount: settlement?.amount ?? "10000",
          payer: settlement?.payer,
          merchant: payToAccountId,
          txHash: settlement?.transaction,
          receiptId: settlement?.transaction,
          errorCode: `HTTP_${res.statusCode}`,
          createdAt: finishedAt,
        }).catch((error: unknown) => {
          console.error("Failed to write Hedera request outcome to HCS:", error);
        });
      });
      try {
        await writeAuditEvent(database, {
          eventId: randomUUID(),
          paymentId,
          rail: "hedera",
          status: "attempting",
          serviceId: "translate",
          amount: "10000",
          merchant: payToAccountId,
          createdAt,
        });
      } catch (error) {
        database.prepare("UPDATE payments SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify({ code: "HCS_AUDIT_FAILED" }), new Date().toISOString(), paymentId);
        throw error;
      }
      next();
    } catch (error) {
      next(error);
    }
  },
  paymentMiddleware(
    {
      "POST /translate": {
        accepts: [
          {
            scheme: "exact",
            price: { amount: "10000", asset: testnetUsdc },
            network: "hedera:testnet",
            payTo: payToAccountId,
            maxTimeoutSeconds: 180,
          },
        ],
        description: "Indic language translation",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
  async (req, res, next) => {
    try {
      const input: unknown = res.locals.translateInput;
      if (!isTranslateRequest(input)) {
        throw new Error("Validated translation input was not available.");
      }

      const translation = await translate(input);
      const responseBody = {
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        translation,
      };
      const paymentId = res.locals.hederaPaymentId;
      if (typeof paymentId !== "string") {
        throw new Error("Hedera idempotency record was not available.");
      }
      const responseHeader = responseHeaderString(res.getHeader("PAYMENT-RESPONSE"));
      if (!responseHeader) throw new Error("x402 facilitator response was missing.");
      const payment = readHederaSettlement(responseHeader);
      const settledAt = new Date().toISOString();
      database.prepare(
        `UPDATE payments
         SET status = 'settled', payer = ?, tx_hash = ?, explorer_url = ?, receipt_id = ?,
             response_json = ?, payment_response_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        payment.payer ?? null,
        payment.transaction,
        `https://hashscan.io/testnet/transaction/${encodeURIComponent(payment.transaction)}`,
        payment.transaction,
        JSON.stringify(responseBody),
        responseHeader,
        settledAt,
        paymentId,
      );
      storeHederaReceipt(database, paymentId, payment, settledAt);
      await writeAuditEvent(database, {
        eventId: randomUUID(),
        paymentId,
        rail: "hedera",
        status: "settled",
        serviceId: "translate",
        amount: payment.amount ?? "10000",
        payer: payment.payer,
        merchant: payToAccountId,
        txHash: payment.transaction,
        receiptId: payment.transaction,
        createdAt: settledAt,
      });
      res.json(responseBody);
    } catch (error) {
      next(error);
    }
  },
);

registerHederaMediaRoute(
  "/stt",
  "stt",
  "50000",
  "Indic-language speech transcription",
  sttRequestSchema,
  async (input) => ({
    transcription: await transcribeAudio({
      audioBase64: input.audioBase64,
      fileName: input.fileName,
      mimeType: input.mimeType,
      language: input.language,
    }),
  }),
);
registerHederaMediaRoute(
  "/ocr",
  "ocr",
  "30000",
  "Indic-language document OCR",
  ocrRequestSchema,
  async (input) => ({
    text: await extractDocumentText({
      imageBase64: input.imageBase64,
      mimeType: input.mimeType,
      sourceLanguage: input.sourceLanguage,
    }),
  }),
);

app.post("/whitechain/translate", async (req, res, next) => {
  let paymentId: string | undefined;
  try {
    const parsed = whitechainRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "INVALID_REQUEST",
          message: "Invalid Whitechain translation request.",
          details: parsed.error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
        },
      });
      return;
    }

    const idempotencyKey = z.string().min(8).max(200).safeParse(req.header("idempotency-key"));
    if (!idempotencyKey.success) {
      res.status(400).json({
        error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "A valid Idempotency-Key header is required." },
      });
      return;
    }

    const facilitatorUrl = process.env.WHITECHAIN_FACILITATOR_URL ?? "http://localhost:4030";
    const facilitatorSecret = process.env.FACILITATOR_SHARED_SECRET;
    if (!facilitatorSecret) {
      res.status(503).json({
        error: { code: "FACILITATOR_NOT_CONFIGURED", message: "Whitechain settlement is not configured." },
      });
      return;
    }

    const input = parsed.data;
    const paymentPayload = {
      text: input.text,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
    };
    const payloadHash = hashPayload(paymentPayload);
    const payer = getAddress(input.payer);
    const requestHash = calculateWhitechainRequestHash({
      idempotencyKey: idempotencyKey.data,
      serviceId: input.serviceId,
      payer,
      payloadHash,
    });
    const prior = database.prepare(
      "SELECT * FROM payments WHERE idempotency_key = ?",
    ).get(idempotencyKey.data) as {
      id: string;
      request_hash: string | null;
      status: string;
      response_json: string | null;
      receipt_id: string | null;
    } | undefined;
    if (prior) {
      if (prior.request_hash?.toLowerCase() !== requestHash.toLowerCase()) {
        sendError(res, 409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different request.");
        return;
      }
      if (prior.status !== "settled") {
        sendError(res, 409, "IDEMPOTENCY_IN_PROGRESS", "This idempotent payment attempt has already been processed.");
        return;
      }
      if (prior.response_json) {
        res.json(JSON.parse(prior.response_json) as unknown);
        return;
      }
      const receiptRow = database.prepare("SELECT * FROM receipts WHERE id = ?").get(prior.receipt_id) as
        | {
            rail: string;
            tx_hash: string;
            explorer_url: string;
            receipt_json: string;
          }
        | undefined;
      if (!receiptRow) {
        sendError(res, 503, "SETTLED_RECEIPT_MISSING", "Settled payment receipt is unavailable.");
        return;
      }
      const translation = await translate(paymentPayload);
      const responseBody = {
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        translation,
        payment: {
          rail: receiptRow.rail,
          transactionHash: receiptRow.tx_hash,
          transactionUrl: receiptRow.explorer_url,
          receiptId: prior.receipt_id,
          receipt: JSON.parse(receiptRow.receipt_json) as unknown,
        },
      };
      database.prepare("UPDATE payments SET response_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(responseBody), new Date().toISOString(), prior.id);
      res.json(responseBody);
      return;
    }

    paymentId = randomUUID();
    const createdAt = new Date().toISOString();
    const inserted = database.prepare(
      `INSERT OR IGNORE INTO payments
        (id, service_id, rail, amount, payer, status, idempotency_key, request_hash, created_at, updated_at)
       VALUES (?, ?, 'whitechain', ?, ?, 'attempting', ?, ?, ?, ?)`,
    ).run(
      paymentId,
      input.serviceId,
      input.amount,
      payer,
      idempotencyKey.data,
      requestHash,
      createdAt,
      createdAt,
    );
    if (inserted.changes !== 1) {
      sendError(res, 409, "IDEMPOTENCY_IN_PROGRESS", "This idempotent payment attempt has already been processed.");
      return;
    }
    await writeAuditEvent(database, {
      eventId: randomUUID(),
      paymentId,
      rail: "whitechain",
      status: "attempting",
      serviceId: input.serviceId,
      amount: input.amount,
      payer,
      createdAt,
    });

    const facilitatorResponse = await fetch(`${facilitatorUrl.replace(/\/+$/, "")}/settle`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${facilitatorSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        serviceId: input.serviceId,
        payer,
        amount: input.amount,
        validAfter: input.validAfter,
        validBefore: input.validBefore,
        nonce: input.nonce,
        signature: input.signature,
        idempotencyKey: idempotencyKey.data,
        payloadHash,
      }),
    });

    const facilitatorBody: unknown = await facilitatorResponse.json();
    if (!facilitatorResponse.ok) {
      const failure = settlementErrorFields(facilitatorBody);
      database.prepare("UPDATE payments SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(failure), new Date().toISOString(), paymentId);
      await writeAuditEvent(database, {
        eventId: randomUUID(),
        paymentId,
        rail: "whitechain",
        status: "failed",
        serviceId: input.serviceId,
        amount: input.amount,
        payer,
        errorCode: failure.code,
        createdAt: new Date().toISOString(),
      });
      res.status(facilitatorResponse.status).json(facilitatorBody);
      return;
    }

    const settlement = whitechainSettlementSchema.safeParse(facilitatorBody);
    if (!settlement.success) {
      console.error("Whitechain facilitator returned an invalid success response:", settlement.error.issues);
      throw new ApiError("Settlement confirmation was invalid.", 502, "INVALID_SETTLEMENT_RESPONSE");
    }
    if (
      settlement.data.receipt.serviceId.toLowerCase() !== input.serviceId.toLowerCase() ||
      getAddress(settlement.data.receipt.payer) !== payer ||
      settlement.data.receipt.amount !== input.amount ||
      settlement.data.receipt.requestHash.toLowerCase() !== requestHash.toLowerCase() ||
      settlement.data.explorerUrl !==
        `https://explorer.testnet.whitechain.io/tx/${settlement.data.transactionHash}`
    ) {
      console.error("Whitechain facilitator settlement fields did not match the request.");
      throw new ApiError("Settlement confirmation did not match the request.", 502, "SETTLEMENT_MISMATCH");
    }

    await verifyWhitechainSettlement(settlement.data, requestHash, payer, input.amount);
    const settlementTime = new Date().toISOString();
    database.prepare(
      "UPDATE payments SET status = 'settled', merchant = ?, tx_hash = ?, explorer_url = ?, receipt_id = ?, updated_at = ? WHERE id = ?",
    ).run(
      settlement.data.receipt.merchant,
      settlement.data.transactionHash,
      settlement.data.explorerUrl,
      settlement.data.receiptId,
      settlementTime,
      paymentId,
    );
    database.prepare(
      `INSERT INTO receipts (id, payment_id, rail, service_id, payer, merchant, amount, tx_hash, explorer_url, receipt_json, created_at)
       VALUES (?, ?, 'whitechain', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      settlement.data.receiptId,
      paymentId,
      input.serviceId,
      payer,
      settlement.data.receipt.merchant,
      input.amount,
      settlement.data.transactionHash,
      settlement.data.explorerUrl,
      JSON.stringify(settlement.data.receipt),
      settlementTime,
    );
    await writeAuditEvent(database, {
      eventId: randomUUID(),
      paymentId,
      rail: "whitechain",
      status: "settled",
      serviceId: input.serviceId,
      amount: input.amount,
      payer,
      merchant: settlement.data.receipt.merchant,
      txHash: settlement.data.transactionHash,
      receiptId: settlement.data.receiptId,
      createdAt: settlementTime,
    });

    const translation = await translate(paymentPayload);
    const responseBody = {
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      translation,
      payment: {
        rail: "whitechain",
        transactionHash: settlement.data.transactionHash,
        transactionUrl: settlement.data.explorerUrl,
        receiptId: settlement.data.receiptId,
        receipt: settlement.data.receipt,
      },
    };
    database.prepare("UPDATE payments SET response_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(responseBody), new Date().toISOString(), paymentId);
    res.json(responseBody);
  } catch (error) {
    if (paymentId) {
      const row = database.prepare(
        "SELECT status, payer, tx_hash, explorer_url, receipt_id FROM payments WHERE id = ?",
      ).get(paymentId) as
        | {
            status: string;
            payer: string | null;
            tx_hash: string | null;
            explorer_url: string | null;
            receipt_id: string | null;
          }
        | undefined;
      if (row?.status === "attempting") {
        const detail = error instanceof Error ? error.message : String(error);
        const code = error instanceof ApiError ? error.code : "PAYMENT_ATTEMPT_FAILED";
        database.prepare("UPDATE payments SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify({ code, message: detail }), new Date().toISOString(), paymentId);
        try {
          await writeAuditEvent(database, {
            eventId: randomUUID(),
            paymentId,
            rail: "whitechain",
            status: "failed",
            errorCode: code,
            createdAt: new Date().toISOString(),
          });
        } catch (auditError) {
          console.error("Failed to anchor payment failure in HCS:", auditError);
        }
      } else if (row?.status === "settled") {
        database.prepare("UPDATE payments SET status = 'settled_action_failed', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), paymentId);
        const detail = error instanceof Error ? error.message : String(error);
        const receiptRow = row.receipt_id
          ? database.prepare("SELECT receipt_json FROM receipts WHERE id = ?").get(row.receipt_id) as
              | { receipt_json: string }
              | undefined
          : undefined;
        res.status(502).json({
          error: {
            code: "SETTLED_ACTION_FAILED",
            message: "Payment settled, but the protected service action failed. Do not retry with another rail.",
            detail,
          },
          payment: {
            transactionHash: row.tx_hash,
            explorerUrl: row.explorer_url,
            receiptId: row.receipt_id,
            payer: row.payer,
            receipt: receiptRow ? JSON.parse(receiptRow.receipt_json) as unknown : null,
          },
        });
        return;
      }
    }
    if (error instanceof ApiError) {
      sendError(res, error.status, error.code, error.message);
      return;
    }
    next(error);
  }
});

app.use(
  (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof TranslationProviderError) {
      console.error("Translation provider request failed:", error.message);
      sendError(res, 502, "TRANSLATION_PROVIDER_FAILED", "Translation provider request failed.");
      return;
    }
    if (error instanceof ApiError) {
      sendError(res, error.status, error.code, error.message);
      return;
    }

    console.error("Unhandled API error:", error);
    sendError(res, 500, "INTERNAL_ERROR", "Internal server error.");
  },
);

app.use((_req, res) => {
  sendError(res, 404, "NOT_FOUND", "Route was not found.");
});

app.listen(port, () => {
  console.log(`BhashaPay API listening on http://localhost:${port}`);
});

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function registerHederaMediaRoute<T extends { audioBase64?: string; imageBase64?: string }>(
  path: "/stt" | "/ocr",
  serviceId: "stt" | "ocr",
  amount: string,
  description: string,
  schema: z.ZodType<T>,
  execute: (input: T) => Promise<unknown>,
): void {
  const payTo = payToAccountId;
  if (!payTo) throw new Error("HEDERA_PAY_TO_ACCOUNT_ID is required.");
  const routeConfig = {
    [`POST ${path}`]: {
      accepts: [{
        scheme: "exact",
        price: { amount, asset: testnetUsdc },
        network: "hedera:testnet",
        payTo,
        maxTimeoutSeconds: 180,
      }],
      description,
      mimeType: "application/json",
    },
  } satisfies RoutesConfig;
  app.post(
    path,
    (req, res, next) => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "INVALID_REQUEST", `Invalid ${serviceId} request.`);
        return;
      }
      res.locals.mediaInput = parsed.data;
      next();
    },
    async (req, res, next) => {
      try {
        const key = z.string().min(8).max(200).safeParse(req.header("idempotency-key"));
        if (!key.success) {
          sendError(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required.");
          return;
        }
        const input = res.locals.mediaInput as T;
        const requestHash = hashPayload(input);
        const hasPaymentPayload = Boolean(req.header("payment-signature") || req.header("x-payment"));
        const prior = database.prepare("SELECT * FROM payments WHERE idempotency_key = ?")
          .get(key.data) as {
            id: string;
            request_hash: string | null;
            status: string;
            response_json: string | null;
            payment_response_json: string | null;
          } | undefined;
        if (prior) {
          if (prior.request_hash?.toLowerCase() !== requestHash.toLowerCase()) {
            sendError(res, 409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different request.");
            return;
          }
          if (prior.status === "settled" && prior.response_json && prior.payment_response_json) {
            res.setHeader("PAYMENT-RESPONSE", prior.payment_response_json);
            res.setHeader("Idempotency-Replayed", "true");
            res.json(JSON.parse(prior.response_json) as unknown);
            return;
          }
          sendError(
            res,
            409,
            prior.status === "settled_action_failed" ? "SETTLED_ACTION_FAILED" : "IDEMPOTENCY_IN_PROGRESS",
            prior.status === "settled_action_failed"
              ? "Payment settled but the service action failed; it cannot safely be retried."
              : "This idempotent payment attempt has already been processed.",
          );
          return;
        }
        if (!hasPaymentPayload) {
          next();
          return;
        }
        if (!allowPaymentAttempt(req.ip ?? "unknown")) {
          sendError(res, 429, "PAYMENT_ATTEMPT_RATE_LIMITED", "Too many signed payment attempts from this IP.");
          return;
        }

        const paymentId = randomUUID();
        const createdAt = new Date().toISOString();
        database.prepare(
          `INSERT INTO payments
            (id, service_id, rail, amount, merchant, status, idempotency_key, request_hash, created_at, updated_at)
           VALUES (?, ?, 'hedera', ?, ?, 'attempting', ?, ?, ?, ?)`,
        ).run(paymentId, serviceId, amount, payToAccountId, key.data, requestHash, createdAt, createdAt);
        res.locals.hederaPaymentId = paymentId;
        res.once("finish", () => {
          const row = database.prepare("SELECT status FROM payments WHERE id = ?").get(paymentId) as
            | { status: string }
            | undefined;
          if (row?.status !== "attempting") return;
          const responseHeader = responseHeaderString(res.getHeader("PAYMENT-RESPONSE"));
          let settlement: z.infer<typeof hederaSettlementSchema> | undefined;
          if (responseHeader) {
            try {
              settlement = readHederaSettlement(responseHeader);
            } catch (error) {
              console.error("Could not validate x402 settlement response after media request failure:", error);
            }
          }
          const status = settlement ? "settled_action_failed" : "denied";
          const finishedAt = new Date().toISOString();
          database.prepare(
            `UPDATE payments SET status = ?, payer = ?, tx_hash = ?, explorer_url = ?, receipt_id = ?,
               payment_response_json = ?, updated_at = ? WHERE id = ?`,
          ).run(
            status,
            settlement?.payer ?? null,
            settlement?.transaction ?? null,
            settlement
              ? `https://hashscan.io/testnet/transaction/${encodeURIComponent(settlement.transaction)}`
              : null,
            settlement?.transaction ?? null,
            responseHeader ?? null,
            finishedAt,
            paymentId,
          );
          if (settlement) storeHederaReceipt(database, paymentId, settlement, finishedAt, serviceId, amount);
          void writeAuditEvent(database, {
            eventId: randomUUID(),
            paymentId,
            rail: "hedera",
            status,
            serviceId: "translate",
            amount: "10000",
            payer: settlement?.payer,
            merchant: payTo,
            txHash: settlement?.transaction,
            receiptId: settlement?.transaction,
            errorCode: `HTTP_${res.statusCode}`,
            createdAt: finishedAt,
          }).catch((error: unknown) => console.error("Failed to write media request outcome to HCS:", error));
        });
        try {
          await writeAuditEvent(database, {
            eventId: randomUUID(),
            paymentId,
            rail: "hedera",
            status: "attempting",
            serviceId,
            amount,
            merchant: payTo,
            createdAt,
          });
        } catch (error) {
          database.prepare("UPDATE payments SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify({ code: "HCS_AUDIT_FAILED" }), new Date().toISOString(), paymentId);
          throw error;
        }
        next();
      } catch (error) {
        next(error);
      }
    },
    paymentMiddleware(routeConfig, resourceServer),
    async (_req, res, next) => {
      const paymentId = res.locals.hederaPaymentId;
      const responseHeader = responseHeaderString(res.getHeader("PAYMENT-RESPONSE"));
      if (typeof paymentId !== "string" || !responseHeader) {
        next(new ApiError("x402 facilitator response was missing.", 502, "INVALID_HEDERA_SETTLEMENT"));
        return;
      }
      let settlement: z.infer<typeof hederaSettlementSchema>;
      try {
        settlement = readHederaSettlement(responseHeader);
        if (
          settlement.amount !== undefined && settlement.amount !== amount ||
          settlement.payer !== undefined && settlement.payer !== process.env.HEDERA_CLIENT_ACCOUNT_ID
        ) {
          throw new ApiError("x402 settlement fields did not match the requested payment.", 502, "SETTLEMENT_MISMATCH");
        }
        const result = await execute(res.locals.mediaInput as T);
        const createdAt = new Date().toISOString();
        const responseBody = { service: serviceId, ...asRecord(result) };
        const explorerUrl =
          `https://hashscan.io/testnet/transaction/${encodeURIComponent(settlement.transaction)}`;
        database.prepare(
          `UPDATE payments SET status = 'settled', payer = ?, tx_hash = ?, explorer_url = ?, receipt_id = ?,
             response_json = ?, payment_response_json = ?, updated_at = ? WHERE id = ?`,
        ).run(
          settlement.payer ?? null,
          settlement.transaction,
          explorerUrl,
          settlement.transaction,
          JSON.stringify(responseBody),
          responseHeader,
          createdAt,
          paymentId,
        );
        storeHederaReceipt(database, paymentId, settlement, createdAt, serviceId, amount);
        await writeAuditEvent(database, {
          eventId: randomUUID(),
          paymentId,
          rail: "hedera",
          status: "settled",
          serviceId,
          amount,
          payer: settlement.payer,
          merchant: payTo,
          txHash: settlement.transaction,
          receiptId: settlement.transaction,
          createdAt,
        });
        res.json(responseBody);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const row = database.prepare("SELECT status FROM payments WHERE id = ?").get(paymentId) as
          | { status: string }
          | undefined;
        if (row?.status === "settled") {
          database.prepare("UPDATE payments SET status = 'settled_action_failed', error_json = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify({ message: detail }), new Date().toISOString(), paymentId);
          sendError(res, 502, "SETTLED_ACTION_FAILED", "Payment settled, but the protected action failed.");
          return;
        }
        next(error);
      }
    },
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Protected service returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function settlementErrorFields(body: unknown): { code: string; message: string } {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null
  ) {
    const error = body.error;
    return {
      code: "code" in error && typeof error.code === "string" ? error.code : "SETTLEMENT_REJECTED",
      message: "message" in error && typeof error.message === "string" ? error.message : "Settlement was rejected.",
    };
  }
  return { code: "SETTLEMENT_REJECTED", message: "Settlement was rejected." };
}

function responseHeaderString(value: string | number | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function allowPaymentAttempt(ip: string): boolean {
  const now = Date.now();
  const bucket = paymentAttemptBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    paymentAttemptBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    if (paymentAttemptBuckets.size > 1_000) {
      for (const [key, value] of paymentAttemptBuckets) {
        if (value.resetAt <= now) paymentAttemptBuckets.delete(key);
      }
    }
    return true;
  }
  bucket.count += 1;
  return bucket.count <= 20;
}

function readHederaSettlement(value: string): z.infer<typeof hederaSettlementSchema> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
  } catch {
    throw new ApiError("x402 returned a malformed settlement response.", 502, "INVALID_HEDERA_SETTLEMENT");
  }
  const parsed = hederaSettlementSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ApiError("x402 settlement response failed validation.", 502, "INVALID_HEDERA_SETTLEMENT");
  }
  return parsed.data;
}

function storeHederaReceipt(
  database: ReturnType<typeof openDatabase>,
  paymentId: string,
  settlement: z.infer<typeof hederaSettlementSchema>,
  createdAt: string,
  serviceId = "translate",
  amount = settlement.amount ?? "10000",
): void {
  const explorerUrl =
    `https://hashscan.io/testnet/transaction/${encodeURIComponent(settlement.transaction)}`;
  database.prepare(
    `INSERT OR IGNORE INTO receipts
      (id, payment_id, rail, service_id, payer, merchant, amount, tx_hash, explorer_url, receipt_json, created_at)
     VALUES (?, ?, 'hedera', ?, ?, ?, ?, ?, ?, ?, ?)` ,
  ).run(
    settlement.transaction,
    paymentId,
    serviceId,
    settlement.payer ?? null,
    payToAccountId,
    amount,
    settlement.transaction,
    explorerUrl,
    JSON.stringify(settlement),
    createdAt,
  );
}

async function verifyWhitechainSettlement(
  settlement: z.infer<typeof whitechainSettlementSchema>,
  requestHash: string,
  payer: string,
  amount: string,
): Promise<void> {
  const settlementAddress = process.env.WHITECHAIN_SETTLEMENT_ADDRESS;
  if (!settlementAddress || !isAddress(settlementAddress)) {
    throw new ApiError("Whitechain settlement contract is not configured.", 503, "SETTLEMENT_NOT_CONFIGURED");
  }
  const provider = new JsonRpcProvider(
    process.env.WHITECHAIN_RPC_URL ?? "https://rpc.testnet.whitechain.io/",
    1874,
  );
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(1874)) {
      throw new ApiError("Configured RPC is not Whitechain Sepolia.", 503, "WRONG_CHAIN");
    }
    const transactionReceipt = await provider.getTransactionReceipt(settlement.transactionHash);
    if (!transactionReceipt || transactionReceipt.status !== 1) {
      throw new ApiError("Settlement transaction is not confirmed successfully on Whitechain.", 502, "TX_NOT_CONFIRMED");
    }
    const transaction = await provider.getTransaction(settlement.transactionHash);
    if (!transaction || transaction.to?.toLowerCase() !== settlementAddress.toLowerCase()) {
      throw new ApiError("Transaction was not submitted to the configured settlement contract.", 502, "WRONG_SETTLEMENT_CONTRACT");
    }
    const contract = new Contract(settlementAddress, whitechainReceiptAbi, provider);
    const receipt = await contract.getReceipt(settlement.receiptId);
    const actual = {
      serviceId: String(receipt.serviceId ?? receipt[0]).toLowerCase(),
      payer: getAddress(String(receipt.payer ?? receipt[1])),
      merchant: getAddress(String(receipt.merchant ?? receipt[2])),
      amount: String(receipt.amount ?? receipt[3]),
      requestHash: String(receipt.requestHash ?? receipt[5]).toLowerCase(),
    };
    if (
      actual.serviceId !== settlement.receipt.serviceId.toLowerCase() ||
      actual.payer !== getAddress(payer) ||
      actual.payer !== getAddress(settlement.receipt.payer) ||
      actual.merchant !== getAddress(settlement.receipt.merchant) ||
      actual.amount !== amount ||
      actual.amount !== settlement.receipt.amount ||
      actual.requestHash !== requestHash.toLowerCase() ||
      actual.requestHash !== settlement.receipt.requestHash.toLowerCase()
    ) {
      throw new ApiError("Onchain receipt does not match the payment request.", 502, "ONCHAIN_RECEIPT_MISMATCH");
    }
    const emittedSettlement = transactionReceipt.logs.some((log) => {
      if (log.address.toLowerCase() !== settlementAddress.toLowerCase()) return false;
      try {
        const parsed = whitechainSettlementInterface.parseLog(log);
        return Boolean(
          parsed &&
          parsed.name === "PaymentSettled" &&
          String(parsed.args.receiptId) === settlement.receiptId &&
          String(parsed.args.serviceId).toLowerCase() === actual.serviceId &&
          getAddress(String(parsed.args.payer)) === actual.payer &&
          getAddress(String(parsed.args.merchant)) === actual.merchant &&
          String(parsed.args.amount) === actual.amount &&
          String(parsed.args.requestHash).toLowerCase() === actual.requestHash
        );
      } catch {
        return false;
      }
    });
    if (!emittedSettlement) {
      throw new ApiError("Settlement transaction does not emit the matching payment receipt.", 502, "SETTLEMENT_EVENT_MISSING");
    }
  } finally {
    provider.destroy();
  }
}

function isTranslateRequest(value: unknown): value is TranslateRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    typeof body.text === "string" &&
    body.text.length > 0 &&
    body.text.length <= 10_000 &&
    typeof body.sourceLanguage === "string" &&
    body.sourceLanguage.length > 0 &&
    body.sourceLanguage.length <= 100 &&
    typeof body.targetLanguage === "string" &&
    body.targetLanguage.length > 0 &&
    body.targetLanguage.length <= 100
  );
}

async function translate(input: TranslateRequest): Promise<string> {
  try {
    return await generateGeminiContent({
      model: getGeminiModel(),
      temperature: 0.2,
      parts: [{
        text: `Translate from ${input.sourceLanguage} to ${input.targetLanguage} faithfully. Return only the translation.\n\n${input.text}`,
      }],
    });
  } catch (error) {
    throw new TranslationProviderError(
      error instanceof Error ? error.message : "Gemini translation request failed.",
    );
  }
}
