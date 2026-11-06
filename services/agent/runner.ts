import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getRegistry, type RegistryService } from "../api/registry";
import { writeAuditEvent, type AuditMessage } from "../api/audit";
import { decideSpend, dollarsToUnits } from "../../packages/shared/spend-policy";
import { payForWhitechainTranslation } from "./whitechain";
import { waitForApproval } from "./approvals";
import { PaymentSettledActionError } from "../../packages/shared/payment-errors";

type RunPolicy = {
  perMerchantLimit: string;
  merchantAllowlist: string[];
  approvalThreshold: string;
};

type RunInput = {
  task: string;
  budget: string;
  policy: RunPolicy;
  input: {
    text?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    audioBase64?: string;
    imageBase64?: string;
    fileName?: string;
    mimeType?: string;
  };
};

type Candidate = {
  service: RegistryService;
  rail: "hedera" | "whitechain";
  amount: bigint;
  merchant: string;
};

const taskChoiceSchema = z.object({
  kind: z.enum(["stt", "translate", "ocr"]),
  sourceLanguage: z.string().max(100).default("Marathi"),
  targetLanguage: z.string().max(100).default("English"),
});

const apiBaseUrl = (process.env.API_BASE_URL ?? "http://localhost:4021").replace(/\/+$/, "");

