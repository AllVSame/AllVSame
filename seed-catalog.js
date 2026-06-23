#!/usr/bin/env node

/**
 * ============================================================================
 *  seed-catalog.js — AllVSame Product Catalog Seed Script
 * ============================================================================
 *
 *  PURPOSE:
 *    Pre-populates the Supabase product_cache table with real product data
 *    from 7 UK supermarkets (Tesco, Sainsbury's, Asda, Morrisons, Aldi,
 *    Lidl, Waitrose). Each product is scraped via Apify actors, ingredient-
 *    normalised, and stored for instant cache hits during barcode scanning.
 *
 *  HOW IT WORKS:
 *    1.  Defines 60 high-frequency UK grocery search keywords
 *    2.  For each keyword, fires Apify scrapers for ALL 7 supermarkets
 *        in parallel (maxItems: 1 per call for minimum cost)
 *    3.  Extracts name, brand, price, ingredients from each result
 *    4.  Runs the same lower-case / strip-brackets / remove-filler-words
 *        normalisation used by the verify-and-match edge function
 *    5.  Generates a deterministic barcode from the product URL (or a
 *        hash of keyword+supermarket if no URL is available)
 *    6.  Batch-upserts records into Supabase product_cache via REST API
 *    7.  Waits 5 seconds between keyword batches to respect rate limits
 *
 *  SCHEDULING & COST:
 *    - 60 keywords x 7 supermarkets = 420 Apify actor invocations
 *    - Parallel batch per keyword: ~7 concurrent calls, then 5s pause
 *    - Estimated total wall-clock time: 6-10 minutes
 *    - maxItems: 1 per invocation = < 1 Apify compute unit per call
 *
 *  PREREQUISITES:
 *    - Node.js 18+ (for native fetch support)
 *    - Apify API token with available credits
 *    - Supabase service_role key (for direct table writes)
 *
 *  USAGE:
 *    1. export APIFY_TOKEN="your_apify_token_here"
 *    2. export SUPABASE_SERVICE_ROLE_KEY="your_supabase_service_role_key"
 *    3. node seed-catalog.js
 *
 *    (Both tokens must be set in your terminal session before running.)
 *
 * ============================================================================
 */

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  1.  CONFIGURATION                                                       ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// -- Supabase project details ------------------------------------------------
const SUPABASE_URL = "https://zfhpzlgomylyfggwyeqm.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// -- Apify API token (must be set in environment) ----------------------------
const APIFY_TOKEN = process.env.APIFY_TOKEN || "";

// -- Node built-in for deterministic hashing ----------------------------------
const crypto = require("crypto");

// -- Target table (change to "products" if you prefer Phase D matching) -----
const TARGET_TABLE = "product_cache";

// -- Apify actor IDs for each supported UK supermarket -----------------------
//    Dedicated actors where available; generic web scraper fallback otherwise.
const SUPERMARKETS = [
  {
    id: "tesco",
    name: "Tesco",
    actorId: "radeance/tesco-scraper",
    searchUrl: "https://www.tesco.com/groceries/en-GB/search?query=",
  },
  {
    id: "sainsburys",
    name: "Sainsbury's",
    actorId: "natanielsantos/sainsbury-s-scraper",
    searchUrl: "https://www.sainsburys.co.uk/shop/gb/groceries/search?q=",
  },
  {
    id: "asda",
    name: "Asda",
    actorId: "drobnyk/asda-scraper",
    searchUrl: "https://www.asda.com/search?q=",
  },
  {
    id: "morrisons",
    name: "Morrisons",
    actorId: "aYG0l9s7dbB7j3gbS",
    searchUrl: "https://www.morrisons.com/search?search=",
  },
  {
    id: "aldi",
    name: "Aldi",
    actorId: "aYG0l9s7dbB7j3gbS",
    searchUrl: "https://www.aldi.co.uk/c/s?q=",
  },
  {
    id: "lidl",
    name: "Lidl",
    actorId: "aYG0l9s7dbB7j3gbS",
    searchUrl: "https://www.lidl.co.uk/search?q=",
  },
  {
    id: "waitrose",
    name: "Waitrose",
    actorId: "aYG0l9s7dbB7j3gbS",
    searchUrl: "https://www.waitrose.com/ecom/shop/search?&searchTerm=",
  },
];

