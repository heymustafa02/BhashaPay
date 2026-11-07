export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

export type DemoService = {
  serviceId: string;
  name: string;
  kind: string;
  description: string;
  price: { hedera: string | null; whitechain: string | null };
  quality: number;
  merchant: { hedera: string | null; whitechain: string | null };
  acceptedRails: Array<"hedera" | "whitechain">;
  active: boolean;
  registryUrl: string | null;
};

export const demoServices: DemoService[] = [
  {
    serviceId: "demo-translation-mr-en",
    name: "Marathi → English Translation",
    kind: "translate",
    description: "Faithful, context-aware translation for everyday and business text.",
    price: { hedera: "10000", whitechain: "12000" },
    quality: 96,
    merchant: { hedera: "0.0.4829101", whitechain: "0x4a2d000000000000000000000000000000004a2d" },
    acceptedRails: ["hedera", "whitechain"],
    active: true,
    registryUrl: null,
  },
  {
    serviceId: "demo-speech-hi",
    name: "Hindi Speech Transcription",
    kind: "stt",
    description: "Transcribes short Hindi audio clips while preserving the original script.",
    price: { hedera: "50000", whitechain: null },
    quality: 93,
    merchant: { hedera: "0.0.4829102", whitechain: null },
    acceptedRails: ["hedera"],
    active: true,
    registryUrl: null,
  },
  {
    serviceId: "demo-document-ocr",
    name: "Indic Document OCR",
    kind: "ocr",
    description: "Extracts readable text from scanned forms and document images.",
    price: { hedera: "30000", whitechain: null },
    quality: 91,
    merchant: { hedera: "0.0.4829103", whitechain: null },
    acceptedRails: ["hedera"],
    active: true,
    registryUrl: null,
  },
];

export type DemoPayment = {
  id: string;
  run_id: string | null;
  service_id: string;
  rail: "hedera" | "whitechain";
  amount: string;
  payer: string | null;
  merchant: string | null;
  status: string;
  tx_hash: string | null;
  explorer_url: string | null;
  receipt_id: string | null;
  error_json: string | null;
  created_at: string;
};

export const demoPayments: DemoPayment[] = [
  {
    id: "demo-payment-1042",
    run_id: "demo-run-1042",
    service_id: "demo-translation-mr-en",
    rail: "hedera",
    amount: "10000",
    payer: "0.0.4829001",
    merchant: "0.0.4829101",
    status: "settled",
    tx_hash: null,
    explorer_url: null,
    receipt_id: "DEMO-RECEIPT-1042",
    error_json: null,
    created_at: new Date(Date.now() - 3 * 60_000).toISOString(),
  },
  {
    id: "demo-payment-1041",
    run_id: "demo-run-1041",
    service_id: "demo-translation-mr-en",
    rail: "whitechain",
    amount: "12000",
    payer: "0x4a2d000000000000000000000000000000000001",
    merchant: "0x4a2d000000000000000000000000000000004a2d",
    status: "settled",
    tx_hash: null,
    explorer_url: null,
    receipt_id: "DEMO-RECEIPT-1041",
    error_json: null,
    created_at: new Date(Date.now() - 19 * 60_000).toISOString(),
  },
  {
    id: "demo-payment-1040",
    run_id: "demo-run-1040",
    service_id: "demo-speech-hi",
    rail: "hedera",
    amount: "50000",
    payer: "0.0.4829001",
    merchant: "0.0.4829102",
    status: "denied",
    tx_hash: null,
    explorer_url: null,
    receipt_id: null,
    error_json: JSON.stringify({ code: "MERCHANT_NOT_ALLOWED" }),
    created_at: new Date(Date.now() - 47 * 60_000).toISOString(),
  },
];

export type DemoAuditEntry = {
  sequence_number: string;
  consensus_timestamp: string;
  decoded: {
    eventId: string;
    status: string;
    rail: "hedera" | "whitechain";
    serviceId: string;
    amount: string;
    createdAt: string;
    errorCode?: string;
  };
};

export const demoAuditEntries: DemoAuditEntry[] = [
  {
    sequence_number: "DEMO-1042",
    consensus_timestamp: new Date(Date.now() - 3 * 60_000).toISOString(),
    decoded: {
      eventId: "demo-event-1042",
      status: "settled",
      rail: "hedera",
      serviceId: "demo-translation-mr-en",
      amount: "10000",
      createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    },
  },
  {
    sequence_number: "DEMO-1041",
    consensus_timestamp: new Date(Date.now() - 19 * 60_000).toISOString(),
    decoded: {
      eventId: "demo-event-1041",
      status: "settled",
      rail: "whitechain",
      serviceId: "demo-translation-mr-en",
      amount: "12000",
      createdAt: new Date(Date.now() - 19 * 60_000).toISOString(),
    },
  },
  {
    sequence_number: "DEMO-1040",
    consensus_timestamp: new Date(Date.now() - 47 * 60_000).toISOString(),
    decoded: {
      eventId: "demo-event-1040",
      status: "denied",
      rail: "hedera",
      serviceId: "demo-speech-hi",
      amount: "50000",
      createdAt: new Date(Date.now() - 47 * 60_000).toISOString(),
      errorCode: "MERCHANT_NOT_ALLOWED",
    },
  },
];
