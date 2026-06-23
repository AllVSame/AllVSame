/**
 * ============================================================================
 *  verify-and-match -- AllVSame Secure Cloud Backend (Supabase Edge Function)
 * ============================================================================
 *
 *  PRODUCTION PIPELINE (Phases A-E):
 *  ---------------------------------------------------------------------------
 *    Phase A: Check Supabase "product_cache" table for cached data ($0 lookup)
 *    Phase B: Fetch from Open Food Facts v2 API (free, no key)
 *    Phase C: Scrape via supermarket-specific Apify actor using secret token
 *    Phase D: Find alternative products in same category from Supabase
 *    Phase E: Jaccard ingredient-match calculation + cache to database
 *
 *  SECURITY:
 *    - APIFY_TOKEN is read via Deno.env.get() -- never touches the browser
 *    - SERVICE_ROLE_KEY is read via Deno.env.get() -- never touches the browser
 *    - Input validation + CORS whitelist + IP rate limiting (5 req/min)
 *
 * ============================================================================
 */

// =============================================================================
//  TOP-LEVEL DEPENDENCIES
//  Supabase JS client for Deno. Imported at the top level so it is available
//  to all functions that need it.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// =============================================================================
//  1.  ENVIRONMENT & CONFIGURATION
// =============================================================================

// -- Secrets (set via Supabase Dashboard -> Edge Functions -> Secrets) --------
//    DO NOT hardcode these. They are injected at runtime by the Deno runtime.
const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY") || "";

// -- CORS whitelist -- only these origins may call this function ------------
const ALLOWED_ORIGINS = [
  "https://allvsame.com",
  "https://www.allvsame.com",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8000",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8000",
];

// -- Apify actor IDs per UK supermarket ------------------------------------
//    These are live actors from Apify Store. The function sends a search
//    keyword to the selected supermarket's dedicated scraper, which returns
//    product details including ingredients, price, and images.
const APIFY_ACTORS: Record<string, string> = {
  tesco: "radeance/tesco-scraper",
  sainsburys: "natanielsantos/sainsbury-s-scraper",
  asda: "drobnyk/asda-scraper",
  morrisons: "aYG0l9s7dbB7j3gbS", // generic web scraper fallback for Morrisons
};

// -- Additional search URLs for the generic web scraper fallback ------------
const SUPERMARKET_SEARCH_URLS: Record<string, string> = {
  tesco: "https://www.tesco.com/groceries/en-GB/search?query=",
  sainsburys: "https://www.sainsburys.co.uk/shop/gb/groceries/search?q=",
  asda: "https://www.asda.com/search?q=",
  morrisons: "https://www.morrisons.com/search?search=",
};

// -- Rate limiting configuration -------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 5; // max 5 per window per IP

// =============================================================================
//  2.  IN-MEMORY RATE LIMITER
// =============================================================================

const rateLimitMap = new Map<string, number[]>();

/**
 * Checks and enforces the per-IP rate limit.
 *
 * @param ip  The client IP address (from x-forwarded-for or remote address).
 * @returns   true if the request is allowed; false if rate-limited.
 */
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  let timestamps = rateLimitMap.get(ip) || [];
  timestamps = timestamps.filter((ts) => ts > windowStart);

  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return true;
}

// =============================================================================
//  3.  CORS HEADERS HELPER
// =============================================================================

/**
 * Returns the appropriate CORS headers based on the request origin.
 *
 * @param requestOrigin  The value of the Origin header from the request.
 * @returns              Headers object with CORS + content-type set.
 */
function corsHeaders(requestOrigin: string | null): Headers {
  const origin =
    requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)
      ? requestOrigin
      : "https://allvsame.com";

  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
  });
}

// =============================================================================
//  4.  SUPABASE CLIENT HELPER
// =============================================================================

/**
 * Creates a Supabase client authenticated with the service_role key.
 * This client can read/write all tables without RLS restrictions.
 *
 * @returns A Supabase client instance, or null if config is missing.
 */
function createServiceClient() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error(
      "[verify-and-match] Missing SUPABASE_URL or SERVICE_ROLE_KEY",
    );
    return null;
  }
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

// =============================================================================
//  5.  DATA SCHEMA
// =============================================================================

interface ProductData {
  barcode: string;
  name: string;
  brand: string;
  supermarket: string;
  category: string;
  categoriesTags?: string[]; // OFF taxonomy tags (e.g. "en:biscuits") -- used for Tier 2 search fallback
  ingredients: string;
  price: number | null;
  image_url: string;
  source: string;
}

interface MatchResult {
  percentage: number;
  brandMatchRatio: number;
  matching: string[];
  differingA: string[];
  differingB: string[];
}

interface ScanResult {
  product: ProductData;
  alternatives: ProductData[];
  bestAlternative: ProductData | null;
  comparison: MatchResult | null;
}

// =============================================================================
//  6.  PHASE B -- LIVE OPEN FOOD FACTS v2 API
// =============================================================================
//
//  Endpoint: https://world.openfoodfacts.org/api/v2/product/{barcode}
//  No API key required. Returns crowd-sourced product data.
//  If ingredients are missing, the response signals the frontend to ask
//  the user for manual ingredient photo capture.

/**
 * Fetches product data from the Open Food Facts v2 public API.
 *
 * @param barcode  The product barcode (EAN-13 / GTIN format).
 * @returns        A ProductData object, or null if not found / missing ingredients.
 */
async function fetchFromOpenFoodFacts(
  barcode: string,
): Promise<ProductData | null> {
  // The v2 endpoint returns richer data and supports more fields
  const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    console.warn(
      "[verify-and-match] OFF v2 network error:",
      (err as Error).message,
    );
    return null;
  }

  if (!response.ok) {
    console.warn("[verify-and-match] OFF v2 HTTP", response.status);
    return null;
  }

  let json: any;
  try {
    json = await response.json();
  } catch {
    console.warn("[verify-and-match] OFF v2 JSON parse error");
    return null;
  }

  // v2 returns { status: 1, product: { ... } } when found
  if (!json || json.status !== 1 || !json.product) {
    return null;
  }

  const p = json.product;

  // Extract product name -- if missing, we cannot search effectively
  const productName = (p.product_name || "").trim();
  if (!productName) {
    console.warn("[verify-and-match] OFF v2: product found but has no name");
    return null;
  }

  // Extract ingredients -- OFF stores them as a string or language-keyed object.
  // If ingredients are missing entirely, we return a special marker so the
  // frontend can display the "manual photo capture" fallback.
  let ingredientsText = "";
  if (typeof p.ingredients_text === "string") {
    ingredientsText = p.ingredients_text;
  } else if (p.ingredients_text && typeof p.ingredients_text === "object") {
    ingredientsText =
      p.ingredients_text.en || Object.values(p.ingredients_text)[0] || "";
  }
  ingredientsText = ingredientsText.trim();

  // Extract categories -- OFF uses a taxonomy like "Colas, pt:bebidas cafeina"
  const categories = (p.categories || "").trim();

  // Extract OFF category taxonomy tags (e.g. ["en:biscuits", "en:chocolate-biscuits"])
  // These are used by the Tier 2 search fallback to generate broader keywords.
  let categoriesTags: string[] = [];
  if (Array.isArray(p.categories_tags)) {
    categoriesTags = p.categories_tags.filter(
      (tag: string) => typeof tag === "string" && tag.startsWith("en:"),
    );
  } else if (Array.isArray(p.categories_hierarchy)) {
    categoriesTags = p.categories_hierarchy.filter(
      (tag: string) => typeof tag === "string" && tag.startsWith("en:"),
    );
  }

  // Extract brand(s) -- can be comma-separated; take the first one
  let brand = "Unknown Brand";
  if (p.brands && typeof p.brands === "string") {
    brand = p.brands.split(",")[0].trim();
  }

  // Extract image URL
  let imageUrl = "";
  if (p.image_url) {
    imageUrl = p.image_url;
  } else if (p.selected_images?.front?.display?.en) {
    imageUrl = p.selected_images.front.display.en;
  }

  return {
    barcode,
    name: productName,
    brand,
    supermarket: "unknown",
    category: categories || "Unknown",
    categoriesTags: categoriesTags.length > 0 ? categoriesTags : undefined,
    ingredients: ingredientsText,
    price: null, // OFF does not provide price data
    image_url: imageUrl,
    source: "openfoodfacts",
  };
}