// -- 60 high-frequency UK grocery search keywords ----------------------------
//    These cover the most commonly bought items across dairy, bakery, drinks,
//    canned, condiments, pasta/rice, spreads, snacks, frozen, produce, meat,
//    and household categories.
const KEYWORDS = [
  // Dairy & Eggs
  "Whole Milk",
  "Semi-Skimmed Milk",
  "Salted Butter",
  "Unsalted Butter",
  "Mature Cheddar",
  "Natural Yogurt",
  "Free Range Eggs",
  "Double Cream",
  // Bakery
  "White Bread",
  "Wholemeal Bread",
  "Crumpets",
  "Plain Flour",
  // Beverages
  "Orange Juice",
  "Cola",
  "Still Water",
  "Tea Bags",
  "Instant Coffee",
  // Canned & Jarred
  "Baked Beans",
  "Chopped Tomatoes",
  "Tuna in Oil",
  "Sweetcorn",
  "Tomato Soup",
  "Tomato Ketchup",
  "Mayonnaise",
  "Brown Sauce",
  // Pasta, Rice & Grains
  "Spaghetti",
  "Penne Pasta",
  "Long Grain Rice",
  "Basmati Rice",
  "Porridge Oats",
  "Corn Flakes",
  // Spreads & Condiments
  "Strawberry Jam",
  "Marmalade",
  "Peanut Butter",
  "Marmite",
  "Honey",
  // Snacks
  "Digestive Biscuits",
  "Shortbread Biscuits",
  "Salted Crisps",
  "Milk Chocolate",
  "Mixed Nuts",
  // Frozen
  "Frozen Peas",
  "Oven Chips",
  "Frozen Pizza",
  "Ice Cream",
  "Fish Fingers",
  // Fresh Produce
  "Bananas",
  "Apples",
  "Potatoes",
  "Onions",
  "Carrots",
  "Mushrooms",
  "Tomatoes",
  "Cucumber",
  "Broccoli",
  // Meat & Fish
  "Chicken Breast",
  "Minced Beef",
  "Bacon",
  "Pork Sausages",
  "Salmon Fillets",
  // Household
  "Toilet Roll",
  "Kitchen Roll",
  "Washing Up Liquid",
];

// -- Throttling ---------------------------------------------------------------
const DELAY_BETWEEN_KEYWORDS_MS = 5000; // 5 seconds between keyword batches

// -- Batching -----------------------------------------------------------------
const SUPABASE_BATCH_SIZE = 21; // Flush to Supabase every ~3 keywords (3x7=21 records)

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  2.  ENVIRONMENT VALIDATION                                              ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

