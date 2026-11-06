"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchJson, formatUnits } from "../../lib/api";

type Service = {
  serviceId: string;
  name: string;
  kind: string;
  description: string;
  price: { hedera: string | null; whitechain: string | null };
  quality: number;
  merchant: { hedera: string | null; whitechain: string | null };
  acceptedRails: Array<"hedera" | "whitechain">;
  active: boolean;
  registryUrl: string | null;
};

export default function MarketplacePage() {
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetchJson<{ services: Service[] }>("/registry")
      .then((result) => {
        if (active) setServices(result.services);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load services.");
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
          <div className="eyebrow">SERVICE DIRECTORY</div>
          <h1>Marketplace</h1>
          <p>Compare registered Indic-language services, prices, quality, and payment rails.</p>
        </div>
        <span className="pill">{services.filter((service) => service.active).length} active</span>
      </header>
      {loading ? <div className="loading-state">Loading registered services…</div> : null}
      {!loading && error ? <div className="error-state"><strong>Marketplace unavailable</strong><p>{error}</p></div> : null}
      {!loading && !error && services.length === 0 ? (
        <div className="empty-state">
          <strong>No services registered yet</strong>
          <p>Start the API and seed services after configuring the Whitechain registry.</p>
        </div>
      ) : null}
      {!loading && !error && services.length > 0 ? (
        <div className="service-grid">
          {services.map((service) => (
            <article className="service-card" key={service.serviceId}>
              <div className="service-top">
                <div>
                  <h2 className="service-title">{service.name}</h2>
                  <p className="service-description">{service.description}</p>
                </div>
                <span className={service.active ? "pill" : "pill pill-danger"}>
                  {service.active ? "Active" : "Inactive"}
                </span>
              </div>
              <div className="service-facts">
                <div>
                  <div className="fact-label">Quality score</div>
                  <div className="fact-value">{service.quality}/100</div>
                </div>
                <div>
                  <div className="fact-label">Service type</div>
                  <div className="fact-value">{service.kind.toUpperCase()}</div>
                </div>
                <div>
                  <div className="fact-label">Hedera price</div>
                  <div className="fact-value">{formatUnits(service.price.hedera)}</div>
                </div>
                <div>
                  <div className="fact-label">Whitechain price</div>
                  <div className="fact-value">{formatUnits(service.price.whitechain)}</div>
                </div>
              </div>
              <div className="rail-row">
                {service.acceptedRails.map((rail) => <span className="pill" key={rail}>{rail}</span>)}
              </div>
              <div>
                <div className="fact-label">Merchant</div>
                {service.merchant.hedera ? (
                  <div className="mono">Hedera · {service.merchant.hedera}</div>
                ) : null}
                {service.merchant.whitechain ? (
                  <div className="mono">Whitechain · {service.merchant.whitechain}</div>
                ) : null}
                {!service.merchant.hedera && !service.merchant.whitechain ? (
                  <div className="mono muted">Merchant is not available</div>
                ) : null}
              </div>
              {service.registryUrl ? (
                <Link className="text-link" href={service.registryUrl} target="_blank" rel="noreferrer">
                  View on-chain registry entry <span aria-hidden="true">↗</span>
                </Link>
              ) : (
                <span className="muted" style={{ fontSize: 10 }}>Registry entry not available</span>
              )}
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
