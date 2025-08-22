// ===== Helpers =====
const $ = sel => document.querySelector(sel);
const out = $("#out");
const dsInfo = $("#dsInfo");
const expansionSelect = $("#expansionSelect");
const eur = n => n==null || n==="" || isNaN(n)
  ? "—" : new Intl.NumberFormat("fr-FR",{style:"currency",currency:"EUR"}).format(Number(n));
const norm = s => (s||"").toString().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu,"").trim();

// ===== State =====
let singlesRows = [];        // products_singles_6.json (Pokémon Single)
let nonsinglesRows = [];     // products_nonsingles_6.json (Booster, Display…)
let priceRows = [];          // price_guide.json (avec "priceGuides")
let priceById = new Map();   // idProduct -> { base, holo }
let expansionsMap = new Map(); // idExpansion -> "Nom du set"

// Noms multi-langues
let nameToEnglish = new Map();    // key normalisée -> nom EN
let aliasesJsonCount = 0;
let csvAliasCount = 0;

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
  const ks = Object.keys(obj||{});
  for (const n of names) { const k = ks.find(k => k.toLowerCase() === n.toLowerCase()); if (k) return obj[k]; }
  return undefined;
}
function formatDeltaEUR(base, val){
  if (base==null || val==null || !isFinite(base) || !isFinite(val)) return null;
  const diff = val - base;
  const pct  = base === 0 ? null : (diff / base) * 100;
  return { diff, pct };
}

// Choisit le meilleur horizon dispo: 7j > 30j > 1j
function pickTimeframe(pr){
  if (pr.avg7 != null)  return { label: "7 j",  value: pr.avg7 };
  if (pr.avg30 != null) return { label: "30 j", value: pr.avg30 };
  if (pr.avg1 != null)  return { label: "1 j",  value: pr.avg1 };
  return null;
}

// Fabrique une phrase simple: ↑ / ↓ / ≈ vs trend
function verdictText(pr){
  if (pr.trend == null) return "";
  const tf = pickTimeframe(pr);
  if (!tf) return "";

  const d = formatDeltaEUR(pr.trend, tf.value);
  if (!d || d.pct == null) return "";

  const absPct = Math.abs(d.pct);
  const arrow  = d.diff > 0.01 ? "↗" : (d.diff < -0.01 ? "↘" : "≈");
  const cls    = d.diff > 0.01 ? "up" : (d.diff < -0.01 ? "down" : "muted");

  // Si variation < 1% → Stable
  if (absPct < 1) return `<span class="verdict muted">≈ Stable (vs trend)</span>`;

  const sign = d.diff >= 0 ? "+" : "";
  const eurFmt = new Intl.NumberFormat("fr-FR",{style:"currency",currency:"EUR"}).format(d.diff);
  const pctFmt = d.pct.toFixed(1).replace(".", ",");

  return `<span class="verdict ${cls}">${arrow} ${
    d.diff>0 ? "En hausse" : "En baisse"
  } sur ${tf.label} (${sign}${eurFmt}, ${sign}${pctFmt}%)</span>`;
}


// ===== Mappers =====
function mapCatalogSingle(r){
  const idProduct   = pick(r, "idProduct","productId","id");
  const metaName    = pick(r, "name","productName"); // ex. "Electrode [Tackle | Chain Lightning]"
  const baseNameEN  = (metaName || "").split(" [")[0].trim();
  const idExpansion = pick(r, "idExpansion","expansionId");
  const idMetacard  = pick(r, "idMetacard","idMetaproduct","metacardId");
  const lang        = (pick(r, "language","lang","idLanguage","loc") || "").toString().toUpperCase();
  const idCategory  = Number(pick(r, "idCategory","categoryId")) || null;
  const categoryName= pick(r, "categoryName","category");

  return {
    idProduct: idProduct!=null? String(idProduct) : "",
    baseNameEN, metaName: metaName || "",
    idExpansion: idExpansion!=null? String(idExpansion) : "",
    idMetacard: idMetacard!=null? String(idMetacard) : "",
    lang,
    idCategory,
    categoryName: categoryName || "",
    _row: r
  };
}
function mapPrice(r){
  const idProduct = (r.idProduct ?? r.productId ?? r.id);
  const toNum = v => (v==null || v==="") ? undefined : Number(v);

  const base = {
    low:   toNum(r.low ?? r.LOW ?? r.lowPrice),
    avg:   toNum(r.avg ?? r.AVG ?? r.avgSellPrice),
    trend: toNum(r.trend ?? r.TREND ?? r.trendPrice),
    avg1:  toNum(r.avg1 ?? r["avg1"] ?? r["AVG1"]),
    avg7:  toNum(r.avg7 ?? r["avg7"] ?? r["AVG7"]),
    avg30: toNum(r.avg30 ?? r["avg30"] ?? r["AVG30"])
  };

  const holo = {
    low:   toNum(r["low-holo"]   ?? r["LOW-HOLO"]),
    avg:   toNum(r["avg-holo"]   ?? r["AVG-HOLO"]),
    trend: toNum(r["trend-holo"] ?? r["TREND-HOLO"]),
    avg1:  toNum(r["avg1-holo"]  ?? r["AVG1-HOLO"]),
    avg7:  toNum(r["avg7-holo"]  ?? r["AVG7-HOLO"]),
    avg30: toNum(r["avg30-holo"] ?? r["AVG30-HOLO"])
  };

  return { idProduct: idProduct!=null ? String(idProduct) : "", base, holo };
}
function buildPriceIndex() {
  priceById.clear();
  for (const r of priceRows) {
    const mp = mapPrice(r);
    if (!mp.idProduct) continue;
    priceById.set(mp.idProduct, mp);
  }
}