export async function runAgent(database: Database.Database, runId: string): Promise<void> {
  const run = database.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
    | { id: string; task: string; budget: string; policy_json: string }
    | undefined;
  if (!run) throw new Error(`Run ${runId} was not found.`);

  const input = JSON.parse(run.policy_json) as RunInput;
  const budget = BigInt(run.budget);
  let spent = BigInt(0);
  const merchantSpend = new Map<string, bigint>();

  try {
    await emit(database, runId, "discovery", "Discovering registered services.", {});
    const registry = await getRegistry(database);
    const availableServices = registry.services.filter((service) => service.active);
    if (availableServices.length === 0) {
      throw new Error("No active services are registered. Run the funded service seed script.");
    }

    const choice = await identifyTask(run.task);
    if (choice.kind === "stt" && !input.input.audioBase64) {
      throw new Error("Speech-to-text requires an audio file before any payment is attempted.");
    }
    if (choice.kind === "ocr" && !input.input.imageBase64) {
      throw new Error("Document OCR requires an image before any payment is attempted.");
    }
    if (choice.kind === "translate" && !input.input.text) {
      throw new Error("Translation requires input.text before any payment is attempted.");
    }
    const candidates = availableServices
      .filter((service) => service.kind === choice.kind)
      .flatMap((service) => buildCandidates(service, choice.kind))
      .sort((left, right) => {
        if (left.amount !== right.amount) return left.amount < right.amount ? -1 : 1;
        return right.service.quality - left.service.quality;
      });

    await emit(
      database,
      runId,
      "comparison",
      `Compared ${candidates.length} available ${choice.kind} offers by price, then quality.`,
      candidates.map((candidate) => ({
        serviceId: candidate.service.serviceId,
        name: candidate.service.name,
        rail: candidate.rail,
        amount: candidate.amount.toString(),
        quality: candidate.service.quality,
        merchant: candidate.merchant,
      })),
    );

    if (candidates.length === 0) {
      throw new Error(`No active ${choice.kind} service has a configured, usable payment rail.`);
    }
    await emit(
      database,
      runId,
      "selection",
      `Selected ${candidates[0].service.name} on ${candidates[0].rail}: it has the lowest available price; quality breaks price ties.`,
      {
        serviceId: candidates[0].service.serviceId,
        rail: candidates[0].rail,
        amount: candidates[0].amount.toString(),
        quality: candidates[0].service.quality,
        candidates: candidates.map((candidate) => ({
          serviceId: candidate.service.serviceId,
          rail: candidate.rail,
          amount: candidate.amount.toString(),
          quality: candidate.service.quality,
        })),
      },
    );

    const allowed = new Set(input.policy.merchantAllowlist.map((address) => address.toLowerCase()));
    const perMerchantLimit = dollarsToUnits(input.policy.perMerchantLimit);
    const approvalThreshold = dollarsToUnits(input.policy.approvalThreshold);
    let completed = false;
    let lastFailure = "Every available payment rail failed.";

    for (const candidate of candidates) {
      const merchantKey = candidate.merchant.toLowerCase();
      const priorMerchantSpend = merchantSpend.get(merchantKey) ?? BigInt(0);
      const decision = decideSpend({
        merchant: candidate.merchant,
        merchantAllowlist: [...allowed],
        amount: candidate.amount,
        budget,
        spent,
        perMerchantLimit,
        merchantSpent: priorMerchantSpend,
        approvalThreshold,
      });
      if (!decision.allowed) {
        const code = decision.reason.toUpperCase();
        lastFailure = {
          merchant_not_allowed: `Merchant ${candidate.merchant} is not in the allowlist.`,
          over_budget: "The payment exceeds the remaining run budget.",
          merchant_limit: "The payment exceeds the per-merchant spend limit.",
        }[decision.reason];
        await recordDenied(database, runId, candidate, code, lastFailure);
        continue;
      }

      const paymentId = randomUUID();
      const idempotencyKey = `${runId}-${paymentId}`;
      const now = new Date().toISOString();
      database.prepare(
        `INSERT INTO payments
          (id, run_id, service_id, rail, amount, payer, merchant, status, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'attempting', ?, ?, ?)`,
      ).run(
        paymentId,
        runId,
        candidate.service.serviceId,
        candidate.rail,
        candidate.amount.toString(),
        payerFor(candidate.rail),
        candidate.merchant,
        idempotencyKey,
        now,
        now,
      );

      if (decision.requiresApproval) {
        database.prepare("UPDATE payments SET status = 'awaiting_approval', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), paymentId);
        await emit(database, runId, "approval_required", "Payment is paused for human approval.", {
          paymentId,
          amount: candidate.amount.toString(),
          rail: candidate.rail,
          merchant: candidate.merchant,
        });
        const approved = await waitForApproval(paymentId);
        if (!approved) {
          const reason = "Payment was rejected or the approval request expired.";
          updatePaymentFailure(database, paymentId, "APPROVAL_DENIED", reason, "denied");
          await writePaymentAudit(database, runId, paymentId, candidate, "denied", "APPROVAL_DENIED");
          lastFailure = reason;
          continue;
        }
        await emit(database, runId, "approval_granted", "Payment approved; proceeding with settlement.", { paymentId });
      }

      try {
        await writePaymentAudit(database, runId, paymentId, candidate, "attempting");
        await emit(database, runId, "payment", `Submitting ${candidate.rail} payment.`, {
          paymentId,
          serviceId: candidate.service.serviceId,
          amount: candidate.amount.toString(),
          rail: candidate.rail,
        });
        const payment = await executePayment(candidate, input, choice, idempotencyKey);
        const settledAt = new Date().toISOString();
        database.prepare(
          `UPDATE payments
           SET status = 'settled', tx_hash = ?, explorer_url = ?, receipt_id = ?, updated_at = ?
           WHERE id = ?`,
        ).run(payment.txHash, payment.explorerUrl, payment.receiptId, settledAt, paymentId);
        database.prepare(
          `INSERT INTO receipts (id, payment_id, rail, service_id, payer, merchant, amount, tx_hash, explorer_url, receipt_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          payment.receiptId,
          paymentId,
          candidate.rail,
          candidate.service.serviceId,
          payment.payer,
          candidate.merchant,
          candidate.amount.toString(),
          payment.txHash,
          payment.explorerUrl,
          JSON.stringify(payment.receipt),
          settledAt,
        );
        await writePaymentAudit(database, runId, paymentId, candidate, "settled", undefined, payment);
        spent += candidate.amount;
        merchantSpend.set(merchantKey, priorMerchantSpend + candidate.amount);
        database.prepare("UPDATE runs SET spent = ?, chosen_service_id = ?, updated_at = ? WHERE id = ?")
          .run(spent.toString(), candidate.service.serviceId, settledAt, runId);
        await emit(database, runId, "result", "The paid service returned a verified result.", {
          serviceId: candidate.service.serviceId,
          rail: candidate.rail,
          result: payment.result,
          spend: {
            amount: candidate.amount.toString(),
            totalSpent: spent.toString(),
            remaining: (budget - spent).toString(),
          },
          transactionHash: payment.txHash,
          explorerUrl: payment.explorerUrl,
          receiptId: payment.receiptId,
        });
        database.prepare(
          "UPDATE runs SET status = 'succeeded', result_json = ?, updated_at = ?, finished_at = ? WHERE id = ?",
        ).run(JSON.stringify(payment.result), settledAt, settledAt, runId);
        completed = true;
        break;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (error instanceof PaymentSettledActionError) {
          const settledAt = new Date().toISOString();
          database.prepare(
            `UPDATE payments SET status = 'settled_action_failed', tx_hash = ?, explorer_url = ?,
               receipt_id = ?, payer = ?, error_json = ?, updated_at = ? WHERE id = ?`,
          ).run(
            error.payment.txHash,
            error.payment.explorerUrl,
            error.payment.receiptId,
            error.payment.payer,
            JSON.stringify({ code: "SETTLED_ACTION_FAILED", message: detail }),
            settledAt,
            paymentId,
          );
          database.prepare(
            `INSERT OR IGNORE INTO receipts
             (id, payment_id, rail, service_id, payer, merchant, amount, tx_hash, explorer_url, receipt_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            error.payment.receiptId,
            paymentId,
            candidate.rail,
            candidate.service.serviceId,
            error.payment.payer,
            candidate.merchant,
            candidate.amount.toString(),
            error.payment.txHash,
            error.payment.explorerUrl,
            JSON.stringify(error.payment.receipt),
            settledAt,
          );
          spent += candidate.amount;
          merchantSpend.set(merchantKey, priorMerchantSpend + candidate.amount);
          database.prepare("UPDATE runs SET spent = ?, updated_at = ? WHERE id = ?")
            .run(spent.toString(), settledAt, runId);
          await writePaymentAudit(
            database,
            runId,
            paymentId,
            candidate,
            "settled_action_failed",
            "SETTLED_ACTION_FAILED",
            error.payment,
          );
          await emit(database, runId, "payment_failed", detail, {
            paymentId,
            code: "SETTLED_ACTION_FAILED",
            transactionHash: error.payment.txHash,
            explorerUrl: error.payment.explorerUrl,
          });
          throw error;
        }
        updatePaymentFailure(database, paymentId, "PAYMENT_FAILED", detail);
        await writePaymentAudit(database, runId, paymentId, candidate, "failed", "PAYMENT_FAILED");
        lastFailure = detail;
        await emit(database, runId, "payment_failed", `${candidate.rail} payment failed; checking the next allowed rail.`, {
          paymentId,
          error: detail,
        });
      }
    }

    if (!completed) {
      throw new Error(lastFailure);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    database.prepare(
      "UPDATE runs SET status = 'failed', error_json = ?, updated_at = ?, finished_at = ? WHERE id = ?",
    ).run(JSON.stringify({ message: detail }), new Date().toISOString(), new Date().toISOString(), runId);
    await emit(database, runId, "failed", detail, {});
  }
}

async function identifyTask(task: string): Promise<z.infer<typeof taskChoiceSchema>> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error("LLM_API_KEY is required for agent tool calling.");
  const baseUrl = (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.LLM_MODEL ?? "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Classify the paid service needed for the task. Use stt for speech/audio transcription, ocr for document images, and translate for text translation. Always call the tool.",
        },
        { role: "user", content: task },
      ],
      tools: [{
        type: "function",
        function: {
          name: "select_service_kind",
          description: "Choose the required BhashaPay service and language pair.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", enum: ["stt", "translate", "ocr"] },
              sourceLanguage: { type: "string" },
              targetLanguage: { type: "string" },
            },
            required: ["kind", "sourceLanguage", "targetLanguage"],
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "select_service_kind" } },
    }),
  });
  if (!response.ok) {
    throw new Error(`LLM tool selection failed with HTTP ${response.status}.`);
  }
  const data: unknown = await response.json();
  const choice = toolArguments(data);
  const parsed = taskChoiceSchema.safeParse(choice);
  if (!parsed.success) throw new Error("LLM returned an invalid service selection.");
  return parsed.data;
}

