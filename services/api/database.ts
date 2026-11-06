import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function openDatabase(filename = process.env.DATABASE_PATH ?? "./data/bhashapay.sqlite") {
  const resolvedPath = filename === ":memory:" ? filename : resolve(filename);
  if (resolvedPath !== ":memory:") {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }
  const database = new Database(resolvedPath);
  database.pragma("foreign_keys = ON");
  if (resolvedPath !== ":memory:") database.pragma("journal_mode = WAL");
  initializeDatabase(database);
  return database;
}

export function initializeDatabase(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS services (
      service_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      description TEXT NOT NULL,
      hedera_price TEXT,
      whitechain_price TEXT,
      hedera_merchant TEXT,
      whitechain_merchant TEXT,
      quality INTEGER NOT NULL CHECK (quality BETWEEN 0 AND 100),
      metadata_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      registry_source TEXT NOT NULL DEFAULT 'local',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      budget TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      status TEXT NOT NULL,
      chosen_service_id TEXT,
      result_json TEXT,
      error_json TEXT,
      spent TEXT NOT NULL DEFAULT '0',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES runs(id),
      service_id TEXT NOT NULL,
      rail TEXT NOT NULL,
      amount TEXT NOT NULL,
      payer TEXT,
      merchant TEXT,
      status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      tx_hash TEXT,
      explorer_url TEXT,
      receipt_id TEXT,
      request_hash TEXT,
      response_json TEXT,
      payment_response_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL REFERENCES payments(id),
      rail TEXT NOT NULL,
      service_id TEXT NOT NULL,
      payer TEXT,
      merchant TEXT,
      amount TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      explorer_url TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES runs(id),
      payment_id TEXT REFERENCES payments(id),
      rail TEXT NOT NULL,
      status TEXT NOT NULL,
      message_json TEXT NOT NULL,
      hcs_topic_id TEXT,
      hcs_sequence_number TEXT,
      hcs_transaction_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS payments_run_created ON payments(run_id, created_at);
    CREATE INDEX IF NOT EXISTS audit_events_created ON audit_events(created_at);
    CREATE INDEX IF NOT EXISTS run_events_run_id ON run_events(run_id, id);
  `);
  const paymentColumns = database.pragma("table_info(payments)") as Array<{ name: string }>;
  if (!paymentColumns.some((column) => column.name === "request_hash")) {
    database.exec("ALTER TABLE payments ADD COLUMN request_hash TEXT");
  }
  if (!paymentColumns.some((column) => column.name === "response_json")) {
    database.exec("ALTER TABLE payments ADD COLUMN response_json TEXT");
  }
  if (!paymentColumns.some((column) => column.name === "payment_response_json")) {
    database.exec("ALTER TABLE payments ADD COLUMN payment_response_json TEXT");
  }
}
