import "dotenv/config";
import {
  AccountId,
  Client,
  PrivateKey,
  TopicId,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type AuditMessage = {
  eventId: string;
  runId?: string;
  paymentId?: string;
  rail: "hedera" | "whitechain" | "system";
  status: string;
  serviceId?: string;
  amount?: string;
  payer?: string;
  merchant?: string;
  txHash?: string;
  receiptId?: string;
  errorCode?: string;
  createdAt: string;
};

export async function writeAuditEvent(
  database: Database.Database,
  message: AuditMessage,
): Promise<{ id: string; topicId: string; sequenceNumber: string; transactionId: string }> {
  const topicId = process.env.HEDERA_AUDIT_TOPIC_ID;
  const operatorId = process.env.HEDERA_OPERATOR_ID;
  const operatorKey = process.env.HEDERA_OPERATOR_PRIVATE_KEY;
  const id = randomUUID();

  database
    .prepare(
      `INSERT INTO audit_events
        (id, run_id, payment_id, rail, status, message_json, hcs_topic_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      message.runId ?? null,
      message.paymentId ?? null,
      message.rail,
      "pending",
      JSON.stringify(message),
      topicId ?? null,
      message.createdAt,
    );

  if (!topicId || !operatorId || !operatorKey) {
    const error = "Hedera HCS audit is not configured; payment is blocked until it is available.";
    database.prepare("UPDATE audit_events SET status = 'failed', error = ? WHERE id = ?").run(error, id);
    throw new Error(error);
  }

  const client = Client.forTestnet().setOperator(
    AccountId.fromString(operatorId),
    PrivateKey.fromStringECDSA(operatorKey),
  );
  try {
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(JSON.stringify(message))
      .execute(client);
    const receipt = await response.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS" || !receipt.topicSequenceNumber) {
      throw new Error(`HCS submission did not reach consensus: ${receipt.status.toString()}.`);
    }

    const sequenceNumber = receipt.topicSequenceNumber.toString();
    const transactionId = response.transactionId.toString();
    database
      .prepare(
        `UPDATE audit_events
         SET status = 'submitted', hcs_sequence_number = ?, hcs_transaction_id = ?
         WHERE id = ?`,
      )
      .run(sequenceNumber, transactionId, id);
    return { id, topicId, sequenceNumber, transactionId };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    database.prepare("UPDATE audit_events SET status = 'failed', error = ? WHERE id = ?").run(detail, id);
    throw new Error(`HCS audit submission failed: ${detail}`, { cause: error });
  } finally {
    client.close();
  }
}

export async function readHcsMessages(limit = 100): Promise<unknown[]> {
  const topicId = process.env.HEDERA_AUDIT_TOPIC_ID;
  if (!topicId) {
    throw new Error("HEDERA_AUDIT_TOPIC_ID is required to read the HCS audit log.");
  }
  const url = new URL(
    `api/v1/topics/${encodeURIComponent(topicId)}/messages`,
    process.env.HEDERA_MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com/",
  );
  url.searchParams.set("order", "asc");
  url.searchParams.set("limit", String(Math.max(1, Math.min(100, limit))));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Hedera mirror node returned HTTP ${response.status}.`);
  }
  const result: unknown = await response.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("messages" in result) ||
    !Array.isArray(result.messages)
  ) {
    throw new Error("Hedera mirror node returned an invalid topic-message response.");
  }
  return result.messages.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("message" in entry)) {
      throw new Error("Hedera mirror node returned a malformed topic message.");
    }
    const raw = entry.message;
    if (typeof raw !== "string") {
      throw new Error("Hedera mirror node topic message was not base64 encoded.");
    }
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch (error) {
      throw new Error("HCS topic contains a message that is not valid JSON.", { cause: error });
    }
    return { ...entry, decoded: parsed };
  });
}
