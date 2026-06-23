/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AllVSame — Compare product ingredients & prices across UK supermarkets
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  SECURITY ARCHITECTURE
 *  ─────────────────────
 *  This frontend contains ZERO secret tokens. All sensitive operations
 *  (Apify scraping, ingredient matching, database persistence) happen
 *  inside the Supabase Edge Function at:
 *
 *    POST https://zfhpzlgomylyfggwyeqm.supabase.co/functions/v1/verify-and-match
 *
 *  DATA FLOW:
 *    1. User scans a barcode (or types it manually)
 *    2. handleProductScan() POSTs { barcode, supermarket } to the edge function
 *    3. The edge function runs Phases A–E (cache check, OFF, Apify, match, save)
 *    4. The edge function returns { product, alternatives, bestAlternative, comparison }
 *    5. renderResultsDashboard() builds a Tailwind CSS dashboard inside
 *       the HTML element with ID "results-display"
 *
 *  PUBLIC VARIABLES (safe in client code):
 *    - SUPABASE_URL       — Project URL (public)
 *    - SUPABASE_ANON_KEY  — Public anon key (safe for client-side use)
 *
 *  SECRETS (NEVER in client code):
 *    - APIFY_TOKEN             → Deno.env on the edge function
 *    - SERVICE_ROLE_KEY        → Deno.env on the edge function
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  1.  CONFIGURATION                                                      ║
// ║     Only public-facing variables live here. All secrets are server-side. ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ── Supabase ───────────────────────────────────────────────────────────────
// Your Supabase project URL and the public anonymous (anon) API key.
// Find these in your Supabase dashboard under Project Settings → API.
// These are safe to leave in client-side code (the anon key is public).
const SUPABASE_URL = "https://zfhpzlgomylyfggwyeqm.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmaHB6bGdvbXlseWZnZ3d5ZXFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwODA0NjAsImV4cCI6MjA5NzY1NjQ2MH0.TeNO6CpmHVbC15RMMngkl_GxJDRjBB4X1ZZ9FNKYUbM";

// ── Edge Function URL ──────────────────────────────────────────────────────
// This is the secure backend that handles all data fetching and comparison.
// The APIFY_TOKEN lives inside this function's Deno environment — NEVER here.
const EDGE_FUNCTION_URL = SUPABASE_URL + "/functions/v1/verify-and-match";

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  2.  SUPERMARKET LOOKUP TABLE                                           ║
// ║     Maps internal IDs to display names, hex colours, and supermarket info.║
// ╚══════════════════════════════════════════════════════════════════════════╝

const SUPERMARKETS = {
  tesco: { name: "Tesco", hex: "#00539f" },
  sainsburys: { name: "Sainsbury's", hex: "#e2231a" },
  asda: { name: "Asda", hex: "#68c000" },
  morrisons: { name: "Morrisons", hex: "#f9a200" },
};

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  3.  APPLICATION STATE                                                  ║
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
// This is a UX optimization for instant re-scans. It is NOT a security secret.
const LOCAL_CACHE_KEY = "allvsame_local_cache";

// Key used to store the scan history in localStorage
const HISTORY_STORAGE_KEY = "allvsame_scan_history";

// Key used to remember that the user previously granted camera access.
const CAMERA_PERMISSION_KEY = "avs_camera_permission";

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  4.  DOM REFERENCES                                                      ║
// ║     Cached once after the page loads for fast lookups.                  ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const DOM = {};

/**
 * Caches references to frequently accessed DOM elements.
 * Call once after the page has loaded.
 */
