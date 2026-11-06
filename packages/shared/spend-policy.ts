export type SpendDecision =
  | { allowed: true; requiresApproval: boolean }
  | { allowed: false; reason: "merchant_not_allowed" | "over_budget" | "merchant_limit" };

export function decideSpend(input: {
  merchant: string;
  merchantAllowlist: string[];
  amount: bigint;
  budget: bigint;
  spent: bigint;
  perMerchantLimit: bigint;
  merchantSpent: bigint;
  approvalThreshold: bigint;
}): SpendDecision {
  const allowedMerchants = new Set(input.merchantAllowlist.map((merchant) => merchant.toLowerCase()));
  if (!allowedMerchants.has(input.merchant.toLowerCase())) {
    return { allowed: false, reason: "merchant_not_allowed" };
  }
  if (input.amount <= BigInt(0) || input.spent + input.amount > input.budget) {
    return { allowed: false, reason: "over_budget" };
  }
  if (input.merchantSpent + input.amount > input.perMerchantLimit) {
    return { allowed: false, reason: "merchant_limit" };
  }
  return {
    allowed: true,
    requiresApproval: input.amount > input.approvalThreshold,
  };
}

export function dollarsToUnits(amount: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(amount)) {
    throw new Error("Budget and policy amounts must be valid decimals with up to 6 places.");
  }
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0"));
}