function toolArguments(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("choices" in value) || !Array.isArray(value.choices)) {
    throw new Error("LLM response did not contain tool calls.");
  }
  const first = value.choices[0];
  if (typeof first !== "object" || first === null || !("message" in first) || typeof first.message !== "object" || first.message === null) {
    throw new Error("LLM response did not contain a tool call message.");
  }
  const message = first.message;
  if (!("tool_calls" in message) || !Array.isArray(message.tool_calls) || typeof message.tool_calls[0] !== "object" || message.tool_calls[0] === null) {
    throw new Error("LLM did not call the required service-selection tool.");
  }
  const call = message.tool_calls[0];
  if (!("function" in call) || typeof call.function !== "object" || call.function === null || !("arguments" in call.function) || typeof call.function.arguments !== "string") {
    throw new Error("LLM returned a malformed service-selection call.");
  }
  try {
    return JSON.parse(call.function.arguments) as unknown;
  } catch (error) {
    throw new Error("LLM returned invalid JSON in the service-selection tool call.", { cause: error });
  }
}

function buildCandidates(
  service: RegistryService,
  kind: z.infer<typeof taskChoiceSchema>["kind"],
): Candidate[] {
  const options: Candidate[] = [];
  if (
    service.acceptedRails.includes("hedera") &&
    service.price.hedera &&
    service.merchant.hedera &&
    process.env.HEDERA_CLIENT_ACCOUNT_ID &&
    process.env.HEDERA_CLIENT_PRIVATE_KEY
  ) {
    options.push({
      service,
      rail: "hedera",
      amount: BigInt(service.price.hedera),
      merchant: service.merchant.hedera,
    });
  }
  if (
    kind === "translate" &&
    service.acceptedRails.includes("whitechain") &&
    service.price.whitechain &&
    service.merchant.whitechain &&
    process.env.WHITECHAIN_PAYER_PRIVATE_KEY &&
    process.env.FACILITATOR_SHARED_SECRET
  ) {
    options.push({
      service,
      rail: "whitechain",
      amount: BigInt(service.price.whitechain),
      merchant: service.merchant.whitechain,
    });
  }
  return options;
}