function cacheDomRefs() {
  DOM.scanner_section = document.getElementById("scanner-section");
  DOM.scanner_viewport = document.getElementById("scanner-viewport");
  DOM.scanner_placeholder = document.getElementById("scanner-placeholder");
  DOM.scanning_dot = document.getElementById("scanning-dot");
  DOM.scan_line = document.getElementById("scan-line");
  DOM.toggle_scanner_btn = document.getElementById("toggle-scanner-btn");
  DOM.manual_barcode = document.getElementById("manual-barcode");
  DOM.manual_search_btn = document.getElementById("manual-search-btn");
  DOM.supermarket = document.getElementById("supermarket-select");
  DOM.results_display = document.getElementById("results-display");
  DOM.loading_state = document.getElementById("loading-state");
  DOM.loading_text = document.getElementById("loading-text");
  DOM.loading_subtext = document.getElementById("loading-subtext");
  DOM.error_state = document.getElementById("error-state");
  DOM.error_title = document.getElementById("error-title");
  DOM.error_message = document.getElementById("error-message");
  DOM.error_retry_btn = document.getElementById("error-retry-btn");
  DOM.idle_state = document.getElementById("idle-state");
  DOM.about_panel = document.getElementById("about-panel");
  DOM.close_about_btn = document.getElementById("close-about-btn");
  DOM.history_panel = document.getElementById("history-panel");
  DOM.history_list = document.getElementById("history-list");
  DOM.close_history_btn = document.getElementById("close-history-btn");
  DOM.navBtns = document.querySelectorAll(".nav-btn");
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  5.  MAIN ENTRY POINT — handleProductScan()                             ║
// ║                                                                         ║
// ║  Makes a single POST request to the secure Supabase Edge Function.       ║
// ║  The edge function handles:                                             ║
// ║    Phase A — Check Supabase product cache                               ║
// ║    Phase B — Open Food Facts API (free, no key)                         ║
// ║    Phase C — Apify scraper (using secret token from Deno.env)           ║
// ║    Phase D — Find alternatives in the same category                     ║
// ║    Phase E — Jaccard ingredient-match calculation                       ║
// ║    Save   — Upsert result to Supabase "products" table                  ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Main entry point. Call this when a barcode is scanned or typed.
 *
 * The function first checks the browser's localStorage for an instant
 * re-scan result. If not cached, it POSTs to the secure edge function
 * which runs the full pipeline server-side.
 *
 * @param {string} barcode            - The product barcode (e.g. "5012345678900")
 * @param {string} selectedSupermarket - Supermarket ID ("tesco", "sainsburys", etc.)
 */
async function handleProductScan(barcode, selectedSupermarket) {
  // ── Guard: prevent re-entry while already loading ─────────────────────
  if (state.isLoading) return;
  state.isLoading = true;

  showLoadingUI("Scanning product data…", "Checking our database");

  try {
    // ── Phase 0: Check browser's localStorage for fast re-scans ─────────
    //     This is a pure UX optimization — no secrets involved.
    let responseData = checkLocalCache(barcode);

    if (responseData) {
      console.log(
        "[AllVSame] Found in local cache →",
        responseData.product?.name,
      );
      updateLoadingUI("Using cached data", "Found in local storage");
    } else {
      // ── Phase 1: Call the secure edge function ────────────────────────
      //     All API keys, database writes, and comparison logic live here.
      updateLoadingUI("Scanning securely…", "Edge function processing");

      const edgeResponse = await fetch(EDGE_FUNCTION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          barcode: barcode,
          supermarket: selectedSupermarket,
        }),
        signal: AbortSignal.timeout(30000),
      });

      // ── Handle HTTP 429 — Rate limited ──────────────────────────────
      if (edgeResponse.status === 429) {
        const errorBody = await edgeResponse.json().catch(() => ({}));
        showUserFallbackUI(
          "You've reached the scan limit. " +
            (errorBody.message ||
              "Please wait 60 seconds before scanning again."),
          "error",
        );
        state.isLoading = false;
        return;
      }

      // ── Handle HTTP 404 — Product not found ─────────────────────────
      if (edgeResponse.status === 404) {
        const errorBody = await edgeResponse.json().catch(() => ({}));
        showUserFallbackUI(
          errorBody.message ||
            "We searched everywhere but could not find data for barcode <strong>" +
              escapeHtml(barcode) +
              "</strong>. Try a different product.",
          "error",
        );
        state.isLoading = false;
        return;
      }

      // ── Handle other HTTP errors ───────────────────────────────────
      if (!edgeResponse.ok) {
        const errorBody = await edgeResponse.json().catch(() => ({}));
        throw new Error(
          errorBody.message || `Server returned HTTP ${edgeResponse.status}`,
        );
      }

      // ── Parse the response ─────────────────────────────────────────
      responseData = await edgeResponse.json();

      // Cache the result in localStorage for instant re-scans
      updateLocalCache(barcode, responseData);
    }

    // ── Validate the response has all required fields ──────────────────
    if (!responseData || !responseData.product) {
      showUserFallbackUI(
        "The server returned incomplete data. Please try again.",
        "error",
      );
      state.isLoading = false;
      return;
    }

    const product = responseData.product;
    const alternatives = responseData.alternatives || [];
    const bestAlternative = responseData.bestAlternative || null;
    const comparison = responseData.comparison || null;

    // ── Update state ──────────────────────────────────────────────────
    state.currentProduct = product;
    state.alternatives = alternatives;
    state.bestAlternative = bestAlternative;
    state.lastComparison = comparison;

    // ── Add to scan history ───────────────────────────────────────────
    addToScanHistory(product);

    // ── Render the results dashboard ──────────────────────────────────
    renderResultsDashboard(product, bestAlternative, comparison);

    // Scroll the results into view
    setTimeout(() => {
      const el = DOM.results_display;
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);

    state.isLoading = false;
  } catch (err) {
    // ── Catch network errors, timeouts, or unexpected failures ────────

    // Detect network disconnects
    if (
      err.name === "TypeError" &&
      (err.message.includes("NetworkError") ||
        err.message.includes("Failed to fetch") ||
        err.message.includes("Load failed"))
    ) {
      showUserFallbackUI(
        "Unable to reach the server. Please check your internet connection and try again.",
        "error",
      );
    } else if (err.name === "TimeoutError" || err.name === "AbortError") {
      showUserFallbackUI(
        "The request timed out. Our servers may be busy — please try again shortly.",
        "error",
      );
    } else {
      console.error("[AllVSame] handleProductScan error:", err);
      showUserFallbackUI(
        "Something unexpected went wrong: <em>" +
          escapeHtml(err.message || "Unknown error") +
          "</em>. Please try again or refresh the page.",
        "error",
      );
    }

    state.isLoading = false;
  }
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  6.  LOCAL BROWSER CACHE (UX optimization only)                         ║
// ║     Stores recently scanned products for instant re-scan.               ║
// ║     This is client-only; no secrets are involved.                       ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Looks up a barcode in the browser's localStorage cache.
 *
 * @param  {string} barcode - The product barcode.
 * @returns {object|null}     The cached response data, or null if not found.
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
 * Stores the edge function response in the browser's localStorage cache
 * under the given barcode key. Keeps only the most recent 200 entries.
 *
 * @param {string} barcode - The product barcode.
 * @param {object} data    - The response data object to cache.
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
// ║  7.  UI STATE MANAGEMENT                                                ║
// ║     Functions to show/hide the various states of the app.               ║
// ╚══════════════════════════════════════════════════════════════════════════╝

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
 * Shows the loading spinner with a title and subtitle.
 *
 * @param {string} title   - Primary loading text.
 * @param {string} subtext - Secondary loading text.
 */
