// ===== Helpers =====
const $ = sel => document.querySelector(sel);
const out = $("#out");
const expansionSelect = $("#expansionSelect");

const eur = n =>
  n == null || n === "" || isNaN(n)
    ? "—"
    : new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" })
      .format(Number(n));

const norm = s =>
  (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();

// ===== State =====
let singlesRows = [];        // data/products_singles_6.json
let nonsinglesRows = [];     // data/products_nonsingles_6.json
let priceRows = [];          // data/price_guide.json
let priceById = new Map();   // idProduct -> { base, holo }
let expansionsMap = new Map(); // idExpansion -> "Nom du set"
let nameToEnglish = new Map(); // mapping noms (toutes langues) -> EN depuis CSV et (optionnel) JSON
// Construit une URL image TCGdex finale depuis une base sans extension
function tcgdexCardImg(base, quality = "low", ext = "webp") {
  if (!base) return null;
  // si l'URL a déjà une extension, on la renvoie telle quelle
  if (/\.(png|jpe?g|webp)$/i.test(base)) return base;
  return `${base.replace(/\/$/, "")}/${quality}.${ext}`;
}

// ===== Normalisation générique =====
function normalizeJSONArray(json, preferKeys = []) {
  if (Array.isArray(json)) return json;
  const known = [...preferKeys, "products", "priceGuides", "items", "rows", "data"];
  for (const k of known) if (json && Array.isArray(json[k])) return json[k];
  if (json && typeof json === "object") {
    let best = [];
    for (const k of Object.keys(json)) {
      const v = json[k];
      if (Array.isArray(v) && v.length && typeof v[0] === "object") {
        const ok = v.some(o => o && ("idProduct" in o || "productId" in o || "id" in o));
        if (ok && v.length > best.length) best = v;
      }
    }
    if (best.length) return best;
  }
  return [];
}
function pick(obj, ...names) {
  const ks = Object.keys(obj || {});
  for (const n of names) {
    const k = ks.find(k => k.toLowerCase() === n.toLowerCase());
    if (k) return obj[k];
  }
  return undefined;
}

// ===== Catalog & Price mappers =====
function mapCatalogSingle(r) {
  const idProduct = pick(r, "idProduct", "productId", "id");
  const metaName = pick(r, "name", "productName"); // ex. "Electrode [Tackle | Chain Lightning]"
  const baseNameEN = (metaName || "").split(" [")[0].trim();
  const idExpansion = pick(r, "idExpansion", "expansionId");
  const idMetacard = pick(r, "idMetacard", "idMetaproduct", "metacardId");
  const lang = (pick(r, "language", "lang", "idLanguage", "loc") || "").toString().toUpperCase();
  const idCategory = Number(pick(r, "idCategory", "categoryId")) || null;
  const categoryName = pick(r, "categoryName", "category");

  return {
    idProduct: idProduct != null ? String(idProduct) : "",
    baseNameEN,
    metaName: metaName || "",
    idExpansion: idExpansion != null ? String(idExpansion) : "",
    idMetacard: idMetacard != null ? String(idMetacard) : "",
    lang,
    idCategory,
    categoryName: categoryName || "",
    _row: r
  };
}

function mapPrice(r) {
  const idProduct = (r.idProduct ?? r.productId ?? r.id);
  const toNum = v => (v == null || v === "") ? undefined : Number(v);

  const base = {
    low: toNum(r.low ?? r.LOW ?? r.lowPrice),
    avg: toNum(r.avg ?? r.AVG ?? r.avgSellPrice),
    trend: toNum(r.trend ?? r.TREND ?? r.trendPrice),
    avg1: toNum(r.avg1 ?? r["AVG1"]),
    avg7: toNum(r.avg7 ?? r["AVG7"]),
    avg30: toNum(r.avg30 ?? r["AVG30"])
  };

  const holo = {
    low: toNum(r["low-holo"] ?? r["LOW-HOLO"]),
    avg: toNum(r["avg-holo"] ?? r["AVG-HOLO"]),
    trend: toNum(r["trend-holo"] ?? r["TREND-HOLO"]),
    avg1: toNum(r["avg1-holo"] ?? r["AVG1-HOLO"]),
    avg7: toNum(r["avg7-holo"] ?? r["AVG7-HOLO"]),
    avg30: toNum(r["avg30-holo"] ?? r["AVG30-HOLO"])
  };

  return { idProduct: idProduct != null ? String(idProduct) : "", base, holo };
}

function buildPriceIndex() {
  priceById.clear();
  for (const r of priceRows) {
    const mp = mapPrice(r);
    if (!mp.idProduct) continue;
    priceById.set(mp.idProduct, mp);
  }
}

// ===== Extensions depuis NON-SINGLES =====
function deriveExpansionsFromProducts(products) {
  const STRIP = [
    /\b(Sleeved Booster|Booster Box|Booster|Display|Blister|Checklane|Elite Trainer Box|ETB|Build & Battle|Theme Deck|Deck|Collection|Tin|Bundle|Promo|Preorder)\b.*$/i,
    /\s*\[.*?\]\s*$/ // retire crochets éventuels
  ];
  const clean = s => {
    let x = (s || "").trim();
    for (const re of STRIP) x = x.replace(re, "").trim();
    return x.replace(/[-–—:]+$/g, "").trim();
  };

  const buckets = new Map(); // idExpansion -> Map(name -> count)
  for (const r of products) {
    const expId = String(r.idExpansion ?? "");
    if (!expId) continue;
    const base = clean(r.name || r.productName || "");
    if (!base) continue;
    if (!buckets.has(expId)) buckets.set(expId, new Map());
    const m = buckets.get(expId);
    m.set(base, (m.get(base) || 0) + 1);
  }

  const map = new Map();
  for (const [expId, counts] of buckets) {
    let best = "", bestScore = -1;
    for (const [name, cnt] of counts) {
      const score = cnt * 1000 + name.length; // fréquence puis longueur
      if (score > bestScore) { bestScore = score; best = name; }
    }
    map.set(expId, best || `Expansion ${expId}`);
  }
  return map;
}

// ===== Filtre Singles & exclusion Live Code Card =====
function isPokemonSingle(m) {
  const isSingle = (m.categoryName || "").trim() === "Pokémon Single";
  const n = ((m.metaName || m.baseNameEN || "") + "").toLowerCase();
  const isLiveCode = /live\s*code\s*card/i.test(n);
  return isSingle && !isLiveCode;
}

// ===== Aliases depuis CSV (direct) =====
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/)[0] || "";
  const c = ch => (firstLine.match(new RegExp(`\\${ch}`, "g")) || []).length;
  const candidates = [",", ";", "\t", "|"];
  let best = ",", bestCnt = -1;
  for (const d of candidates) {
    const cnt = c(d);
    if (cnt > bestCnt) { best = d; bestCnt = cnt; }
  }
  return best;
}
function parseCSV(text, delimiter) {
  const rows = [];
  let row = [], cell = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') { cell += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (!inQuotes && ch === delimiter) {
      row.push(cell); cell = "";
    } else if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell); rows.push(row);
      row = []; cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function loadNamesCSV() {
  nameToEnglish.clear();
  const tries = ["data/pokemon_names.csv", "data/International List of Pokémon Names - Pokemon.csv"];
  let text = null;
  for (const path of tries) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (res.ok) { text = await res.text(); break; }
    } catch { }
  }
  if (!text) return;

  const delim = detectDelimiter(text);
  const rows = parseCSV(text, delim);
  if (!rows.length) return;

  let startIdx = 0;
  const header = rows[0].map(x => x.trim().toLowerCase());
  if (header.some(h => h.includes("english"))) startIdx = 1;

  // Col 2 = EN (idx 1). On indexe toutes colonnes non vides -> EN
  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 2) continue;
    const en = (r[1] || "").trim();
    if (!en) continue;
    for (let j = 1; j < r.length; j++) {
      const val = (r[j] || "").trim();
      if (!val) continue;
      const key = norm(val);
      if (!nameToEnglish.has(key)) nameToEnglish.set(key, en);
    }
  }
}

