import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateWhitechainRequestHash,
  canonicalJson,
  hashPayload,
} from "../packages/shared/payment";
import { decideSpend, dollarsToUnits } from "../packages/shared/spend-policy";

const identity = {
  idempotencyKey: "run-123-call-1",
  serviceId: `0x${"11".repeat(32)}`,
  payer: "0x0000000000000000000000000000000000000001",
  payloadHash: `0x${"22".repeat(32)}`,
};

test("canonical JSON sorts nested keys", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: true, x: "hi" } }),
    '{"a":{"x":"hi","y":true},"z":1}',
  );
});

test("request hashes are stable and bind to the idempotency key", () => {
  const first = calculateWhitechainRequestHash(identity);
  assert.equal(first, calculateWhitechainRequestHash({ ...identity }));
  assert.notEqual(
    first,
    calculateWhitechainRequestHash({ ...identity, idempotencyKey: "run-123-call-2" }),
  );
});

test("payload hashes bind payment to the actual request body", () => {
  assert.equal(hashPayload({ text: "नमस्ते", targetLanguage: "English" }), hashPayload({
    targetLanguage: "English",
    text: "नमस्ते",
  }));
  assert.notEqual(
    hashPayload({ text: "नमस्ते", targetLanguage: "English" }),
    hashPayload({ text: "नमस्ते", targetLanguage: "Marathi" }),
  );
});

test("dollar amounts convert to six-decimal atomic units without floating point", () => {
  assert.equal(dollarsToUnits("0.50"), BigInt(500000));
  assert.equal(dollarsToUnits("2"), BigInt(2000000));
  assert.throws(() => dollarsToUnits("0.0000001"));
});

test("spend policy enforces allowlist, total, merchant cap, then approval threshold", () => {
  const base = {
    merchant: "0x0000000000000000000000000000000000000001",
    merchantAllowlist: ["0x0000000000000000000000000000000000000001"],
    amount: BigInt(50),
    budget: BigInt(100),
    spent: BigInt(10),
    perMerchantLimit: BigInt(60),
    merchantSpent: BigInt(0),
    approvalThreshold: BigInt(40),
  };
  assert.deepEqual(decideSpend(base), { allowed: true, requiresApproval: true });
  assert.deepEqual(
    decideSpend({ ...base, merchantAllowlist: [] }),
    { allowed: false, reason: "merchant_not_allowed" },
  );
  assert.deepEqual(
    decideSpend({ ...base, spent: BigInt(60) }),
    { allowed: false, reason: "over_budget" },
  );
  assert.deepEqual(
    decideSpend({ ...base, merchantSpent: BigInt(11) }),
    { allowed: false, reason: "merchant_limit" },
  );
});