// =============================================================================
//  7.  PHASE C -- LIVE APIFY SUPERMARKET SCRAPER
// =============================================================================
//
//  TOKEN ENCAPSULATION:
//    The APIFY_TOKEN is read from Deno.env.get("APIFY_TOKEN") at the top of
//    this file. It is embedded in the Apify API URL server-side and NEVER
//    included in any response data returned to the client.
//
//  ARCHITECTURE:
//    Instead of using a single generic web scraper that crawls all four
//    supermarkets at once, we use supermarket-specific Apify actors. The
//    selected supermarket (from the client's dropdown) determines which
//    actor runs. This means only ONE actor invocation per scan, keeping
//    Apify computing costs near zero.
//
//    We use the /run-sync-get-dataset-items endpoint which runs the actor
//    synchronously and returns results directly -- no polling required.

/**
 * Cleans a product name into a focused search keyword.
 *
 * Strips out:
 *   - Weight/volume measurements (e.g. "415g", "500ml", "1l", "2kg", "1.5l")
 *   - Brand prefixes (e.g. "Tesco " before a generic product name)
 *   - Common filler words (e.g. "Finest", "Organic", "Premium")
 *
 * @param productName  The raw product name from Open Food Facts or Apify.
 * @param brand        The product brand (used to strip brand prefix).
 * @returns            A clean search keyword string.
 */
function cleanSearchKeyword(productName: string, brand: string): string {
  if (!productName) return "";

  let keyword = productName;

  // Remove weight/volume patterns: "500g", "1kg", "250ml", "1l", "1.5l", "2l", etc.
  keyword = keyword.replace(
    /\d+(\.\d+)?\s*(g|kg|ml|l|cl|oz|lb|litre|liters|litres)/gi,
    "",
  );

  // Remove "x" count patterns: "x6", "x 12", "4x", "8 x 2"
  keyword = keyword.replace(/\b\d+\s*x\s*\d*\b/gi, "");
  keyword = keyword.replace(/\bx\s*\d+\b/gi, "");

  // Remove parenthetical content: "(415g)", "(Pack of 6)", "Ready to Eat"
  keyword = keyword.replace(/\([^)]*\)/g, "");

  // Remove trailing size suffixes: "415g", "500 ml" at end of string
  keyword = keyword.replace(/\s+\d+(\.\d+)?\s*(g|kg|ml|l|cl|oz)\s*$/gi, "");

  // Remove brand prefix if it appears at the start
  if (brand && brand !== "Unknown Brand") {
    const brandParts = brand.toLowerCase().split(",")[0].trim();
    if (keyword.toLowerCase().startsWith(brandParts)) {
      keyword = keyword.substring(brandParts.length).trim();
    }
    // Also try removing just the first word of the brand
    const firstBrandWord = brandParts.split(" ")[0];
    if (
      firstBrandWord &&
      keyword.toLowerCase().startsWith(firstBrandWord.toLowerCase())
    ) {
      keyword = keyword.substring(firstBrandWord.length).trim();
    }
  }

  // Remove leading/trailing punctuation and collapse whitespace
  keyword = keyword.replace(/^[\s,;:-]+|[\s,;:-]+$/g, "");
  keyword = keyword.replace(/\s+/g, " ").trim();

  return keyword || productName; // fall back to original if we stripped everything
}

/**
 * Builds the Apify actor input payload based on the actor type.
 *
 * Each Apify actor expects a different input schema. This function maps
 * each actor ID to its correct payload format so the request succeeds.
 *
 * @param actorId  The Apify actor ID (e.g. "radeance/tesco-scraper").
 * @param keyword  The cleaned search keyword.
 * @returns        The payload object to send to the Apify API.
 */
function buildApifyPayload(
  actorId: string,
  keyword: string,
): Record<string, unknown> {
  switch (actorId) {
    case "radeance/tesco-scraper":
      return {
        searchTerm: keyword,
        maxItems: 2,
      };

    case "natanielsantos/sainsbury-s-scraper":
      return {
        searchTerm: keyword,
        maxResults: 2,
      };

    case "drobnyk/asda-scraper":
      return {
        search: keyword,
        maxProducts: 2,
      };

    default:
      // Generic web scraper fallback
      return {
        runInput: {
          startUrls: [
            {
              url: `https://www.google.com/search?q=${encodeURIComponent(keyword)}`,
            },
          ],
          maxPagesPerCrawl: 2,
          maxResults: 2,
        },
      };
  }
}

/**
 * Extracts structured product data from any Apify actor's result item.
 *
 * Different actors return different field names. This function normalises
 * them into our ProductData schema by trying multiple common field names
 * for each property.
 *
 * @param item     A single item from the Apify dataset.
 * @param barcode  The scanned barcode.
 * @param supermarket  The supermarket ID (tesco, sainsburys, etc.).
 * @returns        A ProductData object (source defaults to "apify").
 */
