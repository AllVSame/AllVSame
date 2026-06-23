/**
 * ============================================================================
 *  verify-and-match -- AllVSame Secure Cloud Backend (Supabase Edge Function)
 * ============================================================================
 *
 *  ARCHITECTURE OVERVIEW
 *  ---------------------------------------------------------------------------
 *  This Edge Function acts as the single secure gateway between the
 *  AllVSame frontend and all backend services. The client NEVER holds
 *  any secret tokens -- they live here, in Supabase environment variables.
 *
 *  TOKEN ENCAPSULATION LAYER
 *  ---------------------------------------------------------------------------
 *    APIFY_TOKEN         -> Deno.env.get("APIFY_TOKEN")        Set in Supabase dashboard
 *    SUPABASE_SERVICE_ROLE -> Deno.env.get("SERVICE_ROLE_KEY")  Service key (not anon!)
 *
 *  The frontend only knows SUPABASE_URL and SUPABASE_ANON_KEY -- both are
 *  designed to be public (the anon key is safe in client code). The Apify
 *  token and the Supabase service_role key NEVER touch the browser.
 *
 *  PIPELINE (Phases A-E)
 *  ---------------------------------------------------------------------------
 *    POST /verify-and-match  { barcode: string, supermarket: string }
 *
 *    Phase A -- Check Supabase "products" table for cached data
 *    Phase B -- If missed, call Open Food Facts (free, no key)
 *    Phase C -- If still missed, scrape via Apify actor using secret token
 *    Phase D -- Find alternative products in same category
 *    Phase E -- Run Jaccard ingredient-match algorithm, save, return result
 *
 *  SECURITY CONTROLS
 *  ---------------------------------------------------------------------------
 *    * CORS origin whitelist -- only allvsame.com + localhost
 *    * IP-based rate limiting -- 5 requests/minute per IP, returns 429
 *    * No secret leakage -- tokens are Deno.env-only, never returned
 *
 * ============================================================================
 */

// =============================================================================
//  TOP-LEVEL DEPENDENCIES
//  Supabase JS client for Deno. Imported at the top level so it is available
//  to all functions that need it. This is the standard Deno import pattern.
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

// ── CORS whitelist — only these origins may call this function ────────────
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

// ── Apify actor ID (generic web scraper for supermarket product pages) ───
const APIFY_ACTOR_ID = "aYG0l9s7dbB7j3gbS";

// ── Rate limiting configuration ──────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 5; // max 5 per window per IP

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  2.  IN-MEMORY RATE LIMITER                                             ║
// ║                                                                         ║
// ║  Stores a Map of IP → [timestamps]. Old entries are pruned on each      ║
// ║  request. Resets automatically when the function cold-starts (which     ║
// ║  is acceptable — rate limits are a backstop, not an audit trail).       ║
// ╚══════════════════════════════════════════════════════════════════════════╝

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

  // Get the existing timestamps for this IP, filtering out old ones
  let timestamps = rateLimitMap.get(ip) || [];
  timestamps = timestamps.filter((ts) => ts > windowStart);

  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    return false; // Rate limited
  }

  // Record this request
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return true;
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  3.  CORS HEADERS HELPER                                                ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Returns the appropriate CORS headers based on the request origin.
 * If the origin is not in the whitelist, the function will still process
 * the request but the browser will block the response client-side.
 *
 * @param requestOrigin  The value of the Origin header from the request.
 * @returns              Headers object with CORS + content-type set.
 */
function corsHeaders(requestOrigin: string | null): Headers {
  const origin =
    requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)
      ? requestOrigin
      : "https://allvsame.com"; // Safe fallback

  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
  });
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  4.  SUPABASE CLIENT HELPER                                             ║
// ║                                                                         ║
// ║  Uses the service_role key (NOT the anon key) so the edge function      ║
// ║  can write to tables that have Row-Level Security (RLS) policies.       ║
// ║  The service_role key bypasses RLS entirely — safe here because this    ║
// ║  code runs server-side and is never exposed to the client.              ║
// ╚══════════════════════════════════════════════════════════════════════════╝

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

  // The createClient function was imported at the top of this file.
  // It uses the Supabase JS library v2 for Deno from esm.sh.
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  5.  DATA SCHEMA                                                        ║
// ║                                                                         ║
// ║  Internal TypeScript interfaces for the product and comparison data.    ║
// ╚══════════════════════════════════════════════════════════════════════════╝

