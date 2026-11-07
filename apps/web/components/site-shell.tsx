"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navigation = [
  { href: "/", label: "Overview", glyph: "◫" },
  { href: "/marketplace", label: "Marketplace", glyph: "⌘" },
  { href: "/agent", label: "Agent runs", glyph: "✳" },
  { href: "/payments", label: "Payments", glyph: "↗" },
  { href: "/audit", label: "Audit log", glyph: "≋" },
];

export function SiteShell({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="BhashaPay home">
          <span className="brand-mark">भ</span>
          <span>
            <strong>BhashaPay</strong>
            <small>agentic services</small>
          </span>
        </Link>
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          {navigation.map((item) => (
            <Link
              className="nav-link"
              href={item.href}
              key={item.href}
              aria-current={pathname === item.href ? "page" : undefined}
            >
              <span className="nav-glyph" aria-hidden="true">{item.glyph}</span>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="network-dot" />
          <span>Hedera testnet</span>
          <span className="network-tag">TEST</span>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark">भ</span>BhashaPay</div>
          <span className="topbar-caption">Indic AI services, paid per call</span>
          <Link className="topbar-action" href="/agent">New run <span aria-hidden="true">+</span></Link>
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
