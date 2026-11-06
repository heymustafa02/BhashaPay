import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";

export type WhitechainRequestIdentity = {
  idempotencyKey: string;
  serviceId: string;
  payer: string;
  payloadHash: string;
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const properties = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${properties.join(",")}}`;
}

export function hashPayload(value: unknown): string {
  return keccak256(toUtf8Bytes(canonicalJson(value)));
}

export function calculateWhitechainRequestHash(identity: WhitechainRequestIdentity): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "address", "bytes32"],
      [
        keccak256(toUtf8Bytes(identity.idempotencyKey)),
        identity.serviceId,
        identity.payer,
        identity.payloadHash,
      ],
    ),
  );
}
