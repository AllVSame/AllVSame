/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AllVSame — Compare product ingredients & prices across UK supermarkets
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  DATA FLOW:
 *    1. User scans a barcode (or types it manually)
 *    2. handleProductScan() orchestrates three phases:
 *       Phase A — Check browser's localStorage for cached product data
 *       Phase B — If not cached, fetch from Open Food Facts (free public API)
 *       Phase C — If OFF has no data, scrape via Apify (synchronous await)
 *    3. Product data is saved to Supabase via saveToLocalCache() with
 *       'Prefer: resolution=merge-duplicates' for safe overwrites
 *    4. Alternatives are found in the same category from other supermarkets
 *    5. Ingredient lists are compared using Jaccard similarity
 *    6. renderResultsDashboard() builds a Tailwind CSS dashboard inside
 *       the HTML element with ID "results-display"
 *
 *  EXTERNAL APIs:
 *    - Open Food Facts:     https://world.openfoodfacts.org/api/v0/product/{barcode}.json
 *    - Apify:               https://api.apify.com/v2/acts/{actorId}/runs
 *    - Supabase (your DB):  https://zfhpzlgomylyfggwyeqm.supabase.co/rest/v1/products
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  1.  CONFIGURATION                                                      ║
// ║     Paste your API keys and tokens below between the quote marks.       ║
// ║     These are safe to leave in client-side code (public anon key).      ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ── Supabase ───────────────────────────────────────────────────────────────
// Your Supabase project URL and the public anonymous (anon) API key.
// Find these in your Supabase dashboard under Project Settings → API.
// ╔══════════════════════════════════════════════════════════════════════╗
// ║  IMPORTANT: Replace these placeholder values with your real keys!   ║
// ║  Get Supabase keys from: Project Settings → API                     ║
// ║  Get Apify token from:    Integrations → API                        ║
// ╚══════════════════════════════════════════════════════════════════════╝
const SUPABASE_URL = "https://zfhpzlgomylyfggwyeqm.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmaHB6bGdvbXlseWZnZ3d5ZXFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwODA0NjAsImV4cCI6MjA5NzY1NjQ2MH0.TeNO6CpmHVbC15RMMngkl_GxJDRjBB4X1ZZ9FNKYUbM";

// ── Apify ──────────────────────────────────────────────────────────────────
// Your Apify API token. Get this from your Apify account → Integrations → API.
// Used as a fallback to scrape product data from supermarket websites.
const APIFY_TOKEN = "YOUR_APIFY_TOKEN_HERE";

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  2.  SUPERMARKET LOOKUP TABLE                                           ║
// ║     Maps internal IDs to display names, emojis and brand colours.       ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const SUPERMARKETS = {
  tesco: { name: "Tesco", emoji: "📦", hex: "#00539f" },
  sainsburys: { name: "Sainsbury's", emoji: "🔴", hex: "#e2231a" },
  asda: { name: "Asda", emoji: "💚", hex: "#68c000" },
  morrisons: { name: "Morrisons", emoji: "💛", hex: "#f9a200" },
};

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  3.  SUPABASE CLIENT                                                    ║
// ║     Initialised once at startup using the Supabase JS UMD library.      ║
// ╚══════════════════════════════════════════════════════════════════════════╝

let supabase = null;

/**
 * Creates the Supabase client if the library is available.
 * Safe to call multiple times — it only initialises once.
 */
function initSupabase() {
  if (supabase) return; // already initialised

  // The Supabase UMD bundle exposes itself as window.supabase
  // We check for both possible global names across library versions
  const SupabaseLib = window.supabase || window.supabaseJs;
  if (!SupabaseLib || !SupabaseLib.createClient) {
    console.warn(
      "[AllVSame] Supabase library not loaded. Saving to Supabase will be skipped.",
    );
    return;
  }

  supabase = SupabaseLib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log("[AllVSame] Supabase client ready");
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  4.  APPLICATION STATE                                                  ║
// ║     Central object that holds all runtime data for the app.             ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const state = {
  /** The product that was scanned (or looked up manually) */
  currentProduct: null,

  /** Array of alternative products found in the same category */
  alternatives: [],

  /** The single best-matching alternative (highest ingredient similarity) */
  bestAlternative: null,

  /** The most recent comparison result from calculateIngredientMatch() */
  lastComparison: null,

  /** Currently selected supermarket in the dropdown */
  selectedSupermarket: "tesco",

  /** true while the camera is actively scanning for barcodes */
  isScanning: false,

  /** true while a product lookup or comparison is in progress */
  isLoading: false,

  /** Instance of Html5Qrcode used for barcode scanning */
  scanner: null,

  /** History of past scans (persisted in localStorage) */
  scanHistory: [],
};

// Key used to store the local cache in the browser's localStorage
const LOCAL_CACHE_KEY = "allvsame_local_cache";

// Key used to store the scan history in localStorage
const HISTORY_STORAGE_KEY = "allvsame_scan_history";

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  5.  DOM REFERENCES                                                      ║
// ║     Cached once after the page loads for fast lookups.                  ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const DOM = {};

/**
 * Scans the document for every element we need by its "id" attribute
 * and stores a reference in the DOM object.
 *
 * For example, an element with id="toggle-scanner-btn" becomes
 * available as DOM.toggle_scanner_btn (hyphens become underscores).
 */
function cacheDomRefs() {
  const ids = [
    "toggle-scanner-btn",
    "scanner-viewport",
    "scanner-placeholder",
    "scan-line",
    "scanning-dot",
    "manual-barcode",
    "manual-search-btn",
    "supermarket",
    "loading-state",
    "loading-text",
    "loading-subtext",
    "error-state",
    "error-title",
    "error-message",
    "error-retry-btn",
    "results-display",
    "idle-state",
    "scanner-section",
    "about-panel",
    "close-about-btn",
    "history-panel",
    "close-history-btn",
    "history-list",
  ];

  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) DOM[id.replace(/-/g, "_")] = el;
  });

  // Cache the bottom navigation buttons (they use a class, not an id)
  DOM.navBtns = document.querySelectorAll(".nav-btn");
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  6.  MAIN ENTRY POINT — handleProductScan()                             ║
// ║                                                                         ║
// ║  This is the central orchestrator. It runs three data-fetching phases   ║
// ║  in order, stopping at the first one that returns useful data:          ║
// ║                                                                         ║
// ║    Phase A — Local cache (browser's localStorage)                       ║
// ║               Fastest; avoids a network call for repeat scans.          ║
// ║                                                                         ║
// ║    Phase B — Open Food Facts API (free, public food database)           ║
// ║               Covers hundreds of thousands of branded products.         ║
// ║                                                                         ║
// ║    Phase C — Apify scraper                                              ║
// ║               Runs synchronously (awaited) to scrape UK supermarket     ║
// ║               websites when the other sources have no data.             ║
// ║                                                                         ║
// ║  Once product data is obtained it is:                                   ║
// ║    1. Saved to Supabase via saveToLocalCache()                          ║
// ║    2. Used to find alternatives from other supermarkets                 ║
// ║    3. Compared ingredient-by-ingredient with the best alternative       ║
// ║    4. Displayed via renderResultsDashboard()                            ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Main entry point. Call this when a barcode is scanned or typed.
 *
 * @param {string} barcode            - The product barcode (e.g. "5012345678900")
 * @param {string} selectedSupermarket - Supermarket ID ("tesco", "sainsburys", etc.)
 */