function extractProductFromApifyItem(
  item: Record<string, unknown>,
  barcode: string,
  supermarket: string,
): ProductData {
  // Helper: find first non-empty string value from a list of field keys
  const findField = (keys: string[]): string => {
    for (const key of keys) {
      const val = item[key];
      if (val && typeof val === "string" && val.trim()) return val.trim();
    }
    return "";
  };

  const name = findField([
    "title",
    "name",
    "productName",
    "product_name",
    "heading",
    "label",
  ]);
  const brand = findField([
    "brand",
    "brandName",
    "brand_name",
    "manufacturer",
    "seller",
  ]);
  const priceRaw = findField([
    "price",
    "currentPrice",
    "current_price",
    "priceNow",
    "salePrice",
  ]);
  const imageUrl = findField([
    "image",
    "imageUrl",
    "image_url",
    "mainImage",
    "thumbnail",
    "img",
  ]);
  const url = findField(["url", "productUrl", "product_url", "link"]);

  // Try to extract ingredients -- some scrapers include them directly
  let ingredients = findField([
    "ingredients",
    "ingredientsText",
    "ingredients_text",
    "productInformation",
    "description",
    "details",
    "features",
  ]);

  // If the ingredients field is very short or missing, try looking in nested
  // objects like "productInformation" or "attributes"
  if (!ingredients || ingredients.length < 10) {
    const nested = item.productInformation || item.attributes || item.nutrition;
    if (nested && typeof nested === "string" && nested.length > 20) {
      ingredients = nested.substring(0, 2000);
    } else if (nested && typeof nested === "object") {
      const vals = Object.values(nested as Record<string, unknown>).filter(
        (v): v is string => typeof v === "string" && v.length > 10,
      );
      if (vals.length > 0) {
        ingredients = vals.join(", ").substring(0, 2000);
      }
    }
  }

  // Parse price from string (strip currency symbols)
  let price: number | null = null;
  if (priceRaw) {
    const cleaned = priceRaw.replace(/[^0-9.]/g, "");
    price = parseFloat(cleaned);
    if (isNaN(price)) price = null;
  }

  return {
    barcode,
    name: name || `Product ${barcode}`,
    brand: brand || "Unknown Brand",
    supermarket,
    category: findField(["category", "categories", "breadcrumb", "department"]),
    ingredients,
    price,
    image_url: imageUrl,
    source: "apify",
    url, // stored for reference, not in interface but used for category
  };
}

/**
 * Scrapes a single UK supermarket via its dedicated Apify actor.
 *
 * Uses the synchronous Apify endpoint (/run-sync-get-dataset-items) which
 * runs the actor and blocks until results are ready -- no polling needed.
 *
 * Returns ALL results from the dataset so the caller can inspect them for
 * own-brand matches. The tiered fallback logic uses this to determine
 * whether to re-search with a broader category keyword.
 *
 * @param barcode      The scanned product barcode (used as search query).
 * @param supermarket  The supermarket ID (tesco, sainsburys, asda, morrisons).
 * @param productHint  The product name from Phase B (for keyword cleaning).
 * @param brandHint    The brand name from Phase B (for keyword cleaning).
 * @returns            Array of ProductData results (may be empty), or null if the
 *                     request itself failed (network error, auth error, etc.).
 */
async function scrapeSupermarketProduct(
  barcode: string,
  supermarket: string,
  productHint: string,
  brandHint: string,
): Promise<ProductData[] | null> {
  if (!APIFY_TOKEN) {
    console.warn("[verify-and-match] APIFY_TOKEN not set in environment");
    return null;
  }

  const actorId = APIFY_ACTORS[supermarket];
  if (!actorId) {
    console.warn(
      `[verify-and-match] No Apify actor configured for "${supermarket}"`,
    );
    return null;
  }

  // Clean the product name into a search keyword
  const keyword = cleanSearchKeyword(productHint, brandHint);
  console.log(
    `[verify-and-match] Apify: searching "${supermarket}" for keyword="${keyword}" (from hint="${productHint}")`,
  );

  // Build the payload for this specific actor
  const payload = buildApifyPayload(actorId, keyword);

  // Use the synchronous endpoint -- runs actor and returns dataset items directly
  const apiUrl = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    console.warn(
      "[verify-and-match] Apify network error:",
      (err as Error).message,
    );
    return null;
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    console.warn(
      `[verify-and-match] Apify HTTP ${response.status} for actor ${actorId}: ${errorBody.substring(0, 200)}`,
    );
    return null;
  }

  let dataset: any[];
  try {
    dataset = await response.json();
  } catch {
    console.warn("[verify-and-match] Apify JSON parse error");
    return null;
  }

  if (!Array.isArray(dataset) || dataset.length === 0) {
    console.warn(
      `[verify-and-match] Apify: no results for "${keyword}" on ${supermarket}`,
    );
    return []; // Return empty array -- no results, but request succeeded
  }

  // Return ALL results so the caller can inspect each for own-brand status
  const products = dataset.map((item: any) =>
    extractProductFromApifyItem(item, barcode, supermarket),
  );

  console.log(
    `[verify-and-match] Apify: found ${products.length} result(s) for "${keyword}" on ${supermarket}`,
  );
  products.forEach((p: ProductData) => {
    console.log(`  -> "${p.name}" (brand: "${p.brand}", GBP ${p.price})`);
  });

  return products;
}

/**
 * FALLBACK: Scrapes all four UK supermarkets using the generic web scraper.
 *
 * Used when Phase B (Open Food Facts) fails to find the product. This
 * crawls all supermarket search pages simultaneously looking for the barcode.
 *
 * @param barcode  The scanned product barcode.
 * @returns        A ProductData object, or null if all searches failed.
 */
async function scrapeAllSupermarketsFallback(
  barcode: string,
): Promise<ProductData | null> {
  if (!APIFY_TOKEN) {
    console.warn("[verify-and-match] APIFY_TOKEN not set for fallback");
    return null;
  }

  const actorId = "aYG0l9s7dbB7j3gbS"; // Apify Web Scraper (generic)
  const apiUrl = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;

  const startUrls = Object.entries(SUPERMARKET_SEARCH_URLS).map(
    ([_, baseUrl]) => ({
      url: `${baseUrl}${encodeURIComponent(barcode)}`,
    }),
  );

  const payload = {
    runInput: {
      startUrls,
      maxPagesPerCrawl: 3,
      maxResults: 2,
    },
  };

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    console.warn(
      "[verify-and-match] Apify fallback network error:",
      (err as Error).message,
    );
    return null;
  }

  if (!response.ok) {
    console.warn("[verify-and-match] Apify fallback HTTP", response.status);
    return null;
  }

  let dataset: any[];
  try {
    dataset = await response.json();
  } catch {
    console.warn("[verify-and-match] Apify fallback JSON parse error");
    return null;
  }

  if (!Array.isArray(dataset) || dataset.length === 0) {
    return null;
  }

  // Use the first result across all supermarkets
  const item = dataset[0];

  // Infer which supermarket this URL belongs to
  const itemUrl = (item.url || item.productUrl || "").toLowerCase();
  let supermarket = "tesco";
  if (itemUrl.includes("sainsburys")) supermarket = "sainsburys";
  else if (itemUrl.includes("asda")) supermarket = "asda";
  else if (itemUrl.includes("morrisons")) supermarket = "morrisons";

  return extractProductFromApifyItem(item, barcode, supermarket);
}

// =============================================================================
//  8A.  TIER 1 + TIER 2 -- MULTI-TIER SEARCH FALLBACK STRATEGY
// =============================================================================
//
//  PROBLEM:
//    Searching for a brand name like "Oreo" on Tesco only returns branded Oreo
//    products. The supermarket's generic equivalent is named "Cookies & Cream
//    Biscuits" -- a completely different string. Our Tier 1 search misses it.
//
//  SOLUTION (Tier 1 -> Tier 2):
//    Tier 1: Search with the cleaned brand product name (e.g. "Oreo Double Cream")
//    Tier 2: If Tier 1 returns results but NONE are supermarket own-brand, extract
//            the product's category from Open Food Facts tags, map them to plain
//            English product-type keywords (e.g. "en:chocolate-sandwich-biscuit"
//            -> "Chocolate Sandwich Biscuits"), and re-run the Apify scraper.
//            Filter for supermarket own-brand items in the results.