async function loadNameAliasesJSON() {
  try {
    const res = await fetch("data/name_aliases.json", { cache: "no-store" });
    if (!res.ok) return;
    const json = await res.json();
    for (const [k, v] of Object.entries(json || {})) {
      const key = norm(k);
      if (!nameToEnglish.has(key)) nameToEnglish.set(key, v);
    }
  } catch { }
}

function toEnglishName(inputName) {
  const key = norm(inputName);
  return nameToEnglish.get(key) || inputName;
}

// ===== Remplir le <select> des extensions (ordre A→Z) =====
function populateExpansionSelect() {
  while (expansionSelect.options.length > 1) expansionSelect.remove(1);

  const entries = Array.from(deriveExpansionsFromProducts(nonsinglesRows).entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

  expansionsMap = new Map(entries.map(e => [e.id, e.name]));

  for (const { id, name } of entries) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = name;
    expansionSelect.appendChild(opt);
  }
}

// ===== Recherche =====
function findSinglesByFilters(inputName, selectedExpansionId) {
  const nameEN = inputName ? toEnglishName(inputName) : "";
  const N = norm(nameEN);
  const expFilter = selectedExpansionId ? String(selectedExpansionId) : "";

  const cands = [];
  for (const r of singlesRows) {
    const m = mapCatalogSingle(r);

    // Singles strict + pas "Live Code Card"
    if (!isPokemonSingle(m)) continue;

    if (expFilter && String(m.idExpansion) !== expFilter) continue;

    if (N) {
      const names = [m.baseNameEN, m.metaName].filter(Boolean).map(norm);
      const hasName = names.some(x => x.includes(N) || N.includes(x));
      if (!hasName) continue;
    }
    cands.push({ id: m.idProduct, m });
  }

  // dédoublonnage + tri (si nom, priorité aux startsWith)
  const seen = new Set();
  const dedup = cands.filter(c => (c.id && !seen.has(c.id)) && seen.add(c.id));
  if (N) {
    dedup.sort((a, b) => {
      const an = norm(a.m.baseNameEN || "");
      const bn = norm(b.m.baseNameEN || "");
      const aScore = an.startsWith(N) ? 1 : 0;
      const bScore = bn.startsWith(N) ? 1 : 0;
      return bScore - aScore;
    });
  }
  return dedup;
}