function showLoadingUI(title, subtext) {
  hideAllSections();
  if (DOM.loading_state) DOM.loading_state.classList.remove("hidden");
  if (DOM.loading_text) DOM.loading_text.textContent = title;
  if (DOM.loading_subtext) DOM.loading_subtext.textContent = subtext;
}

/**
 * Updates the loading text without hiding other sections.
 *
 * @param {string} title   - New primary text.
 * @param {string} subtext - New secondary text.
 */
function updateLoadingUI(title, subtext) {
  if (DOM.loading_text) DOM.loading_text.textContent = title;
  if (DOM.loading_subtext) DOM.loading_subtext.textContent = subtext;
}

/**
 * Shows a full-screen error state with a custom title and message.
 *
 * @param {string} title   - The error title.
 * @param {string} message - The error description.
 */
function showErrorState(title, message) {
  hideAllSections();
  if (DOM.error_state) DOM.error_state.classList.remove("hidden");
  if (DOM.error_title) DOM.error_title.textContent = title;
  if (DOM.error_message) DOM.error_message.textContent = message;
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  8.  UI RENDERERS                                                       ║
// ║                                                                          ║
// ║  renderResultsDashboard() — Builds the complete results view inside      ║
// ║                              the <div id="results-display"> element.     ║
// ║                                                                          ║
// ║  showUserFallbackUI()     — Shows an error or informational alert card   ║
// ║                              inside the <div id="results-display"> element.║
// ║                                                                          ║
// ║  Both functions use Tailwind CSS classes for a clean, modern look.       ║
// ╚══════════════════════════════════════════════════════════════════════════╝

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
      icon: "",
      badgeClass: "bg-emerald-500 text-white",
      barColor: "#10b981",
    };
  if (percentage >= 80)
    return {
      label: "Very Similar",
      icon: "",
      badgeClass: "bg-teal-500 text-white",
      barColor: "#14b8a6",
    };
  if (percentage >= 60)
    return {
      label: "Similar",
      icon: "",
      badgeClass: "bg-amber-500 text-white",
      barColor: "#f59e0b",
    };
  return {
    label: "Different",
    icon: "",
    badgeClass: "bg-red-500 text-white",
    barColor: "#ef4444",
  };
}