/**
 * Detects whether a product result is a supermarket's own brand.
 *
 * A product is considered "own brand" if:
 *   1. The brand field contains the supermarket name (e.g. "Tesco", "Asda")
 *   2. The product name starts with the supermarket name
 *   3. The brand is not a known branded manufacturer
 *
 * Known branded manufacturers are household names whose products have generic
 * equivalents (Oreo, Pringles, Nutella, Heinz, Kellogg's, etc.).
 *
 * @param product     The product to check.
 * @param supermarket The supermarket ID (tesco, sainsburys, asda, morrisons).
 * @returns           true if the product appears to be supermarket own brand.
 */
function isOwnBrandProduct(product: ProductData, supermarket: string): boolean {
  // Known branded manufacturers whose supermarket equivalents we want to find
  const KNOWN_BRANDS = [
    "oreo",
    "pringles",
    "nutella",
    "heinz",
    "kellogg",
    "nestle",
    "cadbury",
    "pepsi",
    "coca-cola",
    "walkers",
    "doritos",
    "m&m",
    "mars",
    "snickers",
    "twix",
    "kitkat",
    "haribo",
    "danone",
    "muller",
    "yoplait",
    "ben & jerry",
    "haagen-dazs",
    "maggi",
    "bisto",
    "oxo",
    "colgate",
    "persil",
    "fairy",
    "cif",
    "ajax",
    "dove",
    "nivea",
    "gillette",
    "pampers",
    "huggies",
    "whiskas",
    "pedigree",
    "felix",
    "iams",
    "lindt",
    "galaxy",
    "mcvities",
    "jordans",
    "ryvita",
    "hovis",
    "warburtons",
    "kingsmill",
    "robin",
  ];

  const supermarketName =
    supermarket.charAt(0).toUpperCase() + supermarket.slice(1);
  const nameLower = (product.name || "").toLowerCase();
  const brandLower = (product.brand || "").toLowerCase();

  // Check 1: Brand field contains the supermarket name
  if (
    brandLower.includes(supermarket) ||
    brandLower.includes(supermarketName)
  ) {
    return true;
  }

  // Check 2: Product name starts with the supermarket name (e.g. "Tesco Cola")
  if (
    nameLower.startsWith(supermarket) ||
    nameLower.startsWith(supermarketName)
  ) {
    return true;
  }

  // Check 3: Brand is NOT a known branded manufacturer
  //          (if brand is empty/unknown, treat as possibly own brand)
  if (!brandLower || brandLower === "unknown brand") {
    return true;
  }

  const isKnownBrand = KNOWN_BRANDS.some((kb) => brandLower.includes(kb));
  if (!isKnownBrand) {
    // Unknown brand that is not the supermarket -- could be a third-party own brand
    // We treat this as a weak own-brand match if the product name looks generic
    const genericIndicators = [
      supermarket,
      supermarketName,
      "value",
      "everyday",
      "essential",
      "savers",
      "own",
      "selected",
      "basics",
      "budget",
    ];
    const hasGenericName = genericIndicators.some((ind) =>
      nameLower.includes(ind),
    );
    if (hasGenericName) return true;
  }

  return false;
}

/**
 * Maps Open Food Facts category taxonomy tags to plain English search keywords.
 *
 * OFF uses a hierarchical taxonomy like "en:biscuits", "en:chocolate-sandwich-biscuit".
 * This function converts those into search terms that a UK supermarket search bar
 * would understand (e.g. "Chocolate Sandwich Biscuits", "Cream Biscuits").
 *
 * @param categoriesTags  Array of OFF category tags (e.g. ["en:biscuits", "en:chocolate-sandwich-biscuit"]).
 * @param categories      Free-text categories string as a fallback (e.g. "Biscuits, Chocolate biscuits").
 * @returns               Array of English search keywords, most specific first.
 */