// ===== Expansions depuis NON-SINGLES =====
function deriveExpansionsFromProducts(products) {
  const STRIP = [
    /\b(Sleeved Booster|Booster Box|Booster|Display|Blister|Checklane|Elite Trainer Box|ETB|Build & Battle|Theme Deck|Deck|Collection|Tin|Bundle|Promo|Preorder)\b.*$/i,
    /\s*\[.*?\]\s*$/  // retire les crochets éventuels
  ];
  const clean = (s) => {
    let x = (s||"").trim();
    for (const re of STRIP) x = x.replace(re, "").trim();
    return x.replace(/[-–—:]+$/g,"").trim();
  };

  const buckets = new Map(); // idExpansion -> Map(name -> count)
  for (const r of products) {
    const expId = String(r.idExpansion ?? "");
    if (!expId) continue;
    const base = clean(r.name || r.productName || "");
    if (!base) continue;
    if (!buckets.has(expId)) buckets.set(expId, new Map());
    const m = buckets.get(expId);
    m.set(base, (m.get(base)||0)+1);
  }

  const map = new Map();
  for (const [expId, counts] of buckets) {
    let best = "", bestScore = -1;
    for (const [name, cnt] of counts) {
      const score = cnt*1000 + name.length; // fréquence puis longueur
      if (score > bestScore) { bestScore = score; best = name; }
    }
    map.set(expId, best || `Expansion ${expId}`);
  }
  return map;
}

// ===== Filtre "Pokémon Single" & exclusion Live Code Card =====
function isPokemonSingle(m) {
  const isSingle = (m.categoryName || "").trim() === "Pokémon Single";
  const n = ((m.metaName || m.baseNameEN || "") + "").toLowerCase();
  const isLiveCode = /live\s*code\s*card/i.test(n);
  return isSingle && !isLiveCode;
}

// ===== Aliases depuis CSV (direct) =====
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/)[0] || "";
  const c = ch => (firstLine.match(new RegExp(`\\${ch}`, "g"))||[]).length;
  const candidates = [",",";","\t","|"];
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
  for (let i=0; i<text.length; i++) {
    const ch = text[i];
    const next = text[i+1];
    if (ch === '"') {
      if (inQuotes && next === '"') { cell += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (!inQuotes && ch === delimiter) {
      row.push(cell); cell = "";
    } else if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") { i++; }
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
  csvAliasCount = 0;
  const tries = ["data/pokemon_names.csv", "data/International List of Pokémon Names - Pokemon.csv"];
  let text = null;
  for (const path of tries) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (res.ok) { text = await res.text(); break; }
    } catch {}
  }
  if (!text) return;

  const delim = detectDelimiter(text);
  const rows = parseCSV(text, delim);
  if (!rows.length) return;

  let startIdx = 0;
  const header = rows[0].map(x => x.trim().toLowerCase());
  if (header.some(h => h.includes("english"))) startIdx = 1;

  // Col 2 = EN (idx 1). On mappe toutes colonnes non vides -> EN
  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 2) continue;
    const en = (r[1] || "").trim();
    if (!en) continue;
    for (let j = 1; j < r.length; j++) {
      const val = (r[j] || "").trim();
      if (!val) continue;
      const key = norm(val);
      if (!nameToEnglish.has(key)) {
        nameToEnglish.set(key, en);
        csvAliasCount++;
      }
    }
  }
}
async function loadNameAliasesJSON() {
  aliasesJsonCount = 0;
  try {
    const res = await fetch("data/name_aliases.json", { cache:"no-store" });
    if (!res.ok) return;
    const json = await res.json();
    for (const [k,v] of Object.entries(json||{})) {
      const key = norm(k);
      if (!nameToEnglish.has(key)) {
        nameToEnglish.set(key, v);
        aliasesJsonCount++;
      }
    }
  } catch {}
}
function toEnglishName(inputName){
  const key = norm(inputName);
  return nameToEnglish.get(key) || inputName;
}