// ── MATCH THRESHOLD COLOURS ──────────────────────────────────────────────

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
 * Picks a colour scheme based on the match percentage.
 *
 * @param {number} pct - Match percentage (0–100).
 * @returns {object} The colour config object from MATCH_COLORS.
 */
function matchColorScheme(pct) {
  if (pct >= 95) return MATCH_COLORS.emerald;
  if (pct >= 80) return MATCH_COLORS.teal;
  if (pct >= 60) return MATCH_COLORS.amber;
  return MATCH_COLORS.red;
}

/**
 * Builds and injects the full results dashboard HTML into results-display.
 *
 * @param {object} product       - The scanned product data.
 * @param {object|null} alt      - The best alternative product, or null.
 * @param {object|null} comp     - The comparison result, or null.
 */
function renderResultsDashboard(product, alt, comp) {
  hideAllSections();

  const el = DOM.results_display;
  if (!el) return;

  el.classList.remove("hidden");

  // ── BUILD THE HTML ────────────────────────────────────────────────────

  let html = "";

  // ── Scanned Product Card ─────────────────────────────────────────────
  html += renderProductCardHtml(product, "Scanned Product", "");

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
    html += renderProductCardHtml(alt, "Best Alternative", "", "emerald");

    // Savings Callout
    if (savings > 0) {
      html += `
        <div class="bg-emerald-50 border border-emerald-200 rounded-2xl px-5 py-4 flex items-center gap-3 animate-fade-in">
          <span class="text-2xl"></span>
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
          <h3 class="text-sm font-bold text-slate-700">
            Ingredient Comparison
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
          <p class="text-[0.65rem] font-semibold uppercase tracking-wider text-emerald-600 mb-1.5">
            Identical Ingredients
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
          <p class="text-[0.65rem] font-semibold uppercase tracking-wider text-amber-600 mb-1.5">
            Only in Brand Product
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
          <p class="text-[0.65rem] font-semibold uppercase tracking-wider text-blue-600 mb-1.5">
            Only in Alternative
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
          <h3 class="text-sm font-bold text-slate-700 mb-3">
            Price Comparison
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
          <h3 class="text-sm font-bold text-slate-700">
            All Alternatives Found
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
        <span class="text-3xl"></span>
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

  // ── Bind action buttons ─────────────────────────────────────────────
  const scanAnotherBtn = document.getElementById("scan-another-btn");
  if (scanAnotherBtn) scanAnotherBtn.addEventListener("click", resetForNewScan);

  const viewAltBtn = document.getElementById("view-alt-list-btn");
  if (viewAltBtn) {
    viewAltBtn.addEventListener("click", () => {
      const list = document.getElementById("all-alternatives");
      if (list) list.classList.toggle("hidden");
    });
  }
}

/**
 * Renders a single product card as HTML.
 *
 * @param {object} product    - Product data.
 * @param {string} label      - Label text (e.g. "Scanned Product").
 * @param {string} fallbackText - Text to show when no image is available.
 * @param {string} [accent]   - Tailwind accent colour key (default: "brand").
 * @returns {string} HTML string.
 */
function renderProductCardHtml(product, label, fallbackText, accent) {
  const accentText =
    accent === "emerald" ? "text-emerald-600" : "text-brand-600";
  const superInfo = product.supermarket
    ? SUPERMARKETS[product.supermarket]?.name || product.supermarket
    : "Price comparison unavailable";

  const imageHtml = product.image_url
    ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.name || "Product")}" class="w-full h-full object-cover" onerror="this.parentElement.innerText=''"/>`
    : fallbackText;

  return `
    <div class="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 animate-fade-in">
      <div class="flex items-center gap-3">
        <div class="w-16 h-16 rounded-xl bg-slate-100 flex-shrink-0 flex items-center justify-center text-xl overflow-hidden">
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
            ? `<img src="${escapeHtml(alt.image_url)}" alt="" class="w-full h-full object-cover" onerror="this.parentElement.innerText=''" />`
            : ""
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
 * Shows a fallback UI message (error / info / success) inside results-display.
 *
 * @param {string} message - The message text (HTML allowed).
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
      icon: "",
      title: "red-700",
      text: "red-600",
    },
    info: {
      border: "border-blue-200",
      bg: "bg-blue-50",
      icon: "",
      title: "blue-700",
      text: "blue-600",
    },
    success: {
      border: "border-emerald-200",
      bg: "bg-emerald-50",
      icon: "",
      title: "emerald-700",
      text: "emerald-600",
    },
  };

  const s = styles[type] || styles.info;

  el.className = "animate-fade-in";
  el.innerHTML = `
    <div class="${s.bg} border ${s.border} rounded-2xl p-5 text-center shadow-sm">
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
// ║  9.  SCAN HISTORY                                                       ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Adds a product to the scan history (in-memory + localStorage).
 *
 * @param {object} product - The product data to record.
 */
function addToScanHistory(product) {
  if (!product || !product.barcode) return;

  // Remove existing entry with same barcode (to move it to the top)
  state.scanHistory = state.scanHistory.filter(
    (h) => h.barcode !== product.barcode,
  );

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
 * Loads the scan history from localStorage on startup.
 */
function loadScanHistory() {
  try {
    const stored = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (stored) {
      state.scanHistory = JSON.parse(stored);
    }
  } catch (err) {
    console.warn("[AllVSame] Could not load scan history:", err);
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
          ${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="" class="w-full h-full object-cover" />` : ""}
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
// ║  10.  UI UTILITIES                                                       ║
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
// ║  11.  BARCODE SCANNER (html5-qrcode)                                     ║
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

// ── Camera Permission Manager ────────────────────────────────────────────
//
//  The browser only allows camera access after the user has explicitly
//  granted it via a permission prompt. This manager:
//
//    1. Requests camera access via getUserMedia() BEFORE the scanner
//       starts, so the permission prompt is shown cleanly.
//    2. Saves a flag in localStorage once permission is granted.
//    3. On the next visit, checks the stored flag and the Permissions
//       API to decide whether to auto-start the camera.

/**
 * Explicitly requests camera access by calling getUserMedia.
 * This is what triggers the browser's permission prompt.
 *
 * @returns {Promise<boolean>} True if permission was granted.
 */
async function requestCameraPermission() {
  // Check the Permissions API first — skip the prompt if already granted
  if (navigator.permissions && navigator.permissions.query) {
    try {
      const status = await navigator.permissions.query({ name: "camera" });
      if (status.state === "granted") {
        return true;
      }
    } catch (_) {
      // Permissions API unavailable — fall through to getUserMedia
    }
  }

  // Request camera access explicitly. This triggers the browser's prompt.
  let tempStream = null;
  try {
    tempStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    tempStream.getTracks().forEach((t) => t.stop());
    return true;
  } catch (err) {
    if (tempStream) tempStream.getTracks().forEach((t) => t.stop());
    console.warn("[AllVSame] Camera permission denied:", err.message);
    return false;
  }
}

/**
 * Saves a flag to localStorage so we know the user previously granted
 * camera access. On their next visit we can try to auto-start the scanner.
 */
function saveCameraPermissionGranted() {
  try {
    localStorage.setItem(CAMERA_PERMISSION_KEY, "granted");
  } catch (_) {}
}

/**
 * Removes the stored camera permission flag.
 */
function clearCameraPermissionFlag() {
  try {
    localStorage.removeItem(CAMERA_PERMISSION_KEY);
  } catch (_) {}
}

/**
 * Checks whether the user previously granted camera access.
 *
 * @returns {Promise<boolean>}
 */
async function checkSavedCameraPermission() {
  const flag = localStorage.getItem(CAMERA_PERMISSION_KEY);
  if (flag !== "granted") return false;

  if (navigator.permissions && navigator.permissions.query) {
    try {
      const status = await navigator.permissions.query({ name: "camera" });
      if (status.state === "denied") {
        clearCameraPermissionFlag();
        return false;
      }
      if (status.state === "granted") return true;
      return true;
    } catch (_) {
      return true;
    }
  }
  return true;
}

/**
 * Starts the camera and begins barcode detection.
 * Requests camera permission first, then initialises the scanner.
 */
async function startScanner() {
  // ── Step 1: Request camera permission explicitly ────────────────
  const permitted = await requestCameraPermission();
  if (!permitted) {
    showToast(
      "Camera access is required to scan barcodes. Please allow camera access in your browser settings.",
      "error",
    );
    return;
  }

  // ── Step 2: Permission confirmed — save the flag ────────────────
  saveCameraPermissionGranted();

  // ── Step 3: Initialise the scanner if not already done ──────────
  if (!state.scanner) initScanner();
  if (!state.scanner || state.isScanning) return;

  // ── Step 4: Start the scanner ───────────────────────────────────
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
// ║  12.  EVENT HANDLERS                                                     ║
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

  // ── Nav tab switching ─────────────────────────────────────
  DOM.navBtns?.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      if (tab === "scan") {
        DOM.scanner_section?.scrollIntoView({ behavior: "smooth" });
      } else if (tab === "history") {
        openPanel("history");
      } else if (tab === "about") {
        openPanel("about");
      }

      // Update active tab styling
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
// ║  13.  INITIALISATION                                                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * Application entry point — called once the DOM is ready.
 */
function initApp() {
  console.log("[AllVSame] Initialising…");

  cacheDomRefs();
  initScanner();
  loadScanHistory();
  bindEvents();
  showIdleState();

  // ── Auto-start scanner if user previously granted camera access ──
  setTimeout(async () => {
    const canAutoStart = await checkSavedCameraPermission();
    if (canAutoStart) {
      console.log(
        "[AllVSame] Camera permission previously granted — auto-starting scanner",
      );
      if (DOM.loading_text) DOM.loading_text.textContent = "Resuming camera…";
      await startScanner();
    }
  }, 300);

  console.log("[AllVSame] Application ready");
}

// Start the app once the DOM is fully loaded
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTimeout(initApp, 100));
} else {
  setTimeout(initApp, 100);
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  14.  DEBUGGING HELPERS                                                  ║
// ║                                                                          ║
// ║  Exposed on window.avs so you can test from the browser console:         ║
// ║                                                                          ║
// ║    window.avs.lookup("5012345678900")   — manual barcode lookup           ║
// ║    window.avs.state                     — view the full app state         ║
// ║    window.avs.reset()                   — reset the UI                    ║
// ╚══════════════════════════════════════════════════════════════════════════╝

if (typeof window !== "undefined") {
  window.avs = {
    lookup: (barcode) => {
      if (barcode)
        handleProductScan(
          barcode.replace(/\D/g, ""),
          state.selectedSupermarket,
        );
    },
    reset: resetForNewScan,
    state: state,
  };
}
