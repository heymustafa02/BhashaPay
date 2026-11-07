"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiBaseUrl, fetchJson, formatUnits } from "../../lib/api";
import { DEMO_MODE, demoPayments } from "../../lib/demoData";

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

function statusClass(status: string): string {
  if (status === "settled") return "pill";
  if (status === "denied" || status === "failed") return "pill pill-danger";
  return "pill pill-warning";
}

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>(DEMO_MODE ? demoPayments : []);
  const [loading, setLoading] = useState(!DEMO_MODE);
  const [showingDemo, setShowingDemo] = useState(DEMO_MODE);

  useEffect(() => {
    if (DEMO_MODE) return;
    let active = true;
    const load = () => fetchJson<{ payments: Payment[] }>("/payments")
      .then((result) => {
        if (active) {
          setShowingDemo(result.payments.length === 0);
          setPayments(result.payments.length > 0 ? result.payments : demoPayments);
        }
      })
      .catch(() => {
        if (active) {
          setPayments(demoPayments);
          setShowingDemo(true);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
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
          {showingDemo ? <span className="pill pill-warning">Sample data</span> : null}
          <span className="pill">{payments.length} records</span>
        </div>
      </header>
      {loading ? <div className="loading-state">Loading payment history…</div> : null}
      {!loading && payments.length === 0 ? (
        <div className="empty-state"><strong>No payment attempts yet</strong><p>Completed and denied runs will appear here.</p></div>
      ) : null}
      {!loading && payments.length > 0 ? (
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
                    {showingDemo && payment.receipt_id ? (
                      <span className="mono muted">Sample receipt</span>
                    ) : payment.receipt_id ? (
                      <Link className="table-link mono" href={`${apiBaseUrl}/receipts/${encodeURIComponent(payment.receipt_id)}`} target="_blank" rel="noreferrer">
                        {payment.receipt_id.slice(0, 13)}…
                      </Link>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td>
                    {showingDemo ? (
                      <span className="muted">Sample transaction</span>
                    ) : payment.explorer_url ? (
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