async function handleProductScan(barcode, selectedSupermarket) {
  // ── Guard: prevent re-entry while already loading ─────────────────────
  if (state.isLoading) return;
  state.isLoading = true;

  // Show the loading spinner
  showLoadingUI("Scanning product data…", "Checking multiple sources");

  try {
    // ═════════════════════════════════════════════════════════════════════
    //  PHASE A — Local Cache (browser's localStorage)
    // ═════════════════════════════════════════════════════════════════════
    //
    //  Check if we already looked up this barcode before. The cache stores
    //  a simple { barcode → productData } map. This avoids unnecessary API
    //  calls when the user re-scans the same product.

    let productData = checkLocalCache(barcode);

    if (productData) {
      console.log(
        "[AllVSame] Phase A: found in local cache →",
        productData.name,
      );
      updateLoadingUI("Using cached data", "Found in local storage");
    }

    // ═════════════════════════════════════════════════════════════════════
    //  PHASE B — Open Food Facts API (free, open public database)
    // ═════════════════════════════════════════════════════════════════════
    //
    //  Open Food Facts is a crowd-sourced database of food products from
    //  around the world. It includes ingredient lists, brands, categories,
    //  and nutrition data. The API is free and requires no key.
    //
    //  We only call this if Phase A did not find anything.

    if (!productData) {
      updateLoadingUI(
        "Phase B: querying Open Food Facts…",
        "Free public food database",
      );
      productData = await fetchFromOpenFoodFacts(barcode);

      if (productData) {
        console.log(
          "[AllVSame] Phase B: Open Food Facts found →",
          productData.name,
        );
      } else {
        console.log("[AllVSame] Phase B: Open Food Facts returned nothing");
      }
    }

    // ═════════════════════════════════════════════════════════════════════
    //  PHASE C — Apify Scraper (synchronous — we await it)
    // ═════════════════════════════════════════════════════════════════════
    //
    //  If neither the local cache nor Open Food Facts had the product, we
    //  fall back to scraping UK supermarket websites via Apify.
    //
    //  This runs synchronously in the sense that we await the result before
    //  continuing — the user sees a loading state until it completes.

    if (!productData) {
      updateLoadingUI(
        "Phase C: scraping supermarket websites…",
        "Searching via Apify",
      );

      try {
        productData = await scrapeWithApify(barcode);
      } catch (apifyErr) {
        console.warn("[AllVSame] Phase C: Apify scrape failed:", apifyErr);
        productData = null;
      }

      if (productData) {
        console.log("[AllVSame] Phase C: Apify scraped →", productData.name);
      } else {
        console.log("[AllVSame] Phase C: Apify also found nothing");
      }
    }

    // ═════════════════════════════════════════════════════════════════════
    //  HANDLE: No data found from any source
    // ═════════════════════════════════════════════════════════════════════

    if (!productData) {
      showUserFallbackUI(
        "We searched everywhere (local cache, Open Food Facts, and supermarket websites) " +
          "but could not find data for barcode <strong>" +
          escapeHtml(barcode) +
          "</strong>. " +
          "Try scanning a different product or check the barcode number.",
        "error",
      );
      state.isLoading = false;
      return;
    }

    // ═════════════════════════════════════════════════════════════════════
    //  SAVE TO SUPABASE (via saveToLocalCache)
    // ═════════════════════════════════════════════════════════════════════
    //
    //  Persist the product data to your Supabase "products" table using a
    //  POST request with the 'Prefer: resolution=merge-duplicates' header.
    //  This safely overwrites any existing row with the same barcode.

    updateLoadingUI("Saving to database…", "Updating product cache");

    try {
      await saveToLocalCache(productData);
    } catch (saveErr) {
      // Non-fatal: the app still works, just without persistence
      console.warn("[AllVSame] Could not save to Supabase:", saveErr);
    }

    // Update the browser's local cache too (for fast re-scans)
    updateLocalCache(barcode, productData);

    // ═════════════════════════════════════════════════════════════════════
    //  FIND ALTERNATIVES & COMPARE INGREDIENTS
    // ═════════════════════════════════════════════════════════════════════

    state.currentProduct = productData;

    updateLoadingUI(
      "Finding alternatives…",
      "Comparing ingredients across supermarkets",
    );

    const alternatives = await findAlternatives(
      productData,
      selectedSupermarket,
    );
    state.alternatives = alternatives;

    // ── Determine the best alternative ─────────────────────────────────
    //     Prefer one from the user-selected supermarket, otherwise pick
    //     the highest-scoring match overall.

    let bestAlt = null;
    if (alternatives.length > 0) {
      bestAlt =
        alternatives.find((a) => a.supermarket === selectedSupermarket) ||
        alternatives[0];
    }
    state.bestAlternative = bestAlt;

    // ── Calculate the ingredient match ────────────────────────────────
    let comparison = null;
    if (bestAlt) {
      comparison = calculateIngredientMatch(
        productData.ingredients || "",
        bestAlt.ingredients || "",
      );
      state.lastComparison = comparison;
    }

    // ── Add to scan history ───────────────────────────────────────────
    addToScanHistory(productData);

    // ═════════════════════════════════════════════════════════════════════
    //  RENDER THE RESULTS DASHBOARD
    // ═════════════════════════════════════════════════════════════════════

    renderResultsDashboard(productData, bestAlt, comparison);

    // Scroll the results into view
    setTimeout(() => {
      const el = DOM.results_display;
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);

    state.isLoading = false;
  } catch (err) {
    // ── Catch any unexpected error in the entire pipeline ──────────────
    console.error("[AllVSame] handleProductScan error:", err);
    showUserFallbackUI(
      "Something unexpected went wrong: <em>" +
        escapeHtml(err.message) +
        "</em>. " +
        "Please try again or refresh the page.",
      "error",
    );
    state.isLoading = false;
  }
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  7.  PHASE A — Local Cache (browser's localStorage)                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Looks up a barcode in the browser's localStorage cache.
 *
 * @param  {string} barcode - The product barcode.
 * @returns {object|null}     The cached product data, or null if not found.
 */
function checkLocalCache(barcode) {
  try {
    const stored = localStorage.getItem(LOCAL_CACHE_KEY);
    if (!stored) return null;

    const cache = JSON.parse(stored);
    return cache[barcode] || null;
  } catch (err) {
    console.warn("[AllVSame] checkLocalCache error:", err);
    return null;
  }
}

/**
 * Stores product data in the browser's localStorage cache under the
 * given barcode key. The cache persists across browser sessions.
 *
 * @param {string} barcode - The product barcode.
 * @param {object} data    - The product data object to cache.
 */
function updateLocalCache(barcode, data) {
  try {
    const stored = localStorage.getItem(LOCAL_CACHE_KEY);
    const cache = stored ? JSON.parse(stored) : {};

    cache[barcode] = data;

    // Keep only the most recent 200 entries to avoid hitting storage limits
    const keys = Object.keys(cache);
    if (keys.length > 200) {
      const oldest = keys.slice(0, keys.length - 200);
      oldest.forEach((k) => delete cache[k]);
    }

    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(cache));
  } catch (err) {
    console.warn("[AllVSame] updateLocalCache error:", err);
  }
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  8.  PHASE B — Open Food Facts API                                      ║
// ║                                                                         ║
// ║  Docs: https://world.openfoodfacts.org/api/v0/product/{barcode}.json    ║
// ║  Free, no API key required. Returns JSON with product_name, brands,     ║
// ║  ingredients_text, categories, image_url, and more.                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Fetches product data from the Open Food Facts public API.
 *
 * @param  {string} barcode - The product barcode (EAN-13 / GTIN format).
 * @returns {object|null}     A product object matching our schema, or null.
 */
async function fetchFromOpenFoodFacts(barcode) {
  const url = `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`;

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    console.warn("[AllVSame] OFF network error:", err);
    return null;
  }

  if (!response.ok) {
    console.warn("[AllVSame] OFF HTTP", response.status);
    return null;
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    console.warn("[AllVSame] OFF JSON parse error:", err);
    return null;
  }

  // The OFF API returns { status: 1, product: { ... } } when found
  if (!json || json.status !== 1 || !json.product) {
    return null;
  }

  const p = json.product;

  // Extract the ingredients text — OFF stores it in a language-keyed
  // object like { "en": "Water, Sugar, ..." }. We try the "en" key
  // first, then fall back to any language's value.
  let ingredientsText = "";
  if (typeof p.ingredients_text === "string") {
    ingredientsText = p.ingredients_text;
  } else if (p.ingredients_text && typeof p.ingredients_text === "object") {
    ingredientsText =
      p.ingredients_text.en || Object.values(p.ingredients_text)[0] || "";
  }

  // Map the OFF response into our internal product schema
  return {
    barcode: barcode,
    name: p.product_name || `Product ${barcode}`,
    brand: p.brands || "Unknown Brand",
    supermarket: "unknown", // OFF doesn't specify a supermarket
    category: p.categories || "Unknown",
    ingredients: ingredientsText || "",
    price: null, // OFF doesn't provide prices
    image_url: p.image_url || "",
    source: "openfoodfacts", // tells us where this came from
  };
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  9.  PHASE C — Apify Scraper                                            ║
// ║                                                                         ║
// ║  Runs synchronously (awaited) to scrape UK supermarket product pages.   ║
// ║  Falls back gracefully — returns null if anything fails.                ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Attempts to scrape product data from UK supermarket websites via Apify.
 *
 * @param  {string} barcode - The product barcode.
 * @returns {object|null}     A product object, or null if scraping failed.
 */
async function scrapeWithApify(barcode) {
  console.log("[AllVSame] Apify: scraping for barcode", barcode);

  // Generic Apify Web Scraper actor ID.
  // Replace with a supermarket-specific actor for better results:
  //   Tesco:      jancurn/tesco-product-scraper
  //   Sainsburys: drobnikj/sainsburys-scraper
  //   Asda:       drobnikj/asda-scraper
  //   Morrisons:  drobnikj/morrisons-scraper
  const APIFY_ACTOR_ID = "aYG0l9s7dbB7j3gbS";

  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_TOKEN}`;

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

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.warn("[AllVSame] Apify network error:", err);
    return null;
  }

  if (!response.ok) {
    console.warn("[AllVSame] Apify HTTP", response.status);
    return null;
  }

  let result;
  try {
    result = await response.json();
  } catch (err) {
    console.warn("[AllVSame] Apify JSON error:", err);
    return null;
  }

  // Parse the first item from the scraped dataset
  if (result && result.data && result.data.length > 0) {
    const scraped = result.data[0];

    return {
      barcode: barcode,
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

  return null;
}

/**
 * Tries to determine which supermarket a URL belongs to.
 * @param {string} url - The product page URL from Apify.
 * @returns {string} Supermarket ID key.
 */
function inferSupermarketFromUrl(url) {
  const u = url.toLowerCase();
  if (u.includes("tesco")) return "tesco";
  if (u.includes("sainsburys")) return "sainsburys";
  if (u.includes("asda")) return "asda";
  if (u.includes("morrisons")) return "morrisons";
  return "tesco"; // best guess
}

/**
 * Best-effort extraction of ingredient text from scraped data.
 * Tries several common field names that Apify scrapers may use.
 *
 * @param {object} scraped - Raw Apify output item.
 * @returns {string} Extracted ingredient text, or empty string.
 */
function extractIngredientsFromScraped(scraped) {
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
// ║  10.  SUPABASE PERSISTENCE — saveToLocalCache()                          ║
// ║                                                                          ║
// ║  POSTs product data to your Supabase "products" table with the           ║
// ║  'Prefer: resolution=merge-duplicates' header. This tells PostgREST      ║
// ║  (the REST API behind Supabase) to treat the barcode column as a         ║
// ║  conflict target and merge the new data into the existing row instead    ║
// ║  of throwing a duplicate-key error.                                      ║
// ║                                                                          ║
// ║  NOTE: Your "products" table MUST have a UNIQUE constraint on the         ║
// ║  "barcode" column for merge-duplicates to work.                          ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Saves (or overwrites) a product record in Supabase using a POST request
 * with the 'Prefer: resolution=merge-duplicates' header.
 *
 * @param {object} product - The product data object to persist.
 * @returns {Promise<boolean>} true on success, false on failure.
 */
async function saveToLocalCache(product) {
  // If the Supabase client wasn't initialised, we skip the save.
  // The app still works — it just won't persist to Supabase.
  if (!supabase) {
    console.log(
      "[AllVSame] Supabase not available — skipping saveToLocalCache",
    );
    return false;
  }

  try {
    // Build a clean record that matches the expected "products" table schema.
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

    // We use the Supabase JS client's upsert() method, which internally
    // sends a POST request with 'Prefer: resolution=merge-duplicates'.
    //
    // The "onConflict" option tells it which column has the unique constraint.
    const { error } = await supabase
      .from("products")
      .upsert(record, { onConflict: "barcode" });

    if (error) {
      console.warn("[AllVSame] saveToLocalCache upsert error:", error);
      return false;
    }

    console.log("[AllVSame] Product saved to Supabase:", product.barcode);
    return true;
  } catch (err) {
    console.warn("[AllVSame] saveToLocalCache exception:", err);
    return false;
  }
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  11.  INGREDIENT COMPARISON ENGINE                                      ║
// ║                                                                         ║
// ║  Uses Jaccard similarity coefficient to measure how closely two         ║
// ║  ingredient lists match. The algorithm:                                 ║
// ║                                                                         ║
// ║    1. Parse each ingredient string into individual items                ║
// ║    2. Normalise each item:                                              ║
// ║       - Convert to lowercase                                         ║
// ║       - Strip content inside brackets/parentheses                   ║
// ║       - Remove punctuation and filler marketing words               ║
// ║       - Trim whitespace                                             ║
// ║       - Discard empty or trivial items                              ║
// ║    3. Compute |intersection| / |union| × 100                        ║
// ║    4. Also compute brand-match ratio: % of brand's ingredients      ║
// ║       that appear in the alternative                                ║
// ╚══════════════════════════════════════════════════════════════════════╝

/**
 * Normalises a single ingredient string by:
 *   - Lowercasing
 *   - Removing parenthetical notes like "(1%)", "(May contain traces of nuts)"
 *   - Stripping punctuation (commas, periods, quotes, angle brackets)
 *   - Removing common filler marketing adjectives
 *   - Trimming excess whitespace
 *
 * @param {string} text - A raw ingredient name.
 * @returns {string}     The clean, normalised ingredient name.
 */
function normalizeIngredient(text) {
  if (!text || typeof text !== "string") return "";

  // Step 1 — Lowercase
  let t = text.toLowerCase();

  // Step 2 — Remove content in parentheses and brackets, including the brackets
  //          e.g. "Salt (1%)"       → "Salt"
  //          e.g. "Milk [contains]" → "Milk"
  t = t.replace(/\([^)]*\)/g, "");
  t = t.replace(/\[[^\]]*\]/g, "");

  // Step 3 — Strip punctuation characters that add no meaning
  t = t.replace(/[<>"'.,;:!?™®]/g, "");

  // Step 4 — Remove common filler / marketing adjectives.
  //          These words add no chemical meaning and inflate the match score.
  //          We remove them as whole words (surrounded by word boundaries).
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
    " rustic",
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

  // Build a regex that matches any of the filler words as whole tokens.
  // The (^|\\s) and (\\s|$) ensure we only match whole words.
  const fillerRegex = new RegExp(
    "(^|\\s)(" + fillerWords.join("|") + ")(?=\\s|$)",
    "gi",
  );
  t = t.replace(fillerRegex, " ");

  // Step 5 — Collapse multiple spaces into one and trim
  t = t.replace(/\s+/g, " ").trim();

  return t;
}

/**
 * Splits a raw ingredient string on commas and normalises each item.
 *
 * @param {string} str - Raw ingredient list, e.g. "Water, Sugar, Salt (1%)"
 * @returns {string[]}  Array of normalised ingredient names.
 */
function parseIngredients(str) {
  if (!str || typeof str !== "string") return [];

  const items = str
    .split(",")
    .map((item) => normalizeIngredient(item))
    .filter((item) => item.length > 1); // discard single characters

  // Deduplicate within the same list (some products list the same ingredient
  // in multiple forms)
  return [...new Set(items)];
}

/**
 * Calculates the ingredient match percentage between two products using
 * the Jaccard similarity coefficient.
 *
 * Result includes:
 *   percentage       - Overall Jaccard similarity (0–100)
 *   brandMatchRatio  - % of the brand product's ingredients found in the alt
 *   matching         - Ingredients present in BOTH products
 *   differingA       - Ingredients ONLY in the brand product
 *   differingB       - Ingredients ONLY in the alternative product
 *
 * @param {string} ingredientsA - Ingredient list from the brand (scanned) product.
 * @param {string} ingredientsB - Ingredient list from the alternative product.
 * @returns {{ percentage: number, brandMatchRatio: number, matching: string[], differingA: string[], differingB: string[] }}
 */
function calculateIngredientMatch(ingredientsA, ingredientsB) {
  const listA = parseIngredients(ingredientsA);
  const listB = parseIngredients(ingredientsB);

  // ── Edge cases ──────────────────────────────────────────────────────────
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

  // Intersection: ingredients that appear in both products
  const intersection = new Set([...setA].filter((x) => setB.has(x)));

  // Union: every unique ingredient across both products
  const union = new Set([...setA, ...setB]);

  // Jaccard coefficient = size of intersection / size of union
  const jaccard = intersection.size / union.size;

  // Brand-match ratio: how many of the brand's ingredients the alternative shares
  const brandMatchRatio = intersection.size / setA.size;

  return {
    percentage: Math.round(jaccard * 100),
    brandMatchRatio: Math.round(brandMatchRatio * 100),
    matching: [...intersection].sort(),
    differingA: [...setA].filter((x) => !setB.has(x)).sort(),
    differingB: [...setB].filter((x) => !setA.has(x)).sort(),
  };
}

/**
 * Returns the match threshold config for a given percentage score.
 *
 * Thresholds:
 *   ≥95%  → "Near Match"      (green)
 *   ≥80%  → "Very Similar"    (teal)
 *   ≥60%  → "Similar"         (amber)
 *   <60%  → "Different"       (red)
 *
 * @param {number} percentage - Match score (0–100).
 * @returns {{ label: string, icon: string, badgeClass: string, barColor: string }}
 */
function getMatchThreshold(percentage) {
  if (percentage >= 95)
    return {
      label: "Near Match",
      icon: "🟢",
      badgeClass: "bg-emerald-500 text-white",
      barColor: "#10b981",
    };
  if (percentage >= 80)
    return {
      label: "Very Similar",
      icon: "🔵",
      badgeClass: "bg-teal-500 text-white",
      barColor: "#14b8a6",
    };
  if (percentage >= 60)
    return {
      label: "Similar",
      icon: "🟡",
      badgeClass: "bg-amber-500 text-white",
      barColor: "#f59e0b",
    };
  return {
    label: "Different",
    icon: "🔴",
    badgeClass: "bg-red-500 text-white",
    barColor: "#ef4444",
  };
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  12.  FIND ALTERNATIVES                                                  ║
// ║                                                                          ║
// ║  Looks for products in the same category from other supermarkets.        ║
// ║  Queries both Supabase (if available) and the local cache.               ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Searches for alternative products that share the same category as the
 * scanned product but come from a different supermarket.
 *
 * Results are scored by ingredient similarity and sorted best-first.
 *
 * @param {object} product            - The scanned product.
 * @param {string} preferredSupermarket - The user's selected supermarket ID.
 * @returns {Promise<object[]>} Array of alternative product objects, each
 *                              with a _match property containing the comparison.
 */
async function findAlternatives(product, preferredSupermarket) {
  const alternatives = [];

  // ── Option 1: Query Supabase for same-category products ──────────────
  if (supabase && product.category && product.category !== "Unknown") {
    try {
      const { data: rows, error } = await supabase
        .from("products")
        .select("*")
        .eq("category", product.category)
        .neq("barcode", product.barcode)
        .limit(20);

      if (!error && rows && rows.length > 0) {
        rows.forEach((r) => alternatives.push(r));
      }
    } catch (err) {
      console.warn("[AllVSame] Supabase alternatives query failed:", err);
    }
  }

  // ── Option 2: Check the browser's local cache for same-category items ─
  try {
    const stored = localStorage.getItem(LOCAL_CACHE_KEY);
    if (stored) {
      const cache = JSON.parse(stored);
      Object.values(cache).forEach((cached) => {
        // Skip the scanned product itself
        if (cached.barcode === product.barcode) return;

        // Match by category if both have one
        if (
          product.category &&
          product.category !== "Unknown" &&
          cached.category &&
          cached.category.toLowerCase() === product.category.toLowerCase()
        ) {
          // Avoid duplicates from Supabase results
          if (!alternatives.some((a) => a.barcode === cached.barcode)) {
            alternatives.push(cached);
          }
        }
      });
    }
  } catch (err) {
    console.warn("[AllVSame] Local cache alternatives scan failed:", err);
  }

  // ── Score each candidate by ingredient similarity ────────────────────
  alternatives.forEach((alt) => {
    alt._match = calculateIngredientMatch(
      product.ingredients || "",
      alt.ingredients || "",
    );
  });

  // ── Sort: best match first, then lowest price ────────────────────────
  alternatives.sort((a, b) => {
    const scoreA = a._match?.percentage || 0;
    const scoreB = b._match?.percentage || 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (a.price || Infinity) - (b.price || Infinity);
  });

  return alternatives;
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  13.  UI RENDERERS                                                       ║
// ║                                                                          ║
// ║  renderResultsDashboard() — Builds the complete results view inside      ║
// ║                              the <div id="results-display"> element.      ║
// ║                                                                           ║
// ║  showUserFallbackUI()     — Shows an error or informational alert card     ║
// ║                              inside the <div id="results-display"> element.║
// ║                                                                           ║
// ║  Both functions use Tailwind CSS classes for a clean, modern look.        ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

/**
 * Hides all major sections: idle, loading, error, and results display.
 */
function hideAllSections() {
  if (DOM.idle_state) DOM.idle_state.classList.add("hidden");
  if (DOM.loading_state) DOM.loading_state.classList.add("hidden");
  if (DOM.error_state) DOM.error_state.classList.add("hidden");
}

/**
 * Shows the idle (ready-to-scan) state and clears the results display.
 */
function showIdleState() {
  hideAllSections();
  if (DOM.idle_state) DOM.idle_state.classList.remove("hidden");
  if (DOM.results_display) DOM.results_display.innerHTML = "";
}

/**
 * Shows the loading spinner with custom messages.
 * @param {string} title   - Main loading text.
 * @param {string} subtext - Secondary description.
 */
function showLoadingUI(title, subtext) {
  hideAllSections();
  if (DOM.loading_state) DOM.loading_state.classList.remove("hidden");
  if (DOM.loading_text) DOM.loading_text.textContent = title;
  if (DOM.loading_subtext) DOM.loading_subtext.textContent = subtext;
}

/**
 * Updates the loading text without hiding/re-showing the section.
 * @param {string} title   - New main text.
 * @param {string} subtext - New secondary text.
 */
function updateLoadingUI(title, subtext) {
  if (DOM.loading_text) DOM.loading_text.textContent = title;
  if (DOM.loading_subtext) DOM.loading_subtext.textContent = subtext;
}

/**
 * Shows the error state with a custom title and message.
 * @param {string} title   - Error heading.
 * @param {string} message - Error description.
 */
function showErrorState(title, message) {
  hideAllSections();
  if (DOM.error_state) DOM.error_state.classList.remove("hidden");
  if (DOM.error_title) DOM.error_title.textContent = title;
  if (DOM.error_message) DOM.error_message.textContent = message;
}

// ── MATCH THRESHOLD COLOURS (used by renderResultsDashboard) ──────────────

const MATCH_COLORS = {
  emerald: {
    bg: "bg-emerald-50 border-emerald-200",
    text: "text-emerald-800",
    dot: "bg-emerald-500",
  },
  teal: {
    bg: "bg-teal-50 border-teal-200",
    text: "text-teal-800",
    dot: "bg-teal-500",
  },
  amber: {
    bg: "bg-amber-50 border-amber-200",
    text: "text-amber-800",
    dot: "bg-amber-500",
  },
  red: {
    bg: "bg-red-50 border-red-200",
    text: "text-red-800",
    dot: "bg-red-500",
  },
};

/**
 * Picks the right colour scheme for a given match percentage.
 */
function matchColorScheme(pct) {
  if (pct >= 95) return MATCH_COLORS.emerald;
  if (pct >= 80) return MATCH_COLORS.teal;
  if (pct >= 60) return MATCH_COLORS.amber;
  return MATCH_COLORS.red;
}

/**
 * Renders the full results dashboard inside the <div id="results-display"> element.
 *
 * Builds the view as clean Tailwind CSS cards showing:
 *   - Scanned product card
 *   - Match badge & percentage
 *   - Alternative product card with savings callout
 *   - Ingredient comparison (match bar + matching/differing lists)
 *   - Price comparison table
 *   - Action buttons (Scan Another, View All Alternatives)
 *
 * @param {object} product    - The scanned (brand) product.
 * @param {object|null} alt   - The best alternative product (null if none found).
 * @param {object|null} comp  - Comparison result from calculateIngredientMatch().
 */
function renderResultsDashboard(product, alt, comp) {
  hideAllSections();

  const el = DOM.results_display;
  if (!el) return;

  el.classList.remove("hidden");
  el.className = "space-y-4 animate-slide-up";

  // ══════════════════════════════════════════════════════════════════════
  //  BUILD THE HTML
  // ══════════════════════════════════════════════════════════════════════

  let html = "";

  // ── Scanned Product Card ─────────────────────────────────────────────
  html += renderProductCardHtml(product, "Scanned Product", "📷");

  // ── Match Badge & Alternative (if we found one) ──────────────────────
  if (alt && comp) {
    const pct = comp.percentage;
    const th = getMatchThreshold(pct);
    const cs = matchColorScheme(pct);
    const savings = (product.price || 0) - (alt.price || 0);

    // Match Badge
    html += `
      <div class="flex justify-center animate-fade-in">
        <div class="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold shadow-md backdrop-blur-sm transition-all duration-300 ${th.badgeClass}">
          <span class="text-lg">${th.icon}</span>
          <span>${th.label}</span>
          <span class="text-base">${pct}%</span>
        </div>
      </div>
    `;

    // Alternative Product Card
    html += renderProductCardHtml(alt, "Best Alternative", "🛒", "emerald");

    // Savings Callout
    if (savings > 0) {
      html += `
        <div class="bg-emerald-50 border border-emerald-200 rounded-2xl px-5 py-4 flex items-center gap-3 animate-fade-in">
          <span class="text-2xl">💰</span>
          <div>
            <p class="text-xs font-bold text-emerald-700 uppercase tracking-wider">You could save</p>
            <p class="text-lg font-extrabold text-emerald-600">${formatPrice(savings)}</p>
          </div>
        </div>
      `;
    }

    // ── Ingredient Comparison Section ──────────────────────────────────
    html += `
      <div class="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden animate-fade-in">
        <div class="px-4 py-3 border-b border-slate-100">
          <h3 class="text-sm font-bold text-slate-700 flex items-center gap-1.5">
            <span>🧪</span> Ingredient Comparison
          </h3>
        </div>

        <!-- Match Score Bar -->
        <div class="px-4 py-3 border-b border-slate-50">
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-xs font-medium text-slate-500">Match Score</span>
            <span class="text-sm font-bold text-slate-700">${pct}%</span>
          </div>
          <div class="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all duration-700 ease-out" style="width:${pct}%;background-color:${th.barColor}"></div>
          </div>
          <div class="flex justify-between mt-1 text-[0.6rem] text-slate-400">
            <span>Brand product: ${comp.differingA.length} unique</span>
            <span>${comp.matching.length} shared</span>
            <span>Alternative: ${comp.differingB.length} unique</span>
          </div>
        </div>

        <!-- Ingredient Tags -->
        <div class="px-4 py-3 space-y-3">
    `;

    // Matching ingredients
    if (comp.matching.length > 0) {
      html += `
        <div>
          <p class="text-[0.65rem] font-semibold uppercase tracking-wider text-emerald-600 mb-1.5 flex items-center gap-1">
            <span>✅</span> Identical Ingredients
            <span class="ml-auto text-xs font-normal text-slate-400">${comp.matching.length} items</span>
          </p>
          <div class="flex flex-wrap gap-1">
            ${comp.matching.map((i) => `<span class="ingredient-tag bg-emerald-100 text-emerald-800">${escapeHtml(i)}</span>`).join("")}
          </div>
        </div>
      `;
    }

    // Differing (brand product only)
    if (comp.differingA.length > 0) {
      html += `
        <div>
          <p class="text-[0.65rem] font-semibold uppercase tracking-wider text-amber-600 mb-1.5 flex items-center gap-1">
            <span>⚠️</span> Only in Brand Product
            <span class="ml-auto text-xs font-normal text-slate-400">${comp.differingA.length} items</span>
          </p>
          <div class="flex flex-wrap gap-1">
            ${comp.differingA.map((i) => `<span class="ingredient-tag bg-amber-100 text-amber-800">${escapeHtml(i)}</span>`).join("")}
          </div>
        </div>
      `;
    }

    // Differing (alternative only)
    if (comp.differingB.length > 0) {
      html += `
        <div>
          <p class="text-[0.65rem] font-semibold uppercase tracking-wider text-blue-600 mb-1.5 flex items-center gap-1">
            <span>ℹ️</span> Only in Alternative
            <span class="ml-auto text-xs font-normal text-slate-400">${comp.differingB.length} items</span>
          </p>
          <div class="flex flex-wrap gap-1">
            ${comp.differingB.map((i) => `<span class="ingredient-tag bg-blue-100 text-blue-800">${escapeHtml(i)}</span>`).join("")}
          </div>
        </div>
      `;
    }

    html += `</div></div>`; // close ingredient comparison

    // ── Price Comparison ───────────────────────────────────────────────
    if (product.price != null || alt.price != null) {
      const brandPrice =
        product.price != null ? formatPrice(product.price) : "£—";
      const altPrice = alt.price != null ? formatPrice(alt.price) : "£—";
      const savingsAmt = formatPrice(Math.max(savings, 0));

      html += `
        <div class="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 animate-fade-in">
          <h3 class="text-sm font-bold text-slate-700 mb-3 flex items-center gap-1.5">
            <span>💷</span> Price Comparison
          </h3>
          <div class="space-y-2">
            <div class="flex items-center justify-between text-sm py-2 border-b border-slate-50">
              <span class="text-slate-600 font-medium">${escapeHtml(product.name || "Brand Product")}</span>
              <span class="font-bold text-slate-800">${brandPrice}</span>
            </div>
            <div class="flex items-center justify-between text-sm py-2 border-b border-slate-50">
              <span class="text-slate-600 font-medium">${escapeHtml(alt.name || "Alternative")}</span>
              <span class="font-bold text-emerald-600">${altPrice}</span>
            </div>
            <div class="flex items-center justify-between text-sm py-2 bg-emerald-50 rounded-xl px-3 -mx-1">
              <span class="font-bold text-emerald-700">Savings</span>
              <span class="font-extrabold text-emerald-600">${savingsAmt}</span>
            </div>
          </div>
        </div>
      `;
    }

    // ── Action Buttons ─────────────────────────────────────────────────
    html += `
      <div class="flex gap-3 pt-1">
        <button id="scan-another-btn" class="flex-1 bg-brand-600 hover:bg-brand-700 active:scale-95 text-white font-bold text-sm py-3 rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-brand-400 shadow-lg shadow-brand-600/20">
          Scan Another
        </button>
        <button id="view-alt-list-btn" class="flex-1 bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-700 font-semibold text-sm py-3 rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-brand-400">
          ${state.alternatives.length > 0 ? "View All Alternatives" : "Scan Another"}
        </button>
      </div>
    `;

    // ── All Alternatives List (hidden initially) ───────────────────────
    if (state.alternatives.length > 1) {
      html += `
        <div id="all-alternatives" class="hidden space-y-2 animate-slide-up">
          <h3 class="text-sm font-bold text-slate-700 flex items-center gap-1.5">
            <span>📋</span> All Alternatives Found
          </h3>
          <div id="alternatives-list" class="space-y-2">
            ${state.alternatives.map((a) => renderAltListItem(a, product)).join("")}
          </div>
        </div>
      `;
    }
  } else {
    // ── No alternative found ──────────────────────────────────────────
    html += `
      <div class="bg-amber-50 border border-amber-200 rounded-2xl p-5 text-center animate-fade-in">
        <span class="text-3xl">🔍</span>
        <p class="text-sm font-bold text-amber-800 mt-2">No Alternatives Found</p>
        <p class="text-xs text-amber-600 mt-1 leading-relaxed">
          We couldn't find any products with similar ingredients in other supermarkets.
          Check back later as our database grows.
        </p>
        <button id="scan-another-btn" class="mt-4 text-sm font-semibold text-brand-600 bg-brand-50 hover:bg-brand-100 active:scale-95 px-6 py-2.5 rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-brand-400">
          Scan Another Product
        </button>
      </div>
    `;
  }

  // ── Inject the HTML ─────────────────────────────────────────────────
  el.innerHTML = html;

  // ── Re-bind event listeners for dynamic buttons ─────────────────────
  const scanBtn = document.getElementById("scan-another-btn");
  if (scanBtn) scanBtn.addEventListener("click", resetForNewScan);

  const viewAltBtn = document.getElementById("view-alt-list-btn");
  if (viewAltBtn) {
    viewAltBtn.addEventListener("click", () => {
      const list = document.getElementById("all-alternatives");
      if (list) {
        list.classList.toggle("hidden");
        viewAltBtn.textContent = list.classList.contains("hidden")
          ? "View All Alternatives"
          : "Hide Alternatives";
      }
    });
  }

  // ── Show the display ────────────────────────────────────────────────
  el.classList.remove("hidden");
}

/**
 * Renders a single product card as HTML.
 *
 * @param {object} product    - Product data.
 * @param {string} label      - Label text (e.g. "Scanned Product").
 * @param {string} fallbackEmoji - Emoji to show when no image is available.
 * @param {string} [accent]   - Tailwind accent colour key (default: "brand").
 * @returns {string} HTML string.
 */
function renderProductCardHtml(product, label, fallbackEmoji, accent) {
  const accentText =
    accent === "emerald" ? "text-emerald-600" : "text-brand-600";
  const superInfo = product.supermarket
    ? SUPERMARKETS[product.supermarket]?.name || product.supermarket
    : "Price comparison unavailable";

  const imageHtml = product.image_url
    ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.name || "Product")}" class="w-full h-full object-cover" onerror="this.parentElement.innerHTML='${fallbackEmoji}'" />`
    : fallbackEmoji;

  return `
    <div class="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 animate-fade-in">
      <div class="flex items-start gap-3">
        <div class="w-16 h-16 rounded-xl bg-slate-100 flex-shrink-0 overflow-hidden flex items-center justify-center text-2xl">
          ${imageHtml}
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-[0.65rem] font-semibold uppercase tracking-wider text-slate-400">${escapeHtml(label)}</p>
          <h3 class="text-base font-bold text-slate-800 truncate">${escapeHtml(product.name || "Unknown Product")}</h3>
          <p class="text-xs text-slate-500 truncate">${escapeHtml(product.brand || "")}${product.brand && superInfo ? " · " : ""}${escapeHtml(superInfo)}</p>
          <p class="text-sm font-bold ${accentText} mt-1">${product.price != null ? formatPrice(product.price) : "Price N/A"}</p>
        </div>
      </div>
    </div>
  `;
}

/**
 * Renders a single alternative as a compact list-item row.
 *
 * @param {object} alt      - Alternative product (with _match property).
 * @param {object} brandProduct - The original scanned product.
 * @returns {string} HTML string.
 */
function renderAltListItem(alt, brandProduct) {
  const pct = alt._match?.percentage || 0;
  const th = getMatchThreshold(pct);
  const savings = (brandProduct.price || 0) - (alt.price || 0);

  return `
    <div class="bg-white rounded-xl border border-slate-100 p-3 flex items-center gap-3">
      <div class="w-12 h-12 rounded-lg bg-slate-100 flex-shrink-0 flex items-center justify-center text-lg overflow-hidden">
        ${
          alt.image_url
            ? `<img src="${escapeHtml(alt.image_url)}" alt="" class="w-full h-full object-cover" onerror="this.parentElement.innerHTML='🛒'" />`
            : "🛒"
        }
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-semibold text-slate-800 truncate">${escapeHtml(alt.name || "Unknown")}</p>
        <p class="text-xs text-slate-400 truncate">${escapeHtml(alt.brand || "")}${alt.brand && alt.supermarket ? " · " : ""}${SUPERMARKETS[alt.supermarket]?.name || ""}</p>
        <div class="flex items-center gap-2 mt-0.5">
          <span class="text-xs font-bold ${savings > 0 ? "text-emerald-600" : "text-slate-500"}">${alt.price != null ? formatPrice(alt.price) : "—"}</span>
          <span class="text-[0.6rem] font-semibold px-1.5 py-0.5 rounded-full ${th.badgeClass}">${th.icon} ${pct}%</span>
          ${savings > 0 ? `<span class="text-[0.6rem] font-bold text-emerald-600">Save ${formatPrice(savings)}</span>` : ""}
        </div>
      </div>
    </div>
  `;
}

/**
 * Shows a user-friendly fallback UI (error / info / success) inside
 * the <div id="results-display"> element using a Tailwind CSS alert card.
 *
 * @param {string} message - The message to display. HTML is allowed for
 *                           basic formatting (bold, italics).
 * @param {'error'|'info'|'success'} type - The type of alert to show.
 */
function showUserFallbackUI(message, type) {
  hideAllSections();

  const el = DOM.results_display;
  if (!el) return;

  const styles = {
    error: {
      border: "border-red-200",
      bg: "bg-red-50",
      icon: "⚠️",
      title: "red-700",
      text: "red-600",
    },
    info: {
      border: "border-blue-200",
      bg: "bg-blue-50",
      icon: "ℹ️",
      title: "blue-700",
      text: "blue-600",
    },
    success: {
      border: "border-emerald-200",
      bg: "bg-emerald-50",
      icon: "✅",
      title: "emerald-700",
      text: "emerald-600",
    },
  };

  const s = styles[type] || styles.info;

  el.className = "animate-fade-in";
  el.innerHTML = `
    <div class="${s.bg} border ${s.border} rounded-2xl p-5 text-center shadow-sm">
      <div class="w-12 h-12 rounded-full bg-white/80 flex items-center justify-center mx-auto mb-3 shadow-sm">
        <span class="text-2xl">${s.icon}</span>
      </div>
      <p class="text-sm font-bold text-${s.title}">${type === "error" ? "Something went wrong" : type === "success" ? "Success" : "Heads up"}</p>
      <p class="text-xs text-${s.text} mt-1.5 leading-relaxed">${message}</p>
      <button id="fallback-retry-btn" class="mt-4 text-sm font-semibold text-brand-600 bg-white hover:bg-brand-50 active:scale-95 px-6 py-2.5 rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-brand-400 border border-slate-200">
        Try Again
      </button>
    </div>
  `;

  el.classList.remove("hidden");

  // Bind the retry button to reset
  const retryBtn = document.getElementById("fallback-retry-btn");
  if (retryBtn) retryBtn.addEventListener("click", resetForNewScan);
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  14.  SCAN HISTORY                                                       ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Loads the scan history array from localStorage.
 */
function loadScanHistory() {
  try {
    const stored = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (stored) state.scanHistory = JSON.parse(stored);
  } catch (err) {
    console.warn("[AllVSame] Could not load scan history:", err);
    state.scanHistory = [];
  }
}

/**
 * Adds a product to the front of the scan history (deduplicated by barcode).
 * Persists to localStorage. Keeps at most 50 entries.
 *
 * @param {object} product - The scanned product.
 */
function addToScanHistory(product) {
  // Remove existing entry for the same barcode (if any)
  const idx = state.scanHistory.findIndex((p) => p.barcode === product.barcode);
  if (idx !== -1) state.scanHistory.splice(idx, 1);

  // Add to front
  state.scanHistory.unshift({
    barcode: product.barcode,
    name: product.name,
    brand: product.brand,
    supermarket: product.supermarket,
    price: product.price,
    image_url: product.image_url,
    scannedAt: new Date().toISOString(),
  });

  // Trim to 50 entries
  if (state.scanHistory.length > 50) {
    state.scanHistory = state.scanHistory.slice(0, 50);
  }

  // Persist
  try {
    localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify(state.scanHistory),
    );
  } catch (err) {
    console.warn("[AllVSame] Could not save scan history:", err);
  }
}

/**
 * Renders the scan history panel with clickable items.
 */
function renderScanHistory() {
  if (!DOM.history_list) return;

  if (state.scanHistory.length === 0) {
    DOM.history_list.innerHTML = `
      <div class="flex flex-col items-center justify-center py-12 text-slate-400">
        <span class="text-3xl mb-2">🕐</span>
        <p class="text-sm font-medium">No scans yet</p>
        <p class="text-xs mt-0.5">Scan a product to see it here</p>
      </div>
    `;
    return;
  }

  DOM.history_list.innerHTML = state.scanHistory
    .slice(0, 20)
    .map(
      (item) => `
      <div class="flex items-center gap-3 py-2.5 border-b border-slate-50 cursor-pointer hover:bg-slate-50 rounded-lg px-2 transition-colors" data-barcode="${escapeHtml(item.barcode)}">
        <div class="w-10 h-10 rounded-lg bg-slate-100 flex-shrink-0 flex items-center justify-center text-base overflow-hidden">
          ${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="" class="w-full h-full object-cover" />` : "🏷️"}
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold text-slate-700 truncate">${escapeHtml(item.name || "Unknown")}</p>
          <p class="text-xs text-slate-400 truncate">${escapeHtml(item.brand || "")}${item.brand && item.supermarket ? " · " : ""}${SUPERMARKETS[item.supermarket]?.name || ""}</p>
        </div>
        <span class="text-xs text-slate-400 font-medium">${item.price != null ? formatPrice(item.price) : ""}</span>
      </div>
    `,
    )
    .join("");

  // Bind click to re-scan
  DOM.history_list.querySelectorAll("[data-barcode]").forEach((el) => {
    el.addEventListener("click", () => {
      const bc = el.getAttribute("data-barcode");
      if (bc) {
        closePanel("history");
        handleProductScan(bc, state.selectedSupermarket);
      }
    });
  });
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  15.  UI UTILITIES                                                       ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Formats a number as GBP (pounds sterling).
 * @param {number} value - The numeric price.
 * @returns {string} e.g. "£1.50" or "£—" when null/NaN.
 */
function formatPrice(value) {
  if (value == null || isNaN(value)) return "£—";
  return "£" + Number(value).toFixed(2);
}

/**
 * Escapes HTML special characters to prevent XSS attacks.
 * @param {string} text - Raw user/content text.
 * @returns {string} Safe HTML string.
 */
function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Shows a short toast notification at the bottom of the screen.
 * Auto-dismisses after 3 seconds.
 *
 * @param {string} message - The toast text.
 * @param {'info'|'success'|'error'} type - Style variant.
 */
function showToast(message, type) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const colors = {
    info: "bg-slate-800 text-white",
    success: "bg-emerald-600 text-white",
    error: "bg-red-500 text-white",
  };

  const toast = document.createElement("div");
  toast.className = `toast show fixed bottom-20 left-4 right-4 max-w-xs mx-auto z-50 px-4 py-3 rounded-xl text-sm font-medium shadow-lg ${colors[type] || colors.info}`;
  toast.style.maxWidth = "calc(480px - 2rem)";
  toast.textContent = message;
  document.getElementById("app")?.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove("show");
    toast.classList.add("hide");
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

/**
 * Opens an overlay panel (about or history).
 * @param {'about'|'history'} panel
 */
function openPanel(panel) {
  closeAllPanels();
  if (panel === "about" && DOM.about_panel) {
    DOM.about_panel.classList.remove("hidden");
  } else if (panel === "history" && DOM.history_panel) {
    DOM.history_panel.classList.remove("hidden");
    renderScanHistory();
  }
}

/**
 * Closes a specific overlay panel.
 * @param {'about'|'history'} panel
 */
function closePanel(panel) {
  if (panel === "about" && DOM.about_panel)
    DOM.about_panel.classList.add("hidden");
  if (panel === "history" && DOM.history_panel)
    DOM.history_panel.classList.add("hidden");
}

/**
 * Closes all overlay panels.
 */
function closeAllPanels() {
  if (DOM.about_panel) DOM.about_panel.classList.add("hidden");
  if (DOM.history_panel) DOM.history_panel.classList.add("hidden");
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  16.  BARCODE SCANNER (html5-qrcode)                                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Creates the scanner instance. Does not start the camera.
 */
function initScanner() {
  if (typeof Html5Qrcode === "undefined") {
    console.error("[AllVSame] html5-qrcode not loaded");
    showToast("Barcode scanner library failed to load", "error");
    return;
  }
  if (state.scanner) return;

  try {
    state.scanner = new Html5Qrcode("scanner-viewport");
  } catch (err) {
    console.error("[AllVSame] Scanner init error:", err);
    showToast("Could not initialise camera scanner", "error");
  }
}

/**
 * Starts the camera and begins barcode detection.
 */
async function startScanner() {
  if (!state.scanner) initScanner();
  if (!state.scanner || state.isScanning) return;

  try {
    DOM.scanner_placeholder.classList.add("hidden");
    DOM.scanning_dot.classList.remove("hidden");

    await state.scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 260, height: 120 }, aspectRatio: 1.33333 },
      onBarcodeDetected,
      () => {}, // squelch per-frame errors
    );

    state.isScanning = true;
    DOM.toggle_scanner_btn.textContent = "Stop Scan";
    DOM.toggle_scanner_btn.classList.remove(
      "bg-brand-600",
      "hover:bg-brand-700",
    );
    DOM.toggle_scanner_btn.classList.add("bg-red-500", "hover:bg-red-600");
    showToast("Camera active — point at a barcode", "info");
  } catch (err) {
    DOM.scanner_placeholder.classList.remove("hidden");
    DOM.scanning_dot.classList.add("hidden");
    DOM.toggle_scanner_btn.textContent = "Start Scan";

    if (
      err.toString().includes("NotAllowed") ||
      err.toString().includes("Permission")
    ) {
      showToast(
        "Camera permission denied. Allow camera access in your browser settings.",
        "error",
      );
    } else if (err.toString().includes("NotFound")) {
      showToast("No camera found on this device.", "error");
    } else {
      showToast("Camera error: " + (err.message || "unknown"), "error");
    }
  }
}

/**
 * Stops the scanner and releases the camera.
 */
async function stopScanner() {
  if (!state.scanner || !state.isScanning) return;
  try {
    await state.scanner.stop();
    state.isScanning = false;
    DOM.toggle_scanner_btn.textContent = "Start Scan";
    DOM.toggle_scanner_btn.classList.remove("bg-red-500", "hover:bg-red-600");
    DOM.toggle_scanner_btn.classList.add("bg-brand-600", "hover:bg-brand-700");
    DOM.scanner_placeholder.classList.remove("hidden");
    DOM.scanning_dot.classList.add("hidden");
  } catch (err) {
    console.error("[AllVSame] stopScanner error:", err);
  }
}

/**
 * Toggles the scanner on/off.
 */
function toggleScanner() {
  state.isScanning ? stopScanner() : startScanner();
}

/**
 * Callback when a barcode is successfully decoded.
 * Validates the barcode length, stops the scanner, and calls
 * handleProductScan().
 *
 * @param {string} decodedText - Raw barcode string.
 */
function onBarcodeDetected(decodedText) {
  if (state.isLoading) return;

  const cleaned = decodedText.trim();
  if (cleaned.length < 8 || cleaned.length > 14) return;

  console.log("[AllVSame] Barcode detected:", cleaned);
  stopScanner();

  // Call the main entry point
  handleProductScan(cleaned, state.selectedSupermarket);
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  17.  EVENT HANDLERS                                                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Wires up all event listeners after the DOM is ready.
 */
function bindEvents() {
  // ── Scanner toggle ────────────────────────────────────────
  DOM.toggle_scanner_btn?.addEventListener("click", toggleScanner);

  // ── Manual barcode search ─────────────────────────────────
  DOM.manual_search_btn?.addEventListener("click", handleManualSearch);
  DOM.manual_barcode?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleManualSearch();
  });

  // ── Supermarket selector ──────────────────────────────────
  DOM.supermarket?.addEventListener("change", (e) => {
    state.selectedSupermarket = e.target.value;

    // If results are already showing, re-render with the new supermarket
    if (state.currentProduct && state.alternatives.length > 0) {
      const preferred = state.alternatives.find(
        (a) => a.supermarket === state.selectedSupermarket,
      );
      const bestAlt = preferred || state.alternatives[0];
      state.bestAlternative = bestAlt;
      state.lastComparison = bestAlt?._match || null;
      renderResultsDashboard(
        state.currentProduct,
        bestAlt,
        state.lastComparison,
      );
    }
  });

  // ── Error state retry ─────────────────────────────────────
  DOM.error_retry_btn?.addEventListener("click", () => {
    showIdleState();
    if (DOM.manual_barcode) DOM.manual_barcode.value = "";
  });

  // ── Bottom navigation ─────────────────────────────────────
  DOM.navBtns?.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");

      if (tab === "scan") {
        closeAllPanels();
        DOM.scanner_section?.scrollIntoView({ behavior: "smooth" });
      } else if (tab === "history") {
        openPanel("history");
      } else if (tab === "about") {
        openPanel("about");
      }

      // Update active nav styling
      DOM.navBtns.forEach((b) => {
        b.querySelector("span:first-child")?.classList.remove("text-brand-600");
        b.querySelector("span:first-child")?.classList.add("text-slate-400");
        b.querySelector("span:last-child")?.classList.remove(
          "text-brand-600",
          "font-bold",
        );
        b.querySelector("span:last-child")?.classList.add(
          "text-slate-400",
          "font-semibold",
        );
      });
      if (tab === "scan") {
        btn
          .querySelector("span:first-child")
          ?.classList.remove("text-slate-400");
        btn.querySelector("span:first-child")?.classList.add("text-brand-600");
        btn
          .querySelector("span:last-child")
          ?.classList.remove("text-slate-400", "font-semibold");
        btn
          .querySelector("span:last-child")
          ?.classList.add("text-brand-600", "font-bold");
      }
    });
  });

  // ── Panel close buttons ───────────────────────────────────
  DOM.close_about_btn?.addEventListener("click", () => closePanel("about"));
  DOM.close_history_btn?.addEventListener("click", () => closePanel("history"));
}

/**
 * Reads the manual barcode input, validates it, and kicks off a scan.
 */
function handleManualSearch() {
  const input = DOM.manual_barcode;
  if (!input) return;

  let raw = input.value.trim();
  if (!raw) {
    showToast("Please enter a barcode number", "error");
    return;
  }

  // Strip non-digits
  const cleaned = raw.replace(/\D/g, "");
  if (cleaned.length < 8) {
    showToast("Barcode must be at least 8 digits", "error");
    return;
  }

  if (state.isScanning) stopScanner();
  handleProductScan(cleaned, state.selectedSupermarket);
}

/**
 * Resets the UI back to the idle state for a new scan.
 */
function resetForNewScan() {
  closeAllPanels();
  if (state.isScanning) stopScanner();

  state.currentProduct = null;
  state.alternatives = [];
  state.bestAlternative = null;
  state.lastComparison = null;
  state.isLoading = false;

  if (DOM.manual_barcode) DOM.manual_barcode.value = "";
  if (DOM.results_display) DOM.results_display.innerHTML = "";
  showIdleState();
  DOM.scanner_section?.scrollIntoView({ behavior: "smooth" });
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  18.  INITIALISATION                                                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Application entry point — called once the DOM is ready.
 */
function initApp() {
  console.log("[AllVSame] Initialising…");

  cacheDomRefs();
  initSupabase();
  initScanner();
  loadScanHistory();
  bindEvents();
  showIdleState();

  console.log("[AllVSame] Application ready");
}

// Start the app once the DOM is fully loaded
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTimeout(initApp, 100));
} else {
  setTimeout(initApp, 100);
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  19.  DEBUGGING HELPERS                                                  ║
// ║                                                                          ║
// ║  Exposed on window.avs so you can test from the browser console:         ║
// ║                                                                           ║
// ║    window.avs.lookup("5012345678900")   — manual barcode lookup            ║
// ║    window.avs.compare("a, b, c", "a, d") — test ingredient comparison      ║
// ║    window.avs.reset()                   — reset the UI                     ║
// ║    window.avs.state                     — view the full app state          ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

if (typeof window !== "undefined") {
  window.avs = {
    lookup: (barcode) => {
      if (barcode)
        handleProductScan(
          barcode.replace(/\D/g, ""),
          state.selectedSupermarket,
        );
    },
    compare: (ingA, ingB) => {
      const r = calculateIngredientMatch(ingA, ingB);
      console.table(r);
      return r;
    },
    reset: resetForNewScan,
    state: state,
    supabase: () => supabase,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  END OF AllVSame APPLICATION LOGIC
 * ═══════════════════════════════════════════════════════════════════════════
 */
