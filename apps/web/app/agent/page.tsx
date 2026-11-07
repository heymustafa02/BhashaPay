"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiBaseUrl, fetchJson } from "../../lib/api";

type Service = {
  serviceId: string;
  name: string;
  kind: string;
  active: boolean;
  merchant: { hedera: string | null; whitechain: string | null };
  acceptedRails: Array<"hedera" | "whitechain">;
};

type RunEvent = {
  id: number;
  type: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: string;
};

const eventTypes = [
  "discovery",
  "comparison",
  "selection",
  "approval_required",
  "approval_granted",
  "payment",
  "payment_denied",
  "payment_failed",
  "result",
  "failed",
];

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("The selected file could not be encoded."));
        return;
      }
      const separator = reader.result.indexOf(",");
      if (separator < 0) {
        reject(new Error("The selected file has an invalid data URL."));
        return;
      }
      resolve(reader.result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

function money(value: unknown): string {
  if (typeof value !== "string") return "—";
  return `${(Number(value) / 1_000_000).toFixed(3)} USDC/USDT`;
}

export default function AgentPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [registryError, setRegistryError] = useState("");
  const [task, setTask] = useState("Translate this Marathi text to English");
  const [text, setText] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState("Marathi");
  const [targetLanguage, setTargetLanguage] = useState("English");
  const [budget, setBudget] = useState("0.50");
  const [perMerchantLimit, setPerMerchantLimit] = useState("0.25");
  const [approvalThreshold, setApprovalThreshold] = useState("0.10");
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [upload, setUpload] = useState<File | null>(null);
  const [uploadType, setUploadType] = useState<"audio" | "image">("audio");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [runId, setRunId] = useState("");
  const [runStatus, setRunStatus] = useState("");
  const [pendingApproval, setPendingApproval] = useState("");
  const [approvalDetails, setApprovalDetails] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [spendReport, setSpendReport] = useState<Record<string, unknown> | null>(null);
  const streamRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let active = true;
    fetchJson<{ services: Service[] }>("/registry")
      .then(({ services: registered }) => {
        if (active) setServices(registered.filter((service) => service.active));
      })
      .catch((cause: unknown) => {
        if (active) setRegistryError(cause instanceof Error ? cause.message : "Could not load service registry.");
      });
    return () => {
      active = false;
      streamRef.current?.close();
    };
  }, []);

  const merchantOptions = Array.from(new Map(
    services.flatMap((service) =>
      (["hedera", "whitechain"] as const)
        .filter((rail) => service.acceptedRails.includes(rail) && service.merchant[rail])
        .map((rail) => [service.merchant[rail]!, `${service.name} · ${rail}`] as const),
    ),
  ).entries());

  function toggleMerchant(address: string) {
    setAllowlist((current) =>
      current.includes(address)
        ? current.filter((entry) => entry !== address)
        : [...current, address],
    );
  }

  async function submitRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setEvents([]);
    setRunId("");
    setRunStatus("Starting");
    setPendingApproval("");
    setApprovalDetails(null);
    setSpendReport(null);
    streamRef.current?.close();
    try {
      const input: Record<string, string> = {
        text,
        sourceLanguage,
        targetLanguage,
      };
      if (upload) {
        if (upload.size > 10 * 1024 * 1024) {
          throw new Error("Choose an audio or image file smaller than 10 MB.");
        }
        const encoded = await fileAsBase64(upload);
        input[uploadType === "audio" ? "audioBase64" : "imageBase64"] = encoded;
        input.fileName = upload.name;
        input.mimeType = upload.type || (uploadType === "audio" ? "audio/webm" : "image/png");
      }
      const response = await fetchJson<{ runId: string; status: string }>("/runs", {
        method: "POST",
        body: JSON.stringify({
          task,
          budget,
          policy: {
            perMerchantLimit,
            merchantAllowlist: allowlist,
            approvalThreshold,
          },
          input,
        }),
      });
      setRunId(response.runId);
      setRunStatus(response.status);
      const stream = new EventSource(`${apiBaseUrl}/runs/${encodeURIComponent(response.runId)}/events`);
      streamRef.current = stream;
      for (const type of eventTypes) {
        stream.addEventListener(type, (rawEvent) => {
          const messageEvent = rawEvent as MessageEvent<string>;
          const parsed = JSON.parse(messageEvent.data) as {
            message: string;
            data: Record<string, unknown>;
            createdAt: string;
          };
          const newEvent: RunEvent = {
            id: Number(messageEvent.lastEventId),
            type,
            message: parsed.message,
            data: parsed.data,
            createdAt: parsed.createdAt,
          };
          setEvents((current) => [...current, newEvent]);
          if (type === "approval_required" && typeof parsed.data.paymentId === "string") {
            setPendingApproval(parsed.data.paymentId);
            setApprovalDetails(parsed.data);
          }
          if (type === "result") {
            setRunStatus("succeeded");
            if (typeof parsed.data.spend === "object" && parsed.data.spend !== null) {
              setSpendReport(parsed.data.spend as Record<string, unknown>);
            }
          }
          if (type === "failed") setRunStatus("failed");
        });
      }
      stream.onerror = () => {
        setRunStatus((current) => current === "running" ? "Reconnecting to run events" : current);
      };
    } catch (cause) {
      setRunStatus("failed");
      setError(cause instanceof Error ? cause.message : "Could not start agent run.");
    } finally {
      setSubmitting(false);
    }
  }

  async function decideApproval(decision: "approve" | "reject") {
    if (!pendingApproval) return;
    setApprovalBusy(true);
    setError("");
    try {
      await fetchJson(`/approvals/${encodeURIComponent(pendingApproval)}`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      setPendingApproval("");
      setApprovalDetails(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit approval.");
    } finally {
      setApprovalBusy(false);
    }
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="eyebrow">AUTONOMOUS PROCUREMENT</div>
          <h1>Agent run</h1>
          <p>Set a task and spend policy. The agent discovers services and streams each step.</p>
        </div>
        <div className="page-header-badges">
          <span className="pill">Gemini AI</span>
          {runStatus ? <span className={runStatus === "failed" ? "pill pill-danger" : "pill"}>{runStatus}</span> : null}
        </div>
      </header>

      <div className="agent-layout">
        <form className="panel panel-pad" onSubmit={(event) => void submitRun(event)}>
          <div className="form-grid">
            <div className="field field-full">
              <label htmlFor="task">Task</label>
              <input id="task" className="input" value={task} onChange={(event) => setTask(event.target.value)} required maxLength={2000} />
              <span className="field-hint">Gemini selects speech transcription, translation, or OCR from your request.</span>
            </div>
            <div className="field field-full">
              <label htmlFor="input-text">Text input</label>
              <textarea id="input-text" className="textarea" value={text} onChange={(event) => setText(event.target.value)} maxLength={10000} placeholder="Paste text for translation or include context for the task." />
            </div>
            <div className="field">
              <label htmlFor="source-language">Source language</label>
              <input id="source-language" className="input" value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value)} maxLength={100} />
            </div>
            <div className="field">
              <label htmlFor="target-language">Target language</label>
              <input id="target-language" className="input" value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)} maxLength={100} />
            </div>
            <div className="field field-full">
              <label htmlFor="upload-type">Optional audio or document</label>
              <select id="upload-type" className="select" value={uploadType} onChange={(event) => setUploadType(event.target.value as "audio" | "image")}>
                <option value="audio">Audio for speech-to-text</option>
                <option value="image">Image for document OCR</option>
              </select>
              <div className="upload-field">
                <input
                  type="file"
                  accept={uploadType === "audio" ? "audio/*" : "image/png,image/jpeg,image/webp,image/gif"}
                  onChange={(event) => setUpload(event.target.files?.[0] ?? null)}
                />
              </div>
              {upload ? <span className="field-hint">{upload.name} · {(upload.size / 1024 / 1024).toFixed(2)} MB</span> : null}
            </div>
            <div className="field">
              <label htmlFor="budget">Total budget (USD)</label>
              <input id="budget" className="input" inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} pattern="^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$" required />
            </div>
            <div className="field">
              <label htmlFor="merchant-limit">Per-merchant limit</label>
              <input id="merchant-limit" className="input" inputMode="decimal" value={perMerchantLimit} onChange={(event) => setPerMerchantLimit(event.target.value)} pattern="^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$" required />
            </div>
            <div className="field field-full">
              <label htmlFor="approval-threshold">Human approval above</label>
              <input id="approval-threshold" className="input" inputMode="decimal" value={approvalThreshold} onChange={(event) => setApprovalThreshold(event.target.value)} pattern="^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$" required />
              <span className="field-hint">Any single payment above this amount pauses until approved.</span>
            </div>
            <div className="field field-full">
              <div className="field-label">Merchant allowlist</div>
              {registryError ? <div className="error-state"><strong>Registry unavailable</strong><p>{registryError}</p></div> : null}
              {!registryError && merchantOptions.length === 0 ? (
                <div className="empty-state"><strong>No merchant addresses available</strong><p>Load active services from the registry before starting a paid run.</p></div>
              ) : null}
              {merchantOptions.length > 0 ? (
                <div className="checkbox-list">
                  {merchantOptions.map(([address, label]) => (
                    <label className="checkbox-row" key={address}>
                      <input type="checkbox" checked={allowlist.includes(address)} onChange={() => toggleMerchant(address)} />
                      <span>{label} · <span className="mono">{address}</span></span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
            {error ? <div className="field-full error-state"><strong>Request could not continue</strong><p>{error}</p></div> : null}
            <div className="field-full">
              <button className="button button-primary" type="submit" disabled={submitting || merchantOptions.length === 0}>
                {submitting ? "Starting run…" : "Start agent run"} <span aria-hidden="true">↗</span>
              </button>
            </div>
          </div>
        </form>

        <section className="panel panel-pad" aria-live="polite">
          <div className="section-heading" style={{ alignItems: "center", marginBottom: 18 }}>
            <div>
              <div className="eyebrow">LIVE RUN TIMELINE</div>
              <h2 style={{ marginTop: 6, fontSize: 17 }}>{runId ? `Run ${runId.slice(0, 8)}` : "Waiting for a run"}</h2>
            </div>
            {runStatus ? <span className={runStatus === "failed" ? "pill pill-danger" : "pill"}>{runStatus}</span> : null}
          </div>
          {spendReport ? (
            <div className="result-box">
              <strong>Spend report</strong>
              <div className="audit-meta">
                <span>Paid: {money(spendReport.amount)}</span>
                <span>Total spent: {money(spendReport.totalSpent)}</span>
                <span>Remaining: {money(spendReport.remaining)}</span>
              </div>
            </div>
          ) : null}
          {events.length === 0 ? (
            <div className="empty-state"><strong>Run steps will appear here</strong><p>Discovery, comparison, approval, payment, and result events stream from the API.</p></div>
          ) : (
            <div className="timeline" style={{ marginTop: 19 }}>
              {events.map((item, index) => (
                <article className="timeline-item" key={`${item.id}-${index}`}>
                  <span className="timeline-marker">{item.type === "result" ? "✓" : item.type === "failed" ? "!" : index + 1}</span>
                  <div className="timeline-content">
                    <h3 className="timeline-title">{item.type.replaceAll("_", " ")}</h3>
                    <p className="timeline-message">{item.message}</p>
                    {(item.type === "comparison" || item.type === "selection") && Array.isArray(item.data) ? (
                      <div className="result-box">
                        {(item.data as Array<Record<string, unknown>>).map((candidate) => (
                          <div className="audit-meta" key={`${String(candidate.serviceId)}-${String(candidate.rail)}`}>
                            <span>{String(candidate.name)}</span>
                            <span>{String(candidate.rail)}</span>
                            <span>{money(candidate.amount)}</span>
                            <span>Quality {String(candidate.quality)}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {item.type === "result" ? (
                      <div className="result-box">
                        <strong>Paid result</strong>
                        <pre>{JSON.stringify(item.data.result ?? item.data, null, 2)}</pre>
                        {typeof item.data.explorerUrl === "string" ? (
                          <a className="table-link" href={item.data.explorerUrl} target="_blank" rel="noreferrer">Open settlement in explorer ↗</a>
                        ) : null}
                      </div>
                    ) : null}
                    {item.type === "payment_denied" || item.type === "failed" ? (
                      <div className="result-box" style={{ color: "var(--danger)" }}>
                        {String(item.data.code ?? item.data.error ?? "No protected service result was released.")}
                      </div>
                    ) : null}
                    <div className="timeline-time">{new Date(item.createdAt).toLocaleTimeString()}</div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
      <p className="footer-note">Uploads and spend policies are sent to the configured backend. Payment keys never enter this browser.</p>
      {pendingApproval ? (
        <div className="modal-backdrop">
          <section className="approval-modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
            <div className="eyebrow">HUMAN APPROVAL REQUIRED</div>
            <h2 id="approval-title">Allow this payment?</h2>
            <p className="timeline-message">
              This request is paused. The protected service will not execute until you approve.
            </p>
            <div className="approval-summary">
              <span>Amount <strong>{money(approvalDetails?.amount)}</strong></span>
              <span>Payment rail <strong>{String(approvalDetails?.rail ?? "unknown")}</strong></span>
              <span>Merchant <strong className="mono">{String(approvalDetails?.merchant ?? "unknown")}</strong></span>
            </div>
            {error ? <div className="error-state"><strong>Approval was not submitted</strong><p>{error}</p></div> : null}
            <div className="approval-actions">
              <button className="button button-primary" type="button" disabled={approvalBusy} onClick={() => void decideApproval("approve")}>
                {approvalBusy ? "Submitting…" : "Approve payment"}
              </button>
              <button className="button button-secondary" type="button" disabled={approvalBusy} onClick={() => void decideApproval("reject")}>Reject</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
