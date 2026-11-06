"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "../../lib/api";

type AuditEntry = {
  sequence_number?: string;
  consensus_timestamp?: string;
  decoded?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export default function AuditPage() {
  const [messages, setMessages] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetchJson<{ messages: AuditEntry[] }>("/audit?limit=100")
      .then((result) => {
        if (active) setMessages(result.messages);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load HCS messages.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="eyebrow">HEDERA CONSENSUS SERVICE</div>
          <h1>Audit log</h1>
          <p>Payment events read from the Hedera testnet mirror node.</p>
        </div>
        <span className="pill">Tamper-evident</span>
      </header>
      {loading ? <div className="loading-state">Loading HCS topic messages…</div> : null}
      {!loading && error ? (
        <div className="error-state">
          <strong>HCS audit log unavailable</strong>
          <p>{error}</p>
        </div>
      ) : null}
      {!loading && !error && messages.length === 0 ? (
        <div className="empty-state"><strong>No audit messages found</strong><p>Payment attempts will be written to the configured HCS topic.</p></div>
      ) : null}
      {!loading && !error && messages.length > 0 ? (
        <section className="panel panel-pad">
          {messages.map((entry, index) => {
            const event = asRecord(entry.decoded);
            const status = typeof event.status === "string" ? event.status : "unknown";
            const failed = ["failed", "denied", "settle_failed", "settled_action_failed"].includes(status);
            const eventId = typeof event.eventId === "string" ? event.eventId : `message-${index}`;
            return (
              <article className="audit-message" key={entry.sequence_number ?? eventId}>
                <div className="audit-top">
                  <div className="rail-row">
                    <span className={failed ? "pill pill-danger" : "pill"}>{status.replaceAll("_", " ")}</span>
                    <span className="pill">{typeof event.rail === "string" ? event.rail : "system"}</span>
                  </div>
                  <span className="mono muted">Sequence {entry.sequence_number ?? "unavailable"}</span>
                </div>
                <div className="audit-meta">
                  <span>Service: {String(event.serviceId ?? "—")}</span>
                  <span>Amount: {String(event.amount ?? "—")}</span>
                  <span>Time: {entry.consensus_timestamp ?? String(event.createdAt ?? "—")}</span>
                </div>
                {typeof event.errorCode === "string" ? <div className="mono" style={{ color: "var(--danger)" }}>{event.errorCode}</div> : null}
                <details>
                  <summary className="text-link">View signed event content</summary>
                  <pre className="result-box mono">{JSON.stringify(entry.decoded, null, 2)}</pre>
                </details>
              </article>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}
