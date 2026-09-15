import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CjClient } from "../src/connectors/cj.js";
import type { SupplierProduct, SupplierVariant } from "../src/connectors/types.js";
import { loadConfig } from "../src/config.js";
import { scoreProductViability, type ViabilityScores } from "../src/enrichment/index.js";
import { logger } from "../src/logger.js";
import {
  FALLBACK_US_SHIPPING_CENTS,
  MAX_LANDED_COST_CENTS,
  MIN_US_WAREHOUSE_UNITS,
  cjProductUrl,
  evaluateResearchGates,
  formatUsd,
} from "../src/policy/product-research.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = path.join(ROOT, "output", "catalog-candidates.md");
const MAX_PAGES = 5;
const PAGE_SIZE = 20;
const MAX_FREIGHT_LOOKUPS = 60;
const MAX_LLM_SCORES = 30;
const TOP_N = 10;

type RankedCandidate = {
  sku: string;
  title: string;
  landedCostCents: number;
  suggestedRetailCents: number;
  usStock: number;
  viralScore: number;
  problemScore: number;
  combinedScore: number;
  scoreSource: ViabilityScores["source"];
  rationale: string;
  cjUrl: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 120);
}

async function resolveLandedCostCents(
  client: CjClient,
  product: SupplierProduct,
  variant: SupplierVariant,
  freightBudget: { used: number },
): Promise<number> {
  if (Number(product.raw.addMarkStatus) === 1) return variant.costCents;
  if (variant.shippingCents > 0) return variant.costCents + variant.shippingCents;
  if (variant.costCents > MAX_LANDED_COST_CENTS) return variant.costCents;
  if (variant.costCents + FALLBACK_US_SHIPPING_CENTS <= MAX_LANDED_COST_CENTS) {
    return variant.costCents + FALLBACK_US_SHIPPING_CENTS;
  }
  if (freightBudget.used >= MAX_FREIGHT_LOOKUPS) {
    return variant.costCents + FALLBACK_US_SHIPPING_CENTS;
  }
  freightBudget.used += 1;
  const quoted = await client.getUsStandardShippingCents(variant.supplierVariantId);
  return variant.costCents + (quoted ?? FALLBACK_US_SHIPPING_CENTS);
}

function renderReport(input: {
  generatedAt: string;
  pages: number;
  seen: number;
  gated: number;
  error?: string;
  rejections?: Record<string, number>;
  ranked: RankedCandidate[];
}): string {
  const rows =
    input.ranked.length === 0
      ? "_No SKUs passed all five gates. Confirm `CJ_ENABLED=true`, `CJ_API_KEY`, and that verified US stock exists._"
      : [
          "| Rank | SKU | Title | Landed Cost | Suggested Retail | US Stock | Viral Score | Problem-Solving | Combined | CJ URL |",
          "| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
          ...input.ranked.map((row, index) =>
            [
              `| ${index + 1}`,
              `\`${escapeCell(row.sku)}\``,
              escapeCell(row.title),
              formatUsd(row.landedCostCents),
              formatUsd(row.suggestedRetailCents),
              String(row.usStock),
              String(row.viralScore),
              String(row.problemScore),
              String(row.combinedScore),
              `[CJ](${row.cjUrl}) |`,
            ].join(" | "),
          ),
        ].join("\n");

  const notes = input.ranked
    .map((row, index) => `${index + 1}. **${escapeCell(row.title)}** (${row.scoreSource}): ${row.rationale || "n/a"}`)
    .join("\n");

  return `# Product candidates (CJ US warehouse)

Generated: ${input.generatedAt}
${input.error ? `\n**Run note:** ${input.error}\n` : ""}
Scanned **${input.seen}** variants across **${input.pages}** catalog pages. **${input.gated}** passed rules 1–4. Showing top **${input.ranked.length}** after Rule 5.

## Five-point gate

1. **Healthy margins** — landed cost (item + US standard shipping) ≤ $15.00; retail $29.99–$44.99 at ≥ 60% gross margin.
2. **Fulfillment safety** — packaged weight ≤ 1.5 lb (680 g); reject glass, liquids, powders, ingestibles, complex electronics.
3. **Supplier inventory** — ≥ 200 units in a verified US warehouse.
4. **Policy** — no Nike / Apple / Disney-class brands; no restricted health or skincare claims.
5. **Visual / problem potential** — Gemini scores viral-video potential and problem-solving value (heuristic fallback if Gemini is off).

## Top 10

${rows}

## Scoring notes

${notes || "_None._"}

Freight: CJ \`/logistic/freightCalculate\` when item cost is near the $15 cap; otherwise a conservative **$6.99** US standard-shipping estimate is used so landed cost is not understated. Catalog query is listV2 with \`countryCode=US\`, \`verifiedWarehouse=1\`, and \`startWarehouseInventory=200\`; variants and US stock are hydrated from \`variant/query\` + \`stock/queryByVid\`.
${rejectionBlock(input.rejections)}
`;
}

