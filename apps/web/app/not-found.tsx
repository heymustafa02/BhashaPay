import Link from "next/link";

export default function NotFoundPage() {
  return (
    <div className="empty-state">
      <strong>Page not found</strong>
      <p>The BhashaPay page you requested does not exist.</p>
      <Link className="text-link" href="/">Return to overview</Link>
    </div>
  );
}