// ===== Prix & Holo =====
function hasAny(obj) {
  return obj && (
    obj.low != null || obj.avg != null || obj.trend != null || obj.high != null ||
    obj.avg1 != null || obj.avg7 != null || obj.avg30 != null
  );
}
function hasPositive(obj) {
  if (!obj) return false;
  const vals = [obj.low, obj.avg, obj.trend, obj.high, obj.avg1, obj.avg7, obj.avg30];
  return vals.some(v => typeof v === "number" && isFinite(v) && v > 0);
}
function pickPrices(mp, useHolo) {
  if (!mp) return { low: undefined, avg: undefined, trend: undefined, avg1: undefined, avg7: undefined, avg30: undefined };
  const src = useHolo && hasPositive(mp.holo) ? mp.holo : mp.base;
  const { low, avg, trend, avg1, avg7, avg30 } = src;
  return { low, avg, trend, avg1, avg7, avg30 };
}

function formatDeltaEUR(base, val) {
  if (base == null || val == null || !isFinite(base) || !isFinite(val)) return null;
  const diff = val - base;
  const pct = base === 0 ? null : (diff / base) * 100;
  return { diff, pct };
}
function pickTimeframe(pr) {
  if (pr.avg7 != null) return { label: "7 j", value: pr.avg7 };
  if (pr.avg30 != null) return { label: "30 j", value: pr.avg30 };
  if (pr.avg1 != null) return { label: "1 j", value: pr.avg1 };
  return null;
}
function verdictText(pr) {
  if (pr.trend == null) return "";
  const tf = pickTimeframe(pr);
  if (!tf) return "";
  const d = formatDeltaEUR(pr.trend, tf.value);
  if (!d || d.pct == null) return "";
  const absPct = Math.abs(d.pct);
  const arrow = d.diff > 0.01 ? "↗" : (d.diff < -0.01 ? "↘" : "≈");
  const cls = d.diff > 0.01 ? "up" : (d.diff < -0.01 ? "down" : "muted");
  if (absPct < 1) return `<span class="verdict muted">≈ Stable (vs trend)</span>`;
  const sign = d.diff >= 0 ? "+" : "";
  const eurFmt = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(d.diff);
  const pctFmt = d.pct.toFixed(1).replace(".", ",");
  return `<span class="verdict ${cls}">${arrow} ${d.diff > 0 ? "En hausse" : "En baisse"} sur ${tf.label} (${sign}${eurFmt}, ${sign}${pctFmt}%)</span>`;
}

