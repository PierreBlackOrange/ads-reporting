/* ============================================================================
   Reporting Google Ads — moteur du dashboard
   Sans dépendance : agrégation en mémoire + rendu SVG à la main.

   Table de faits (data.json) — un tableau par ligne, indices figés :
     0 date  1 campagne  2 appareil  3 réseau
     4 impressions  5 clics  6 coût  7 conversions  8 valeur de conversion
   ========================================================================== */
'use strict';

const F = { DATE: 0, CAMP: 1, DEV: 2, NET: 3, IMPR: 4, CLICKS: 5, COST: 6, CONV: 7, VALUE: 8 };

/* Un compte garde sa teinte quoi qu'il arrive : la couleur suit l'entité (son
   index dans le jeu de données), jamais son rang courant — filtrer ne repeint
   donc jamais les survivants. Au-delà de 7 comptes, la queue est repliée sur
   « Autres » plutôt que de cycler les teintes. */
const MAX_ENTITY_SLOTS = 7;
const FOLD_SLOT = 8;

const cssVar = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
const seriesColor = (slot) => cssVar(`--series-${slot}`);

/* ── Formatage (fr-CH) ────────────────────────────────────────────────────── */

const nf0 = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('fr-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('fr-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfCompact = new Intl.NumberFormat('fr-CH', { notation: 'compact', maximumFractionDigits: 1 });

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
                'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

let CURRENCY = 'CHF';

/* `compact` signifie « notation compacte », sans seuil interne : c'est l'appelant
   qui décide, d'après le maximum de l'axe ou de la tuile. Sinon une même échelle
   mélangerait « 5 000 CHF » et « 10 k CHF ». Le zéro exact n'a jamais de
   décimales : « 0,00 CHF » sur une graduation est du bruit. */
function fmtMoney(v, { compact = false } = {}) {
  if (!isFinite(v)) return '—';
  if (v === 0) return `0 ${CURRENCY}`;
  if (compact) return `${nfCompact.format(v)} ${CURRENCY}`;
  const abs = Math.abs(v);
  return `${abs >= 100 ? nf0.format(v) : nf2.format(v)} ${CURRENCY}`;
}
function fmtInt(v, { compact = false } = {}) {
  if (!isFinite(v)) return '—';
  if (v === 0) return '0';
  return compact ? nfCompact.format(v) : nf0.format(v);
}
function fmtNum1(v, { compact = false } = {}) {
  if (!isFinite(v)) return '—';
  if (v === 0) return '0';
  return compact ? nfCompact.format(v) : nf1.format(v);
}
function fmtPct(v) {
  if (!isFinite(v)) return '—';
  return v === 0 ? '0 %' : `${nf2.format(v * 100)} %`;
}
function fmtRatio(v) {
  if (!isFinite(v)) return '—';
  return v === 0 ? '0 ×' : `${nf2.format(v)} ×`;
}

/** Un seul format pour toute une échelle, choisi d'après son maximum. */
function axisFormatter(fmt, max) {
  const compact = Math.abs(max) >= 10000;
  return (v) => fmt(v, { compact });
}
/** Idem pour une valeur isolée (tuile, étiquette directe). */
const compactly = (fmt, v) => fmt(v, { compact: Math.abs(v) >= 10000 });

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtDateShort(iso) {
  const d = parseDate(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
function fmtDateLong(iso) {
  const d = parseDate(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
function addDays(iso, n) {
  const d = parseDate(iso);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ── Indicateurs ──────────────────────────────────────────────────────────── */

/* dir : +1 → une hausse est bonne ; -1 → une hausse est mauvaise ; 0 → neutre. */
const METRICS = {
  cost:        { label: 'Coût',              calc: (t) => t.cost,                fmt: fmtMoney,  dir:  0, money: true },
  impressions: { label: 'Impressions',       calc: (t) => t.impr,                fmt: fmtInt,    dir:  0 },
  clicks:      { label: 'Clics',             calc: (t) => t.clicks,              fmt: fmtInt,    dir:  1 },
  ctr:         { label: 'CTR',               calc: (t) => t.impr ? t.clicks / t.impr : NaN,  fmt: fmtPct,   dir:  1 },
  cpc:         { label: 'CPC moyen',         calc: (t) => t.clicks ? t.cost / t.clicks : NaN, fmt: fmtMoney, dir: -1, money: true },
  conversions: { label: 'Conversions',       calc: (t) => t.conv,                fmt: fmtNum1,   dir:  1 },
  convRate:    { label: 'Taux de conv.',     calc: (t) => t.clicks ? t.conv / t.clicks : NaN, fmt: fmtPct,   dir:  1 },
  cpa:         { label: 'CPA',               calc: (t) => t.conv ? t.cost / t.conv : NaN,     fmt: fmtMoney, dir: -1, money: true },
  convValue:   { label: 'Valeur de conv.',   calc: (t) => t.value,               fmt: fmtMoney,  dir:  1, money: true },
  roas:        { label: 'ROAS',              calc: (t) => t.cost ? t.value / t.cost : NaN,    fmt: fmtRatio, dir:  1 },
};

const KPI_ORDER = ['cost', 'impressions', 'clicks', 'ctr', 'cpc', 'conversions', 'cpa', 'roas'];
const TS_METRICS = ['cost', 'impressions', 'clicks', 'ctr', 'cpc', 'conversions', 'convRate', 'cpa', 'convValue', 'roas'];
const TOP_METRICS = ['cost', 'conversions', 'convValue', 'clicks', 'impressions', 'roas', 'cpa'];

const DEVICE_LABELS = { MOBILE: 'Mobile', DESKTOP: 'Ordinateur', TABLET: 'Tablette', CONNECTED_TV: 'TV connectée', OTHER: 'Autre', UNKNOWN: 'Inconnu' };
const NETWORK_LABELS = {
  SEARCH: 'Recherche Google', SEARCH_PARTNERS: 'Partenaires de recherche', CONTENT: 'Display',
  YOUTUBE_SEARCH: 'YouTube (recherche)', YOUTUBE_WATCH: 'YouTube (vidéos)', MIXED: 'Mixte',
  GOOGLE_TV: 'Google TV', UNKNOWN: 'Inconnu', UNSPECIFIED: 'Non spécifié',
};
const CHANNEL_LABELS = {
  SEARCH: 'Recherche', DISPLAY: 'Display', SHOPPING: 'Shopping', VIDEO: 'Vidéo',
  PERFORMANCE_MAX: 'Performance Max', DISCOVERY: 'Demand Gen', DEMAND_GEN: 'Demand Gen',
  LOCAL: 'Local', SMART: 'Smart', APP: 'Application', HOTEL: 'Hôtel',
  MULTI_CHANNEL: 'Multicanal', UNKNOWN: 'Inconnu',
};
const label = (map, key) => map[key] || key;

const RANGE_PRESETS = [
  { key: '7',   label: '7 j' },
  { key: '30',  label: '30 j' },
  { key: '90',  label: '90 j' },
  { key: 'mtd', label: 'Mois en cours' },
  { key: 'all', label: 'Tout' },
];

/* ── État ─────────────────────────────────────────────────────────────────── */

const S = {
  data: null,
  range: '30',
  start: null,
  end: null,
  accounts: new Set(),   // vide = tous
  devices: new Set(),
  networks: new Set(),
  search: '',
  tsMetric: 'cost',
  tsGrain: 'day',
  tsMode: 'account',
  tsHidden: new Set(),
  topMetric: 'cost',
  mixDim: 'device',
  mixHidden: new Set(),
  views: {},             // id de carte → 'chart' | 'table'
  sort: { col: 'cost', dir: -1 },
};

const $ = (sel) => document.querySelector(sel);
const els = {};

/* ── Agrégation ───────────────────────────────────────────────────────────── */

const emptyTotals = () => ({ impr: 0, clicks: 0, cost: 0, conv: 0, value: 0 });

function addFact(t, f) {
  t.impr   += f[F.IMPR];
  t.clicks += f[F.CLICKS];
  t.cost   += f[F.COST];
  t.conv   += f[F.CONV];
  t.value  += f[F.VALUE];
  return t;
}

/** Index des dates → position, pour convertir une plage en bornes d'index. */
function dateBounds(startIso, endIso) {
  const dates = S.data.dates;
  let lo = 0;
  let hi = dates.length - 1;
  while (lo < dates.length && dates[lo] < startIso) lo++;
  while (hi >= 0 && dates[hi] > endIso) hi--;
  return { lo, hi };
}

/**
 * Applique tous les filtres actifs et retourne les lignes de la période
 * courante ainsi que celles de la période précédente de même longueur
 * (nécessaire au calcul des évolutions).
 */
function selectRows() {
  const d = S.data;
  const { lo, hi } = dateBounds(S.start, S.end);
  const spanDays = Math.max(1, Math.round((parseDate(S.end) - parseDate(S.start)) / 86400000) + 1);

  const prevEnd = addDays(S.start, -1);
  const prevStart = addDays(prevEnd, -(spanDays - 1));
  const prev = dateBounds(prevStart, prevEnd);

  const accOn = S.accounts.size ? S.accounts : null;
  const devOn = S.devices.size ? S.devices : null;
  const netOn = S.networks.size ? S.networks : null;
  const q = S.search.trim().toLowerCase();

  // Pré-calcul du prédicat par campagne : évite de retester compte et nom
  // sur chacune des dizaines de milliers de lignes.
  const campOk = d.campaigns.map((c) => {
    if (accOn && !accOn.has(c.account)) return false;
    if (q && !c.name.toLowerCase().includes(q)) return false;
    return true;
  });

  const cur = [];
  const pre = [];
  for (const f of d.facts) {
    if (!campOk[f[F.CAMP]]) continue;
    if (devOn && !devOn.has(f[F.DEV])) continue;
    if (netOn && !netOn.has(f[F.NET])) continue;
    const di = f[F.DATE];
    if (di >= lo && di <= hi) cur.push(f);
    else if (di >= prev.lo && di <= prev.hi) pre.push(f);
  }

  return { cur, pre, lo, hi, spanDays, prevStart, prevEnd };
}

function totalsOf(rows) {
  const t = emptyTotals();
  for (const f of rows) addFact(t, f);
  return t;
}

/** Regroupe par une clé entière ; retourne une Map<clé, totaux>. */
function groupBy(rows, keyFn) {
  const map = new Map();
  for (const f of rows) {
    const k = keyFn(f);
    let t = map.get(k);
    if (!t) map.set(k, (t = emptyTotals()));
    addFact(t, f);
  }
  return map;
}

/** Clé de regroupement temporel selon la granularité. */
function grainKey(iso, grain) {
  if (grain === 'month') return iso.slice(0, 7);
  if (grain === 'week') {
    const d = parseDate(iso);
    // Semaine ISO : on recule jusqu'au lundi.
    const shift = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - shift);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return iso;
}

function grainLabel(key, grain) {
  if (grain === 'month') {
    const [y, m] = key.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }
  if (grain === 'week') return `sem. du ${fmtDateShort(key)}`;
  return fmtDateShort(key);
}

/**
 * Un bucket hebdomadaire ou mensuel tronqué par les bornes du filtre plonge
 * vers zéro et se lit comme un effondrement de performance. On ne masque pas
 * la donnée — on le dit.
 */
function partialBuckets(keys, grain) {
  if (grain === 'day' || !keys.length) return { first: false, last: false };
  const naturalRange = (k) => {
    if (grain === 'week') return [k, addDays(k, 6)];
    const [yy, mm] = k.split('-').map(Number);
    const lastDay = new Date(yy, mm, 0).getDate();   // jour 0 du mois suivant
    return [`${k}-01`, `${k}-${String(lastDay).padStart(2, '0')}`];
  };
  return {
    first: naturalRange(keys[0])[0] < S.start,
    last: naturalRange(keys[keys.length - 1])[1] > S.end,
  };
}

function partialNote(keys, grain) {
  const p = partialBuckets(keys, grain);
  if (p.first && p.last) return ' — première et dernière périodes incomplètes';
  if (p.last) return ' — dernière période incomplète';
  if (p.first) return ' — première période incomplète';
  return '';
}

/** Buckets temporels ordonnés sur la période sélectionnée. */
function timeBuckets(rows, grain) {
  const dates = S.data.dates;
  const keys = [];
  const seen = new Set();
  const { lo, hi } = dateBounds(S.start, S.end);
  for (let i = lo; i <= hi; i++) {
    const k = grainKey(dates[i], grain);
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  const pos = new Map(keys.map((k, i) => [k, i]));
  return { keys, pos, lo, hi };
}

/**
 * Attribue les 7 créneaux de teinte aux comptes qui pèsent réellement.
 *
 * Le classement se fait sur le coût de TOUT le jeu de données, jamais sur la
 * sélection courante : c'est une propriété fixe du fichier de données, donc
 * filtrer ne repeint jamais une série — la couleur suit le compte, pas son rang
 * dans la vue. Un ordre alphabétique, lui, donnerait les 7 teintes aux premiers
 * comptes de la liste, souvent dormants, et noierait tout le trafic réel dans
 * « Autres ».
 */
function computeAccountSlots() {
  const n = S.data.accounts.length;
  const cost = new Array(n).fill(0);
  for (const f of S.data.facts) cost[S.data.campaigns[f[F.CAMP]].account] += f[F.COST];

  // Départage par index pour que l'ordre soit totalement déterministe.
  const ranked = cost
    .map((c, i) => ({ i, c }))
    .sort((a, b) => b.c - a.c || a.i - b.i);

  S.accountCost = cost;
  S.slotOf = new Array(n).fill(FOLD_SLOT);
  S.accountRank = new Array(n).fill(Infinity);

  ranked.forEach((entry, rank) => {
    S.accountRank[entry.i] = rank;
    if (rank < MAX_ENTITY_SLOTS) S.slotOf[entry.i] = rank + 1;
  });

  // Le repli ne compte que les comptes ayant réellement dépensé : annoncer
  // « Autres (79 comptes) » quand 67 sont dormants serait trompeur.
  S.foldedCount = ranked.filter((e) => e.c > 0 && S.accountRank[e.i] >= MAX_ENTITY_SLOTS).length;
  S.topAccounts = ranked.slice(0, MAX_ENTITY_SLOTS).filter((e) => e.c > 0).map((e) => e.i);
}

const entitySlot = (index) => (S.slotOf ? S.slotOf[index] : FOLD_SLOT) || FOLD_SLOT;
const isFolded = (index) => !S.accountRank || S.accountRank[index] >= MAX_ENTITY_SLOTS;
const accountKey = (i) => (isFolded(i) ? 'other' : String(i));

function accountSeries() {
  const out = S.topAccounts.map((i) => ({
    key: String(i),
    name: S.data.accounts[i].name,
    slot: entitySlot(i),
  }));
  if (S.foldedCount > 0) {
    out.push({
      key: 'other',
      name: `Autres (${S.foldedCount} compte${S.foldedCount > 1 ? 's' : ''})`,
      slot: FOLD_SLOT,
    });
  }
  return out;
}

/* ── Primitives SVG ───────────────────────────────────────────────────────── */

const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs, parent) {
  const node = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) {
    if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
  }
  if (parent) parent.appendChild(node);
  return node;
}

function textNode(tag, attrs, content, parent) {
  const node = el(tag, attrs, parent);
  node.textContent = content;   // données non fiables : jamais innerHTML
  return node;
}

/** Échelle « points » : les valeurs se posent sur les bornes du plot. */
function pointScale(n, w, padL) {
  if (n <= 1) return () => padL + w / 2;
  const step = w / (n - 1);
  return (i) => padL + i * step;
}

/** Graduations rondes couvrant [0, max] — jamais un max brut sur l'axe. */
function niceTicks(min, max, count = 5) {
  if (!isFinite(min) || !isFinite(max) || max === min) {
    return { ticks: [0, 1], min: 0, max: max || 1 };
  }
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  // Tolérance : les flottants font parfois manquer la dernière graduation.
  for (let v = lo; v <= hi + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  return { ticks, min: lo, max: hi };
}

/** Chemin de barre à extrémité arrondie 4px, carrée sur la ligne de base. */
function barPath(x, y, w, h, r, dir) {
  const rr = Math.max(0, Math.min(r, dir === 'h' ? w : h, (dir === 'h' ? h : w) / 2));
  if (dir === 'h') {
    if (w <= 0.5) return '';
    return `M${x},${y} H${x + w - rr} A${rr},${rr} 0 0 1 ${x + w},${y + rr}`
         + ` V${y + h - rr} A${rr},${rr} 0 0 1 ${x + w - rr},${y + h} H${x} Z`;
  }
  if (h <= 0.5) return '';
  return `M${x},${y + h} V${y + rr} A${rr},${rr} 0 0 1 ${x + rr},${y}`
       + ` H${x + w - rr} A${rr},${rr} 0 0 1 ${x + w},${y + rr} V${y + h} Z`;
}

function linePath(pts) {
  let d = '';
  let open = false;
  for (const p of pts) {
    if (p === null) { open = false; continue; }
    d += (open ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1) + ' ';
    open = true;
  }
  return d.trim();
}

function measureWidth(container) {
  const w = container.clientWidth;
  return w > 40 ? w : 640;
}

function emptyState(container, message) {
  container.replaceChildren();
  const p = document.createElement('p');
  p.className = 'chart-empty';
  p.textContent = message;
  container.appendChild(p);
}

/* ── Infobulle partagée ───────────────────────────────────────────────────── */

const Tip = {
  node: null,
  init() { this.node = $('#tooltip'); },
  show(x, y, build) {
    const n = this.node;
    n.replaceChildren();
    build(n);
    n.dataset.open = 'true';
    n.setAttribute('aria-hidden', 'false');
    this.move(x, y);
  },
  move(x, y) {
    const n = this.node;
    const r = n.getBoundingClientRect();
    const pad = 12;
    let left = x + 14;
    let top = y - r.height / 2;
    if (left + r.width > window.innerWidth - pad) left = x - r.width - 14;
    if (left < pad) left = pad;
    top = Math.max(pad, Math.min(top, window.innerHeight - r.height - pad));
    n.style.left = `${left}px`;
    n.style.top = `${top}px`;
  },
  hide() {
    this.node.dataset.open = 'false';
    this.node.setAttribute('aria-hidden', 'true');
  },
};

function tipHead(parent, text) {
  const h = document.createElement('div');
  h.className = 'tooltip__head';
  h.textContent = text;
  parent.appendChild(h);
}

/** Ligne d'infobulle : la valeur mène, le libellé suit ; clé en trait. */
function tipRow(parent, { name, value, color, total = false }) {
  const row = document.createElement('div');
  row.className = 'tooltip__row' + (total ? ' tooltip__total' : '');
  if (color) {
    const key = document.createElement('span');
    key.className = 'tooltip__key';
    key.style.background = color;
    row.appendChild(key);
  }
  const nm = document.createElement('span');
  nm.className = 'tooltip__name';
  nm.textContent = name;
  row.appendChild(nm);
  const val = document.createElement('span');
  val.className = 'tooltip__val';
  val.textContent = value;
  row.appendChild(val);
  parent.appendChild(row);
}

/* ── Légende ──────────────────────────────────────────────────────────────── */

/**
 * Une légende est toujours présente dès deux séries — l'identité ne repose
 * jamais sur la seule couleur.
 */
function buildLegend(series, { shape = 'line', toggles = null, hidden = null } = {}) {
  const ul = document.createElement('ul');
  ul.className = 'legend';
  for (const s of series) {
    const li = document.createElement('li');
    const makeKey = () => {
      const k = document.createElement('span');
      k.className = shape === 'rect' ? 'legend__key--rect' : 'legend__key--line';
      k.style.background = s.color;
      return k;
    };
    if (toggles) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const on = !hidden.has(s.key);
      btn.setAttribute('aria-pressed', String(on));
      btn.title = on ? `Masquer ${s.name}` : `Afficher ${s.name}`;
      btn.appendChild(makeKey());
      const t = document.createElement('span');
      t.textContent = s.name;
      btn.appendChild(t);
      btn.addEventListener('click', () => toggles(s.key));
      li.appendChild(btn);
    } else {
      li.appendChild(makeKey());
      const t = document.createElement('span');
      t.textContent = s.name;
      li.appendChild(t);
    }
    ul.appendChild(li);
  }
  return ul;
}

/* ── Graphique en courbes, avec réticule ──────────────────────────────────── */

/**
 * @param {object} cfg
 *   xLabels   libellés de l'axe des abscisses
 *   series    [{key, name, color, values:[number|null]}]
 *   fmt       formateur de valeur
 *   endLabel  étiquette directe en fin de courbe (max 4 séries, sinon légende seule)
 *   area      lavis sous la courbe (série unique uniquement)
 */
function renderLineChart(container, cfg) {
  const { xLabels, series, fmt, endLabel = true, area = false, yTitle = null } = cfg;
  container.replaceChildren();
  if (!series.length || !xLabels.length) {
    emptyState(container, 'Aucune donnée sur cette sélection.');
    return;
  }

  if (series.length >= 2) container.appendChild(buildLegend(series, { shape: 'line', ...(cfg.legendToggle || {}) }));

  const wrap = document.createElement('div');
  wrap.className = 'chart';
  container.appendChild(wrap);

  const W = measureWidth(container);
  const plotH = cfg.height || 300;

  let vMin = 0;
  let vMax = 0;
  for (const s of series) for (const v of s.values) {
    if (v === null || !isFinite(v)) continue;
    if (v > vMax) vMax = v;
    if (v < vMin) vMin = v;
  }
  const scale = niceTicks(Math.min(0, vMin), vMax || 1, 5);
  const axisFmt = axisFormatter(fmt, scale.max);

  const yLabels = scale.ticks.map(axisFmt);
  const padL = Math.max(46, Math.max(...yLabels.map((s) => s.length)) * 6.6 + 12);
  // Marge droite : les étiquettes de fin de courbe vivent hors du plot.
  const labelled = endLabel && series.length <= 4;
  const padR = labelled ? 84 : 14;
  const padT = 12;
  const padB = 30;
  const H = plotH + padT + padB;
  const plotW = Math.max(60, W - padL - padR);

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    role: 'img', 'aria-label': cfg.ariaLabel || 'Graphique en courbes',
  }, wrap);

  const y = (v) => padT + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const x = pointScale(xLabels.length, plotW, padL);

  // Grille : filets pleins, jamais tiretés.
  for (const t of scale.ticks) {
    const yy = y(t);
    el('line', { class: 'grid-line', x1: padL, x2: padL + plotW, y1: yy, y2: yy }, svg);
    textNode('text', { class: 'axis-label', x: padL - 8, y: yy + 3.5, 'text-anchor': 'end' },
      axisFmt(t), svg);
  }
  if (yTitle) {
    textNode('text', { class: 'axis-title', x: padL, y: padT - 2, 'text-anchor': 'start' }, yTitle, svg);
  }

  // Axe des abscisses : la densité de graduations se déduit de la largeur réelle
  // des libellés, pas d'un nombre fixe — « sem. du 18 mai » dans une carte
  // étroite ne tient pas sept fois.
  const xLabelW = Math.max(...xLabels.map((s) => s.length)) * 5.7 + 16;
  const maxTicks = Math.max(2, Math.floor(plotW / xLabelW));
  const stepX = Math.max(1, Math.ceil(xLabels.length / maxTicks));

  el('line', { class: 'axis-line', x1: padL, x2: padL + plotW, y1: padT + plotH, y2: padT + plotH }, svg);

  const drawn = [];
  for (let i = 0; i < xLabels.length; i += stepX) {
    textNode('text', { class: 'axis-label', x: x(i), y: padT + plotH + 17, 'text-anchor': 'middle' },
      xLabels[i], svg);
    drawn.push(i);
  }
  // La dernière borne n'est ajoutée que si elle ne heurte pas la précédente.
  // Elle est alignée à droite (donc étendue vers la gauche sur toute sa largeur)
  // alors que les autres sont centrées : il faut la demi-largeur de la
  // précédente plus la largeur entière de celle-ci, soit 1,5 largeur.
  const lastIdx = xLabels.length - 1;
  const lastDrawn = drawn[drawn.length - 1];
  if (lastDrawn !== lastIdx && x(lastIdx) - x(lastDrawn) >= xLabelW * 1.5) {
    textNode('text', {
      class: 'axis-label', x: x(lastIdx), y: padT + plotH + 17, 'text-anchor': 'end',
    }, xLabels[lastIdx], svg);
  }

  // Lavis d'aire à ~10 % : un voile, jamais un bloc saturé.
  if (area && series.length === 1) {
    const s = series[0];
    const pts = s.values.map((v, i) => (v === null || !isFinite(v) ? null : [x(i), y(v)]));
    const solid = pts.filter(Boolean);
    if (solid.length > 1) {
      const d = linePath(pts) + ` L${solid[solid.length - 1][0].toFixed(1)},${y(scale.min).toFixed(1)}`
              + ` L${solid[0][0].toFixed(1)},${y(scale.min).toFixed(1)} Z`;
      el('path', { d, fill: s.color, 'fill-opacity': 0.10, stroke: 'none' }, svg);
    }
  }

  // Courbes : 2px, jointures et extrémités arrondies.
  const ends = [];
  for (const s of series) {
    const pts = s.values.map((v, i) => (v === null || !isFinite(v) ? null : [x(i), y(v)]));
    el('path', {
      d: linePath(pts), fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }, svg);

    // Une série d'un seul point n'a pas de trait : on la matérialise par un point.
    const solid = pts.filter(Boolean);
    if (solid.length === 1) {
      el('circle', { cx: solid[0][0], cy: solid[0][1], r: 4, fill: s.color,
        stroke: cssVar('--surface-1'), 'stroke-width': 2 }, svg);
    }

    if (labelled && solid.length) {
      const last = solid[solid.length - 1];
      el('circle', { cx: last[0], cy: last[1], r: 4, fill: s.color,
        stroke: cssVar('--surface-1'), 'stroke-width': 2 }, svg);
      ends.push({ s, pt: last, value: [...s.values].reverse().find((v) => v !== null && isFinite(v)) });
    }
  }

  // Quand les courbes convergent, les étiquettes de fin se chevauchent. Les
  // décaler verticalement les détacherait de leur courbe et se lirait comme du
  // bruit : on les abandonne alors au profit de la légende et de l'infobulle
  // (les points de fin, eux, restent).
  const sortedEnds = [...ends].sort((a, b) => a.pt[1] - b.pt[1]);
  const collide = sortedEnds.some((e, i) =>
    i > 0 && Math.abs(e.pt[1] - sortedEnds[i - 1].pt[1]) < 13);

  if (!collide) {
    for (const e of ends) {
      textNode('text', {
        class: 'mark-label', x: e.pt[0] + 9, y: e.pt[1] + 3.5, 'text-anchor': 'start',
      }, axisFmt(e.value), svg);
    }
  }

  // ── Couche de survol : le réticule trouve l'abscisse ─────────────────────
  const crosshair = el('line', {
    class: 'crosshair', y1: padT, y2: padT + plotH, x1: -99, x2: -99, style: 'display:none',
  }, svg);
  const focus = el('g', { style: 'display:none' }, svg);
  const dots = series.map((s) => el('circle', {
    r: 4.5, fill: s.color, stroke: cssVar('--surface-1'), 'stroke-width': 2,
  }, focus));

  const overlay = el('rect', {
    class: 'hit', x: padL, y: padT, width: plotW, height: plotH,
    tabindex: 0, role: 'slider', 'aria-label': 'Parcourir les valeurs du graphique',
    'aria-valuemin': 0, 'aria-valuemax': xLabels.length - 1,
  }, svg);

  let active = -1;
  const showAt = (i, cx, cy) => {
    active = i;
    const px = x(i);
    crosshair.setAttribute('x1', px);
    crosshair.setAttribute('x2', px);
    crosshair.style.display = '';
    focus.style.display = '';
    series.forEach((s, si) => {
      const v = s.values[i];
      if (v === null || !isFinite(v)) { dots[si].style.display = 'none'; return; }
      dots[si].style.display = '';
      dots[si].setAttribute('cx', px);
      dots[si].setAttribute('cy', y(v));
    });
    overlay.setAttribute('aria-valuenow', i);
    overlay.setAttribute('aria-valuetext',
      `${xLabels[i]} — ` + series.map((s) => `${s.name} ${fmt(s.values[i])}`).join(', '));

    // Une seule infobulle, toutes les séries : le pointeur n'a jamais à viser une courbe.
    Tip.show(cx, cy, (n) => {
      tipHead(n, cfg.xFull ? cfg.xFull[i] : xLabels[i]);
      const rows = series.map((s) => ({ s, v: s.values[i] }))
        .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity));
      for (const { s, v } of rows) {
        tipRow(n, { name: s.name, value: v === null || !isFinite(v) ? '—' : fmt(v), color: s.color });
      }
      if (series.length > 1 && cfg.tipTotal !== false) {
        const sum = series.reduce((a, s) => a + (isFinite(s.values[i]) ? s.values[i] : 0), 0);
        if (cfg.summable !== false) tipRow(n, { name: 'Total', value: fmt(sum), total: true });
      }
    });
  };

  const idxFromEvent = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    if (xLabels.length <= 1) return 0;
    const step = plotW / (xLabels.length - 1);
    return Math.max(0, Math.min(xLabels.length - 1, Math.round((px - padL) / step)));
  };

  overlay.addEventListener('pointermove', (ev) => showAt(idxFromEvent(ev), ev.clientX, ev.clientY));
  overlay.addEventListener('pointerdown', (ev) => showAt(idxFromEvent(ev), ev.clientX, ev.clientY));
  overlay.addEventListener('pointerleave', () => {
    crosshair.style.display = 'none';
    focus.style.display = 'none';
    Tip.hide();
  });
  // Le focus clavier donne exactement ce que donne le survol.
  overlay.addEventListener('focus', () => {
    const r = svg.getBoundingClientRect();
    const i = active >= 0 ? active : xLabels.length - 1;
    showAt(i, r.left + (x(i) / W) * r.width, r.top + r.height / 2);
  });
  overlay.addEventListener('blur', () => {
    crosshair.style.display = 'none';
    focus.style.display = 'none';
    Tip.hide();
  });
  overlay.addEventListener('keydown', (ev) => {
    let i = active >= 0 ? active : xLabels.length - 1;
    if (ev.key === 'ArrowRight') i = Math.min(xLabels.length - 1, i + 1);
    else if (ev.key === 'ArrowLeft') i = Math.max(0, i - 1);
    else if (ev.key === 'Home') i = 0;
    else if (ev.key === 'End') i = xLabels.length - 1;
    else return;
    ev.preventDefault();
    const r = svg.getBoundingClientRect();
    showAt(i, r.left + (x(i) / W) * r.width, r.top + r.height / 2);
  });
}