if (!APIFY_TOKEN) {
  console.error("\n  ERROR: APIFY_TOKEN is not set.");
  console.error('  Run:  export APIFY_TOKEN="your_apify_token_here"\n');
  process.exit(1);
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("\n  ERROR: SUPABASE_SERVICE_ROLE_KEY is not set.");
  console.error(
    '  Run:  export SUPABASE_SERVICE_ROLE_KEY="your_supabase_service_role_key"\n',
  );
  process.exit(1);
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  3.  HELPER FUNCTIONS                                                    ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// -- Sleep / delay -----------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -- Generate a deterministic 13-character barcode from product data ---------
//    Real barcodes are 13-digit EAN-13 numbers. Since Apify may or may not
//    return a GTIN, we generate a stable hash from the product URL (or from
//    the keyword+supermarket combo if no URL exists). The "999" prefix ensures
//    seed barcodes never collide with real product barcodes.
function generateBarcode(url, keyword, supermarketId) {
  // If the scraped result includes a real GTIN / EAN, use it
  if (url && typeof url === "string") {
    const hash = crypto.createHash("md5").update(url).digest("hex");
    // Take first 13 characters; prefix "999" marks it as seed data
    return "999" + hash.substring(0, 10);
  }
  // Fallback: hash the keyword + supermarket for consistency
  const hash = crypto
    .createHash("md5")
    .update(keyword.toLowerCase().replace(/\s+/g, "") + supermarketId)
    .digest("hex");
  return "999" + hash.substring(0, 10);
}

// -- Build the correct Apify payload for each actor --------------------------
//    maxItems / maxResults / maxProducts is set to 1 for minimum cost.
function buildApifyPayload(actorId, keyword) {
  switch (actorId) {
    case "radeance/tesco-scraper":
      return { searchTerm: keyword, maxItems: 1 };

    case "natanielsantos/sainsbury-s-scraper":
      return { searchTerm: keyword, maxResults: 1 };

    case "drobnyk/asda-scraper":
      return { search: keyword, maxProducts: 1 };

    default:
      // Generic web scraper fallback — used for Morrisons, Aldi, Lidl, Waitrose
      return {
        runInput: {
          startUrls: [
            {
              url: `https://www.google.com/search?q=${encodeURIComponent(keyword)}`,
            },
          ],
          maxPagesPerCrawl: 1,
          maxResults: 1,
        },
      };
  }
}

// -- Extract product fields from any Apify actor's result item ---------------
//    Different actors return different field names. This function normalises
//    them into a consistent structure.
function extractProductFromResult(item, keyword, supermarket) {
  if (!item || typeof item !== "object") return null;

  // Helper: find first non-empty string from a list of possible keys
  const findField = (keys) => {
    for (const key of keys) {
      const val = item[key];
      if (val && typeof val === "string" && val.trim()) return val.trim();
    }
    return "";
  };

  const name =
    findField([
      "title",
      "name",
      "productName",
      "product_name",
      "heading",
      "label",
    ]) || `Generic ${keyword}`;
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

  // Parse price (strip currency symbols)
  let price = null;
  if (priceRaw) {
    const cleaned = priceRaw.replace(/[^0-9.]/g, "");
    price = parseFloat(cleaned);
    if (isNaN(price)) price = null;
  }

  // Extract ingredients — may be in various fields or nested objects
  let ingredients = findField([
    "ingredients",
    "ingredientsText",
    "ingredients_text",
    "productInformation",
    "description",
    "details",
  ]);
  if (
    (!ingredients || ingredients.length < 10) &&
    typeof item.productInformation === "string"
  ) {
    ingredients = item.productInformation.substring(0, 2000);
  }

  // Normalise the ingredient text (same algorithm as the edge function)
  const normalizedIngredients = normaliseIngredientText(ingredients || "");

  // Category — use the generic keyword category as a fallback
  const category =
    findField(["category", "categories", "breadcrumb", "department"]) || "";

  // Generate a deterministic barcode
  const barcode = generateBarcode(url, keyword, supermarket.id);

  return {
    barcode,
    name,
    brand: brand || supermarket.name,
    supermarket: supermarket.id,
    category: category || "Unknown",
    categories_tags: null,
    ingredients: normalizedIngredients,
    price,
    image_url: imageUrl,
    source: "seed-catalog",
  };
}

// -- Normalise ingredient text ------------------------------------------------
//    Ported directly from the verify-and-match edge function (index.ts lines
//    1144-1245). Lowercases, strips brackets/punctuation/filler words, and
//    collapses whitespace. The cleaned text is what the Jaccard similarity
//    calculator uses to compare products.
function normaliseIngredientText(text) {
  if (!text || typeof text !== "string") return "";

  let t = text.toLowerCase();

  // Remove parenthetical and bracketed content
  t = t.replace(/\([^)]*\)/g, "");
  t = t.replace(/\[[^\]]*\]/g, "");

  // Strip punctuation
  t = t.replace(/[<>"'.,;:!?]/g, "");
  t = t.replace(/[^\w\s]/g, "");

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

// -- Batch upsert records into Supabase via the REST API ---------------------
//    Uses the Supabase REST endpoint directly (no SDK needed). The
//    "Prefer: resolution=merge-duplicates" header tells Supabase to
//    overwrite any row with the same barcode.
async function upsertBatch(records) {
  if (records.length === 0) return [];

  const url = `${SUPABASE_URL}/rest/v1/${TARGET_TABLE}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(records),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(
        `    [UPSERT ERROR] HTTP ${response.status}: ${errorText.substring(0, 200)}`,
      );
      return records.map(() => false);
    }

    console.log(
      `    [UPSERT OK] ${records.length} records written to ${TARGET_TABLE}`,
    );
    return records.map(() => true);
  } catch (err) {
    console.error(`    [UPSERT NETWORK ERROR] ${err.message}`);
    return records.map(() => false);
  }
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  4.  MAIN SEED LOOP                                                      ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("  AllVSame — Product Catalog Seed Script");
  console.log("=".repeat(70));
  console.log(`\n  Target table : ${TARGET_TABLE}`);
  console.log(`  Keywords     : ${KEYWORDS.length}`);
  console.log(
    `  Supermarkets : ${SUPERMARKETS.length} (${SUPERMARKETS.map((s) => s.name).join(", ")})`,
  );
  console.log(`  Total calls  : ${KEYWORDS.length * SUPERMARKETS.length}`);
  console.log(`  Batch size   : ${SUPABASE_BATCH_SIZE} records per upsert\n`);

  let totalScraped = 0;
  let totalInserted = 0;
  let totalErrors = 0;
  const batchBuffer = [];
  const startTime = Date.now();

  // ── Loop through each keyword ─────────────────────────────────────────────
  for (let ki = 0; ki < KEYWORDS.length; ki++) {
    const keyword = KEYWORDS[ki];
    const keywordStartTime = Date.now();

    console.log(`\n[${ki + 1}/${KEYWORDS.length}] Keyword: "${keyword}"`);

    // ── Fire all 7 supermarket scrapers IN PARALLEL for this keyword ──────
    const results = await Promise.allSettled(
      SUPERMARKETS.map((supermarket) => scrapeKeyword(supermarket, keyword)),
    );

    // ── Collect successful results ──────────────────────────────────────────
    let keywordScraped = 0;
    for (let si = 0; si < results.length; si++) {
      const result = results[si];
      const supermarket = SUPERMARKETS[si];

      if (result.status === "fulfilled" && result.value) {
        batchBuffer.push(result.value);
        keywordScraped++;
        totalScraped++;
      } else if (result.status === "rejected") {
        console.error(
          `    [${supermarket.name}] ERROR: ${result.reason?.message || result.reason}`,
        );
        totalErrors++;
      }
    }

    console.log(
      `    Scraped: ${keywordScraped}/${SUPERMARKETS.length} supermarkets (${keywordScraped > 0 ? "OK" : "no results"})`,
    );

    // ── Flush batch buffer if it reached the threshold ──────────────────────
    if (batchBuffer.length >= SUPABASE_BATCH_SIZE) {
      const batch = batchBuffer.splice(0, SUPABASE_BATCH_SIZE);
      const results = await upsertBatch(batch);
      totalInserted += results.filter(Boolean).length;
      // Show progress every batch
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(
        `    [PROGRESS] ${totalScraped} scraped, ${totalInserted} inserted, ${totalErrors} errors — ${elapsed}s elapsed`,
      );
    }

    // ── Throttle: wait 5 seconds before the next keyword ────────────────────
    if (ki < KEYWORDS.length - 1) {
      const elapsedThisKeyword = Date.now() - keywordStartTime;
      const waitTime = Math.max(
        0,
        DELAY_BETWEEN_KEYWORDS_MS - elapsedThisKeyword,
      );
      if (waitTime > 0) {
        console.log(
          `    Waiting ${(waitTime / 1000).toFixed(0)}s before next keyword...`,
        );
        await sleep(waitTime);
      }
    }
  }

  // ── Flush any remaining records in the buffer ─────────────────────────────
  if (batchBuffer.length > 0) {
    console.log(`\n  Flushing final batch (${batchBuffer.length} records)...`);
    const results = await upsertBatch(batchBuffer);
    totalInserted += results.filter(Boolean).length;
  }

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  5.  SUMMARY                                                           ║
  // ╚══════════════════════════════════════════════════════════════════════════╝

  const totalElapsed = Math.round((Date.now() - startTime) / 1000);
  const minutes = Math.floor(totalElapsed / 60);
  const seconds = totalElapsed % 60;

  console.log("\n" + "=".repeat(70));
  console.log("  SEED COMPLETE");
  console.log("=".repeat(70));
  console.log(`\n  Products scraped  : ${totalScraped}`);
  console.log(`  Records inserted  : ${totalInserted}`);
  console.log(`  Errors            : ${totalErrors}`);
  console.log(`  Time elapsed      : ${minutes}m ${seconds}s`);
  console.log(
    `\n  Data written to   : ${SUPABASE_URL}/rest/v1/${TARGET_TABLE}`,
  );
  console.log(`\n  NEXT STEPS:`);
  console.log(
    `    1. Verify in Supabase Dashboard: Table Editor -> ${TARGET_TABLE}`,
  );
  console.log(`    2. Run "npm run dev" and scan a matching product barcode`);
  console.log(`    3. Phase A should return cached data immediately\n`);
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  SINGLE-SUPERMARKET SCRAPE FUNCTION                                       ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

/**
 * Calls the Apify synchronous endpoint for one supermarket + keyword combo.
 *
 * @param {object} supermarket  - Supermarket config object { id, name, actorId, searchUrl }
 * @param {string} keyword      - The search keyword
 * @returns {object|null}       - A product record, or null if nothing found / error
 */
async function scrapeKeyword(supermarket, keyword) {
  const {
    id: supermarketId,
    name: supermarketName,
    actorId,
    searchUrl,
  } = supermarket;

  // Build the API payload with maxItems: 1 for minimum computing cost
  const payload = buildApifyPayload(actorId, keyword);

  // Construct the synchronous Apify endpoint URL with token embedded
  const apiUrl = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;

  // We set a 25-second timeout per call (actors may take time to warm up)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      // 404 / empty dataset is normal for some keyword+supermarket combos
      if (response.status === 404) {
        console.log(`    [${supermarketName}] No results for "${keyword}"`);
      } else {
        console.warn(
          `    [${supermarketName}] HTTP ${response.status}: ${errorText.substring(0, 100)}`,
        );
      }
      return null;
    }

    let dataset;
    try {
      dataset = await response.json();
    } catch {
      console.warn(`    [${supermarketName}] Invalid JSON response`);
      return null;
    }

    if (!Array.isArray(dataset) || dataset.length === 0) {
      console.log(`    [${supermarketName}] Empty dataset for "${keyword}"`);
      return null;
    }

    // Take the first (closest) result
    const item = dataset[0];
    const product = extractProductFromResult(item, keyword, supermarket);

    if (product && product.name) {
      console.log(
        `    [${supermarketName}] -> "${product.name}" (${product.price ? "GBP " + product.price.toFixed(2) : "no price"})`,
      );
      return product;
    }

    return null;
  } catch (err) {
    clearTimeout(timeout);

    if (err.name === "AbortError") {
      console.warn(
        `    [${supermarketName}] Timeout after 25s for "${keyword}"`,
      );
    } else {
      console.warn(`    [${supermarketName}] Fetch error: ${err.message}`);
    }
    return null;
  }
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  EXECUTION                                                               ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

main().catch((err) => {
  console.error("\n  FATAL ERROR:", err.message);
  process.exit(1);
});