async function executePayment(
  candidate: Candidate,
  run: RunInput,
  choice: z.infer<typeof taskChoiceSchema>,
  idempotencyKey: string,
): Promise<{
  txHash: string;
  explorerUrl: string;
  receiptId: string;
  payer: string;
  receipt: unknown;
  result: unknown;
}> {
  const serviceIdempotencyKey = `service-${idempotencyKey}`;
  if (candidate.rail === "whitechain") {
    if (choice.kind !== "translate") throw new Error("Whitechain rail currently supports translation only.");
    const text = run.input.text;
    if (!text) throw new Error("Translation requires input.text.");
    const payload = {
      text,
      sourceLanguage: run.input.sourceLanguage ?? choice.sourceLanguage,
      targetLanguage: run.input.targetLanguage ?? choice.targetLanguage,
    };
    const result = await payForWhitechainTranslation({
      serviceId: candidate.service.serviceId,
      merchant: candidate.merchant,
      amount: candidate.amount.toString(),
      ...payload,
      idempotencyKey: serviceIdempotencyKey,
    });
    const parsed = validateWhitechainResult(result, candidate);
    return {
      txHash: parsed.payment.transactionHash,
      explorerUrl: parsed.payment.transactionUrl,
      receiptId: parsed.payment.receiptId,
      payer: parsed.payment.receipt.payer,
      receipt: parsed.payment.receipt,
      result: { translation: parsed.translation },
    };
  }

  const accountId = process.env.HEDERA_CLIENT_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_CLIENT_PRIVATE_KEY;
  if (!accountId || !privateKey) throw new Error("Hedera testnet payer is not configured.");
  const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), {
    network: "hedera:testnet",
  });
  const client = new x402Client().register("hedera:*", new ExactHederaScheme(signer));
  const paidFetch = wrapFetchWithPayment(fetch, client);
  const path = `/${choice.kind}`;
  const payload = choice.kind === "translate"
    ? {
        text: run.input.text,
        sourceLanguage: run.input.sourceLanguage ?? choice.sourceLanguage,
        targetLanguage: run.input.targetLanguage ?? choice.targetLanguage,
      }
    : choice.kind === "stt"
      ? {
          audioBase64: run.input.audioBase64,
          fileName: run.input.fileName ?? "audio.webm",
          mimeType: run.input.mimeType ?? "audio/webm",
          language: run.input.sourceLanguage ?? choice.sourceLanguage,
        }
      : {
          imageBase64: run.input.imageBase64,
          mimeType: run.input.mimeType ?? "image/png",
          sourceLanguage: run.input.sourceLanguage ?? choice.sourceLanguage,
        };
  const response = await paidFetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": serviceIdempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  const settlement = new x402HTTPClient(client).getPaymentSettleResponse((name) =>
    response.headers.get(name),
  );
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    result = { error: "Protected service returned invalid JSON." };
  }
  if (!settlement?.success) {
    throw new Error(`Hedera payment was not confirmed: ${JSON.stringify(result)}`);
  }
  if (
    settlement.network !== "hedera:testnet" ||
    typeof settlement.transaction !== "string" ||
    !/^0\.0\.\d+@\d+\.\d+$/.test(settlement.transaction) ||
    (settlement.payer !== undefined && settlement.payer !== accountId) ||
    (settlement.amount !== undefined && settlement.amount !== candidate.amount.toString())
  ) {
    throw new Error("Hedera settlement response failed backend validation.");
  }
  const transactionHash = settlement.transaction;
  if (!response.ok) {
    throw new PaymentSettledActionError(
      "Hedera payment settled but the protected action failed; another rail will not be attempted.",
      {
        txHash: transactionHash,
        explorerUrl: `https://hashscan.io/testnet/transaction/${encodeURIComponent(transactionHash)}`,
        receiptId: transactionHash,
        payer: accountId,
        receipt: settlement,
      },
    );
  }
  return {
    txHash: transactionHash,
    explorerUrl: `https://hashscan.io/testnet/transaction/${encodeURIComponent(transactionHash)}`,
    receiptId: transactionHash,
    payer: accountId,
    receipt: settlement,
    result,
  };
}