/* ── Barres horizontales ──────────────────────────────────────────────────── */

/**
 * Série unique → une seule teinte (créneau 1). Aucune rampe de valeur sur des
 * catégories nominales : la longueur porte déjà la grandeur.
 */
function renderBarChart(container, cfg) {
  const { items, fmt, color } = cfg;
  container.replaceChildren();
  if (!items.length) {
    emptyState(container, 'Aucune donnée sur cette sélection.');
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'chart';
  container.appendChild(wrap);

  const W = measureWidth(container);
  // Des campagnes homonymes dans plusieurs comptes rendent le nom seul ambigu :
  // le compte prend alors une seconde ligne sous le nom.
  const twoLine = items.some((i) => i.sub2);
  const rowH = twoLine ? 42 : 30;
  const barH = 24;   // plafonné : jamais toute la bande, le reste est de l'air
  const padT = 6;
  const padB = 6;
  const H = items.length * rowH + padT + padB;

  const NAME_MAX = 34;
  const SUB_MAX = 26;
  // Troncature par le milieu : les conventions de nommage publicitaires
  // préfixent lourdement (« [FR] - [SC] - [HM] - … »), si bien que couper la fin
  // rend toutes les lignes identiques. Les deux extrémités portent le sens.
  const trunc = (s, n) => {
    if (s.length <= n) return s;
    const head = Math.ceil((n - 1) * 0.45);
    const tail = n - 1 - head;
    return s.slice(0, head) + '…' + s.slice(s.length - tail);
  };

  const nameW = Math.max(...items.map((i) => trunc(i.label, NAME_MAX).length)) * 6.6;
  const subW = twoLine
    ? Math.max(...items.map((i) => trunc(i.sub2 || '', SUB_MAX).length)) * 6.0
    : 0;
  const padL = Math.min(250, Math.max(90, Math.max(nameW, subW) + 14));

  const maxV = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  const axisFmt = axisFormatter(fmt, maxV);
  const padR = Math.min(160, Math.max(...items.map((i) => axisFmt(i.value).length)) * 6.9 + 16);
  const plotW = Math.max(40, W - padL - padR);

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    role: 'img', 'aria-label': cfg.ariaLabel || 'Diagramme à barres',
  }, wrap);

  items.forEach((it, i) => {
    const yTop = padT + i * rowH + (rowH - barH) / 2;
    const w = (Math.abs(it.value) / maxV) * plotW;

    // Nom tronqué avec ellipsis — le nom complet vit dans l'infobulle et le tableau.
    if (twoLine) {
      textNode('text', {
        class: 'axis-name', x: padL - 10, y: yTop + barH / 2 - 2, 'text-anchor': 'end',
      }, trunc(it.label, NAME_MAX), svg);
      if (it.sub2) {
        textNode('text', {
          class: 'axis-sublabel', x: padL - 10, y: yTop + barH / 2 + 11, 'text-anchor': 'end',
        }, trunc(it.sub2, SUB_MAX), svg);
      }
    } else {
      textNode('text', {
        class: 'axis-label', x: padL - 10, y: yTop + barH / 2 + 3.5, 'text-anchor': 'end',
      }, trunc(it.label, NAME_MAX), svg);
    }

    const g = el('g', {}, svg);
    const path = el('path', {
      class: 'bar-mark', d: barPath(padL, yTop, w, barH, 4, 'h'), fill: color,
    }, g);

    // Valeur au bout de la barre, hors de la barre : jamais rognée.
    textNode('text', {
      class: 'mark-label', x: padL + w + 8, y: yTop + barH / 2 + 3.5, 'text-anchor': 'start',
    }, axisFmt(it.value), svg);

    // La cible de survol dépasse la marque et atteint 24px de haut.
    const hit = el('rect', {
      class: 'hit hit--mark', x: 0, y: padT + i * rowH, width: W,
      height: Math.max(24, rowH), tabindex: 0, role: 'button',
      'aria-label': `${it.label} — ${fmt(it.value)}`,
    }, svg);

    const show = (cx, cy) => {
      path.classList.add('bar-mark--hover');
      Tip.show(cx, cy, (n) => {
        tipHead(n, it.label);
        if (it.sub) {
          const p = document.createElement('div');
          p.className = 'tooltip__name';
          p.textContent = it.sub;
          n.appendChild(p);
        }
        for (const r of (it.rows || [{ name: cfg.metricLabel || 'Valeur', value: fmt(it.value) }])) {
          tipRow(n, { name: r.name, value: r.value, color: r.color || color });
        }
      });
    };
    const hide = () => { path.classList.remove('bar-mark--hover'); Tip.hide(); };

    hit.addEventListener('pointermove', (ev) => show(ev.clientX, ev.clientY));
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => {
      const r = hit.getBoundingClientRect();
      show(r.left + r.width / 2, r.top + r.height / 2);
    });
    hit.addEventListener('blur', hide);
  });
}

