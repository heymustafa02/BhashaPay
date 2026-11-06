import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  getBytes,
  isAddress,
  verifyTypedData,
  type Log,
  type LogDescription,
  type TransactionReceipt,
} from "ethers";
import { calculateWhitechainRequestHash } from "../../packages/shared/payment";
import { z } from "zod";

const chainId = BigInt(1874);
const explorer = "https://explorer.testnet.whitechain.io";
const serviceAbi = [
  "function getService(bytes32) view returns (tuple(bytes32 serviceId,address merchant,uint256 price,string metadataURI,bool active))",
];
const settlementAbi = [
  "function settle(bytes32 serviceId,address payer,uint256 amount,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature,bytes32 requestHash) returns (uint256 receiptId)",
  "function usedRequestHashes(bytes32) view returns (bool)",
  "function receiptForRequestHash(bytes32) view returns (uint256)",
  "function getReceipt(uint256) view returns (tuple(bytes32 serviceId,address payer,address merchant,uint256 amount,uint64 timestamp,bytes32 requestHash,bool refunded))",
  "event PaymentSettled(uint256 indexed receiptId,bytes32 indexed serviceId,address indexed payer,address merchant,uint256 amount,bytes32 requestHash)",
];
const tokenAbi = [
  "function name() view returns (string)",
  "function authorizationState(address,bytes32) view returns (bool)",
];
const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const inputSchema = z.object({
  serviceId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  payer: z.string().refine(isAddress),
  amount: z.string().regex(/^(0|[1-9]\d*)$/),
  validAfter: z.string().regex(/^(0|[1-9]\d*)$/),
  validBefore: z.string().regex(/^(0|[1-9]\d*)$/),
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  idempotencyKey: z.string().min(8).max(200),
  payloadHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

type SettlementInput = z.infer<typeof inputSchema>;
type RateBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateBucket>();
const rateLimitWindowMs = 60_000;

const port = Number(process.env.WHITECHAIN_FACILITATOR_PORT ?? "4030");
const rpcUrl = process.env.WHITECHAIN_RPC_URL ?? "https://rpc.testnet.whitechain.io/";
const tokenAddress = process.env.WHITECHAIN_USDT_ADDRESS ?? "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7";
const registryAddress = process.env.WHITECHAIN_REGISTRY_ADDRESS;
const settlementAddress = process.env.WHITECHAIN_SETTLEMENT_ADDRESS;
const sharedSecret = process.env.FACILITATOR_SHARED_SECRET;
const relayerPrivateKey = process.env.WHITECHAIN_RELAYER_PRIVATE_KEY;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("WHITECHAIN_FACILITATOR_PORT must be a valid TCP port.");
}
if (!registryAddress || !isAddress(registryAddress)) {
  throw new Error("WHITECHAIN_REGISTRY_ADDRESS must be set to the deployed registry.");
}
if (!settlementAddress || !isAddress(settlementAddress)) {
  throw new Error("WHITECHAIN_SETTLEMENT_ADDRESS must be set to the deployed settlement contract.");
}
if (!sharedSecret || sharedSecret.length < 32) {
  throw new Error("FACILITATOR_SHARED_SECRET must contain at least 32 characters.");
}
if (!relayerPrivateKey) {
  throw new Error("WHITECHAIN_RELAYER_PRIVATE_KEY is required.");
}
if (!isAddress(tokenAddress)) {
  throw new Error("WHITECHAIN_USDT_ADDRESS must be a valid EVM address.");
}

const provider = new JsonRpcProvider(rpcUrl, chainId);
const relayer = new Wallet(relayerPrivateKey, provider);
const registry = new Contract(registryAddress, serviceAbi, provider);
const settlement = new Contract(settlementAddress, settlementAbi, relayer);
const token = new Contract(tokenAddress, tokenAbi, provider);
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

app.get("/health", async (_req, res) => {
  try {
    const network = await provider.getNetwork();
    res.json({
      status: network.chainId === chainId ? "ok" : "wrong-chain",
      chainId: network.chainId.toString(),
      relayerAddress: await relayer.getAddress(),
    });
  } catch (error) {
    log("error", "health_check_failed", errorMessage(error));
    res.status(503).json({ error: { code: "RPC_UNAVAILABLE", message: "Whitechain RPC unavailable." } });
  }
});

app.post(
  "/settle",
  (req, res, next) => {
    const supplied = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!constantTimeEqual(supplied, sharedSecret)) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid facilitator credentials." } });
      return;
    }

    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "INVALID_REQUEST",
          message: "Invalid settlement request.",
          details: parsed.error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
        },
      });
      return;
    }

    res.locals.settlementInput = parsed.data;
    next();
  },
  rateLimit((req) => `ip:${req.ip}`, 30),
  rateLimit((_req, res) => `service:${getInput(res)?.serviceId}`, 60),
  rateLimit((_req, res) => `payer:${getInput(res)?.payer.toLowerCase()}`, 12),
  async (_req, res) => {
    try {
      const input = getInput(res);
      if (!input) {
        throw new Error("Validated settlement input was not set.");
      }
      const result = await settle(input);
      res.json(result);
    } catch (error) {
      const failure = classifySettlementError(error);
      log("warn", "settlement_rejected", {
        code: failure.code,
        message: failure.message,
        serviceId: getInput(res)?.serviceId,
        payer: getInput(res)?.payer,
      });
      if (!failure.expected) {
        log("error", "settlement_failed", errorMessage(error));
      }
      res.status(failure.status).json({ error: { code: failure.code, message: failure.message } });
    }
  },
);

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  log("error", "unhandled_facilitator_error", errorMessage(error));
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Settlement failed." } });
});

