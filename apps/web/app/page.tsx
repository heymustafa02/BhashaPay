import Link from "next/link";

const highlights = [
  { label: "Payment rails", value: "2", caption: "Hedera x402 + Whitechain USDT" },
  { label: "Service types", value: "03", caption: "Speech, translation, document OCR" },
  { label: "Settlement", value: "On-chain", caption: "Verified receipts for every paid call" },
];

export default function HomePage() {
  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-dot" /> THE INDIC AI SERVICE MARKETPLACE</div>
          <h1>Language services,<br /><span>paid one call at a time.</span></h1>
          <p>
            BhashaPay gives autonomous agents a way to discover, compare, and pay for
            Indic-language AI services with transparent on-chain settlement.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/agent">Run the agent <span aria-hidden="true">↗</span></Link>
            <Link className="button button-secondary" href="/marketplace">Explore marketplace</Link>
          </div>
          <div className="hero-note"><span className="secure-icon">◈</span> Spend controls before every payment</div>
        </div>
        <div className="hero-art" aria-label="Indic script and payment route illustration">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="orbit orbit-three" />
          <div className="orbit-center"><span>भाषा</span><small>PAY-PER-CALL</small></div>
          <div className="orbit-node node-top">Aa</div>
          <div className="orbit-node node-left">हि</div>
          <div className="orbit-node node-right">मर</div>
          <div className="orbit-node node-bottom">₹</div>
          <div className="orbit-tag tag-one">discover</div>
          <div className="orbit-tag tag-two">settle</div>
        </div>
        <div className="hero-index">01 <span>/</span> 04</div>
      </section>

      <section className="stat-grid" aria-label="Platform overview">
        {highlights.map((item) => (
          <article className="stat-card" key={item.label}>
            <div className="stat-label">{item.label}</div>
            <div className="stat-value">{item.value}</div>
            <div className="stat-caption">{item.caption}</div>
          </article>
        ))}
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <div className="eyebrow">HOW IT WORKS</div>
            <h2>One intent. The right service. A verifiable payment.</h2>
          </div>
          <Link className="text-link" href="/audit">View audit trail <span aria-hidden="true">↗</span></Link>
        </div>
        <div className="steps-grid">
          {[
            ["01", "Describe the task", "Give the agent a language task and a spend limit."],
            ["02", "Compare the market", "The agent checks registered prices, quality, and payment rails."],
            ["03", "Settle on-chain", "Only an allowed, in-budget call is paid and returned."],
          ].map(([number, title, description]) => (
            <article className="step-card" key={number}>
              <span className="step-number">{number}</span>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