// Tooltips + bloc prix
function priceTilesHTML(pr) {
  return `
    <div class="prices">
      <div class="price-tile">
        <div class="k">
          avg
          <span class="tt" tabindex="0" aria-label="Infos avg">
            <span class="q">?</span>
            <span class="bubble">Prix moyen des ventes récentes.</span>
          </span>
        </div>
        <div class="v">${eur(pr.avg)}</div>
      </div>
      <div class="price-tile">
        <div class="k">
          low
          <span class="tt" tabindex="0" aria-label="Infos low">
            <span class="q">?</span>
            <span class="bubble">Prix le plus bas actuellement listé.</span>
          </span>
        </div>
        <div class="v">${eur(pr.low)}</div>
      </div>
      <div class="price-tile tile-trend">
        <div class="k">
          trend
          <span class="tt" tabindex="0" aria-label="Infos trend">
            <span class="q">?</span>
            <span class="bubble">Valeur de tendance Cardmarket (mélange pondéré des dernières ventes).</span>
          </span>
        </div>
        <div class="v">${eur(pr.trend)}</div>
      </div>
      <div class="price-tile tile-mini" style="justify-content:center">
        <div class="k" style="text-transform:none">derniers jours</div>
        <div class="mini-row" style="margin-top:6px">
          ${verdictText(pr) || '<span class="verdict muted">—</span>'}
        </div>
      </div>
    </div>
  `;
}