app.listen(port, () => {
  log("info", "facilitator_started", { port, registryAddress, settlementAddress });
});

async function settle(input: SettlementInput): Promise<{
  success: true;
  receiptId: string;
  transactionHash: string;
  explorerUrl: string;
  receipt: {
    serviceId: string;
    payer: string;
    merchant: string;
    amount: string;
    timestamp: string;
    requestHash: string;
  };
}> {
  const [network, tokenName] = await Promise.all([provider.getNetwork(), token.name()]);
  if (network.chainId !== chainId) {
    throw new SettlementError("WRONG_CHAIN", "Configured RPC is not Whitechain Sepolia.", 503);
  }
  if (tokenName !== "Tether USD") {
    throw new SettlementError("WRONG_TOKEN", "Configured token is not the verified Whitechain USDT.", 503);
  }

  const service = await registry.getService(input.serviceId);
  const merchant = getAddress(service.merchant ?? service[1]);
  const servicePrice = BigInt(service.price ?? service[2]);
  const amount = BigInt(input.amount);
  if (!(service.active ?? service[4])) {
    throw new SettlementError("SERVICE_INACTIVE", "The requested service is inactive.", 409);
  }
  if (amount !== servicePrice) {
    throw new SettlementError("AMOUNT_MISMATCH", "Payment amount does not match the live registry price.", 409);
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = BigInt(input.validAfter);
  const validBefore = BigInt(input.validBefore);
  if (validAfter > now || validBefore <= now || validBefore > now + BigInt(600)) {
    throw new SettlementError("AUTHORIZATION_EXPIRED", "Authorization is expired or outside the 10-minute window.", 409);
  }

  const payer = getAddress(input.payer);
  const nonce = input.nonce;
  const requestHash = calculateWhitechainRequestHash({
    idempotencyKey: input.idempotencyKey,
    serviceId: input.serviceId,
    payer,
    payloadHash: input.payloadHash,
  });
  const domain = { name: tokenName, version: "1", chainId, verifyingContract: tokenAddress };
  const authorization = {
    from: payer,
    to: merchant,
    value: amount,
    validAfter,
    validBefore,
    nonce,
  };
  const recovered = getAddress(
    verifyTypedData(domain, authorizationTypes, authorization, input.signature),
  );
  if (recovered !== payer) {
    throw new SettlementError("INVALID_SIGNATURE", "EIP-3009 authorization signer does not match the payer.", 403);
  }

  const requestAlreadySettled = await settlement.usedRequestHashes(requestHash);
  if (requestAlreadySettled) {
    return existingSettlement(requestHash, input.serviceId, payer, merchant, amount);
  }

  const authorizationUsed = await token.authorizationState(payer, nonce);
  if (authorizationUsed) {
    throw new SettlementError("AUTHORIZATION_REPLAYED", "EIP-3009 nonce has already been used.", 409);
  }

  const transaction = await settlement.settle(
    input.serviceId,
    payer,
    amount,
    validAfter,
    validBefore,
    nonce,
    getBytes(input.signature),
    requestHash,
  );
  const mined: TransactionReceipt | null = await transaction.wait(1);
  if (!mined || mined.status !== 1) {
    throw new SettlementError("TRANSACTION_FAILED", "Whitechain settlement transaction did not succeed.", 502);
  }

  const receiptEvent = mined.logs
    .map((log: Log): LogDescription | null => {
      try {
        return settlement.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((event: LogDescription | null) => event?.name === "PaymentSettled");
  if (!receiptEvent) {
    throw new SettlementError("RECEIPT_MISSING", "Confirmed settlement did not emit PaymentSettled.", 502);
  }

  const receiptId = BigInt(receiptEvent.args.receiptId);
  const receipt = await settlement.getReceipt(receiptId);
  if (
    getAddress(receipt.payer ?? receipt[1]) !== payer ||
    getAddress(receipt.merchant ?? receipt[2]) !== merchant ||
    BigInt(receipt.amount ?? receipt[3]) !== amount ||
    String(receipt.requestHash ?? receipt[5]).toLowerCase() !== requestHash.toLowerCase()
  ) {
    throw new SettlementError("RECEIPT_MISMATCH", "Onchain receipt fields do not match the authorized request.", 502);
  }

  return {
    success: true,
    receiptId: receiptId.toString(),
    transactionHash: mined.hash,
    explorerUrl: `${explorer}/tx/${mined.hash}`,
    receipt: {
      serviceId: String(receipt.serviceId ?? receipt[0]),
      payer,
      merchant,
      amount: amount.toString(),
      timestamp: String(receipt.timestamp ?? receipt[4]),
      requestHash,
    },
  };
}

async function existingSettlement(
  requestHash: string,
  serviceId: string,
  payer: string,
  merchant: string,
  amount: bigint,
) {
  const receiptId = BigInt(await settlement.receiptForRequestHash(requestHash));
  if (receiptId === BigInt(0)) {
    throw new SettlementError("RECEIPT_MISSING", "Request hash was marked settled without a receipt.", 502);
  }
  const receipt = await settlement.getReceipt(receiptId);
  const eventFilter = settlement.filters.PaymentSettled(receiptId);
  const events = await settlement.queryFilter(eventFilter);
  const lastEvent = events.at(-1);
  if (!lastEvent || !("transactionHash" in lastEvent)) {
    throw new SettlementError("TRANSACTION_LOOKUP_FAILED", "Could not locate the existing settlement transaction.", 502);
  }
  if (
    String(receipt.serviceId ?? receipt[0]).toLowerCase() !== serviceId.toLowerCase() ||
    getAddress(receipt.payer ?? receipt[1]) !== payer ||
    getAddress(receipt.merchant ?? receipt[2]) !== merchant ||
    BigInt(receipt.amount ?? receipt[3]) !== amount
  ) {
    throw new SettlementError("RECEIPT_MISMATCH", "Existing receipt does not match the retried request.", 409);
  }
  return {
    success: true as const,
    receiptId: receiptId.toString(),
    transactionHash: lastEvent.transactionHash,
    explorerUrl: `${explorer}/tx/${lastEvent.transactionHash}`,
    receipt: {
      serviceId,
      payer,
      merchant,
      amount: amount.toString(),
      timestamp: String(receipt.timestamp ?? receipt[4]),
      requestHash,
    },
  };
}

function rateLimit(keyFor: (req: Request, res: Response) => string, maxRequests: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyFor(req, res);
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + rateLimitWindowMs };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (rateBuckets.size > 10_000) {
      for (const [bucketKey, entry] of rateBuckets) {
        if (entry.resetAt <= now) rateBuckets.delete(bucketKey);
      }
    }
    if (bucket.count > maxRequests) {
      res.status(429).json({
        error: { code: "RATE_LIMITED", message: "Settlement rate limit exceeded." },
      });
      return;
    }
    next();
  };
}

class SettlementError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function classifySettlementError(error: unknown): {
  code: string;
  message: string;
  status: number;
  expected: boolean;
} {
  if (error instanceof SettlementError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      expected: true,
    };
  }
  const raw = errorMessage(error);
  if (/insufficient funds/i.test(raw)) {
    return {
      code: "RELAYER_UNFUNDED",
      message: "Relayer cannot pay Whitechain gas; protected work was not released.",
      status: 503,
      expected: true,
    };
  }
  if (/execution reverted|CALL_EXCEPTION|revert/i.test(raw)) {
    return {
      code: "SETTLEMENT_REVERTED",
      message: raw.slice(0, 300),
      status: 409,
      expected: true,
    };
  }
  return {
    code: "SETTLEMENT_UNAVAILABLE",
    message: "Whitechain settlement failed before confirmation.",
    status: 502,
    expected: false,
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(level: "info" | "warn" | "error", event: string, fields: unknown): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, event, fields }));
}

function getInput(res: Response): SettlementInput | undefined {
  const result = inputSchema.safeParse(res.locals.settlementInput);
  return result.success ? result.data : undefined;
}