async function recordDenied(
  database: Database.Database,
  runId: string,
  candidate: Candidate,
  code: string,
  message: string,
): Promise<void> {
  const paymentId = randomUUID();
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO payments
      (id, run_id, service_id, rail, amount, merchant, status, idempotency_key, error_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'denied', ?, ?, ?, ?)`,
  ).run(
    paymentId,
    runId,
    candidate.service.serviceId,
    candidate.rail,
    candidate.amount.toString(),
    candidate.merchant,
    `${runId}-${paymentId}`,
    JSON.stringify({ code, message }),
    now,
    now,
  );
  await writePaymentAudit(database, runId, paymentId, candidate, "denied", code);
  await emit(database, runId, "payment_denied", message, {
    paymentId,
    code,
    rail: candidate.rail,
    amount: candidate.amount.toString(),
  });
}

async function writePaymentAudit(
  database: Database.Database,
  runId: string,
  paymentId: string,
  candidate: Candidate,
  status: string,
  errorCode?: string,
  payment?: { txHash: string; receiptId: string },
): Promise<void> {
  const message: AuditMessage = {
    eventId: randomUUID(),
    runId,
    paymentId,
    rail: candidate.rail,
    status,
    serviceId: candidate.service.serviceId,
    amount: candidate.amount.toString(),
    payer: payerFor(candidate.rail) ?? undefined,
    merchant: candidate.merchant,
    txHash: payment?.txHash,
    receiptId: payment?.receiptId,
    errorCode,
    createdAt: new Date().toISOString(),
  };
  await writeAuditEvent(database, message);
}

function updatePaymentFailure(
  database: Database.Database,
  paymentId: string,
  code: string,
  message: string,
  status = "failed",
): void {
  database.prepare(
    "UPDATE payments SET status = ?, error_json = ?, updated_at = ? WHERE id = ?",
  ).run(status, JSON.stringify({ code, message }), new Date().toISOString(), paymentId);
}

function payerFor(rail: "hedera" | "whitechain"): string | null {
  if (rail === "hedera") return process.env.HEDERA_CLIENT_ACCOUNT_ID ?? null;
  const privateKey = process.env.WHITECHAIN_PAYER_PRIVATE_KEY;
  return privateKey ? new Wallet(privateKey).address : null;
}

async function emit(
  database: Database.Database,
  runId: string,
  type: string,
  message: string,
  data: unknown,
): Promise<void> {
  database.prepare(
    "INSERT INTO run_events (run_id, type, message, data_json, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(runId, type, message, JSON.stringify(data), new Date().toISOString());
}

function validateWhitechainResult(value: unknown, candidate: Candidate) {
  const schema = z.object({
    translation: z.string(),
    payment: z.object({
      rail: z.literal("whitechain"),
      transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      transactionUrl: z.string().url(),
      receiptId: z.string().regex(/^\d+$/),
      receipt: z.object({
        serviceId: z.string(),
        payer: z.string(),
        amount: z.string(),
        requestHash: z.string(),
      }),
    }),
  });
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Whitechain API returned an invalid paid response.");
  if (
    parsed.data.payment.receipt.serviceId.toLowerCase() !== candidate.service.serviceId.toLowerCase() ||
    parsed.data.payment.receipt.amount !== candidate.amount.toString()
  ) {
    throw new Error("Whitechain receipt does not match the selected service and price.");
  }
  return parsed.data;
}
