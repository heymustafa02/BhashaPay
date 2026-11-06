import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { openDatabase } from "../services/api/database";

const services = [
  {
    name: "Marathi speech transcription",
    kind: "stt",
    endpoint: "/stt",
    description: "Transcribe Hindi and Marathi speech to text.",
    hederaPrice: "50000",
    whitechainPrice: "50000",
    quality: 91,
  },
  {
    name: "Indic translation",
    kind: "translate",
    endpoint: "/translate",
    description: "Translate Indic-language text to or from English.",
    hederaPrice: "10000",
    whitechainPrice: "10000",
    quality: 96,
  },
  {
    name: "Indic document OCR",
    kind: "ocr",
    endpoint: "/ocr",
    description: "Extract text from an Indic-language document image.",
    hederaPrice: "30000",
    whitechainPrice: "30000",
    quality: 89,
  },
] as const;

async function main(): Promise<void> {
  const registryAddress = process.env.WHITECHAIN_REGISTRY_ADDRESS;
  const privateKey = process.env.WHITECHAIN_DEPLOYER_PRIVATE_KEY;
  const hederaMerchant = process.env.HEDERA_PAY_TO_ACCOUNT_ID;

  if (!registryAddress || !privateKey || !hederaMerchant) {
    throw new Error(
      "Set WHITECHAIN_REGISTRY_ADDRESS, WHITECHAIN_DEPLOYER_PRIVATE_KEY, and HEDERA_PAY_TO_ACCOUNT_ID before seeding.",
    );
  }

  const provider = new JsonRpcProvider(
    process.env.WHITECHAIN_RPC_URL ?? "https://rpc.testnet.whitechain.io/",
    1874,
  );
  const wallet = new Wallet(privateKey, provider);
  const registry = new Contract(
    registryAddress,
    [
      "function listServices() view returns (tuple(bytes32 serviceId,address merchant,uint256 price,string metadataURI,bool active)[])",
      "function registerService(bytes32 serviceId,uint256 price,string metadataURI)",
    ],
    wallet,
  );
  const onchain = await registry.listServices();
  const knownIds = new Set(onchain.map((service: { serviceId?: string; 0?: string }) =>
    String(service.serviceId ?? service[0]).toLowerCase(),
  ));
  const database = openDatabase();
  const now = new Date().toISOString();

  try {
    for (const service of services) {
      const serviceId = keccak256(toUtf8Bytes(service.kind));
      const metadata = {
        name: service.name,
        kind: service.kind,
        endpoint: service.endpoint,
        description: service.description,
        quality: service.quality,
      };
      const metadataURI = `data:application/json;utf8,${encodeURIComponent(JSON.stringify(metadata))}`;
      if (!knownIds.has(serviceId.toLowerCase())) {
        const tx = await registry.registerService(serviceId, service.whitechainPrice, metadataURI);
        const receipt = await tx.wait(1);
        if (!receipt || receipt.status !== 1) {
          throw new Error(`Whitechain service registration failed for ${service.kind}.`);
        }
        console.log(JSON.stringify({
          service: service.kind,
          transactionHash: receipt.hash,
          explorerUrl: `https://explorer.testnet.whitechain.io/tx/${receipt.hash}`,
        }));
      }

      database.prepare(
        `INSERT INTO services (
          service_id, name, kind, endpoint, description, hedera_price, whitechain_price,
          hedera_merchant, whitechain_merchant, quality, metadata_json, active, registry_source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'whitechain', ?)
        ON CONFLICT(service_id) DO UPDATE SET
          name=excluded.name, kind=excluded.kind, endpoint=excluded.endpoint,
          description=excluded.description, hedera_price=excluded.hedera_price,
          whitechain_price=excluded.whitechain_price, hedera_merchant=excluded.hedera_merchant,
          whitechain_merchant=excluded.whitechain_merchant, quality=excluded.quality,
          metadata_json=excluded.metadata_json, active=1, registry_source='whitechain',
          updated_at=excluded.updated_at`,
      ).run(
        serviceId,
        service.name,
        service.kind,
        service.endpoint,
        service.description,
        service.hederaPrice,
        service.whitechainPrice,
        hederaMerchant,
        wallet.address,
        service.quality,
        JSON.stringify(metadata),
        now,
      );
    }
  } finally {
    database.close();
    provider.destroy();
  }
  console.log(`Registered ${services.length} service records using ${wallet.address}.`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