/* ── Barres empilées horizontales ─────────────────────────────────────────── */

function renderStackedBars(container, cfg) {
  const { rows, series, fmt } = cfg;
  container.replaceChildren();
  if (!rows.length || !series.length) {
    emptyState(container, 'Aucune donnée sur cette sélection.');
    return;
  }

  container.appendChild(buildLegend(series, { shape: 'rect', ...(cfg.legendToggle || {}) }));

  const wrap = document.createElement('div');
  wrap.className = 'chart';
  container.appendChild(wrap);

  const W = measureWidth(container);
  const rowH = 34;
  const barH = Math.min(24, rowH - 10);
  const padT = 6;
  const H = rows.length * rowH + padT + 6;

  const LABEL_MAX = 28;
  const shorten = (s) => {
    if (s.length <= LABEL_MAX) return s;
    const head = Math.ceil((LABEL_MAX - 1) * 0.55);
    return s.slice(0, head) + '…' + s.slice(s.length - (LABEL_MAX - 1 - head));
  };
  const maxLabel = Math.min(LABEL_MAX, Math.max(...rows.map((r) => shorten(r.label).length)));
  const padL = Math.min(220, Math.max(90, maxLabel * 6.6));
  const totals = rows.map((r) => series.reduce((a, s) => a + (r.values[s.key] || 0), 0));
  const maxTotal = Math.max(...totals, 1);
  const axisFmt = axisFormatter(fmt, maxTotal);
  const padR = Math.max(...totals.map((t) => axisFmt(t).length)) * 6.9 + 16;
  const plotW = Math.max(40, W - padL - Math.min(150, padR));

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    role: 'img', 'aria-label': cfg.ariaLabel || 'Barres empilées',
  }, wrap);

  const GAP = 2;   // 2px de surface entre segments : c'est le blanc qui sépare

  rows.forEach((r, ri) => {
    const yTop = padT + ri * rowH + (rowH - barH) / 2;
    const total = totals[ri];
    const short = shorten(r.label);
    textNode('text', {
      class: 'axis-label', x: padL - 10, y: yTop + barH / 2 + 3.5, 'text-anchor': 'end',
    }, short, svg);

    const full = (total / maxTotal) * plotW;
    const visible = series.filter((s) => (r.values[s.key] || 0) > 0);
    const gaps = Math.max(0, visible.length - 1) * GAP;
    const usable = Math.max(0, full - gaps);

    let cx = padL;
    visible.forEach((s, si) => {
      const v = r.values[s.key] || 0;
      const w = total ? (v / total) * usable : 0;
      const first = si === 0;
      const last = si === visible.length - 1;

      // Extrémité arrondie seulement au bout du cumul ; carrée côté base.
      let d;
      if (last && w > 0.5) d = barPath(cx, yTop, w, barH, 4, 'h');
      else d = `M${cx},${yTop} h${Math.max(w, 0)} v${barH} h${-Math.max(w, 0)} Z`;
      if (first && !last) d = `M${cx},${yTop} h${Math.max(w, 0)} v${barH} h${-Math.max(w, 0)} Z`;

      const seg = el('path', { class: 'bar-mark', d, fill: s.color }, svg);

      const hit = el('rect', {
        class: 'hit hit--mark', x: cx, y: padT + ri * rowH, width: Math.max(w, 1),
        height: Math.max(24, rowH), tabindex: 0, role: 'button',
        'aria-label': `${r.label}, ${s.name} — ${fmt(v)}`,
      }, svg);

      const show = (mx, my) => {
        seg.classList.add('bar-mark--hover');
        Tip.show(mx, my, (n) => {
          tipHead(n, r.label);
          for (const s2 of series) {
            const v2 = r.values[s2.key] || 0;
            if (!v2) continue;
            tipRow(n, {
              name: s2.name + (total ? ` · ${nf0.format((v2 / total) * 100)} %` : ''),
              value: fmt(v2), color: s2.color,
            });
          }
          tipRow(n, { name: 'Total', value: fmt(total), total: true });
        });
      };
      const hide = () => { seg.classList.remove('bar-mark--hover'); Tip.hide(); };
      hit.addEventListener('pointermove', (ev) => show(ev.clientX, ev.clientY));
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('focus', () => {
        const b = hit.getBoundingClientRect();
        show(b.left + b.width / 2, b.top + b.height / 2);
      });
      hit.addEventListener('blur', hide);

      cx += w + GAP;
    });

    // Total au bout de la barre : la seule étiquette directe, hors du cumul.
    textNode('text', {
      class: 'mark-label', x: padL + full + 9, y: yTop + barH / 2 + 3.5, 'text-anchor': 'start',
    }, axisFmt(total), svg);
  });
}

