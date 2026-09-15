import { getConfig } from "../config.js";
import { logger } from "../logger.js";

export type ListingCopyInput = {
  title: string;
  description?: string | undefined;
  category?: string | undefined;
  brand?: string | undefined;
};

export type ListingCopy = {
  title: string;
  description: string;
  tags: string[];
};

/**
 * Optional Gemini/Claude pass for title cleanup. Returns the original copy when
 * LLM_PROVIDER=none or keys are missing — never block inventory sync on LLM cost.
 */
export async function enrichListingCopy(input: ListingCopyInput): Promise<ListingCopy> {
  const config = getConfig();
  const fallback: ListingCopy = {
    title: input.title.slice(0, 120),
    description: (input.description ?? input.title).slice(0, 2000),
    tags: ["us-warehouse"],
  };
  if (config.LLM_PROVIDER === "none") return fallback;

  logger.info(
    { provider: config.LLM_PROVIDER, endpoint: "enrichment/listing-copy" },
    "LLM enrichment skipped in MVP — using source title/description",
  );
  return fallback;
}