function categoriesToKeywords(
  categoriesTags: string[] | undefined,
  categories: string,
): string[] {
  const keywords: string[] = [];

  // ---- Step 1: Map known OFF taxonomy tags to English keywords ----
  //    Each entry maps from a tag pattern to one or more search keywords.
  //    More specific tags are listed first so they appear earlier in the results.
  const TAG_MAP: Record<string, string[]> = {
    "en:biscuits": ["Biscuits", "Cookies"],
    "en:chocolate-biscuits": ["Chocolate Biscuits", "Chocolate Cookies"],
    "en:cream-biscuit": ["Cream Biscuits"],
    "en:sandwich-biscuit": ["Sandwich Biscuits", "Cream Biscuits"],
    "en:chocolate-sandwich-biscuit": [
      "Chocolate Sandwich Biscuits",
      "Chocolate Cream Biscuits",
    ],
    "en:biscuit-with-chocolate": ["Chocolate Biscuits", "Chocolate Cookies"],
    "en:shortbread-biscuit": ["Shortbread Biscuits"],
    "en:cookie": ["Cookies", "Cookie"],
    "en:chocolate-cookie": ["Chocolate Cookies", "Chocolate Chip Cookies"],
    "en:cream-cookie": ["Cream Cookies", "Sandwich Cookies"],
    "en:chocolate-sandwich-cookie": ["Chocolate Sandwich Cookies"],
    "en:waffle": ["Waffles", "Waffle Biscuits"],
    "en:wafer": ["Wafers", "Wafer Biscuits"],
    "en:chocolate-wafer": ["Chocolate Wafers"],
    "en:cereal": ["Cereal", "Breakfast Cereal"],
    "en:breakfast-cereal": ["Breakfast Cereal", "Cereal"],
    "en:chocolate": ["Chocolate"],
    "en:confectionery": ["Confectionery", "Sweets"],
    "en:chocolate-confectionery": ["Chocolate Confectionery"],
    "en:snacks": ["Snacks", "Crisps"],
    "en:crisps": ["Crisps", "Potato Crisps"],
    "en:potato-crisps": ["Potato Crisps", "Crisps"],
    "en:tortilla-chips": ["Tortilla Chips", "Corn Chips"],
    "en:spread": ["Spread", "Chocolate Spread"],
    "en:chocolate-spread": ["Chocolate Spread", "Hazelnut Spread"],
    "en:hazelnut-spread": ["Hazelnut Spread", "Chocolate Hazelnut Spread"],
    "en:jams": ["Jam", "Marmalade", "Preserves"],
    "en:pasta": ["Pasta", "Pasta Sauce"],
    "en:pasta-sauce": ["Pasta Sauce", "Tomato Sauce"],
    "en:soup": ["Soup"],
    "en:tomato-soup": ["Tomato Soup"],
    "en:baked-beans": ["Baked Beans"],
    "en:beans": ["Beans", "Baked Beans"],
    "en:tuna": ["Tuna", "Canned Tuna"],
    "en:canned-fish": ["Canned Fish", "Tuna"],
    "en:mayonnaise": ["Mayonnaise", "Mayo"],
    "en:ketchup": ["Ketchup", "Tomato Ketchup"],
    "en:sauce": ["Sauce"],
    "en:tomato-sauce": ["Tomato Sauce"],
    "en:yogurt": ["Yogurt", "Yoghurt"],
    "en:fruit-yogurt": ["Fruit Yogurt", "Yogurt"],
    "en:cheese": ["Cheese"],
    "en:cheddar-cheese": ["Cheddar Cheese"],
    "en:milk": ["Milk"],
    "en:butter": ["Butter"],
    "en:margarine": ["Margarine", "Spread"],
    "en:bread": ["Bread"],
    "en:white-bread": ["White Bread"],
    "en:wholemeal-bread": ["Wholemeal Bread", "Whole Wheat Bread"],
    "en:drinks": ["Drinks", "Soft Drinks"],
    "en:carbonated-drinks": ["Carbonated Drinks", "Cola", "Fizzy Drinks"],
    "en:colas": ["Cola", "Carbonated Drinks"],
    "en:water": ["Water", "Spring Water"],
    "en:fruit-juice": ["Fruit Juice", "Juice"],
    "en:rice": ["Rice"],
    "en:pasta": ["Pasta"],
    "en:noodles": ["Noodles"],
    "en:potatoes": ["Potatoes"],
    "en:oven-chips": ["Oven Chips", "Potato Products"],
    "en:frozen-potato-products": ["Frozen Potato Products", "Chips"],
    "en:pizza": ["Pizza"],
    "en:ice-cream": ["Ice Cream", "Ice Cream Desserts"],
    "en:vanilla-ice-cream": ["Vanilla Ice Cream"],
    "en:chocolate-ice-cream": ["Chocolate Ice Cream"],
  };

  // Check each known tag (most specific first -- OFF tags are ordered specific to generic)
  if (categoriesTags && categoriesTags.length > 0) {
    // Use the most specific tags (last ones in the array are more generic)
    // We iterate from most specific (first) to most generic (last)
    for (const tag of categoriesTags) {
      const tagLower = tag.toLowerCase();
      // Direct match
      if (TAG_MAP[tagLower]) {
        for (const kw of TAG_MAP[tagLower]) {
          if (!keywords.includes(kw)) keywords.push(kw);
        }
      }
      // Partial match -- extract the last meaningful part of the tag
      // e.g. "en:chocolate-sandwich-biscuit" -> parts: ["chocolate", "sandwich", "biscuit"]
      const parts = tagLower.replace("en:", "").split(/[-_]/);
      if (parts.length >= 2) {
        // Capitalise each part and join
        const derived = parts
          .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
          .join(" ");
        if (!keywords.includes(derived)) keywords.push(derived);
      }
    }
  }

  // ---- Step 2: Fall back to the free-text categories field ----
  //    If OFF has no tags, parse the human-readable categories string.
  //    E.g. "Biscuits and cakes, Biscuits, Chocolate biscuits"
  //    -> extract meaningful product-type words.
  if (keywords.length === 0 && categories) {
    const categoryParts = categories
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const part of categoryParts) {
      // Remove generic taxonomical prefixes like "en:", "pt:", "fr:"
      const cleaned = part.replace(/^[a-z]{2}:/, "").trim();
      if (cleaned && cleaned.length > 3) {
        // Capitalise first letter
        const formatted = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
        if (!keywords.includes(formatted)) keywords.push(formatted);
      }
    }
  }

  // ---- Step 3: Absolute fallback ----
  if (keywords.length === 0) {
    keywords.push("Biscuits", "Cookies", "Snacks");
  }

  // Return unique keywords, limiting to the 5 most specific
  return [...new Set(keywords)].slice(0, 5);
}

/**
 * Multi-Tier Search Fallback: attempts to find a supermarket own-brand product
 * using progressively broader search keywords.
 *
 * STRATEGY:
 *   Tier 1: Search with the cleaned brand product name (e.g. "Oreo Double Cream").
 *   -> If results contain a supermarket own-brand item, return it immediately.
 *   -> If results exist but none are own-brand, proceed to Tier 2.
 *
 *   Tier 2: Extract OFF category tags, map to plain English keywords (e.g.
 *   "en:chocolate-sandwich-biscuit" -> "Chocolate Sandwich Biscuits"), then
 *   re-run the Apify scraper with each category keyword. Return the first
 *   own-brand match found.
 *
 *   Fallback: If both tiers fail to find an own-brand match, return the best
 *   Tier 1 result (even if branded) so the user still gets data.
 *
 * @param barcode          The scanned barcode.
 * @param supermarket      The user's selected supermarket (tesco, sainsburys, etc.).
 * @param productHint      The product name from Phase B (for keyword cleaning).
 * @param brandHint        The brand name from Phase B (for keyword cleaning).
 * @param categoriesTags   OFF taxonomy tags from Phase B (e.g. ["en:biscuits"]).
 * @param categories       Free-text categories string from Phase B.
 * @returns                The best matching ProductData, or null if nothing found.
 */
async function searchWithTieredFallback(
  barcode: string,
  supermarket: string,
  productHint: string,
  brandHint: string,
  categoriesTags: string[] | undefined,
  categories: string,
): Promise<ProductData | null> {
  // ---- TIER 1: Specific Brand Search ----
  //     Search with the cleaned product name (e.g. "Oreo Double Cream")
  const tier1Keyword = cleanSearchKeyword(productHint, brandHint);
  console.log(
    `[tiered-fallback] TIER 1: searching "${supermarket}" for "${tier1Keyword}"`,
  );

  const tier1Results = await scrapeSupermarketProduct(
    barcode,
    supermarket,
    productHint,
    brandHint,
  );

  // Check if Tier 1 returned any own-brand products
  if (tier1Results && tier1Results.length > 0) {
    const ownBrand = tier1Results.find((p) =>
      isOwnBrandProduct(p, supermarket),
    );
    if (ownBrand) {
      console.log(
        `[tiered-fallback] TIER 1: found own-brand match -> "${ownBrand.name}"`,
      );
      return ownBrand;
    }

    console.log(
      `[tiered-fallback] TIER 1: found ${tier1Results.length} result(s), but NONE are own-brand.`,
    );
    console.log(
      `[tiered-fallback] TIER 1: best branded result -> "${tier1Results[0].name}"`,
    );

    // If Tier 1 found branded results but we have no category info to fall back on,
    // return the best branded result rather than nothing.
    if (
      (!categoriesTags || categoriesTags.length === 0) &&
      (!categories || categories === "Unknown")
    ) {
      console.log(
        `[tiered-fallback] No category data available, returning best branded result.`,
      );
      return tier1Results[0];
    }
  } else {
    console.log(`[tiered-fallback] TIER 1: no results found.`);
  }

  // ---- TIER 2: Category-Broadened Search ----
  //     Map OFF category tags to plain English keywords and re-search.
  const broadKeywords = categoriesToKeywords(categoriesTags, categories);
  console.log(
    `[tiered-fallback] TIER 2: trying keywords: [${broadKeywords.join(", ")}]`,
  );

  for (const keyword of broadKeywords) {
    console.log(
      `[tiered-fallback] TIER 2: searching "${supermarket}" for "${keyword}"`,
    );

    const tier2Results = await scrapeSupermarketProduct(
      barcode,
      supermarket,
      keyword, // Use the category keyword directly (no brand to strip)
      "", // No brand hint for category searches
    );

    if (tier2Results && tier2Results.length > 0) {
      // Prefer own-brand matches
      const ownBrand = tier2Results.find((p) =>
        isOwnBrandProduct(p, supermarket),
      );
      if (ownBrand) {
        console.log(
          `[tiered-fallback] TIER 2: found own-brand match -> "${ownBrand.name}"`,
        );
        return ownBrand;
      }

      // If we found any result in Tier 2, return the best one
      // (it's a category-relevant product even if not own-brand)
      console.log(
        `[tiered-fallback] TIER 2: found "${tier2Results[0].name}" for keyword "${keyword}"`,
      );
      return tier2Results[0];
    }
  }

  // ---- FINAL FALLBACK: Return Tier 1's best result if available ----
  if (tier1Results && tier1Results.length > 0) {
    console.log(
      `[tiered-fallback] All tiers exhausted, returning best Tier 1 result (branded).`,
    );
    return tier1Results[0];
  }

  console.log(`[tiered-fallback] No results found in any tier.`);
  return null;
}