/* ── Nuage de points ──────────────────────────────────────────────────────── */

function renderScatter(container, cfg) {
  const { points, xFmt, yFmt, xLabel, yLabel, color } = cfg;
  container.replaceChildren();
  if (!points.length) {
    emptyState(container, 'Aucune donnée sur cette sélection.');
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'chart';
  container.appendChild(wrap);

  const W = measureWidth(container);
  const plotH = cfg.height || 288;

  const xs = niceTicks(0, Math.max(...points.map((p) => p.x), 1), 5);
  const ys = niceTicks(0, Math.max(...points.map((p) => p.y), 1), 5);

  // Les graduations sont des nombres ronds : un axe de conversions affiche
  // « 500 », pas « 500,0 ». D'où un formateur d'axe distinct de l'infobulle.
  const xAxisFmt = axisFormatter(cfg.xAxisFmt || xFmt, xs.max);
  const yAxisFmt = axisFormatter(cfg.yAxisFmt || yFmt, ys.max);

  const yTexts = ys.ticks.map(yAxisFmt);
  const padL = Math.max(46, Math.max(...yTexts.map((s) => s.length)) * 6.6 + 12);
  const padR = 16;
  const padT = 20;   // de l'air pour le titre de l'axe des ordonnées
  const padB = 44;
  const H = plotH + padT + padB;
  const plotW = Math.max(60, W - padL - padR);

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    role: 'img', 'aria-label': cfg.ariaLabel || 'Nuage de points',
  }, wrap);

  const X = (v) => padL + ((v - xs.min) / (xs.max - xs.min || 1)) * plotW;
  const Y = (v) => padT + plotH - ((v - ys.min) / (ys.max - ys.min || 1)) * plotH;

  for (const t of ys.ticks) {
    const yy = Y(t);
    el('line', { class: 'grid-line', x1: padL, x2: padL + plotW, y1: yy, y2: yy }, svg);
    textNode('text', { class: 'axis-label', x: padL - 8, y: yy + 3.5, 'text-anchor': 'end' },
      yAxisFmt(t), svg);
  }
  el('line', { class: 'axis-line', x1: padL, x2: padL + plotW, y1: padT + plotH, y2: padT + plotH }, svg);
  for (const t of xs.ticks) {
    textNode('text', { class: 'axis-label', x: X(t), y: padT + plotH + 17, 'text-anchor': 'middle' },
      xAxisFmt(t), svg);
  }
  textNode('text', {
    class: 'axis-title', x: padL + plotW, y: padT + plotH + 34, 'text-anchor': 'end',
  }, xLabel, svg);
  // Titre au-dessus du plot : à gauche il chevaucherait les graduations.
  textNode('text', { class: 'axis-title', x: padL, y: padT - 8, 'text-anchor': 'start' }, yLabel, svg);

  // Anneau de 2px en couleur de surface : les points restent lisibles en chevauchement.
  const marks = points.map((p) => el('circle', {
    cx: X(p.x), cy: Y(p.y), r: 5, fill: color,
    stroke: cssVar('--surface-1'), 'stroke-width': 2,
  }, svg));

  // Couche du point le plus proche : le pointeur n'a qu'à être le plus près,
  // jamais pile au centre d'un disque de 10px.
  const overlay = el('rect', {
    class: 'hit', x: padL, y: padT, width: plotW, height: plotH, tabindex: 0,
    'aria-label': `Nuage de points, ${points.length} campagnes. Utilisez la vue tableau pour lire chaque valeur.`,
  }, svg);

  let hovered = -1;
  const highlight = (i) => {
    if (hovered === i) return;
    if (hovered >= 0) marks[hovered].setAttribute('r', 5);
    hovered = i;
    if (i >= 0) marks[i].setAttribute('r', 7);
  };

  overlay.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect();
    const mx = ((ev.clientX - r.left) / r.width) * W;
    const my = ((ev.clientY - r.top) / r.height) * H;
    let best = -1;
    let bestD = Infinity;
    points.forEach((p, i) => {
      const dx = X(p.x) - mx;
      const dy = Y(p.y) - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    });
    // ~28px de rayon d'accroche, en unités du viewBox.
    if (best < 0 || bestD > 28 * 28) { highlight(-1); Tip.hide(); return; }
    highlight(best);
    const p = points[best];
    Tip.show(ev.clientX, ev.clientY, (n) => {
      tipHead(n, p.name);
      if (p.sub) {
        const s = document.createElement('div');
        s.className = 'tooltip__name';
        s.textContent = p.sub;
        n.appendChild(s);
      }
      for (const row of p.rows) tipRow(n, { name: row.name, value: row.value, color });
    });
  });
  overlay.addEventListener('pointerleave', () => { highlight(-1); Tip.hide(); });
  overlay.addEventListener('blur', () => { highlight(-1); Tip.hide(); });
}

/* ── Sparkline ────────────────────────────────────────────────────────────── */

/** ~14 points : au-delà, la courbe se referme sur 68px et ne raconte plus rien. */
function downsample(values, target = 14) {
  if (values.length <= target) return values;
  const size = values.length / target;
  const out = [];
  for (let i = 0; i < target; i++) {
    const slice = values.slice(Math.floor(i * size), Math.max(Math.floor((i + 1) * size), Math.floor(i * size) + 1));
    const ok = slice.filter((v) => isFinite(v));
    out.push(ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : NaN);
  }
  return out;
}

function sparkline(rawValues, { w = 68, h = 24 } = {}) {
  const values = downsample(rawValues);
  const pts = values.filter((v) => isFinite(v));
  if (pts.length < 2) return null;
  const svg = el('svg', { class: 'kpi__spark', width: w, height: h, viewBox: `0 0 ${w} ${h}`,
    'aria-hidden': 'true', focusable: 'false' });
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const step = w / (values.length - 1);
  const coords = values.map((v, i) => (isFinite(v) ? [i * step, h - 2 - ((v - min) / span) * (h - 4)] : null));
  el('path', {
    d: linePath(coords), fill: 'none', stroke: cssVar('--seq-250'), 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }, svg);
  const last = coords.filter(Boolean).pop();
  if (last) el('circle', { cx: last[0], cy: last[1], r: 2.5, fill: cssVar('--seq-450') }, svg);
  return svg;
}

/* ── Vue tableau (le jumeau de chaque graphique) ──────────────────────────── */

/**
 * @param {object} cfg
 *   cols  [{key, label, text?, fmt?}]
 *   rows  [{...valeurs, _swatch?, _sub?}]
 *   foot  ligne de totaux, optionnelle
 *   sort  {col, dir} + onSort → en-têtes triables
 */
