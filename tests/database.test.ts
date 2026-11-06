import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../services/api/database";

test("SQLite schema includes run, payment, receipt, and HCS audit persistence", () => {
  const database = openDatabase(":memory:");
  try {
    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const names = new Set(tables.map(({ name }) => name));
    for (const name of ["services", "runs", "payments", "receipts", "audit_events", "run_events"]) {
      assert.equal(names.has(name), true, `${name} table should exist`);
    }

    const paymentColumns = database.pragma("table_info(payments)") as Array<{ name: string }>;
    for (const column of ["idempotency_key", "request_hash", "response_json", "payment_response_json"]) {
      assert.equal(paymentColumns.some(({ name }) => name === column), true, `${column} should exist`);
    }
  } finally {
    database.close();
  }
});

test("SQLite rejects duplicate idempotency keys", () => {
  const database = openDatabase(":memory:");
  try {
    database.prepare(
      "INSERT INTO payments (id, service_id, rail, amount, status, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("payment-1", "translate", "hedera", "10000", "attempting", "same-key-123", "now", "now");
    assert.throws(() => database.prepare(
      "INSERT INTO payments (id, service_id, rail, amount, status, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("payment-2", "translate", "hedera", "10000", "attempting", "same-key-123", "now", "now"));
  } finally {
    database.close();
  }
});