interface ProductData {
  barcode: string;
  name: string;
  brand: string;
  supermarket: string;
  category: string;
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

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  6.  PHASE B — Open Food Facts API                                      ║
// ║                                                                         ║
// ║  Free, crowd-sourced product database. No API key needed.               ║
// ║  Endpoint: https://world.openfoodfacts.org/api/v0/product/{barcode}.json ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Fetches product data from the Open Food Facts public API.
 *
 * @param barcode  The product barcode (EAN-13 / GTIN format).
 * @returns        A ProductData object, or null if not found.
 */
async function fetchFromOpenFoodFacts(
  barcode: string,
): Promise<ProductData | null> {
  const url = `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    console.warn(
      "[verify-and-match] OFF network error:",
      (err as Error).message,
    );
    return null;
  }

  if (!response.ok) {
    console.warn("[verify-and-match] OFF HTTP", response.status);
    return null;
  }

  let json: any;
  try {
    json = await response.json();
  } catch {
    console.warn("[verify-and-match] OFF JSON parse error");
    return null;
  }

  // OFF returns { status: 1, product: { ... } } when found
  if (!json || json.status !== 1 || !json.product) {
    return null;
  }

  const p = json.product;

  // Extract ingredients — OFF stores them as a string or language-keyed object
  let ingredientsText = "";
  if (typeof p.ingredients_text === "string") {
    ingredientsText = p.ingredients_text;
  } else if (p.ingredients_text && typeof p.ingredients_text === "object") {
    ingredientsText =
      p.ingredients_text.en || Object.values(p.ingredients_text)[0] || "";
  }

  return {
    barcode,
    name: p.product_name || `Product ${barcode}`,
    brand: p.brands || "Unknown Brand",
    supermarket: "unknown",
    category: p.categories || "Unknown",
    ingredients: ingredientsText || "",
    price: null,
    image_url: p.image_url || "",
    source: "openfoodfacts",
  };
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  7.  PHASE C — Apify Scraper                                            ║
// ║                                                                         ║
// ║  Uses the secret APIFY_TOKEN from environment variables. The token      ║
// ║  is injected into the API URL server-side and NEVER returned to the     ║
// ║  client.                                                                ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Scrapes UK supermarket websites via the Apify Web Scraper actor.
 * The APIFY_TOKEN is read from Deno.env — it never reaches the browser.
 *
 * @param barcode  The product barcode.
 * @returns        A ProductData object, or null if scraping failed.
 */
async function scrapeWithApify(barcode: string): Promise<ProductData | null> {
  if (!APIFY_TOKEN) {
    console.warn("[verify-and-match] APIFY_TOKEN not set in environment");
    return null;
  }

  console.log("[verify-and-match] Apify: scraping for barcode", barcode);

  const apiUrl = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_TOKEN}`;

  const payload = {
    runInput: {
      startUrls: [
        {
          url: `https://www.tesco.com/groceries/en-GB/search?query=${barcode}`,
        },
        { url: `https://www.sainsburys.co.uk/gol/productsearch?q=${barcode}` },
        { url: `https://www.asda.com/search?q=${barcode}` },
        { url: `https://www.morrisons.com/search?q=${barcode}` },
      ],
      maxPagesPerCrawl: 5,
      maxResults: 3,
    },
  };

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.warn(
      "[verify-and-match] Apify network error:",
      (err as Error).message,
    );
    return null;
  }

  if (!response.ok) {
    console.warn("[verify-and-match] Apify HTTP", response.status);
    return null;
  }

  let responseData: any;
  try {
    responseData = await response.json();
  } catch {
    console.warn("[verify-and-match] Apify JSON parse error");
    return null;
  }

  // The Apify actor returns a run object; we poll for the dataset
  const runId = responseData.data?.id;
  if (!runId) {
    console.warn("[verify-and-match] Apify: no run ID returned");
    return null;
  }

  // Poll for completion (up to 20 seconds)
  const dataset = await pollApifyRun(runId);
  if (!dataset || dataset.length === 0) {
    return null;
  }

  const scraped = dataset[0];

  return {
    barcode,
    name: scraped.title || scraped.name || `Product ${barcode}`,
    brand: scraped.brand || "Unknown Brand",
    supermarket: inferSupermarketFromUrl(scraped.url || ""),
    category: scraped.category || "Unknown",
    ingredients:
      scraped.ingredients || extractIngredientsFromScraped(scraped) || "",
    price: parseFloat(scraped.price || scraped.currentPrice) || null,
    image_url: scraped.image || scraped.imageUrl || "",
    source: "apify",
  };
}

/**
 * Polls the Apify run until it completes, then fetches the dataset items.
 * Uses the secret token for authentication on each poll request.
 *
 * @param runId  The Apify run ID.
 * @returns      Array of scraped items, or null on failure.
 */