function renderTable(container, cfg) {
  const { cols, rows, foot = null, scroll = false, sort = null, onSort = null } = cfg;
  container.replaceChildren();
  if (!rows.length) {
    emptyState(container, 'Aucune donnée sur cette sélection.');
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = scroll ? 'table-scroll' : 'table-wrap';
  const table = document.createElement('table');
  table.className = 'data';
  if (cfg.caption) {
    const cap = document.createElement('caption');
    cap.className = 'sr-only';
    cap.textContent = cfg.caption;
    table.appendChild(cap);
  }

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const c of cols) {
    const th = document.createElement('th');
    th.scope = 'col';
    if (c.text) th.className = 'txt';
    if (onSort) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const t = document.createElement('span');
      t.textContent = c.label;
      btn.appendChild(t);
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent = sort && sort.col === c.key ? (sort.dir < 0 ? '▼' : '▲') : '';
      btn.appendChild(arrow);
      if (sort && sort.col === c.key) {
        th.setAttribute('aria-sort', sort.dir < 0 ? 'descending' : 'ascending');
      }
      btn.addEventListener('click', () => onSort(c.key));
      th.appendChild(btn);
    } else {
      th.textContent = c.label;
    }
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    cols.forEach((c, ci) => {
      const td = document.createElement('td');
      if (c.text) td.className = 'txt';
      const raw = r[c.key];
      if (ci === 0 && (r._swatch || r._sub)) {
        const box = document.createElement('span');
        box.className = 'cell-name';
        if (r._swatch) {
          const sw = document.createElement('span');
          sw.className = 'cell-swatch';
          sw.style.background = r._swatch;
          box.appendChild(sw);
        }
        const stack = document.createElement('span');
        const main = document.createElement('span');
        main.textContent = c.fmt ? c.fmt(raw) : String(raw ?? '');
        stack.appendChild(main);
        if (r._sub) {
          const sub = document.createElement('span');
          sub.className = 'cell-sub';
          sub.textContent = r._sub;
          stack.appendChild(sub);
        }
        box.appendChild(stack);
        td.appendChild(box);
      } else {
        td.textContent = c.fmt ? c.fmt(raw) : String(raw ?? '');
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  if (foot) {
    const tfoot = document.createElement('tfoot');
    const tr = document.createElement('tr');
    for (const c of cols) {
      const td = document.createElement('td');
      if (c.text) td.className = 'txt';
      const raw = foot[c.key];
      td.textContent = raw === undefined || raw === null ? '' : (c.fmt ? c.fmt(raw) : String(raw));
      tr.appendChild(td);
    }
    tfoot.appendChild(tr);
    table.appendChild(tfoot);
  }

  wrap.appendChild(table);
  container.appendChild(wrap);
}

/* ── Rendu : indicateurs clés ─────────────────────────────────────────────── */

function renderKpis(sel) {
  const cur = totalsOf(sel.cur);
  const prev = totalsOf(sel.pre);
  const hasPrev = sel.pre.length > 0;

  // Séries journalières pour les sparklines, sur la période courante.
  const byDate = groupBy(sel.cur, (f) => f[F.DATE]);
  const dayKeys = [];
  for (let i = sel.lo; i <= sel.hi; i++) dayKeys.push(i);

  els.kpiGrid.replaceChildren();

  for (const key of KPI_ORDER) {
    const m = METRICS[key];
    const value = m.calc(cur);

    const tile = document.createElement('div');
    tile.className = 'kpi';

    const lab = document.createElement('div');
    lab.className = 'kpi__label';
    lab.textContent = m.label;
    tile.appendChild(lab);

    const val = document.createElement('div');
    val.className = 'kpi__value';
    // Compact seulement si la grandeur le justifie : un CPC de 0,83 CHF doit
    // garder ses centimes, un coût de 48 701 CHF devient « 48,7 k ».
    val.textContent = compactly(m.fmt, value);
    tile.appendChild(val);

    const foot = document.createElement('div');
    foot.className = 'kpi__foot';

    const prevVal = m.calc(prev);
    const delta = document.createElement('span');
    if (!hasPrev || !isFinite(prevVal) || prevVal === 0 || !isFinite(value)) {
      delta.className = 'kpi__delta kpi__delta--flat';
      delta.textContent = '—';
      delta.title = hasPrev ? 'Comparaison indisponible' : 'Aucune donnée sur la période précédente';
    } else {
      const pct = (value - prevVal) / Math.abs(prevVal);
      const flat = Math.abs(pct) < 0.005;
      // La direction est portée par le glyphe autant que par la couleur.
      const glyph = flat ? '=' : (pct > 0 ? '↑' : '↓');
      const good = m.dir === 0 || flat ? null : (pct > 0) === (m.dir > 0);
      delta.className = 'kpi__delta ' + (good === null ? 'kpi__delta--flat'
        : good ? 'kpi__delta--good' : 'kpi__delta--bad');
      const g = document.createElement('span');
      g.textContent = glyph;
      delta.appendChild(g);
      const t = document.createElement('span');
      t.textContent = `${nf1.format(Math.abs(pct) * 100)} %`;
      delta.appendChild(t);
      const em = document.createElement('em');
      em.textContent = 'vs préc.';
      delta.appendChild(em);
      delta.title = `Période précédente (${fmtDateLong(sel.prevStart)} – ${fmtDateLong(sel.prevEnd)}) : ${m.fmt(prevVal)}`;
    }
    foot.appendChild(delta);

    const sparkVals = dayKeys.map((di) => {
      const t = byDate.get(di);
      return t ? m.calc(t) : (m.dir === 0 || key === 'clicks' || key === 'conversions' ? 0 : NaN);
    });
    const spark = sparkline(sparkVals);
    if (spark) foot.appendChild(spark);

    tile.appendChild(foot);
    els.kpiGrid.appendChild(tile);
  }

  els.kpiCompare.textContent = hasPrev
    ? `Évolution comparée au ${fmtDateLong(sel.prevStart)} – ${fmtDateLong(sel.prevEnd)}`
    : 'Période précédente hors du jeu de données — évolutions indisponibles';
}

/* ── Rendu : évolution dans le temps ──────────────────────────────────────── */

function tsData(sel) {
  const d = S.data;
  const grain = S.tsGrain;
  const { keys, pos } = timeBuckets(sel.cur, grain);
  const m = METRICS[S.tsMetric];

  const seriesDefs = S.tsMode === 'total'
    ? [{ key: 'total', name: 'Tous les comptes sélectionnés', slot: 1 }]
    : accountSeries().filter((s) => {
        // On n'affiche que les comptes réellement présents dans la sélection.
        if (!S.accounts.size) return true;
        if (s.key === 'other') return [...S.accounts].some(isFolded);
        return S.accounts.has(Number(s.key));
      });

  // Un accumulateur de totaux par (série, bucket) : les indicateurs dérivés
  // (CTR, CPA, ROAS) doivent être calculés sur les totaux agrégés, jamais
  // moyennés depuis des valeurs déjà dérivées.
  const acc = new Map();
  for (const s of seriesDefs) acc.set(s.key, keys.map(() => emptyTotals()));

  for (const f of sel.cur) {
    const bi = pos.get(grainKey(d.dates[f[F.DATE]], grain));
    if (bi === undefined) continue;
    const sk = S.tsMode === 'total' ? 'total' : accountKey(d.campaigns[f[F.CAMP]].account);
    const arr = acc.get(sk);
    if (arr) addFact(arr[bi], f);
  }

  const series = seriesDefs
    .filter((s) => !S.tsHidden.has(s.key))
    .map((s) => ({
      key: s.key,
      name: s.name,
      color: seriesColor(s.slot),
      values: acc.get(s.key).map((t) => {
        const v = m.calc(t);
        // Un bucket sans clic n'a pas de CPC : une valeur nulle mentirait,
        // on coupe la courbe.
        return isFinite(v) ? v : null;
      }),
      totals: acc.get(s.key),
    }));

  return { keys, series, allDefs: seriesDefs, metric: m };
}

function renderTimeSeries(sel) {
  const { keys, series, allDefs, metric } = tsData(sel);
  const grain = S.tsGrain;

  els.tsSub.textContent = `${metric.label} · ${
    { day: 'par jour', week: 'par semaine', month: 'par mois' }[grain]
  } · ${S.tsMode === 'total' ? 'tous comptes confondus' : 'un tracé par compte'}`
    + partialNote(keys, grain);

  if (S.views.ts === 'table') {
    const cols = [{ key: 'bucket', label: grain === 'month' ? 'Mois' : grain === 'week' ? 'Semaine' : 'Jour', text: true }];
    for (const s of series) cols.push({ key: s.key, label: s.name, fmt: (v) => (v === null ? '—' : metric.fmt(v)) });
    const rows = keys.map((k, i) => {
      const r = { bucket: grainLabel(k, grain) };
      for (const s of series) r[s.key] = s.values[i];
      return r;
    });
    renderTable(els.tsBody, {
      cols, rows, scroll: true,
      caption: `${metric.label} ${grain === 'day' ? 'par jour' : grain === 'week' ? 'par semaine' : 'par mois'}`,
    });
    return;
  }

  renderLineChart(els.tsBody, {
    xLabels: keys.map((k) => grainLabel(k, grain)),
    xFull: keys.map((k) => (grain === 'day' ? fmtDateLong(k) : grainLabel(k, grain))),
    series,
    fmt: metric.fmt,
    area: series.length === 1,
    endLabel: true,
    height: 320,
    ariaLabel: `${metric.label} dans le temps`,
    // Additionner des taux (CTR, CPA, ROAS…) n'aurait aucun sens.
    summable: ['cost', 'impressions', 'clicks', 'conversions', 'convValue'].includes(S.tsMetric),
    legendToggle: allDefs.length > 1 ? {
      toggles: (key) => {
        // Ne jamais tout masquer : la dernière série visible reste active.
        if (S.tsHidden.has(key)) S.tsHidden.delete(key);
        else if (allDefs.length - S.tsHidden.size > 1) S.tsHidden.add(key);
        render();
      },
      hidden: S.tsHidden,
    } : null,
  });

  // La légende n'affiche que les séries visibles ; on la reconstruit sur
  // l'ensemble des définitions pour que les séries masquées restent cliquables.
  if (allDefs.length > 1) {
    const legend = els.tsBody.querySelector('.legend');
    const full = buildLegend(
      allDefs.map((s) => ({ key: s.key, name: s.name, color: seriesColor(s.slot) })),
      {
        shape: 'line',
        hidden: S.tsHidden,
        toggles: (key) => {
          if (S.tsHidden.has(key)) S.tsHidden.delete(key);
          else if (allDefs.length - S.tsHidden.size > 1) S.tsHidden.add(key);
          render();
        },
      }
    );
    if (legend) legend.replaceWith(full);
    else els.tsBody.prepend(full);
  }
}

/* ── Rendu : coût et valeur de conversion ─────────────────────────────────── */

function renderRoi(sel) {
  const d = S.data;
  const grain = S.tsGrain;
  const { keys, pos } = timeBuckets(sel.cur, grain);

  const cost = keys.map(() => 0);
  const value = keys.map(() => 0);
  for (const f of sel.cur) {
    const bi = pos.get(grainKey(d.dates[f[F.DATE]], grain));
    if (bi === undefined) continue;
    cost[bi] += f[F.COST];
    value[bi] += f[F.VALUE];
  }

  // Deux montants dans la même devise : une seule échelle est légitime.
  // (Jamais de second axe : l'alignement de deux échelles est arbitraire.)
  const series = [
    { key: 'cost', name: 'Coût', color: seriesColor(1), values: cost },
    { key: 'value', name: 'Valeur de conversion', color: seriesColor(2), values: value },
  ];

  const tc = cost.reduce((a, b) => a + b, 0);
  const tv = value.reduce((a, b) => a + b, 0);
  els.roiSub.textContent = (tc
    ? `Deux montants en ${CURRENCY}, une seule échelle. ROAS global ${fmtRatio(tv / tc)}.`
    : `Deux montants en ${CURRENCY}, une seule échelle.`) + partialNote(keys, grain);

  if (S.views.roi === 'table') {
    renderTable(els.roiBody, {
      scroll: true,
      caption: 'Coût et valeur de conversion par période',
      cols: [
        { key: 'bucket', label: grain === 'month' ? 'Mois' : grain === 'week' ? 'Semaine' : 'Jour', text: true },
        { key: 'cost', label: 'Coût', fmt: (v) => fmtMoney(v) },
        { key: 'value', label: 'Valeur de conv.', fmt: (v) => fmtMoney(v) },
        { key: 'roas', label: 'ROAS', fmt: (v) => fmtRatio(v) },
      ],
      rows: keys.map((k, i) => ({
        bucket: grainLabel(k, grain), cost: cost[i], value: value[i],
        roas: cost[i] ? value[i] / cost[i] : NaN,
      })),
      foot: { bucket: 'Total', cost: tc, value: tv, roas: tc ? tv / tc : NaN },
    });
    return;
  }

  renderLineChart(els.roiBody, {
    xLabels: keys.map((k) => grainLabel(k, grain)),
    xFull: keys.map((k) => (grain === 'day' ? fmtDateLong(k) : grainLabel(k, grain))),
    series, fmt: fmtMoney, endLabel: true, height: 252, summable: false,
    ariaLabel: 'Coût et valeur de conversion dans le temps',
  });
}

/* ── Rendu : efficacité (nuage de points) ─────────────────────────────────── */

function campaignRows(sel) {
  const d = S.data;
  const byCamp = groupBy(sel.cur, (f) => f[F.CAMP]);
  const out = [];
  for (const [ci, t] of byCamp) {
    const c = d.campaigns[ci];
    out.push({
      idx: ci,
      name: c.name,
      account: d.accounts[c.account]?.name || '—',
      accountIdx: c.account,
      channel: label(CHANNEL_LABELS, c.channel),
      impressions: t.impr,
      clicks: t.clicks,
      cost: t.cost,
      conversions: t.conv,
      convValue: t.value,
      ctr: t.impr ? t.clicks / t.impr : NaN,
      cpc: t.clicks ? t.cost / t.clicks : NaN,
      cpa: t.conv ? t.cost / t.conv : NaN,
      convRate: t.clicks ? t.conv / t.clicks : NaN,
      roas: t.cost ? t.value / t.cost : NaN,
    });
  }
  return out;
}

function renderEfficiency(rows) {
  if (S.views.eff === 'table') {
    renderTable(els.effBody, {
      scroll: true,
      caption: 'Coût et conversions par campagne',
      cols: [
        { key: 'name', label: 'Campagne', text: true },
        { key: 'cost', label: 'Coût', fmt: (v) => fmtMoney(v) },
        { key: 'conversions', label: 'Conv.', fmt: fmtNum1 },
        { key: 'cpa', label: 'CPA', fmt: (v) => fmtMoney(v) },
        { key: 'roas', label: 'ROAS', fmt: fmtRatio },
      ],
      rows: [...rows].sort((a, b) => b.cost - a.cost)
        .map((r) => ({ ...r, _sub: r.account, _swatch: seriesColor(entitySlot(r.accountIdx)) })),
    });
    return;
  }

  // Série unique → une seule teinte. La position porte déjà toute l'information.
  renderScatter(els.effBody, {
    points: rows.map((r) => ({
      x: r.cost, y: r.conversions, name: r.name, sub: `${r.account} · ${r.channel}`,
      rows: [
        { name: 'Coût', value: fmtMoney(r.cost) },
        { name: 'Conversions', value: fmtNum1(r.conversions) },
        { name: 'CPA', value: fmtMoney(r.cpa) },
        { name: 'ROAS', value: fmtRatio(r.roas) },
      ],
    })),
    xFmt: fmtMoney, yFmt: fmtNum1, yAxisFmt: fmtInt,
    xLabel: `Coût (${CURRENCY})`, yLabel: 'Conversions',
    color: seriesColor(1), height: 250,
    ariaLabel: 'Coût face aux conversions, par campagne',
  });
}

/* ── Rendu : principales campagnes ────────────────────────────────────────── */

function renderTop(rows) {
  const m = METRICS[S.topMetric];
  // Un CPA ou un ROAS n'a de sens que sur un volume suffisant : sous 5 clics,
  // le ratio est du bruit et écraserait l'échelle du classement.
  const eligible = ['cpa', 'roas'].includes(S.topMetric)
    ? rows.filter((r) => r.clicks >= 5 && isFinite(m.calc({
        impr: r.impressions, clicks: r.clicks, cost: r.cost, conv: r.conversions, value: r.convValue,
      })))
    : rows;

  const valOf = (r) => {
    const v = r[S.topMetric];
    return isFinite(v) ? v : 0;
  };
  // Pour le CPA, « principales » veut dire les moins chères.
  const asc = S.topMetric === 'cpa';
  const sorted = [...eligible].sort((a, b) => (asc ? valOf(a) - valOf(b) : valOf(b) - valOf(a)));
  const shown = sorted.slice(0, 12);

  els.topSub.textContent = `12 premières sur ${rows.length} campagnes, classées par ${m.label.toLowerCase()}`
    + (asc ? ' croissant' : ' décroissant')
    + (['cpa', 'roas'].includes(S.topMetric) ? ' — campagnes de moins de 5 clics exclues' : '');

  if (S.views.top === 'table') {
    const cols = [
      { key: 'name', label: 'Campagne', text: true },
      { key: 'cost', label: 'Coût', fmt: (v) => fmtMoney(v) },
      { key: 'clicks', label: 'Clics', fmt: (v) => fmtInt(v) },
      { key: 'conversions', label: 'Conv.', fmt: fmtNum1 },
    ];
    // L'indicateur de classement n'est ajouté que s'il n'est pas déjà en colonne :
    // sinon « Coût », qui est le classement par défaut, apparaîtrait deux fois.
    if (!cols.some((c) => c.key === S.topMetric)) {
      cols.push({ key: S.topMetric, label: m.label, fmt: (v) => m.fmt(v) });
    }
    renderTable(els.topBody, {
      cols, scroll: true,
      caption: `Campagnes classées par ${m.label}`,
      rows: sorted.map((r) => ({ ...r, _sub: r.account, _swatch: seriesColor(entitySlot(r.accountIdx)) })),
    });
    return;
  }

  renderBarChart(els.topBody, {
    items: shown.map((r) => ({
      label: r.name,
      value: valOf(r),
      sub2: r.account,   // les noms de campagne se répètent d'un compte à l'autre
      sub: `${r.account} · ${r.channel}`,
      rows: [
        { name: m.label, value: m.fmt(r[S.topMetric]) },
        { name: 'Coût', value: fmtMoney(r.cost) },
        { name: 'Clics', value: fmtInt(r.clicks) },
        { name: 'Conversions', value: fmtNum1(r.conversions) },
      ],
    })),
    fmt: m.fmt, color: seriesColor(1), metricLabel: m.label,
    ariaLabel: `Campagnes classées par ${m.label}`,
  });
}

/* ── Rendu : répartition par compte ───────────────────────────────────────── */

function renderMix(sel) {
  const d = S.data;
  const dim = S.mixDim;
  const dimValues = dim === 'device' ? d.devices : dim === 'network' ? d.networks : null;
  const dimIdx = dim === 'device' ? F.DEV : F.NET;
  const labels = dim === 'device' ? DEVICE_LABELS : NETWORK_LABELS;

  // 3 créneaux au plus sur ce type de découpage : c'est la limite validée
  // pour les comparaisons toutes-paires. Au-delà, la queue est repliée.
  const order = dimValues.map((v, i) => ({ i, v })).slice(0, 8);

  const seriesDefs = order.slice(0, MAX_ENTITY_SLOTS).map((o, k) => ({
    key: String(o.i), name: label(labels, o.v), slot: k + 1,
  }));
  if (order.length > MAX_ENTITY_SLOTS) {
    seriesDefs.push({ key: 'other', name: 'Autres', slot: FOLD_SLOT });
  }
  const dimKey = (i) => (i < MAX_ENTITY_SLOTS ? String(i) : 'other');

  const perAccount = new Map();
  for (const f of sel.cur) {
    const ai = d.campaigns[f[F.CAMP]].account;
    let row = perAccount.get(ai);
    if (!row) perAccount.set(ai, (row = {}));
    const k = dimKey(f[dimIdx]);
    row[k] = (row[k] || 0) + f[F.COST];
  }

  const allRows = [...perAccount.entries()]
    .map(([ai, values]) => ({
      label: d.accounts[ai]?.name || `Compte ${ai}`,
      values,
      total: Object.values(values).reduce((a, b) => a + b, 0),
    }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);

  // Le graphique est plafonné pour rester lisible ; le tableau, lui, reste
  // exhaustif — c'est sa raison d'être.
  const MAX_ROWS = 12;
  let rows = allRows;
  if (allRows.length > MAX_ROWS) {
    const tail = allRows.slice(MAX_ROWS);
    const merged = { label: `Autres (${tail.length} comptes)`, values: {}, total: 0 };
    for (const r of tail) {
      for (const k in r.values) merged.values[k] = (merged.values[k] || 0) + r.values[k];
      merged.total += r.total;
    }
    rows = [...allRows.slice(0, MAX_ROWS), merged];
  }

  const series = seriesDefs
    .filter((s) => !S.mixHidden.has(s.key) && allRows.some((r) => (r.values[s.key] || 0) > 0))
    .map((s) => ({ ...s, color: seriesColor(s.slot) }));

  els.mixSub.textContent = `Coût par compte, ventilé par ${dim === 'device' ? 'appareil' : 'réseau'}`
    + (allRows.length > MAX_ROWS ? ` — ${MAX_ROWS} premiers sur ${allRows.length}` : '');

  if (S.views.mix === 'table') {
    const cols = [{ key: 'label', label: 'Compte', text: true }];
    for (const s of series) cols.push({ key: s.key, label: s.name, fmt: (v) => fmtMoney(v || 0) });
    cols.push({ key: 'total', label: 'Total', fmt: (v) => fmtMoney(v) });
    const foot = { label: 'Total', total: allRows.reduce((a, r) => a + r.total, 0) };
    for (const s of series) foot[s.key] = allRows.reduce((a, r) => a + (r.values[s.key] || 0), 0);
    renderTable(els.mixBody, {
      cols, foot, scroll: true,
      caption: `Coût par compte et par ${dim === 'device' ? 'appareil' : 'réseau'}`,
      rows: allRows.map((r) => ({ label: r.label, total: r.total, ...r.values })),
    });
    return;
  }

  renderStackedBars(els.mixBody, {
    rows, series, fmt: fmtMoney,
    ariaLabel: `Coût par compte ventilé par ${dim === 'device' ? 'appareil' : 'réseau'}`,
    legendToggle: {
      hidden: S.mixHidden,
      toggles: (key) => {
        if (S.mixHidden.has(key)) S.mixHidden.delete(key);
        else if (seriesDefs.length - S.mixHidden.size > 1) S.mixHidden.add(key);
        render();
      },
    },
  });

  // Comme pour l'évolution, la légende doit lister aussi les séries masquées.
  const legend = els.mixBody.querySelector('.legend');
  if (legend) {
    legend.replaceWith(buildLegend(
      seriesDefs.map((s) => ({ key: s.key, name: s.name, color: seriesColor(s.slot) })),
      {
        shape: 'rect', hidden: S.mixHidden,
        toggles: (key) => {
          if (S.mixHidden.has(key)) S.mixHidden.delete(key);
          else if (seriesDefs.length - S.mixHidden.size > 1) S.mixHidden.add(key);
          render();
        },
      }
    ));
  }
}

/* ── Rendu : tableau détaillé ─────────────────────────────────────────────── */

const DETAIL_COLS = [
  { key: 'name',        label: 'Campagne',       text: true },
  { key: 'channel',     label: 'Canal',          text: true },
  { key: 'impressions', label: 'Impressions',    fmt: (v) => fmtInt(v) },
  { key: 'clicks',      label: 'Clics',          fmt: (v) => fmtInt(v) },
  { key: 'ctr',         label: 'CTR',            fmt: fmtPct },
  { key: 'cpc',         label: 'CPC',            fmt: (v) => fmtMoney(v) },
  { key: 'cost',        label: 'Coût',           fmt: (v) => fmtMoney(v) },
  { key: 'conversions', label: 'Conv.',          fmt: fmtNum1 },
  { key: 'convRate',    label: 'Taux conv.',     fmt: fmtPct },
  { key: 'cpa',         label: 'CPA',            fmt: (v) => fmtMoney(v) },
  { key: 'convValue',   label: 'Valeur conv.',   fmt: (v) => fmtMoney(v) },
  { key: 'roas',        label: 'ROAS',           fmt: fmtRatio },
];

let detailRowsCache = [];

function renderDetail(rows, sel) {
  const { col, dir } = S.sort;
  const sorted = [...rows].sort((a, b) => {
    const av = a[col];
    const bv = b[col];
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av).localeCompare(String(bv), 'fr') * -dir;
    }
    // Les valeurs non calculables passent en fin de tri, quel que soit le sens.
    const an = isFinite(av) ? av : -Infinity;
    const bn = isFinite(bv) ? bv : -Infinity;
    return (an - bn) * dir;
  });
  detailRowsCache = sorted;

  const t = totalsOf(sel.cur);
  const foot = {
    name: `Total — ${sorted.length} campagne${sorted.length > 1 ? 's' : ''}`,
    channel: '',
    impressions: t.impr, clicks: t.clicks, cost: t.cost, conversions: t.conv, convValue: t.value,
    ctr: t.impr ? t.clicks / t.impr : NaN,
    cpc: t.clicks ? t.cost / t.clicks : NaN,
    cpa: t.conv ? t.cost / t.conv : NaN,
    convRate: t.clicks ? t.conv / t.clicks : NaN,
    roas: t.cost ? t.value / t.cost : NaN,
  };

  els.detailSub.textContent = `${sorted.length} campagne(s) · ${fmtDateLong(S.start)} – ${fmtDateLong(S.end)}`;

  renderTable(els.detailBody, {
    cols: DETAIL_COLS,
    rows: sorted.map((r) => ({ ...r, _sub: r.account, _swatch: seriesColor(entitySlot(r.accountIdx)) })),
    foot, scroll: true, sort: S.sort,
    caption: 'Détail des performances par campagne',
    onSort: (key) => {
      if (S.sort.col === key) S.sort.dir *= -1;
      else S.sort = { col: key, dir: key === 'name' || key === 'channel' ? 1 : -1 };
      render();
    },
  });
}

/* ── Export CSV ───────────────────────────────────────────────────────────── */

function exportCsv() {
  const cols = [{ key: 'account', label: 'Compte' }, ...DETAIL_COLS];
  const esc = (v) => {
    const s = v === null || v === undefined || (typeof v === 'number' && !isFinite(v)) ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map((c) => esc(c.label)).join(';')];
  for (const r of detailRowsCache) {
    lines.push(cols.map((c) => {
      const v = r[c.key];
      // Décimale virgule : Excel en locale FR/CH lit alors les nombres comme tels.
      return esc(typeof v === 'number' ? String(v.toFixed(4)).replace('.', ',') : v);
    }).join(';'));
  }
  // BOM UTF-8 : sans lui Excel abîme les accents.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `google-ads_${S.start}_${S.end}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* ── Filtres ──────────────────────────────────────────────────────────────── */

function resolveRange() {
  const d = S.data;
  const first = d.dates[0];
  const last = d.dates[d.dates.length - 1];

  if (S.range === 'custom') {
    S.start = S.start && S.start >= first ? S.start : first;
    S.end = S.end && S.end <= last ? S.end : last;
    if (S.start > S.end) S.start = S.end;
    return;
  }
  if (S.range === 'all') { S.start = first; S.end = last; return; }
  if (S.range === 'mtd') {
    S.end = last;
    S.start = `${last.slice(0, 7)}-01`;
    if (S.start < first) S.start = first;
    return;
  }
  const n = Number(S.range) || 30;
  S.end = last;
  const start = addDays(last, -(n - 1));
  S.start = start < first ? first : start;
}

/** Ligne de menu réutilisable : coche 16px en gras pour la sélection. */
function optionRow({ checked, label: text, meta, swatch, onClick, disabled = false }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'optrow';
  btn.setAttribute('aria-pressed', String(!!checked));
  if (disabled) btn.setAttribute('aria-disabled', 'true');

  const chk = document.createElement('span');
  chk.className = 'optrow__check';
  chk.setAttribute('aria-hidden', 'true');
  chk.textContent = checked ? '✓' : '';
  btn.appendChild(chk);

  if (swatch) {
    const sw = document.createElement('span');
    sw.className = 'optrow__swatch';
    sw.style.background = swatch;
    btn.appendChild(sw);
  }

  const lb = document.createElement('span');
  lb.className = 'optrow__label';
  lb.textContent = text;
  btn.appendChild(lb);

  if (meta) {
    const m = document.createElement('span');
    m.className = 'optrow__meta';
    m.textContent = meta;
    btn.appendChild(m);
  }

  if (!disabled) btn.addEventListener('click', onClick);
  return btn;
}

function buildAccountPanel() {
  const panel = els.accountPanel;
  panel.replaceChildren();
  const accs = S.data.accounts;

  // Un MCC peut compter des dizaines de comptes : sans recherche ni tri par
  // dépense, la liste est une corvée de défilement.
  const withSearch = accs.length > 12;
  const q = (S.accountQuery || '').trim().toLowerCase();

  if (withSearch) {
    const box = document.createElement('div');
    box.className = 'dropdown__search';
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'input';
    input.placeholder = 'Rechercher un compte…';
    input.value = S.accountQuery || '';
    input.autocomplete = 'off';
    input.addEventListener('input', () => {
      S.accountQuery = input.value;
      buildAccountPanel();
      // Le panneau est reconstruit : il faut rendre le focus au champ.
      const fresh = panel.querySelector('.dropdown__search input');
      if (fresh) { fresh.focus(); fresh.setSelectionRange(fresh.value.length, fresh.value.length); }
    });
    // Évite que la touche Espace ou Entrée referme le <details> parent.
    input.addEventListener('keydown', (ev) => ev.stopPropagation());
    box.appendChild(input);
    panel.appendChild(box);
  }

  const actifs = S.accountCost.reduce((n, c) => n + (c > 0 ? 1 : 0), 0);

  panel.appendChild(optionRow({
    checked: S.accounts.size === 0,
    label: 'Tous les comptes',
    meta: actifs === accs.length ? `${accs.length}` : `${actifs} actifs / ${accs.length}`,
    onClick: () => { S.accounts.clear(); onFilterChange(); },
  }));
  panel.appendChild(document.createElement('hr')).className = 'dropdown__sep';

  // Les comptes qui dépensent d'abord, du plus gros au plus petit ; les dormants
  // ensuite, désactivés — ils n'ont rien à montrer.
  const order = accs
    .map((a, i) => ({ a, i }))
    .filter(({ a, i }) => !q || a.name.toLowerCase().includes(q) || String(a.id).includes(q))
    .sort((x, y) => (S.accountCost[y.i] - S.accountCost[x.i]) || x.a.name.localeCompare(y.a.name, 'fr'));

  if (!order.length) {
    const none = document.createElement('p');
    none.className = 'dropdown__empty';
    none.textContent = 'Aucun compte ne correspond.';
    panel.appendChild(none);
    return;
  }

  for (const { a, i } of order) {
    const cost = S.accountCost[i] || 0;
    panel.appendChild(optionRow({
      checked: S.accounts.size === 0 || S.accounts.has(i),
      label: a.name,
      meta: cost > 0 ? compactly(fmtMoney, cost) : 'aucune dépense',
      swatch: cost > 0 ? seriesColor(entitySlot(i)) : null,
      disabled: cost <= 0,
      onClick: () => {
        // Premier clic depuis « tous » : on isole le compte cliqué.
        if (S.accounts.size === 0) S.accounts = new Set([i]);
        else if (S.accounts.has(i)) S.accounts.delete(i);
        else S.accounts.add(i);
        onFilterChange();
      },
    }));
  }
}

function buildSetPanel(panel, values, labels, set) {
  panel.replaceChildren();
  panel.appendChild(optionRow({
    checked: set.size === 0,
    label: 'Tous',
    onClick: () => { set.clear(); onFilterChange(); },
  }));
  panel.appendChild(document.createElement('hr')).className = 'dropdown__sep';
  values.forEach((v, i) => {
    panel.appendChild(optionRow({
      checked: set.size === 0 || set.has(i),
      label: label(labels, v),
      onClick: () => {
        // Même geste que pour les comptes : depuis « tous », un clic isole.
        if (set.size === 0) set.add(i);
        else if (set.has(i)) set.delete(i);
        else set.add(i);
        // Tout sélectionné équivaut à aucun filtre.
        if (set.size === values.length) set.clear();
        onFilterChange();
      },
    }));
  });
}

function updateFilterSummaries() {
  const accs = S.data.accounts;
  els.accountSummary.textContent = S.accounts.size === 0
    ? 'Tous les comptes'
    : S.accounts.size === 1
      ? accs[[...S.accounts][0]].name
      : `${S.accounts.size} comptes`;

  els.deviceSummary.textContent = S.devices.size === 0 ? 'Tous'
    : S.devices.size === 1 ? label(DEVICE_LABELS, S.data.devices[[...S.devices][0]])
    : `${S.devices.size} appareils`;

  els.networkSummary.textContent = S.networks.size === 0 ? 'Tous'
    : S.networks.size === 1 ? label(NETWORK_LABELS, S.data.networks[[...S.networks][0]])
    : `${S.networks.size} réseaux`;

  for (const b of els.rangePresets.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.key === S.range));
  }
  els.rangeStart.value = S.start;
  els.rangeEnd.value = S.end;
  els.rangeStart.min = S.data.dates[0];
  els.rangeStart.max = S.data.dates[S.data.dates.length - 1];
  els.rangeEnd.min = S.data.dates[0];
  els.rangeEnd.max = S.data.dates[S.data.dates.length - 1];
}

function buildSegmented(host, options, getActive, onPick) {
  host.replaceChildren();
  for (const o of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.key = o.key;
    b.textContent = o.label;
    b.setAttribute('aria-pressed', String(getActive() === o.key));
    b.addEventListener('click', () => onPick(o.key));
    host.appendChild(b);
  }
}

function fillSelect(sel, keys, active) {
  sel.replaceChildren();
  for (const k of keys) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = METRICS[k].label;
    if (k === active) o.selected = true;
    sel.appendChild(o);
  }
}