// =============================================================================
//  8B.  INGREDIENT COMPARISON ENGINE (Phase D & E)
// =============================================================================
//
//  Uses Jaccard similarity on normalised tokens. Both the brand product
//  and the alternative have their ingredient strings split by comma,
//  normalised (lowercased, stripped of punctuation/filler words), and
//  compared as sets.

/**
 * Normalises a single ingredient string.
 *
 * Steps:
 *   1. Lowercase
 *   2. Strip parenthetical and bracketed content (e.g. "(Caramel E150d)")
 *   3. Strip punctuation and trademark symbols
 *   4. Remove common filler / marketing adjectives
 *   5. Collapse multiple spaces
 *
 * @param text  The raw ingredient text.
 * @returns     The cleaned, normalised ingredient token.
 */
function normalizeIngredient(text: string): string {
  if (!text || typeof text !== "string") return "";

  let t = text.toLowerCase();
  t = t.replace(/\([^)]*\)/g, ""); // remove (parenthetical content)
  t = t.replace(/\[[^\]]*\]/g, ""); // remove [bracketed content]
  t = t.replace(/[<>"'.,;:!?]/g, ""); // strip punctuation
  t = t.replace(/[^\w\s]/g, ""); // strip any remaining special chars

  // Remove common filler / marketing adjectives
  const fillerWords = [
    "organic",
    "natural",
    "artisan",
    "artisanal",
    "premium",
    "traditional",
    "finest",
    "fresh",
    "pure",
    "real",
    "authentic",
    "original",
    "classic",
    "selected",
    "quality",
    "extra",
    "special",
    "fine",
    "best",
    "great",
    "farm",
    "estate",
    "kitchen",
    "style",
    "rustic",
    "country",
    "garden",
    "specially",
    "carefully",
    "expertly",
    "hand",
    "handcrafted",
    "handmade",
    "matured",
    "aged",
    "smoked",
    "wood",
    "fire",
    "stoneground",
    "cold",
    "pressed",
    "unrefined",
    "wild",
    "free",
    "range",
    "smooth",
    "rich",
    "creamy",
    "golden",
    "crisp",
    "light",
    "made",
    "produced",
    "prepared",
    "packed",
    "suitable",
    "contains",
    "may",
    "also",
    "free",
    "from",
    "with",
    "added",
    "less",
    "more",
  ];
  const fillerRegex = new RegExp(
    "(^|\\s)(" + fillerWords.join("|") + ")(?=\\s|$)",
    "gi",
  );
  t = t.replace(fillerRegex, " ");

  // Collapse multiple spaces and trim
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/**
 * Parses a comma-separated ingredient string into a cleaned array of tokens.
 *
 * @param ingredientsText  The raw ingredient list (e.g. "Water, Sugar, Acid...").
 * @returns                Array of cleaned, unique ingredient tokens.
 */
function parseIngredients(ingredientsText: string): string[] {
  if (!ingredientsText || typeof ingredientsText !== "string") return [];

  return ingredientsText
    .split(",")
    .map((item) => normalizeIngredient(item))
    .filter((item) => item.length > 0);
}

/**
 * Calculates the ingredient match between two products using Jaccard similarity.
 *
 * The Jaccard index is: |intersection| / |union|
 *   - 100% = identical ingredients (same set)
 *   - 0%   = no common ingredients
 *   - >95% = near match (acceptable substitute)
 *   - >80% = very similar
 *   - >60% = similar
 *   - <60% = different product
 *
 * Also returns brandMatchRatio = |intersection| / |brandSet| which tells the
 * user what fraction of the brand product's ingredients are present in the
 * alternative.
 *
 * @param brandIngredients  Ingredient string of the brand (scanned) product.
 * @param altIngredients    Ingredient string of the alternative product.
 * @returns                 MatchResult with percentage, matching/differing lists.
 */
function calculateIngredientMatch(
  brandIngredients: string,
  altIngredients: string,
): MatchResult {
  const listA = parseIngredients(brandIngredients);
  const listB = parseIngredients(altIngredients);

  // Edge cases
  if (listA.length === 0 && listB.length === 0) {
    return {
      percentage: 100,
      brandMatchRatio: 100,
      matching: [],
      differingA: [],
      differingB: [],
    };
  }
  if (listA.length === 0 || listB.length === 0) {
    return {
      percentage: 0,
      brandMatchRatio: 0,
      matching: [],
      differingA: listA,
      differingB: listB,
    };
  }

  const setA = new Set(listA);
  const setB = new Set(listB);

  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);

  const jaccard = intersection.size / union.size;
  const brandMatchRatio = intersection.size / setA.size;

  return {
    percentage: Math.round(jaccard * 100),
    brandMatchRatio: Math.round(brandMatchRatio * 100),
    matching: [...intersection].sort(),
    differingA: [...setA].filter((x) => !setB.has(x)).sort(),
    differingB: [...setB].filter((x) => !setA.has(x)).sort(),
  };
}

// =============================================================================
//  9.  PHASE D -- FIND ALTERNATIVES FROM DATABASE
// =============================================================================
//
//  Queries the Supabase "products" table for items in the same category
//  as the scanned product, then scores each by ingredient similarity.

/**
 * Finds alternative products in the same category from other supermarkets,
 * scores them by ingredient similarity, and returns them sorted best-first.
 *
 * @param product              The scanned product.
 * @param preferredSupermarket The user's selected supermarket ID.
 * @param supabaseClient       An authenticated Supabase client (service_role).
 * @returns                    Array of alternative products with _match attached.
 */
async function findAlternatives(
  product: ProductData,
  preferredSupermarket: string,
  supabaseClient: any,
): Promise<any[]> {
  const alternatives: any[] = [];

  if (!supabaseClient) {
    console.warn("[verify-and-match] Phase D: no database client available");
    return alternatives;
  }

  try {
    let rows: any[] = [];

    // -- STRATEGY 1: Exact category match -----------------------------------
    //    If OFF returned a category string that exactly matches a row in the
    //    products table, use those as alternatives.
    if (product.category && product.category !== "Unknown") {
      const { data, error } = await supabaseClient
        .from("products")
        .select("*")
        .eq("category", product.category)
        .neq("barcode", product.barcode)
        .limit(20);

      if (!error && data && data.length > 0) {
        rows = data;
        console.log(
          `[verify-and-match] Phase D: Strategy 1 (exact category) found ${rows.length} alternatives`,
        );
      }
    }

    // -- STRATEGY 2: Fuzzy category match via ILike --------------------------
    //    OFF often returns taxonomy strings like "Biscuits, Chocolate biscuits"
    //    that won't match our seed data's exact category. Split on commas and
    //    search for any keyword match.
    if (
      rows.length === 0 &&
      product.category &&
      product.category !== "Unknown"
    ) {
      // Split the category string into individual keywords
      const categoryWords = product.category
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 3)
        .map((s) => `%${s}%`);

      for (const word of categoryWords) {
        const { data, error } = await supabaseClient
          .from("products")
          .select("*")
          .ilike("category", word)
          .neq("barcode", product.barcode)
          .limit(20);

        if (!error && data && data.length > 0) {
          rows = data;
          console.log(
            `[verify-and-match] Phase D: Strategy 2 (ILike "${word}") found ${rows.length} alternatives`,
          );
          break;
        }
      }
    }

    // -- STRATEGY 3: Ingredient-only scoring (no category match) -------------
    //    If no category match exists at all, return ALL products in the database
    //    scored purely by ingredient similarity. This ensures every scan returns
    //    SOMETHING as long as there are products with overlapping ingredients.
    if (rows.length === 0) {
      const { data, error } = await supabaseClient
        .from("products")
        .select("*")
        .neq("barcode", product.barcode)
        .limit(30);

      if (!error && data && data.length > 0) {
        rows = data;
        console.log(
          `[verify-and-match] Phase D: Strategy 3 (ingredient-only scoring) found ${rows.length} candidates`,
        );
      }
    }

    if (rows.length > 0) {
      alternatives.push(...rows);
    } else {
      console.log(
        "[verify-and-match] Phase D: no alternatives found in any strategy",
      );
    }
  } catch (err) {
    console.warn(
      "[verify-and-match] Phase D: exception:",
      (err as Error).message,
    );
  }

  // Score each alternative by ingredient match
  alternatives.forEach((alt: any) => {
    alt._match = calculateIngredientMatch(
      product.ingredients || "",
      alt.ingredients || "",
    );
  });

  // Sort: highest match first, then cheapest
  alternatives.sort((a: any, b: any) => {
    const scoreA = a._match?.percentage || 0;
    const scoreB = b._match?.percentage || 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (a.price || Infinity) - (b.price || Infinity);
  });

  return alternatives;
}

