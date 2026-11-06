const waiters = new Map<string, (approved: boolean) => void>();

export function waitForApproval(paymentId: string, timeoutMs = 5 * 60_000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(paymentId);
      resolve(false);
    }, timeoutMs);
    waiters.set(paymentId, (approved) => {
      clearTimeout(timer);
      waiters.delete(paymentId);
      resolve(approved);
    });
  });
}

export function resolveApproval(paymentId: string, approved: boolean): boolean {
  const resolve = waiters.get(paymentId);
  if (!resolve) return false;
  resolve(approved);
  return true;
}