function buildViewToggles() {
  for (const host of document.querySelectorAll('.viewtoggle')) {
    const id = host.dataset.viewFor;
    if (!(id in S.views)) S.views[id] = 'chart';
    buildSegmented(host,
      [{ key: 'chart', label: 'Graphique' }, { key: 'table', label: 'Tableau' }],
      () => S.views[id],
      (k) => { S.views[id] = k; render(); });
  }
}

/* ── État dans l'URL : un lien partagé rouvre la même vue ─────────────────── */

function writeHash() {
  const p = new URLSearchParams();
  p.set('r', S.range);
  if (S.range === 'custom') { p.set('s', S.start); p.set('e', S.end); }
  if (S.accounts.size) p.set('a', [...S.accounts].join(','));
  if (S.devices.size) p.set('d', [...S.devices].join(','));
  if (S.networks.size) p.set('n', [...S.networks].join(','));
  if (S.search) p.set('q', S.search);
  if (S.tsMetric !== 'cost') p.set('m', S.tsMetric);
  if (S.tsGrain !== 'day') p.set('g', S.tsGrain);
  if (S.tsMode !== 'account') p.set('v', S.tsMode);
  if (S.topMetric !== 'cost') p.set('t', S.topMetric);
  if (S.mixDim !== 'device') p.set('x', S.mixDim);
  const hash = p.toString();
  // replaceState : on ne pollue pas l'historique à chaque clic de filtre.
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

function readHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return;
  const p = new URLSearchParams(raw);
  const nums = (v) => new Set((v || '').split(',').filter((s) => s !== '').map(Number).filter(Number.isInteger));

  const r = p.get('r');
  if (r) S.range = r;
  if (p.get('s')) S.start = p.get('s');
  if (p.get('e')) S.end = p.get('e');
  if (p.has('a')) S.accounts = nums(p.get('a'));
  if (p.has('d')) S.devices = nums(p.get('d'));
  if (p.has('n')) S.networks = nums(p.get('n'));
  if (p.has('q')) S.search = p.get('q');
  if (METRICS[p.get('m')]) S.tsMetric = p.get('m');
  if (['day', 'week', 'month'].includes(p.get('g'))) S.tsGrain = p.get('g');
  if (['account', 'total'].includes(p.get('v'))) S.tsMode = p.get('v');
  if (METRICS[p.get('t')]) S.topMetric = p.get('t');
  if (['device', 'network'].includes(p.get('x'))) S.mixDim = p.get('x');

  // Un index de compte hors bornes viendrait d'un lien obsolète : on l'ignore.
  const n = S.data.accounts.length;
  S.accounts = new Set([...S.accounts].filter((i) => i >= 0 && i < n));
  S.devices = new Set([...S.devices].filter((i) => i >= 0 && i < S.data.devices.length));
  S.networks = new Set([...S.networks].filter((i) => i >= 0 && i < S.data.networks.length));
}

