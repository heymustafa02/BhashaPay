import "dotenv/config";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dollarsToUnits } from "../../packages/shared/spend-policy";
import { getRegistry } from "../api/registry";
import { openDatabase } from "../api/database";
import { runAgent } from "./runner";

const server = new McpServer({
  name: "bhashapay-agent",
  version: "1.0.0",
});
const database = openDatabase();

const policyShape = {
  perMerchantLimit: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/),
  merchantAllowlist: z.array(
    z.string().refine((value) => /^0\.0\.\d+$/.test(value) || /^0x[0-9a-fA-F]{40}$/.test(value)),
  ).max(50),
  approvalThreshold: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/),
};
const inputShape = {
  text: z.string().max(10_000).optional(),
  sourceLanguage: z.string().max(100).optional(),
  targetLanguage: z.string().max(100).optional(),
  audioBase64: z.string().max(15_000_000).optional(),
  imageBase64: z.string().max(15_000_000).optional(),
  fileName: z.string().max(200).optional(),
  mimeType: z.string().max(100).optional(),
};

server.registerTool(
  "list_services",
  {
    title: "List BhashaPay services",
    description: "Discover active Indic-language services, prices, quality, merchants, and payment rails.",
    inputSchema: { includeInactive: z.boolean().optional() },
  },
  async ({ includeInactive }) => {
    const registry = await getRegistry(database);
    const services = includeInactive
      ? registry.services
      : registry.services.filter((service) => service.active);
    return textResult({ whitechainAvailable: registry.whitechainAvailable, services });
  },
);

server.registerTool(
  "call_service",
  {
    title: "Call a paid BhashaPay service",
    description: "Start an agent run. Total budget, merchant allowlist, per-merchant cap, and approval threshold are enforced before payment.",
    inputSchema: {
      task: z.string().min(1).max(2_000),
      budget: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/),
      policy: z.object(policyShape),
      input: z.object(inputShape).default({}),
    },
  },
  async ({ task, budget, policy, input }) => {
    const runId = randomUUID();
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO runs (id, task, budget, policy_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    ).run(runId, task, dollarsToUnits(budget).toString(), JSON.stringify({
      task,
      budget,
      policy,
      input,
    }), now, now);

    void runAgent(database, runId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      database.prepare(
        "UPDATE runs SET status = 'failed', error_json = ?, updated_at = ?, finished_at = ? WHERE id = ?",
      ).run(JSON.stringify({ message }), new Date().toISOString(), new Date().toISOString(), runId);
      console.error(JSON.stringify({ level: "error", event: "mcp_agent_run_failed", runId, message }));
    });
    return textResult({
      runId,
      status: "running",
      message: "Run started. Call get_spend_report with runId to retrieve progress and the final spend report.",
    });
  },
);

server.registerTool(
  "get_spend_report",
  {
    title: "Get agent spend report",
    description: "Return the persisted run budget, actual spend, remaining balance, payment outcomes, and explorer links.",
    inputSchema: { runId: z.string().uuid() },
  },
  async ({ runId }) => {
    const run = database.prepare(
      "SELECT id, status, budget, spent, chosen_service_id, result_json, error_json FROM runs WHERE id = ?",
    ).get(runId) as {
      id: string;
      status: string;
      budget: string;
      spent: string;
      chosen_service_id: string | null;
      result_json: string | null;
      error_json: string | null;
    } | undefined;
    if (!run) return textResult({ error: "Run was not found." }, true);

    const payments = database.prepare(
      `SELECT service_id, rail, amount, status, payer, merchant, tx_hash, explorer_url, receipt_id, error_json
       FROM payments WHERE run_id = ? ORDER BY created_at`,
    ).all(runId);
    return textResult({
      runId: run.id,
      status: run.status,
      budget: run.budget,
      spent: run.spent,
      remaining: (BigInt(run.budget) - BigInt(run.spent)).toString(),
      chosenServiceId: run.chosen_service_id,
      result: run.result_json ? JSON.parse(run.result_json) as unknown : null,
      error: run.error_json ? JSON.parse(run.error_json) as unknown : null,
      payments,
    });
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    isError,
  };
}

void main().catch((error: unknown) => {
  console.error("BhashaPay MCP server failed:", error);
  database.close();
  process.exitCode = 1;
});