// =============================================================================
//  10.  SAVE TO SUPABASE product_cache
// =============================================================================
//
//  After fetching product data from Open Food Facts or Apify, we upsert it
//  into the "product_cache" table. Future scans of the same barcode will
//  hit Phase A and return instantly at zero cost (no API calls).

/**
 * Saves (or overwrites) a product record in the Supabase product_cache table.
 *
 * Uses upsert with onConflict: "barcode" so that re-scans safely overwrite
 * the previous entry with fresh data (e.g., updated price or ingredients).
 *
 * @param product         The product data to persist.
 * @param supabaseClient  An authenticated Supabase client.
 * @returns               true on success, false on failure.
 */
async function saveProductToCache(
  product: ProductData,
  supabaseClient: any,
): Promise<boolean> {
  if (!supabaseClient) return false;

  try {
    const record = {
      barcode: product.barcode,
      name: product.name,
      brand: product.brand || null,
      supermarket: product.supermarket || "unknown",
      category: product.category || null,
      categories_tags: product.categoriesTags
        ? JSON.stringify(product.categoriesTags)
        : null,
      ingredients: product.ingredients || null,
      price: product.price != null ? product.price : null,
      image_url: product.image_url || null,
      source: product.source || "scan",
    };

    const { error } = await supabaseClient
      .from("product_cache")
      .upsert(record, { onConflict: "barcode" });

    if (error) {
      console.warn("[verify-and-match] Cache upsert error:", error.message);
      return false;
    }

    console.log("[verify-and-match] Cached:", product.barcode);
    return true;
  } catch (err) {
    console.warn("[verify-and-match] Cache exception:", (err as Error).message);
    return false;
  }
}

// =============================================================================
//  11.  MAIN REQUEST HANDLER
// =============================================================================
//
//  Deno.serve() is the entry point for Supabase Edge Functions. It receives
//  the HTTP request, validates it, runs the pipeline, and returns the result.