function onFilterChange() {
  buildAccountPanel();
  buildSetPanel(els.devicePanel, S.data.devices, DEVICE_LABELS, S.devices);
  buildSetPanel(els.networkPanel, S.data.networks, NETWORK_LABELS, S.networks);
  render();
}

/* ── Rendu global ─────────────────────────────────────────────────────────── */

let renderScheduled = false;

function render() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    doRender();
  });
}

function doRender() {
  resolveRange();
  updateFilterSummaries();
  writeHash();

  const sel = selectRows();
  const rows = campaignRows(sel);

  const bits = [`${fmtDateLong(S.start)} – ${fmtDateLong(S.end)}`, `${sel.spanDays} jours`];
  if (S.accounts.size) bits.push(`${S.accounts.size} compte(s) sur ${S.data.accounts.length}`);
  if (S.devices.size) bits.push(`${S.devices.size} appareil(s)`);
  if (S.networks.size) bits.push(`${S.networks.size} réseau(x)`);
  if (S.search.trim()) bits.push(`recherche « ${S.search.trim()} »`);
  bits.push(`${rows.length} campagne(s)`);
  els.filterStatus.textContent = bits.join(' · ');

  renderKpis(sel);
  renderTimeSeries(sel);
  renderRoi(sel);
  renderEfficiency(rows);
  renderTop(rows);
  renderMix(sel);
  renderDetail(rows, sel);
}