// ===== Remplir le <select> des extensions (ordre A→Z) =====
function populateExpansionSelect() {
  while (expansionSelect.options.length > 1) expansionSelect.remove(1);

  const entries = Array.from(deriveExpansionsFromProducts(nonsinglesRows).entries())
    .map(([id,name]) => ({ id, name }))
    .sort((a,b) => a.name.localeCompare(b.name, 'en', { sensitivity:'base' }));

  expansionsMap = new Map(entries.map(e => [e.id, e.name]));

  for (const {id,name} of entries) {
    const opt = document.createElement('option');
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
    dedup.sort((a,b) => {
      const an = norm(a.m.baseNameEN||"");
      const bn = norm(b.m.baseNameEN||"");
      const aScore = an.startsWith(N) ? 1 : 0;
      const bScore = bn.startsWith(N) ? 1 : 0;
      return bScore - aScore;
    });
  }
  return dedup;
}

// ===== Prix =====
function hasAny(obj){ return obj && (obj.low!=null || obj.avg!=null || obj.trend!=null || obj.high!=null || obj.avg1!=null || obj.avg7!=null || obj.avg30!=null); }
function hasPositive(obj){
  if (!obj) return false;
  const vals = [obj.low, obj.avg, obj.trend, obj.high, obj.avg1, obj.avg7, obj.avg30];
  return vals.some(v => typeof v === "number" && isFinite(v) && v > 0);
}

function pickPrices(mp, useHolo){
  if (!mp) return { low:undefined, avg:undefined, trend:undefined, avg1:undefined, avg7:undefined, avg30:undefined };
  const src = useHolo && hasPositive(mp.holo) ? mp.holo : mp.base;
  const { low, avg, trend, avg1, avg7, avg30 } = src;
  return { low, avg, trend, avg1, avg7, avg30 };
}
function pctDelta(v, ref){
  if (v==null || ref==null || !isFinite(v) || !isFinite(ref) || ref===0) return null;
  return ((v - ref) / ref) * 100;
}
function deltaBadge(v, ref, label){
  if (v==null) return `<span class="chip">${label}: —</span>`;
  const p = pctDelta(v, ref);
  let arrow = '•', cls = 'muted';
  if (p != null) {
    if (p > 0.01) { arrow = '▲'; cls='up'; }
    else if (p < -0.01) { arrow = '▼'; cls='down'; }
    else { arrow = '•'; cls='muted'; }
  }
  const vv = eur(v).replace(/\u00A0/g,' ');
  const pp = (p==null) ? '' : ` <span class="pct ${cls}">(${p.toFixed(1)}%)</span>`;
  return `<span class="chip ${cls}">${label}: ${vv} <span class="arr">${arrow}</span>${pp}</span>`;
}

// Construit le HTML du bloc prix (utilisé au chargement et quand on coche Holo)
function priceTilesHTML(pr){
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



// ===== Affichage =====
function renderResult(items) {
  if (!items.length) {
    out.innerHTML = `<div class="card err">Aucune carte trouvée.
      <div class="muted" style="margin-top:6px">Choisis une extension ou essaie un nom en anglais/français.</div>
    </div>`;
    return;
  }

  // on génère le HTML + on attachera les handlers Holo ensuite
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
        
        <div class="price-wrap">
          ${priceTilesHTML(init)}
        </div>
        ${!mp ? '<div class="meta" style="margin-top:6px">Pas de ligne Price Guide pour cet idProduct.</div>' : (hasPositive(mp?.holo) ? '' : '')
}
      </div>
    `;
  }).join("");

  // Attache les toggles Holo
  out.querySelectorAll(".line").forEach(line => {
    const id = line.getAttribute("data-id");
    const mp = priceById.get(id);
    const toggle = line.querySelector(".holo-toggle");
    if (!toggle || !mp) return;
    const wrap = line.querySelector(".price-wrap");
    toggle.addEventListener("change", () => {
      const useHolo = toggle.checked;
      const pr = pickPrices(mp, useHolo);
      wrap.innerHTML = priceTilesHTML(pr);
    });
  });
}

// ===== Chargement AUTO depuis /data/ =====
async function tryFetchData() {
  dsInfo.textContent = "Chargement des données…";

  try {
    const res = await fetch("data/products_singles_6.json", { cache:"no-store" });
    if (res.ok) singlesRows = normalizeJSONArray(await res.json(), ["products"]);
  } catch {}
  try {
    const res = await fetch("data/products_nonsingles_6.json", { cache:"no-store" });
    if (res.ok) nonsinglesRows = normalizeJSONArray(await res.json(), ["products"]);
  } catch {}
  try {
    const res = await fetch("data/price_guide.json", { cache:"no-store" });
    if (res.ok) priceRows = normalizeJSONArray(await res.json(), ["priceGuides"]);
  } catch {}
  buildPriceIndex();

  await loadNamesCSV();
  await loadNameAliasesJSON();

  populateExpansionSelect();

  dsInfo.textContent =
    `Singles: ${singlesRows.length} • Non-singles: ${nonsinglesRows.length} • Price guide: ${priceRows.length} • Extensions: ${expansionsMap.size} • Noms: ${nameToEnglish.size} (CSV+JSON)`;
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

// ===== Boot =====
tryFetchData();
