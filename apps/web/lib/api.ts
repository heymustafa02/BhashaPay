export const apiBaseUrl = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4021").replace(/\/+$/, "");

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    cache: "no-store",
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const errorMessage =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
        ? body.error.message
        : `Request failed with HTTP ${response.status}.`;
    throw new Error(errorMessage);
  }
  return body as T;
}

export function formatUnits(value: string | null | undefined): string {
  if (!value) return "Not available";
  const amount = Number(value) / 1_000_000;
  return `${amount.toFixed(amount < 0.1 ? 3 : 2)} USDC/USDT`;
}
