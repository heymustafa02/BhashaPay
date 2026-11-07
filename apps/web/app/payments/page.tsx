"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiBaseUrl, fetchJson, formatUnits } from "../../lib/api";

type Payment = {
  id: string;
  run_id: string | null;
  service_id: string;
  rail: "hedera" | "whitechain";
  amount: string;
  payer: string | null;
  merchant: string | null;
  status: string;
  tx_hash: string | null;
  explorer_url: string | null;
  receipt_id: string | null;
  error_json: string | null;
  created_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPayment(value: unknown): value is Payment {
  if (!isRecord(value)) return false;
  const nullableStrings = [
    value.run_id,
    value.payer,
    value.merchant,
    value.tx_hash,
    value.explorer_url,
    value.receipt_id,
    value.error_json,
  ];
  return (
    typeof value.id === "string" &&
    typeof value.service_id === "string" &&
    (value.rail === "hedera" || value.rail === "whitechain") &&
    typeof value.amount === "string" &&
    typeof value.status === "string" &&
    typeof value.created_at === "string" &&
    nullableStrings.every((item) => item === null || typeof item === "string")
  );
}

function statusClass(status: string): string {
  if (status === "settled") return "pill";
  if (status === "denied" || status === "failed") return "pill pill-danger";
  return "pill pill-warning";
}

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await fetchJson<unknown>("/payments");
        if (!active) return;
        if (!isRecord(result) || !Array.isArray(result.payments)) {
          throw new Error("Payment history returned an invalid response.");
        }
        setPayments(result.payments.filter(isPayment));
        setError("");
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Could not load payments.");
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 8_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="eyebrow">SETTLEMENT HISTORY</div>
          <h1>Payments</h1>
          <p>Payment attempts, settlement receipts, and explorer links.</p>
        </div>
        <div className="rail-row">
          <span className="pill">{payments.length} records</span>
        </div>
      </header>
      {loading ? <div className="loading-state">Loading payment history…</div> : null}
      {!loading && error ? (
        <div className="error-state"><strong>Payment history unavailable</strong><p>{error}</p></div>
      ) : null}
      {!loading && !error && payments.length === 0 ? (
        <div className="empty-state"><strong>No payment attempts yet</strong><p>Completed and denied runs will appear here.</p></div>
      ) : null}
      {!loading && !error && payments.length > 0 ? (
        <div className="panel table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Service</th><th>Rail</th><th>Amount</th><th>Status</th><th>Receipt</th><th>Transaction</th><th>Time</th></tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td>
                    <strong>{payment.service_id}</strong>
                    {payment.run_id ? <div className="mono muted">Run {payment.run_id.slice(0, 8)}</div> : null}
                  </td>
                  <td><span className="pill">{payment.rail}</span></td>
                  <td>{formatUnits(payment.amount)}</td>
                  <td><span className={statusClass(payment.status)}>{payment.status.replaceAll("_", " ")}</span></td>
                  <td>
                    {payment.receipt_id ? (
                      <Link className="table-link mono" href={`${apiBaseUrl}/receipts/${encodeURIComponent(payment.receipt_id)}`} target="_blank" rel="noreferrer">
                        {payment.receipt_id.slice(0, 13)}…
                      </Link>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td>
                    {payment.explorer_url ? (
                      <Link className="table-link" href={payment.explorer_url} target="_blank" rel="noreferrer">
                        Open explorer ↗
                      </Link>
                    ) : <span className="muted">Not settled</span>}
                    {payment.tx_hash ? <div className="mono muted">{payment.tx_hash}</div> : null}
                  </td>
                  <td>{new Date(payment.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