// ===== TCGdex (images, sans clé) =====
// API en EN pour les ids stables, mais on préfère les ASSETS en FR
const TCGDEX_LANG = "en";          // pour /v2/en/sets...
const TCGDEX_ASSET_LANG = "fr";    // pour les images (fr -> fallback en)
const tcgdex = {
  sets: null,
  setIdByName: new Map(),
  cardsBySetId: new Map(),
};
const normalizeSetName = s =>
  (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

async function loadTcgdexSets() {
  if (tcgdex.sets) return tcgdex.sets;
  try {
    const url = `https://api.tcgdex.net/v2/${TCGDEX_LANG}/sets`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    tcgdex.sets = data;
    data.forEach(s => tcgdex.setIdByName.set(normalizeSetName(s.name), s.id));
    return data;
  } catch { return []; }
}

async function resolveTcgdexSetId(expansionName) {
  await loadTcgdexSets();
  const key = normalizeSetName(expansionName);
  if (tcgdex.setIdByName.has(key)) return tcgdex.setIdByName.get(key);
  let best = null;
  for (const s of (tcgdex.sets || [])) {
    const n = normalizeSetName(s.name);
    if (n.includes(key) || key.includes(n)) { best = s; break; }
  }
  if (best) {
    tcgdex.setIdByName.set(key, best.id);
    return best.id;
  }
  return null;
}

async function loadTcgdexSetCards(setId) {
  if (!setId) return [];
  if (tcgdex.cardsBySetId.has(setId)) return tcgdex.cardsBySetId.get(setId);
  try {
    const url = `https://api.tcgdex.net/v2/${TCGDEX_LANG}/sets/${encodeURIComponent(setId)}`;
    const res = await fetch(url);
    if (!res.ok) { tcgdex.cardsBySetId.set(setId, []); return []; }
    const set = await res.json();
    const cards = Array.isArray(set.cards) ? set.cards : [];
    tcgdex.cardsBySetId.set(setId, cards);
    return cards;
  } catch { tcgdex.cardsBySetId.set(setId, []); return []; }
}

async function fetchCardImage(nameEN, expansionName) {
  const setId = await resolveTcgdexSetId(expansionName);
  if (!setId) return null;
  const cards = await loadTcgdexSetCards(setId);
  const N = (nameEN || "").toLowerCase();

  let hit = cards.find(c => (c.name || "").toLowerCase() === N);
  if (!hit) hit = cards.find(c => (c.name || "").toLowerCase().includes(N));
  if (!hit) {
    const normName = x => (x || "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").trim();
    const nN = normName(nameEN);
    hit = cards.find(c => normName(c.name) === nN || normName(c.name).includes(nN));
  }
  return hit ? { image: hit.image, cardId: hit.id, localId: hit.localId, setId } : null;
}

// ===== UI rendering =====
function renderResult(items) {
  if (!items.length) {
    out.innerHTML = `<div class="card err">Aucune carte trouvée.
      <div class="muted" style="margin-top:6px">Choisis une extension ou essaie un nom en anglais/français.</div>
    </div>`;
    return;
  }

  out.innerHTML = items.slice(0, 500).map(c => {
    const mp = priceById.get(c.id);
    const hasHolo = !!(mp && hasPositive(mp.holo));
    const m = c.m;
    const expName = expansionsMap.get(String(m.idExpansion)) || m.idExpansion || "—";

    const init = pickPrices(mp, /*useHolo*/ false);

    return `
  <div class="line" data-id="${c.id}">
    <div class="top">
      <strong>${m.baseNameEN || "?"}</strong>
      <span class="badge">Set: ${expName}</span>
      ${hasHolo ? `<label class="badge" style="cursor:pointer;">
        <input type="checkbox" class="holo-toggle" style="vertical-align:middle;margin-right:6px;"> Holo
      </label>` : ``}
    </div>

    <div class="content-row">
      
        <div class="thumb" data-thumb-for="${m.idProduct}">
          <div class="thumb-ph">Visuel…</div>
        </div>
      

      <div class="price-wrap">
        ${priceTilesHTML(init)}
      </div>
    </div>

    
  </div>
`;

  }).join("");

  // Attache les toggles Holo + charge images TCGdex
  out.querySelectorAll(".line").forEach(async line => {
    const id = line.getAttribute("data-id");
    const mp = priceById.get(id);
    // Holo toggle
    const toggle = line.querySelector(".holo-toggle");
    const wrap = line.querySelector(".price-wrap");
    if (toggle && mp) {
      toggle.addEventListener("change", () => {
        const useHolo = toggle.checked;
        const pr = pickPrices(mp, useHolo);
        wrap.innerHTML = priceTilesHTML(pr);
      });
    }
    // Image
    const nameEN = line.querySelector(".top strong")?.textContent || "";
    const expBadge = [...line.querySelectorAll(".badge")].find(b => b.textContent.startsWith("Set:"));
    const expName = expBadge ? expBadge.textContent.replace(/^Set:\s*/, "").trim() : "";
    const slot = line.querySelector(`.thumb[data-thumb-for="${id}"]`);
    if (slot) {
      const data = await fetchCardImage(nameEN, expName);
      if (data?.image) {
  const base = data.image; // ex: https://assets.tcgdex.net/en/series/set/123
  // Construit la version FR en priorité, sinon EN
  const baseFR = base.replace(/\/(en|de|es|it|pt|ja|ko|zh)\//, `/${TCGDEX_ASSET_LANG}/`);
  const baseEN = base.replace(/\/(fr|de|es|it|pt|ja|ko|zh)\//, "/en/");

  const urls = {
    frWebpLow:  tcgdexCardImg(baseFR, "low",  "webp"),
    frWebpHigh: tcgdexCardImg(baseFR, "high", "webp"),
    enWebpLow:  tcgdexCardImg(baseEN, "low",  "webp"),
    enWebpHigh: tcgdexCardImg(baseEN, "high", "webp"),
    frPngLow:   tcgdexCardImg(baseFR, "low",  "png"),
    frPngHigh:  tcgdexCardImg(baseFR, "high", "png"),
    enPngLow:   tcgdexCardImg(baseEN, "low",  "png"),
    enPngHigh:  tcgdexCardImg(baseEN, "high", "png"),
  };

  slot.innerHTML = `
    <a href="https://api.tcgdex.net/v2/${TCGDEX_LANG}/cards/${encodeURIComponent(data.cardId)}"
       target="_blank" rel="noopener">
      <img
        data-stage="fr-webp"
        src="${urls.frWebpLow}"
        srcset="${urls.frWebpLow} 1x, ${urls.frWebpHigh} 2x"
        alt="${nameEN}"
        loading="lazy"
      />
    </a>
  `;

  // Fallbacks progressifs: fr-webp -> en-webp -> fr-png -> en-png
  const imgEl = slot.querySelector("img");
  imgEl.addEventListener("error", function onErr() {
    const stage = imgEl.getAttribute("data-stage");
    if (stage === "fr-webp") {
      imgEl.setAttribute("data-stage", "en-webp");
      imgEl.src = urls.enWebpLow;
      imgEl.srcset = `${urls.enWebpLow} 1x, ${urls.enWebpHigh} 2x`;
    } else if (stage === "en-webp") {
      imgEl.setAttribute("data-stage", "fr-png");
      imgEl.src = urls.frPngLow;
      imgEl.srcset = `${urls.frPngLow} 1x, ${urls.frPngHigh} 2x`;
    } else if (stage === "fr-png") {
      imgEl.setAttribute("data-stage", "en-png");
      imgEl.src = urls.enPngLow;
      imgEl.srcset = `${urls.enPngLow} 1x, ${urls.enPngHigh} 2x`;
    } else {
      imgEl.removeEventListener("error", onErr); // dernier fallback
    }
  });
} else {
  slot.innerHTML = `<div class="thumb-nope">—</div>`;
}


    }
  });
}

// ===== Chargement des données =====
async function tryFetchData() {
  // datasets locaux
  try {
    const res = await fetch("data/products_singles_6.json", { cache: "no-store" });
    if (res.ok) singlesRows = normalizeJSONArray(await res.json(), ["products"]);
  } catch { }
  try {
    const res = await fetch("data/products_nonsingles_6.json", { cache: "no-store" });
    if (res.ok) nonsinglesRows = normalizeJSONArray(await res.json(), ["products"]);
  } catch { }
  try {
    const res = await fetch("data/price_guide.json", { cache: "no-store" });
    if (res.ok) priceRows = normalizeJSONArray(await res.json(), ["priceGuides"]);
  } catch { }
  buildPriceIndex();

  // noms multi-langues
  await loadNamesCSV();        // CSV direct
  await loadNameAliasesJSON(); // optionnel

  // extensions → select
  populateExpansionSelect();
}

// ===== Actions =====
$("#btnSearch").addEventListener("click", () => {
  const name = $("#name").value.trim();
  const selectedExp = $("#expansionSelect").value.trim();

  if (!name && !selectedExp) {
    out.innerHTML = `<div class="card err">Choisis une <strong>extension</strong> ou saisis un <strong>nom</strong>.</div>`;
    return;
  }
  if (!singlesRows.length || !priceRows.length) {
    out.innerHTML = `<div class="card err">
      Données absentes. Assure-toi d'avoir <code>products_singles_6.json</code>, <code>products_nonsingles_6.json</code> et <code>price_guide.json</code> dans <code>/public/data/</code>.
    </div>`;
    return;
  }

  const items = findSinglesByFilters(name, selectedExp);
  renderResult(items);
});

$("#btnClear").addEventListener("click", () => {
  $("#name").value = "";
  $("#expansionSelect").value = "";
  out.innerHTML = "";
});

// Tooltips au clic (mobile-friendly)
document.addEventListener("click", (e) => {
  const t = e.target.closest(".tt");
  document.querySelectorAll(".tt.open").forEach(x => { if (x !== t) x.classList.remove("open"); });
  if (t) t.classList.toggle("open");
});

// ===== Boot =====
tryFetchData();