/* ── Bandeaux & en-tête ───────────────────────────────────────────────────── */

function setupHeader() {
  const m = S.data.meta;
  const gen = m.generated_at ? new Date(m.generated_at) : null;
  const parts = [
    `${S.data.accounts.length} compte(s)`,
    `${S.data.campaigns.length} campagne(s)`,
    `données du ${fmtDateLong(m.date_start)} au ${fmtDateLong(m.date_end)}`,
  ];
  if (m.currency && m.currency !== 'MIXED') parts.push(`montants en ${m.currency}`);
  els.headerMeta.textContent = parts.join(' · ');

  els.footerMeta.textContent = gen
    ? `Données extraites le ${fmtDateLong(gen.toISOString().slice(0, 10))} à ${
        String(gen.getHours()).padStart(2, '0')}:${String(gen.getMinutes()).padStart(2, '0')} · source : ${
        m.source === 'demo' ? 'jeu de démonstration' : 'Google Ads API'}`
    : '';

  if (m.source === 'demo') els.bannerDemo.hidden = false;

  if (m.currency === 'MIXED') {
    const list = [...new Set(S.data.accounts.map((a) => a.currency))].join(', ');
    els.bannerCurrency.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = 'Comptes en plusieurs devises.';
    els.bannerCurrency.appendChild(strong);
    const span = document.createElement('span');
    span.textContent = `Devises présentes : ${list}. Les totaux inter-comptes (coût, valeur `
      + `de conversion, CPA, ROAS) additionnent des devises différentes et sont donc faux. `
      + `Renseignez report_currency et currency_rates dans scripts/config.json, ou filtrez sur un seul compte.`;
    els.bannerCurrency.appendChild(span);
    els.bannerCurrency.hidden = false;
  }

  if (Array.isArray(m.failed_accounts) && m.failed_accounts.length) {
    els.bannerFailed.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = `${m.failed_accounts.length} compte(s) non récupéré(s).`;
    els.bannerFailed.appendChild(strong);
    const span = document.createElement('span');
    span.textContent = m.failed_accounts.map((f) => f.account).join(' · ')
      + ' — ces comptes sont absents du rapport.';
    els.bannerFailed.appendChild(span);
    els.bannerFailed.hidden = false;
  }
}

function setupTheme() {
  const stored = localStorage.getItem('ads-theme');
  if (stored === 'light' || stored === 'dark') document.documentElement.dataset.theme = stored;

  els.themeToggle.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effective = current === 'light' || current === 'dark' ? current : (systemDark ? 'dark' : 'light');
    const next = effective === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('ads-theme', next);
    // Les couleurs de série sont lues dans le CSS au moment du rendu :
    // il faut redessiner pour que les graphiques suivent le thème.
    render();
  });
}

/* ── Démarrage ────────────────────────────────────────────────────────────── */

function cacheEls() {
  const ids = {
    headerMeta: 'header-meta', footerMeta: 'footer-meta', themeToggle: 'theme-toggle',
    rangePresets: 'range-presets', rangeStart: 'range-start', rangeEnd: 'range-end',
    rangeApply: 'range-apply', rangeCustomWrap: 'range-custom-wrap',
    accountPanel: 'account-panel', accountSummary: 'account-summary',
    devicePanel: 'device-panel', deviceSummary: 'device-summary',
    networkPanel: 'network-panel', networkSummary: 'network-summary',
    campaignSearch: 'campaign-search', filterReset: 'filter-reset', filterStatus: 'filter-status',
    bannerDemo: 'banner-demo', bannerCurrency: 'banner-currency', bannerFailed: 'banner-failed',
    bannerError: 'banner-error',
    kpiGrid: 'kpi-grid', kpiCompare: 'kpi-compare',
    tsBody: 'ts-body', tsSub: 'ts-sub', tsMetric: 'ts-metric', tsGrain: 'ts-grain', tsMode: 'ts-mode',
    roiBody: 'roi-body', roiSub: 'roi-sub', effBody: 'eff-body',
    topBody: 'top-body', topSub: 'top-sub', topMetric: 'top-metric',
    mixBody: 'mix-body', mixSub: 'mix-sub', mixDim: 'mix-dim',
    detailBody: 'detail-body', detailSub: 'detail-sub', exportCsv: 'export-csv',
  };
  for (const k in ids) els[k] = document.getElementById(ids[k]);
}

function showFatal(message) {
  els.bannerError.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = 'Données indisponibles.';
  els.bannerError.appendChild(strong);
  const span = document.createElement('span');
  span.textContent = message;
  els.bannerError.appendChild(span);
  els.bannerError.hidden = false;
  els.headerMeta.textContent = 'Erreur de chargement';
}

function wireControls() {
  buildSegmented(els.rangePresets, RANGE_PRESETS, () => S.range, (k) => {
    S.range = k;
    render();
  });

  els.rangeApply.addEventListener('click', () => {
    const s = els.rangeStart.value;
    const e = els.rangeEnd.value;
    if (!s || !e) return;
    S.range = 'custom';
    S.start = s <= e ? s : e;
    S.end = s <= e ? e : s;
    els.rangeCustomWrap.open = false;
    render();
  });

  fillSelect(els.tsMetric, TS_METRICS, S.tsMetric);
  els.tsMetric.addEventListener('change', () => { S.tsMetric = els.tsMetric.value; render(); });

  fillSelect(els.topMetric, TOP_METRICS, S.topMetric);
  els.topMetric.addEventListener('change', () => { S.topMetric = els.topMetric.value; render(); });

  buildSegmented(els.tsGrain,
    [{ key: 'day', label: 'Jour' }, { key: 'week', label: 'Semaine' }, { key: 'month', label: 'Mois' }],
    () => S.tsGrain, (k) => { S.tsGrain = k; render(); });

  buildSegmented(els.tsMode,
    [{ key: 'account', label: 'Par compte' }, { key: 'total', label: 'Total' }],
    () => S.tsMode, (k) => { S.tsMode = k; render(); });

  buildSegmented(els.mixDim,
    [{ key: 'device', label: 'Appareil' }, { key: 'network', label: 'Réseau' }],
    () => S.mixDim, (k) => { S.mixDim = k; render(); });

  buildViewToggles();

  let searchTimer = null;
  els.campaignSearch.value = S.search;
  els.campaignSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { S.search = els.campaignSearch.value; render(); }, 180);
  });

  els.filterReset.addEventListener('click', () => {
    S.range = '30';
    S.accounts = new Set();
    S.devices = new Set();
    S.networks = new Set();
    S.search = '';
    S.tsHidden = new Set();
    S.mixHidden = new Set();
    els.campaignSearch.value = '';
    onFilterChange();
  });

  els.exportCsv.addEventListener('click', exportCsv);

  // Un clic hors d'un menu le referme.
  document.addEventListener('click', (ev) => {
    for (const d of document.querySelectorAll('details.dropdown[open]')) {
      if (!d.contains(ev.target)) d.open = false;
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    for (const d of document.querySelectorAll('details.dropdown[open]')) d.open = false;
  });

  // Les SVG sont dessinés à une largeur mesurée : il faut redessiner au resize.
  let resizeTimer = null;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  });
  ro.observe(document.querySelector('main'));

  window.addEventListener('beforeprint', () => Tip.hide());
}

async function init() {
  cacheEls();
  Tip.init();
  setupTheme();

  let data;
  try {
    // cache: no-cache → GitHub Pages sert un data.json frais après un push.
    const res = await fetch('data/data.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    data = await res.json();
  } catch (err) {
    showFatal(
      `Impossible de charger data/data.json (${err.message}). `
      + `Générez-le avec « python scripts/gen_demo_data.py » ou « python scripts/fetch_ads_data.py ». `
      + `En local, servez le dossier via « python -m http.server » : ouvrir le fichier en file:// bloque la requête.`
    );
    return;
  }

  if (!data || !Array.isArray(data.facts) || !Array.isArray(data.dates) || !data.dates.length) {
    showFatal('Le fichier data/data.json est vide ou mal formé.');
    return;
  }

  S.data = data;
  // Doit précéder tout rendu : les couleurs de série en dépendent.
  computeAccountSlots();
  CURRENCY = data.meta && data.meta.currency && data.meta.currency !== 'MIXED'
    ? data.meta.currency : (data.accounts[0] && data.accounts[0].currency) || 'EUR';

  setupHeader();
  readHash();
  wireControls();
  onFilterChange();
}

document.addEventListener('DOMContentLoaded', init);