function rejectionBlock(rejections: Record<string, number> | undefined): string {
  if (!rejections || Object.keys(rejections).length === 0) return "";
  const lines = Object.entries(rejections)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `- \`${reason}\`: ${count}`)
    .join("\n");
  return `\n## Gate rejections\n\n${lines}\n`;
}

async function writeReport(body: string): Promise<void> {
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, body, "utf8");
}

async function run(): Promise<void> {
  process.env.DATABASE_URL ??= "postgres://commerce:commerce_local_password@127.0.0.1:5432/commerce_integration";
  const config = loadConfig();
  if (!config.CJ_ENABLED || !config.CJ_API_KEY) {
    throw new Error("Product research requires CJ_ENABLED=true and CJ_API_KEY (used to mint CJ-Access-Token).");
  }

  const client = new CjClient();
  const freightBudget = { used: 0 };
  const passed: Array<{
    product: SupplierProduct;
    variant: SupplierVariant;
    landedCostCents: number;
    suggestedRetailCents: number;
  }> = [];

  let seen = 0;
  let pagesFetched = 0;
  const rejections: Record<string, number> = {};

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const products = await client.listUsWarehouseProducts(page, PAGE_SIZE, {
      minVerifiedInventory: MIN_US_WAREHOUSE_UNITS,
      maxSellPrice: MAX_LANDED_COST_CENTS / 100,
      hydrateVariants: true,
    });
    pagesFetched += 1;
    if (products.length === 0) break;
    for (const product of products) {
      for (const variant of product.variants) {
        seen += 1;
        const landedCostCents = await resolveLandedCostCents(client, product, variant, freightBudget);
        const gate = evaluateResearchGates(product, variant, landedCostCents);
        if (!gate.pass) {
          for (const reason of gate.reasons) {
            rejections[reason] = (rejections[reason] ?? 0) + 1;
          }
          continue;
        }
        passed.push({
          product,
          variant,
          landedCostCents,
          suggestedRetailCents: gate.suggestedRetailCents,
        });
      }
    }
    logger.info({ page, seen, passed: passed.length, endpoint: "product-research" }, "catalog page scanned");
  }

  const bySku = new Map<string, (typeof passed)[number]>();
  for (const row of passed) {
    const key = `${row.product.supplierProductId}:${row.variant.sku}`;
    const existing = bySku.get(key);
    if (!existing || row.landedCostCents < existing.landedCostCents) bySku.set(key, row);
  }
  const unique = [...bySku.values()].slice(0, MAX_LLM_SCORES);

  const ranked: RankedCandidate[] = [];
  for (const row of unique) {
    const scores = await scoreProductViability(row.product.title, row.product.description ?? row.product.title);
    ranked.push({
      sku: row.variant.sku,
      title: row.product.title,
      landedCostCents: row.landedCostCents,
      suggestedRetailCents: row.suggestedRetailCents,
      usStock: row.variant.quantityAvailable,
      viralScore: scores.viralVideoPotential,
      problemScore: scores.problemSolvingValue,
      combinedScore: scores.combined,
      scoreSource: scores.source,
      rationale: scores.rationale,
      cjUrl: cjProductUrl(row.product.supplierProductId),
    });
    await sleep(150);
  }

  ranked.sort((a, b) => b.combinedScore - a.combinedScore || b.viralScore - a.viralScore);
  const top = ranked.slice(0, TOP_N);

  await writeReport(
    renderReport({
      generatedAt: new Date().toISOString(),
      pages: pagesFetched,
      seen,
      gated: unique.length,
      rejections,
      ranked: top,
    }),
  );
  logger.info({ report: REPORT_PATH, candidates: top.length, seen }, "product research report written");
}

run().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err, endpoint: "product-research", timestamp: new Date().toISOString() }, "product research failed");
  await writeReport(
    renderReport({
      generatedAt: new Date().toISOString(),
      pages: 0,
      seen: 0,
      gated: 0,
      error: message,
      ranked: [],
    }),
  );
  process.exitCode = 1;
});