Deno.serve(async (req: Request): Promise<Response> => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const startTime = Date.now();

  // -- Extract origin for CORS -------------------------------------------------
  const requestOrigin = req.headers.get("origin") || req.headers.get("Origin");
  const headers = corsHeaders(requestOrigin);

  // -- Handle CORS preflight (OPTIONS) -----------------------------------------
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  // -- Method check -- only POST is allowed ------------------------------------
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed. Use POST." }),
      { status: 405, headers },
    );
  }

  // -- Extract client IP for rate limiting -------------------------------------
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

  // -- Rate limiting check -----------------------------------------------------
  if (!checkRateLimit(clientIp)) {
    console.warn(`[verify-and-match] ${requestId} Rate limited: ${clientIp}`);
    return new Response(
      JSON.stringify({
        error: "Too Many Requests",
        message:
          "You have exceeded the rate limit of 5 scans per minute. Please wait before trying again.",
        retryAfterSeconds: 60,
      }),
      { status: 429, headers },
    );
  }

  // -- Parse request body --------------------------------------------------------
  let body: { barcode?: string; supermarket?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers,
    });
  }

  const barcode = body.barcode?.replace(/\D/g, "").trim();
  const supermarket = body.supermarket || "tesco";

  // Validate supermarket is one we support
  const validSupermarkets = ["tesco", "sainsburys", "asda", "morrisons"];
  if (!validSupermarkets.includes(supermarket)) {
    return new Response(
      JSON.stringify({
        error: "Invalid supermarket",
        message: `Supported supermarkets: ${validSupermarkets.join(", ")}`,
      }),
      { status: 400, headers },
    );
  }

  if (!barcode || barcode.length < 8) {
    return new Response(
      JSON.stringify({ error: "Invalid barcode. Must be at least 8 digits." }),
      { status: 400, headers },
    );
  }

  console.log(
    `[verify-and-match] ${requestId} Start: barcode=${barcode}, supermarket=${supermarket}`,
  );

  // -- Initialise Supabase service client ------------------------------------
  const supabaseClient = createServiceClient();

  // ============================================================================
  //  PHASE A -- Check Supabase product_cache for cached data
  // ============================================================================
  //  If the barcode was scanned before, the data is in product_cache.
  //  This is a $0 lookup -- no external API calls needed.

  let product: ProductData | null = null;
  let cacheHit = false;

  if (supabaseClient) {
    try {
      const { data: rows, error } = await supabaseClient
        .from("product_cache")
        .select("*")
        .eq("barcode", barcode)
        .limit(1);

      if (!error && rows && rows.length > 0) {
        product = rows[0] as ProductData;
        cacheHit = true;

        // Parse the categories_tags JSON string back into an array
        if (
          product.categoriesTags === undefined &&
          (rows[0] as any).categories_tags &&
          typeof (rows[0] as any).categories_tags === "string"
        ) {
          try {
            const parsed = JSON.parse((rows[0] as any).categories_tags);
            if (Array.isArray(parsed)) {
              product.categoriesTags = parsed;
            }
          } catch {
            // Ignore parse errors; tags are optional
          }
        }

        console.log(
          `[verify-and-match] ${requestId} Phase A: cache HIT -> ${product.name}`,
        );
      } else {
        console.log(`[verify-and-match] ${requestId} Phase A: cache MISS`);
      }
    } catch (err) {
      console.warn(
        `[verify-and-match] ${requestId} Phase A: query error:`,
        (err as Error).message,
      );
    }
  }

  // ============================================================================
  //  PHASE B -- Live Open Food Facts v2 API
  // ============================================================================

  if (!product) {
    console.log(
      `[verify-and-match] ${requestId} Phase B: querying Open Food Facts v2...`,
    );
    product = await fetchFromOpenFoodFacts(barcode);

    if (product) {
      console.log(
        `[verify-and-match] ${requestId} Phase B: found -> "${product.name}"`,
      );

      // If the product exists but has no ingredients, we return it anyway with
      // a special signal so the frontend can ask for manual photo capture.
      if (!product.ingredients) {
        console.log(
          `[verify-and-match] ${requestId} Phase B: product "${product.name}" has NO ingredients list`,
        );
      }
    } else {
      console.log(
        `[verify-and-match] ${requestId} Phase B: product NOT FOUND in Open Food Facts`,
      );
    }
  }

  // ============================================================================
  //  PHASE C -- Live Apify Supermarket Scraper with Tiered Fallback
  // ============================================================================
  //
  //  Two distinct paths:
  //
  //  PATH 1 (OFF succeeded):
  //    We have product name + brand + categories from Open Food Facts.
  //    Run the Multi-Tier Search Fallback:
  //      Tier 1: Search supermarket with cleaned brand name (e.g. "Oreo Double Cream")
  //      Tier 2: If no own-brand match found, use OFF category tags to generate
  //              broader keywords (e.g. "Chocolate Sandwich Biscuits") and re-search.
  //    Merge the scraped result (price, supermarket, image) with OFF data (ingredients).
  //
  //  PATH 2 (OFF failed):
  //    No product data available. Search supermarkets directly using the barcode
  //    via the generic web scraper fallback.
  //
  //  TOKEN ENCAPSULATION:
  //    The APIFY_TOKEN is read from Deno.env.get("APIFY_TOKEN") at line 42.
  //    It is used ONLY in the server-side fetch to api.apify.com. The token
  //    is NEVER included in the response body, headers, or any data returned
  //    to the client. Even in error messages, the token is omitted.

  if (!cacheHit) {
    if (product && product.source === "openfoodfacts") {
      // PATH 1: OFF found the product. Now find it (or its generic twin) on
      // the selected supermarket's website using tiered fallback.
      console.log(
        `[verify-and-match] ${requestId} Phase C: running tiered fallback on ${supermarket}...`,
      );

      const scrapedProduct = await searchWithTieredFallback(
        barcode,
        supermarket,
        product.name,
        product.brand,
        product.categoriesTags,
        product.category,
      );

      if (scrapedProduct) {
        console.log(
          `[verify-and-match] ${requestId} Phase C: scraped -> "${scrapedProduct.name}" at ${supermarket} for GBP ${scrapedProduct.price}`,
        );

        // Merge scraped data with OFF data:
        //   - Keep OFF data: name, brand, category, ingredients (more reliable)
        //   - Use scraped: price, supermarket, image_url (supermarket-specific)
        product.price = scrapedProduct.price || product.price;
        product.supermarket = scrapedProduct.supermarket || supermarket;
        product.image_url = scrapedProduct.image_url || product.image_url;
      } else {
        console.log(
          `[verify-and-match] ${requestId} Phase C: no results on ${supermarket} for this product.`,
        );
      }
    } else if (!product) {
      // PATH 2: No OFF data. Search supermarkets using the barcode directly
      // via the generic web scraper fallback.
      console.log(
        `[verify-and-match] ${requestId} Phase C: scraping ${supermarket} for barcode...`,
      );

      // Try the generic fallback that searches all supermarkets
      product = await scrapeAllSupermarketsFallback(barcode);

      if (product) {
        console.log(
          `[verify-and-match] ${requestId} Phase C: found -> "${product.name}" at ${product.supermarket}`,
        );
      }
    }
  }

  // Note: if cacheHit is true, Phase C is skipped entirely because we already
  // have all the data from a previous scan.

  // ============================================================================
  //  HANDLE: No data found from any source
  // ============================================================================

  if (!product) {
    console.log(
      `[verify-and-match] ${requestId} No data found for barcode ${barcode}`,
    );
    return new Response(
      JSON.stringify({
        error: "not_found",
        message: `We searched Open Food Facts and ${supermarket} but could not find product data for barcode ${barcode}.`,
        barcode,
        requiresManualCapture: true,
      }),
      { status: 404, headers },
    );
  }

  // ============================================================================
  //  HANDLE: Product found but ingredients are missing
  // ============================================================================
  //  If the product exists (from OFF or Apify) but has no ingredient data, we
  //  return it with a marker so the frontend can prompt the user to take a
  //  photo of the ingredients label for OCR processing.

  const hasIngredients = product.ingredients && product.ingredients.length > 10;

  // ============================================================================
  //  SAVE TO product_cache (fire-and-forget)
  // ============================================================================
  //  We upsert the data asynchronously so it doesn't delay the response.
  //  If it fails, the product will be fetched again from OFF or Apify next time.

  if (!cacheHit) {
    saveProductToCache(product, supabaseClient);
  }

  // ============================================================================
  //  PHASE D -- Find Alternatives & Calculate Ingredient Match
  // ============================================================================

  const alternatives = await findAlternatives(
    product,
    supermarket,
    supabaseClient,
  );

  // Determine the best alternative
  let bestAlternative: ProductData | null = null;
  let comparison: MatchResult | null = null;

  if (alternatives.length > 0) {
    // Prefer an alternative from the user's selected supermarket
    bestAlternative =
      alternatives.find((a: any) => a.supermarket === supermarket) ||
      alternatives[0];

    // Phase E -- Calculate the ingredient match (only if both have ingredients)
    if (hasIngredients && (bestAlternative as any).ingredients) {
      comparison = calculateIngredientMatch(
        product.ingredients || "",
        (bestAlternative as any).ingredients || "",
      );
    }
  }

  // ============================================================================
  //  RETURN THE RESULT
  // ============================================================================
  //
  //  SECURITY NOTE:
  //    The APIFY_TOKEN is NOT included anywhere in this response.
  //    The Supabase service_role key is NOT included anywhere in this response.
  //    Only the anon-key-safe data is returned.

  const result: ScanResult = {
    product,
    alternatives,
    bestAlternative,
    comparison,
  };

  const elapsed = Date.now() - startTime;
  console.log(`[verify-and-match] ${requestId} Done in ${elapsed}ms`);

  return new Response(JSON.stringify(result), {
    status: 200,
    headers,
  });
});