async function pollApifyRun(runId: string): Promise<any[] | null> {
  const maxAttempts = 20;
  const pollIntervalMs = 1000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    try {
      const statusUrl = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs/${runId}?token=${APIFY_TOKEN}`;
      const statusResp = await fetch(statusUrl);
      const statusData = await statusResp.json();

      const status = statusData.data?.status;
      if (status === "SUCCEEDED") {
        // Fetch the dataset
        const datasetUrl = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs/${runId}/dataset/items?token=${APIFY_TOKEN}`;
        const datasetResp = await fetch(datasetUrl);
        return await datasetResp.json();
      }

      if (
        status === "FAILED" ||
        status === "ABORTED" ||
        status === "TIMED-OUT"
      ) {
        console.warn(`[verify-and-match] Apify run ${status}`);
        return null;
      }
    } catch (err) {
      console.warn(
        "[verify-and-match] Apify poll error:",
        (err as Error).message,
      );
      return null;
    }
  }

  console.warn("[verify-and-match] Apify poll timed out");
  return null;
}

/**
 * Infers the supermarket ID from a URL.
 */
function inferSupermarketFromUrl(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("tesco")) return "tesco";
  if (u.includes("sainsburys")) return "sainsburys";
  if (u.includes("asda")) return "asda";
  if (u.includes("morrisons")) return "morrisons";
  return "tesco"; // best guess
}

/**
 * Best-effort extraction of ingredient text from scraped data.
 */
