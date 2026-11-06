import { Contract, JsonRpcProvider, isAddress } from "ethers";
import type Database from "better-sqlite3";

const registryAbi = [
  "function listServices() view returns (tuple(bytes32 serviceId,address merchant,uint256 price,string metadataURI,bool active)[])",
];
const chainId = BigInt(1874);

export type RegistryService = {
  serviceId: string;
  name: string;
  kind: "stt" | "translate" | "ocr";
  endpoint: string;
  description: string;
  price: { hedera: string | null; whitechain: string | null };
  quality: number;
  merchant: { hedera: string | null; whitechain: string | null };
  acceptedRails: Array<"hedera" | "whitechain">;
  active: boolean;
  metadata: Record<string, unknown>;
  registrySource: string;
  registryUrl: string | null;
};

export async function getRegistry(database: Database.Database): Promise<{
  services: RegistryService[];
  whitechainAvailable: boolean;
}> {
  const rows = database.prepare("SELECT * FROM services ORDER BY name, service_id").all() as Array<
    Record<string, unknown>
  >;
  const localServices: RegistryService[] = rows.map((row) => {
    const metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
    const rails: Array<"hedera" | "whitechain"> = [];
    if (row.hedera_price !== null) rails.push("hedera");
    if (row.whitechain_price !== null) rails.push("whitechain");
    return {
      serviceId: String(row.service_id),
      name: String(row.name),
      kind: row.kind as RegistryService["kind"],
      endpoint: String(row.endpoint),
      description: String(row.description),
      price: {
        hedera: row.hedera_price === null ? null : String(row.hedera_price),
        whitechain: row.whitechain_price === null ? null : String(row.whitechain_price),
      },
      quality: Number(row.quality),
      merchant: {
        hedera: row.hedera_merchant === null ? null : String(row.hedera_merchant),
        whitechain: row.whitechain_merchant === null ? null : String(row.whitechain_merchant),
      },
      acceptedRails: rails,
      active: Number(row.active) === 1,
      metadata,
      registrySource: String(row.registry_source),
      registryUrl: null,
    };
  });

  const registryAddress = process.env.WHITECHAIN_REGISTRY_ADDRESS;
  if (!registryAddress) {
    return { services: localServices, whitechainAvailable: false };
  }
  if (!isAddress(registryAddress)) {
    throw new Error("WHITECHAIN_REGISTRY_ADDRESS is invalid.");
  }

  const provider = new JsonRpcProvider(
    process.env.WHITECHAIN_RPC_URL ?? "https://rpc.testnet.whitechain.io/",
    chainId,
  );
  const network = await provider.getNetwork();
  if (network.chainId !== chainId) {
    throw new Error("Configured Whitechain RPC is not chain ID 1874.");
  }
  const registry = new Contract(registryAddress, registryAbi, provider);
  const onchain = await registry.listServices();
  const byId = new Map(localServices.map((service) => [service.serviceId.toLowerCase(), service]));

  for (const service of onchain) {
    const id = String(service.serviceId ?? service[0]);
    const merchant = String(service.merchant ?? service[1]);
    const price = String(service.price ?? service[2]);
    const metadataURI = String(service.metadataURI ?? service[3]);
    const active = Boolean(service.active ?? service[4]);
    const existing = byId.get(id.toLowerCase());
    if (existing) {
      existing.price.whitechain = price;
      existing.merchant.whitechain = merchant;
      existing.acceptedRails = existing.acceptedRails.includes("hedera")
        ? ["hedera", "whitechain"]
        : ["whitechain"];
      existing.active = existing.active && active;
      existing.registrySource = "whitechain";
      existing.registryUrl = `https://explorer.testnet.whitechain.io/address/${registryAddress}`;
    } else {
      const metadata = decodeMetadata(metadataURI);
      const kind = metadata.kind;
      if (kind !== "stt" && kind !== "translate" && kind !== "ocr") continue;
      byId.set(id.toLowerCase(), {
        serviceId: id,
        name: typeof metadata.name === "string" ? metadata.name : String(kind),
        kind,
        endpoint: `/${kind}`,
        description: typeof metadata.description === "string" ? metadata.description : "",
        price: { hedera: null, whitechain: price },
        quality: typeof metadata.quality === "number" ? metadata.quality : 0,
        merchant: { hedera: null, whitechain: merchant },
        acceptedRails: ["whitechain"],
        active,
        metadata,
        registrySource: "whitechain",
        registryUrl: `https://explorer.testnet.whitechain.io/address/${registryAddress}`,
      });
    }
  }

  return { services: [...byId.values()], whitechainAvailable: true };
}

function decodeMetadata(uri: string): Record<string, unknown> {
  const prefix = "data:application/json;utf8,";
  if (!uri.startsWith(prefix)) return {};
  try {
    const value: unknown = JSON.parse(decodeURIComponent(uri.slice(prefix.length)));
    return typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : {};
  } catch (error) {
    throw new Error("Invalid JSON metadata in the onchain service registry.", { cause: error });
  }
}