function extractIngredientsFromScraped(scraped: any): string {
  const candidates = [
    "ingredients",
    "description",
    "details",
    "features",
    "specifications",
  ];
  for (const field of candidates) {
    const val = scraped[field];
    if (val && typeof val === "string" && val.length > 10) {
      return val.substring(0, 1000);
    }
  }
  return "";
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  8.  INGREDIENT COMPARISON ENGINE (Phase D & E)                         ║
// ║                                                                         ║
// ║  Identical algorithm to the original client-side version, ported to     ║
// ║  Deno/TypeScript. Uses Jaccard similarity on normalised tokens.         ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Normalises a single ingredient string.
 */
function normalizeIngredient(text: string): string {
  if (!text || typeof text !== "string") return "";

  let t = text.toLowerCase();
  // Remove parenthetical and bracketed content
  t = t.replace(/\([^)]*\)/g, "");
  t = t.replace(/\[[^\]]*\]/g, "");
  // Strip punctuation
  t = t.replace(/[<>"'.,;:!?™®]/g, "");
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
    "specially",
    "carefully",
    "expertly",
    "hand",
    "handcrafted",
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
 * Parses a comma-separated ingredient string into a cleaned array.
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
 * @param brandIngredients   Ingredient string of the brand (scanned) product.
 * @param altIngredients     Ingredient string of the alternative product.
 * @returns                  MatchResult with percentage, matching/differing lists.
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

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  9.  FIND ALTERNATIVES (Phase D)                                        ║
// ║                                                                         ║
// ║  Queries the Supabase "products" table for items in the same category   ║
// ║  from different supermarkets, then scores them by ingredient match.     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

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

  // Query Supabase for same-category products (excluding the scanned product)
  if (supabaseClient && product.category && product.category !== "Unknown") {
    try {
      const { data: rows, error } = await supabaseClient
        .from("products")
        .select("*")
        .eq("category", product.category)
        .neq("barcode", product.barcode)
        .limit(20);

      if (!error && rows && rows.length > 0) {
        rows.forEach((r: any) => alternatives.push(r));
      }
    } catch (err) {
      console.warn(
        "[verify-and-match] Supabase alternatives query failed:",
        (err as Error).message,
      );
    }
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

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  10.  SAVE TO SUPABASE                                                  ║
// ║                                                                         ║
// ║  Uses the service_role client to upsert the product record with         ║
// ║  'Prefer: resolution=merge-duplicates' for safe overwrites.             ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Saves (or overwrites) a product record in Supabase.
 *
 * @param product         The product data to persist.
 * @param supabaseClient  An authenticated Supabase client.
 * @returns               true on success, false on failure.
 */
async function saveProductToDatabase(
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
      ingredients: product.ingredients || null,
      price: product.price != null ? product.price : null,
      image_url: product.image_url || null,
      source: product.source || "scan",
    };

    const { error } = await supabaseClient
      .from("products")
      .upsert(record, { onConflict: "barcode" });

    if (error) {
      console.warn("[verify-and-match] Database upsert error:", error);
      return false;
    }

    console.log("[verify-and-match] Product saved:", product.barcode);
    return true;
  } catch (err) {
    console.warn(
      "[verify-and-match] Database save exception:",
      (err as Error).message,
    );
    return false;
  }
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  11.  MAIN REQUEST HANDLER                                              ║
// ║                                                                         ║
// ║  Deno.serve() is the entry point for Supabase Edge Functions. It        ║
// ║  receives the HTTP request, validates it, runs the pipeline, and        ║
// ║  returns the result.                                                    ║
// ╚══════════════════════════════════════════════════════════════════════════╝

Deno.serve(async (req: Request): Promise<Response> => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const startTime = Date.now();

  // ── Extract origin for CORS ────────────────────────────────────────────
  const requestOrigin = req.headers.get("origin") || req.headers.get("Origin");
  const headers = corsHeaders(requestOrigin);

  // ── Handle CORS preflight (OPTIONS) ────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  // ── Method check — only POST is allowed ────────────────────────────────
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed. Use POST." }),
      { status: 405, headers },
    );
  }

  // ── Extract client IP for rate limiting ─────────────────────────────────
  //    x-forwarded-for is set by Supabase's gateway; fall back to the
  //    remote address if not present.
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

  // ── Rate limiting check ─────────────────────────────────────────────────
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

  // ── Parse request body ──────────────────────────────────────────────────
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

  if (!barcode || barcode.length < 8) {
    return new Response(
      JSON.stringify({ error: "Invalid barcode. Must be at least 8 digits." }),
      { status: 400, headers },
    );
  }

  console.log(
    `[verify-and-match] ${requestId} Start: barcode=${barcode}, supermarket=${supermarket}`,
  );

  // ── Initialise Supabase service client ──────────────────────────────────
  const supabaseClient = createServiceClient();

  // ════════════════════════════════════════════════════════════════════════
  //  PHASE A — Check Supabase product cache
  // ════════════════════════════════════════════════════════════════════════

  let product: ProductData | null = null;

  if (supabaseClient) {
    try {
      const { data: rows, error } = await supabaseClient
        .from("products")
        .select("*")
        .eq("barcode", barcode)
        .limit(1);

      if (!error && rows && rows.length > 0) {
        product = rows[0] as ProductData;
        console.log(
          `[verify-and-match] ${requestId} Phase A: cache hit → ${product.name}`,
        );
      }
    } catch (err) {
      console.warn(
        `[verify-and-match] ${requestId} Phase A: query error:`,
        (err as Error).message,
      );
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  PHASE B — Open Food Facts API
  // ════════════════════════════════════════════════════════════════════════

  if (!product) {
    console.log(
      `[verify-and-match] ${requestId} Phase B: querying Open Food Facts…`,
    );
    product = await fetchFromOpenFoodFacts(barcode);
    if (product) {
      console.log(
        `[verify-and-match] ${requestId} Phase B: found → ${product.name}`,
      );
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  PHASE C — Apify Scraper (using secret token from environment)
  // ════════════════════════════════════════════════════════════════════════
  //  TOKEN ENCAPSULATION NOTE:
  //  The APIFY_TOKEN is read from Deno.env.get("APIFY_TOKEN") on line 31.
  //  It is used ONLY in the server-side fetch to api.apify.com. The token
  //  value is NEVER included in the response body, headers, or any data
  //  returned to the client. Even in error messages, the token is omitted.
  // ════════════════════════════════════════════════════════════════════════

  if (!product) {
    console.log(`[verify-and-match] ${requestId} Phase C: scraping via Apify…`);
    product = await scrapeWithApify(barcode);
    if (product) {
      console.log(
        `[verify-and-match] ${requestId} Phase C: scraped → ${product.name}`,
      );
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  HANDLE: No data found from any source
  // ════════════════════════════════════════════════════════════════════════

  if (!product) {
    console.log(
      `[verify-and-match] ${requestId} No data found for barcode ${barcode}`,
    );
    return new Response(
      JSON.stringify({
        error: "not_found",
        message: `We searched every source but could not find data for barcode ${barcode}.`,
        barcode,
      }),
      { status: 404, headers },
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SAVE TO SUPABASE (background — non-blocking)
  // ════════════════════════════════════════════════════════════════════════
  //  We fire-and-forget the save so it doesn't delay the response.
  //  If it fails, the product will be fetched again from OFF or Apify next time.

  saveProductToDatabase(product, supabaseClient);

  // ════════════════════════════════════════════════════════════════════════
  //  PHASE D — Find Alternatives & Calculate Ingredient Match
  // ════════════════════════════════════════════════════════════════════════

  const alternatives = await findAlternatives(
    product,
    supermarket,
    supabaseClient,
  );

  // Determine the best alternative
  let bestAlternative: ProductData | null = null;
  let comparison: MatchResult | null = null;

  if (alternatives.length > 0) {
    bestAlternative =
      alternatives.find((a: any) => a.supermarket === supermarket) ||
      alternatives[0];

    // Phase E — Calculate the ingredient match
    comparison = calculateIngredientMatch(
      product.ingredients || "",
      (bestAlternative as any).ingredients || "",
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RETURN THE RESULT
  // ════════════════════════════════════════════════════════════════════════
  //  Note: The APIFY_TOKEN is NOT included anywhere in this response.
  //  The Supabase service_role key is NOT included anywhere in this response.
  //  Only the anon-key-safe data is returned.

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
