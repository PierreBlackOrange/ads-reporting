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

/**
 * Encre lisible sur un aplat de couleur.
 *
 * Une étiquette posée *dans* une zone colorée est la seule exception à la règle
 * « le texte ne porte jamais la couleur de série » : on choisit blanc ou noir
 * selon la luminance du fond, pour que le contraste tienne quelle que soit la
 * teinte (le jaune et l'aqua exigent de l'encre sombre, le bleu du blanc).
 */
function inkOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.42 ? '#0b0b0b' : '#ffffff';
}

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

/**
 * Troncature par le milieu.
 *
 * Les conventions de nommage publicitaires préfixent lourdement
 * (« [FR] - [SC] - [HM] - … ») : couper la fin rend toutes les lignes
 * identiques. Ce sont les deux extrémités qui portent le sens.
 */
function shortenMiddle(s, max, headRatio = 0.5) {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * headRatio);
  return s.slice(0, head) + '…' + s.slice(s.length - (max - 1 - head));
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
/** « 2026-07 » → « juil. 2026 ». */
function fmtMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
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
// Le type de correspondance d'une *requête* n'est pas celui d'un mot-clé :
// NEAR_EXACT et NEAR_PHRASE désignent les variantes proches que Google apparie
// sans que l'annonceur les ait écrites. Les nommer « Exact » et « Expression »
// les confondrait avec les ciblages déclarés.
const MATCH_TYPE_LABELS = {
  EXACT: 'Exact', PHRASE: 'Expression', BROAD: 'Large',
  NEAR_EXACT: 'Variante proche (exact)', NEAR_PHRASE: 'Variante proche (expression)',
  AI_MAX: 'AI Max', PERFORMANCE_MAX: 'Performance Max',
  UNKNOWN: 'Inconnu', UNSPECIFIED: 'Non spécifié',
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
  tracking: null,
  trackingState: 'idle', // idle | loading | ready | error
  changelog: null,
  changelogState: 'idle',
  trkDim: 'account',     // account | market
  trkGrain: 'week',
  trkScale: 'index',     // base 100 par défaut : c'est la seule échelle qui
                         // permette de lire des clics et un taux ensemble
  trkLagScale: 'share',
  trkSilent: [],

  gender: null,
  genderState: 'idle',   // idle | loading | ready | error
  // Base 100 par défaut : la question posée à cette carte est « quelle est la
  // composition », pas « qui dépense » — le reste du rapport répond déjà à ça.
  genderScale: 'share',

  aimax: null,
  aimaxState: 'idle',    // idle | loading | ready | error
  aimaxMetric: 'cost',
  aimaxSource: 'all',
  marginMeasure: 'margin',
  // Tri propre à la marge : le tableau de détail garde le sien, les deux
  // répondent à des questions différentes.
  marginSort: { col: 'margin', dir: -1 },
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

/**
 * Graduations logarithmiques : une par puissance de dix couvrant les valeurs.
 *
 * Les bornes sont arrondies à la décade, si bien que l'axe se lit 10, 100,
 * 1 000… plutôt que sur des puissances fractionnaires. Les valeurs nulles ou
 * négatives n'existent pas sur cette échelle : l'appelant filtre en amont, et
 * la borne basse ne descend jamais sous 1 pour éviter une décade vide.
 */
function logTicks(values) {
  const pos = values.filter((v) => v > 0);
  if (!pos.length) return { ticks: [1, 10], min: 1, max: 10 };
  const lo = Math.pow(10, Math.floor(Math.log10(Math.min(...pos))));
  const hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...pos))));
  const min = Math.max(1, lo);
  const max = Math.max(hi, min * 10);
  const ticks = [];
  for (let v = min; v <= max * (1 + 1e-9); v *= 10) ticks.push(v);
  return { ticks, min, max };
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

  // Repères verticaux : marquent des frontières sur l'axe des abscisses (fin de
  // la zone consolidée, déploiement technique…). Trait plein teinté et étiqueté
  // — sans étiquette, un lecteur ne peut pas deviner ce qu'il sépare.
  //
  // `vmarks` accepte plusieurs repères. Au-delà de deux, les étiquettes se
  // chevaucheraient : les traits restent, les libellés partent dans l'infobulle
  // et sous le graphique. Un repère porte alors un numéro, pas un texte — un
  // empilement de mots illisibles ne renseignerait personne.
  const vmarks = (cfg.vmarks || (cfg.vmark ? [cfg.vmark] : []))
    .filter((m) => m && m.at >= 0 && m.at < xLabels.length);
  const labelMarks = vmarks.length <= 2;
  vmarks.forEach((m, mi) => {
    const vx = x(m.at);
    el('line', {
      class: 'threshold-line', x1: vx, x2: vx, y1: padT, y2: padT + plotH,
      ...(m.color ? { stroke: m.color } : {}),
    }, svg);
    const text = labelMarks ? (m.label || '') : (m.tick || String(mi + 1));
    if (text) {
      textNode('text', {
        class: 'threshold-label', x: vx + 5, y: padT + 10, 'text-anchor': 'start',
      }, text, svg);
    }
  });
  // Index des repères par abscisse, pour l'infobulle.
  const marksAt = new Map();
  for (const m of vmarks) {
    if (!marksAt.has(m.at)) marksAt.set(m.at, []);
    marksAt.get(m.at).push(m);
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
      // Les repères de la date survolée : c'est là que se lit la corrélation
      // entre un déploiement technique et une cassure de courbe.
      for (const m of (marksAt.get(i) || [])) {
        tipRow(n, { name: m.label || 'Changement', value: m.tipValue || '', color: m.color });
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
  // Une ligne de référence ajoute une bande sous le graphique pour son libellé.
  const ref = cfg.refLine || null;
  const H = items.length * rowH + padT + padB + (ref ? 18 : 0);

  const NAME_MAX = 34;
  const SUB_MAX = 26;
  const trunc = (s, n) => shortenMiddle(s, n, 0.45);

  const nameW = Math.max(...items.map((i) => trunc(i.label, NAME_MAX).length)) * 6.6;
  const subW = twoLine
    ? Math.max(...items.map((i) => trunc(i.sub2 || '', SUB_MAX).length)) * 6.0
    : 0;
  const padL = Math.min(250, Math.max(90, Math.max(nameW, subW) + 14));

  const maxV = Math.max(...items.map((i) => Math.abs(i.value)), 1,
                        ref ? Math.abs(ref.value) : 0);
  const axisFmt = axisFormatter(fmt, maxV);
  const padR = Math.min(160, Math.max(...items.map((i) => axisFmt(i.value).length)) * 6.9 + 16);
  const plotW = Math.max(40, W - padL - padR);

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    role: 'img', 'aria-label': cfg.ariaLabel || 'Diagramme à barres',
  }, wrap);

  // Tracée avant les barres : un seuil est un fond de scène, pas une donnée.
  // Les barres partent toujours de zéro — le repère donne le point de lecture
  // sans qu'il faille tronquer l'échelle, ce qui fausserait les longueurs.
  if (ref) {
    const rx = padL + (Math.abs(ref.value) / maxV) * plotW;
    const bottom = padT + items.length * rowH;
    el('line', {
      class: 'zero-line', x1: rx, x2: rx, y1: padT, y2: bottom,
      'stroke-dasharray': '4 3',
    }, svg);
    textNode('text', {
      class: 'axis-title', x: rx, y: bottom + 14, 'text-anchor': 'middle',
    }, ref.label, svg);
  }

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
    // Une teinte par marque reste possible quand la question posée oppose une
    // catégorie au reste ; à défaut, série unique et teinte unique.
    const path = el('path', {
      class: 'bar-mark', d: barPath(padL, yTop, w, barH, 4, 'h'), fill: it.color || color,
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

/**
 * Barres empilées horizontales.
 *
 * `normalize` met chaque barre à 100 % de la largeur : les compositions
 * deviennent comparables entre lignes de tailles très différentes, ce qu'une
 * échelle absolue interdit — un compte à 14 k€ n'est qu'un trait à côté d'un
 * compte à 181 k€. Le total absolu reste écrit en bout de barre : sans lui, la
 * normalisation ferait disparaître le fait que l'un pèse treize fois l'autre.
 */
function renderStackedBars(container, cfg) {
  const { rows, series, fmt } = cfg;
  const normalize = !!cfg.normalize;
  // Mode groupé : chaque série a sa propre barre dans la ligne, au lieu d'être
  // empilée. Obligatoire quand les séries sont des alternatives et non des
  // parts d'un tout — empiler « aujourd'hui » et « la semaine dernière »
  // afficherait une somme qui ne veut rien dire.
  const grouped = !!cfg.grouped;
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
  // En groupé, la ligne doit loger une barre par série sans les écraser.
  const rowH = grouped ? Math.max(30, 12 + series.length * 13) : 34;
  const barH = grouped
    ? Math.max(8, Math.floor((rowH - 12) / series.length) - 2)
    : Math.min(24, rowH - 10);
  const padT = 6;
  const H = rows.length * rowH + padT + 6;

  const LABEL_MAX = 28;
  const shorten = (s) => shortenMiddle(s, LABEL_MAX, 0.55);
  const maxLabel = Math.min(LABEL_MAX, Math.max(...rows.map((r) => shorten(r.label).length)));
  const padL = Math.min(220, Math.max(90, maxLabel * 6.6));
  const totals = rows.map((r) => series.reduce((a, s) => a + (r.values[s.key] || 0), 0));
  // En groupé l'échelle est celle de la plus grande valeur unitaire, pas de la
  // somme : sinon toutes les barres seraient écrasées de moitié.
  const maxTotal = grouped
    ? Math.max(...rows.flatMap((r) => series.map((s) => r.values[s.key] || 0)), 1)
    : Math.max(...totals, 1);
  const axisFmt = axisFormatter(fmt, maxTotal);
  const padR = Math.max(...totals.map((t) => axisFmt(t).length)) * 6.9 + 16;
  const plotW = Math.max(40, W - padL - Math.min(150, padR));

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    role: 'img', 'aria-label': cfg.ariaLabel || 'Barres empilées',
  }, wrap);

  const GAP = 2;   // 2px de surface entre segments : c'est le blanc qui sépare

  rows.forEach((r, ri) => {
    const rowTop = padT + ri * rowH;
    const groupH = grouped ? series.length * (barH + 2) - 2 : barH;
    const yTop = rowTop + (rowH - groupH) / 2;
    const total = totals[ri];
    const short = shorten(r.label);
    textNode('text', {
      class: 'axis-label', x: padL - 10, y: rowTop + rowH / 2 + 3.5, 'text-anchor': 'end',
    }, short, svg);

    if (grouped) {
      series.forEach((s, si) => {
        const v = r.values[s.key] || 0;
        const w = (v / maxTotal) * plotW;
        const y = yTop + si * (barH + 2);
        const seg = el('path', {
          class: 'bar-mark', d: barPath(padL, y, w, barH, 3, 'h'), fill: s.color,
        }, svg);
        textNode('text', {
          class: 'mark-label', x: padL + w + 7, y: y + barH / 2 + 3.5,
          'text-anchor': 'start', 'font-size': 10,
        }, axisFmt(v), svg);

        const hit = el('rect', {
          class: 'hit hit--mark', x: 0, y, width: W, height: Math.max(barH, 16),
          tabindex: 0, role: 'button',
          'aria-label': `${r.label}, ${s.name} — ${fmt(v)}`,
        }, svg);
        const show = (mx, my) => {
          seg.classList.add('bar-mark--hover');
          Tip.show(mx, my, (n) => {
            tipHead(n, r.label);
            for (const s2 of series) {
              tipRow(n, { name: s2.name, value: fmt(r.values[s2.key] || 0), color: s2.color });
            }
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
      });
      return;
    }

    const full = normalize ? plotW : (total / maxTotal) * plotW;
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

      // En base 100, la part se lit dans le segment — mais uniquement si elle
      // y tient avec de la marge. Un libellé rogné est pire que pas de libellé ;
      // les parts trop étroites restent dans l'infobulle et le tableau.
      if (normalize && total) {
        const pct = (v / total) * 100;
        const text = `${Math.round(pct)} %`;
        if (w >= text.length * 7.4 + 12) {
          textNode('text', {
            x: cx + w / 2, y: yTop + barH / 2 + 3.5, 'text-anchor': 'middle',
            'font-size': 11, 'font-weight': 600, fill: inkOn(s.color),
          }, text, svg);
        }
      }

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

  // Une légende dès deux séries : sur un nuage de points la couleur est le
  // seul porteur d'identité, elle ne peut pas rester non documentée.
  if (cfg.series && cfg.series.length >= 2) {
    container.appendChild(buildLegend(cfg.series, { shape: 'rect', ...(cfg.legendToggle || {}) }));
  }

  const wrap = document.createElement('div');
  wrap.className = 'chart';
  container.appendChild(wrap);

  const W = measureWidth(container);
  const plotH = cfg.height || 288;

  // Échelle logarithmique optionnelle en abscisse. Les budgets publicitaires
  // s'étalent sur plusieurs ordres de grandeur : une échelle linéaire écrase
  // alors la quasi-totalité des campagnes contre l'axe, et le nuage ne dit plus
  // rien de celles qu'on cherche justement à comparer. Le log ne cache aucune
  // donnée et ne tronque aucune échelle, il redistribue seulement l'espace.
  const xLog = cfg.xScale === 'log';
  const xs = xLog
    ? logTicks(points.map((p) => p.x))
    : niceTicks(0, Math.max(...points.map((p) => p.x), 1), 5);
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

  const lgSpan = xLog ? (Math.log10(xs.max) - Math.log10(xs.min) || 1) : 1;
  const X = xLog
    ? (v) => padL + ((Math.log10(Math.max(v, xs.min)) - Math.log10(xs.min)) / lgSpan) * plotW
    : (v) => padL + ((v - xs.min) / (xs.max - xs.min || 1)) * plotW;
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

  // Seuil optionnel : trait plein teinté, étiqueté — un lecteur ne devine pas
  // où commence la zone problématique.
  const thresholdY = cfg.threshold && cfg.threshold.y !== undefined
    ? Y(cfg.threshold.y) : null;
  if (thresholdY !== null) {
    el('line', { class: 'threshold-line', x1: padL, x2: padL + plotW, y1: thresholdY, y2: thresholdY }, svg);
  }

  // Anneau de 2px en couleur de surface : les points restent lisibles en chevauchement.
  const marks = points.map((p) => el('circle', {
    cx: X(p.x), cy: Y(p.y), r: p.r || 5, fill: p.color || color,
    stroke: cssVar('--surface-1'), 'stroke-width': 2,
  }, svg));

  // Le trait du seuil passe sous les points — c'est un fond de scène — mais son
  // étiquette se pose au-dessus, halo compris : un point tombé pile dessus la
  // rendrait sinon illisible, et un repère qu'on ne peut pas lire n'en est pas un.
  if (thresholdY !== null) {
    textNode('text', {
      class: 'threshold-label', x: padL + plotW, y: thresholdY - 6, 'text-anchor': 'end',
    }, cfg.threshold.label || '', svg);
  }

  // Couche du point le plus proche : le pointeur n'a qu'à être le plus près,
  // jamais pile au centre d'un disque de 10px.
  const overlay = el('rect', {
    class: 'hit', x: padL, y: padT, width: plotW, height: plotH, tabindex: 0,
    'aria-label': `Nuage de points, ${points.length} campagnes. Utilisez la vue tableau pour lire chaque valeur.`,
  }, svg);

  let hovered = -1;
  const baseR = (i) => points[i].r || 5;
  const highlight = (i) => {
    if (hovered === i) return;
    if (hovered >= 0) marks[hovered].setAttribute('r', baseR(hovered));
    hovered = i;
    if (i >= 0) marks[i].setAttribute('r', baseR(i) + 2.5);
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
      for (const row of p.rows) {
        tipRow(n, { name: row.name, value: row.value, color: p.color || color });
      }
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
  // Un ROAS n'existe pas là où la valeur de conversion n'est pas suivie : il
  // vaudrait zéro, ce qui se lirait comme « aucun retour » au lieu de « non
  // mesuré ». Le partage se fait au compte, comme pour la marge — dans un
  // compte qui suit la valeur, une campagne à zéro valeur est un vrai zéro.
  const spending = rows.filter((r) => r.cost > 0);
  const { tracked, untracked } = splitByValueTracking(spending);

  const bits = [`Coût investi face au ROAS obtenu. Chaque point est une campagne.`];
  if (untracked.length) {
    const uCost = untracked.reduce((s, r) => s + r.cost, 0);
    bits.push(
      `${untracked.length} campagne(s) écartée(s), ${compactly(fmtMoney, uCost)} : leur `
      + `compte ne remonte aucune valeur de conversion, leur ROAS serait un zéro `
      + `de mesure et non de résultat.`
    );
  }
  els.effSub.textContent = bits.join(' ');

  if (!tracked.length) {
    emptyState(els.effBody, untracked.length
      ? `Aucun compte de cette sélection ne remonte de valeur de conversion : `
        + `le ROAS n'y est pas mesurable.`
      : 'Aucune dépense sur cette sélection.');
    return;
  }

  if (S.views.eff === 'table') {
    renderTable(els.effBody, {
      scroll: true,
      caption: 'Coût et ROAS par campagne',
      cols: [
        { key: 'name', label: 'Campagne', text: true },
        { key: 'cost', label: 'Coût', fmt: (v) => fmtMoney(v) },
        { key: 'convValue', label: 'Valeur conv.', fmt: (v) => fmtMoney(v) },
        { key: 'roas', label: 'ROAS', fmt: fmtRatio },
        { key: 'conversions', label: 'Conv.', fmt: fmtNum1 },
        { key: 'cpa', label: 'CPA', fmt: (v) => fmtMoney(v) },
      ],
      rows: [...tracked].sort((a, b) => b.cost - a.cost)
        .map((r) => ({ ...r, _sub: r.account, _swatch: seriesColor(entitySlot(r.accountIdx)) })),
    });
    return;
  }

  // Série unique → une seule teinte. La position porte déjà toute l'information.
  renderScatter(els.effBody, {
    points: tracked.map((r) => ({
      x: r.cost, y: r.roas, name: r.name, sub: `${r.account} · ${r.channel}`,
      rows: [
        { name: 'ROAS', value: fmtRatio(r.roas) },
        { name: 'Coût', value: fmtMoney(r.cost) },
        { name: 'Valeur de conv.', value: fmtMoney(r.convValue) },
        { name: 'Conversions', value: fmtNum1(r.conversions) },
        { name: 'CPA', value: fmtMoney(r.cpa) },
      ],
    })),
    xFmt: fmtMoney, yFmt: fmtRatio,
    // Les dépenses vont ici de quelques dizaines à plusieurs dizaines de
    // milliers : en linéaire, la centaine de campagnes qu'on veut comparer
    // s'entasse contre l'axe et le nuage ne montre plus que trois gros points.
    xScale: 'log',
    xLabel: `Coût (${CURRENCY}, échelle logarithmique)`, yLabel: 'ROAS',
    // Sur un ROAS, 1 sépare ce qui rapporte de ce qui coûte : sans ce trait, le
    // lecteur devrait situer le seuil de tête pour chaque point.
    threshold: { y: 1, label: 'seuil de rentabilité' },
    color: seriesColor(1), height: 250,
    ariaLabel: 'Coût face au ROAS, par campagne',
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

/* ════════════════════════════════════════════════════════════════════════════
   Marge par campagne

   Marge = valeur de conversion − coût, sur la période filtrée.

   La mesure ne vaut que si le compte remonte une valeur de conversion. Quand
   il n'en remonte aucune, la marge vaut mécaniquement l'opposé du coût : ce
   serait une perte inventée, pas une perte constatée. Ces campagnes sont donc
   écartées du calcul, et le coût qu'elles représentent est affiché — sans quoi
   « −27 000 » se lirait comme un résultat.

   Le partage se fait au compte et non à la campagne : dans un compte qui suit
   la valeur, une campagne à zéro valeur est une vraie perte, qui doit rester.
   ═══════════════════════════════════════════════════════════════════════════ */

const MARGIN_CHART_ROWS = 14;
/** Part du coût du périmètre sous laquelle un taux de marge n'est plus lisible. */
const MARGIN_RATE_FLOOR = 0.01;

const MARGIN_MEASURES = {
  margin: {
    label: 'Marge',
    calc: (r) => r.convValue - r.cost,
    fmt: fmtMoney,
    axisRight: '→ bénéficiaires', axisLeft: 'déficitaires ←',
  },
  rate: {
    label: 'Taux de marge',
    // Rapportée à la valeur produite : « ce que je garde sur ce que je génère ».
    // Sans valeur, le rapport n'existe pas — il vaut mieux « — » qu'un −100 %
    // qui laisserait croire à une mesure.
    calc: (r) => (r.convValue > 0 ? (r.convValue - r.cost) / r.convValue : NaN),
    fmt: fmtPct,
    axisRight: '→ bénéficiaires', axisLeft: 'déficitaires ←',
  },
};

/**
 * Sépare les campagnes mesurables de celles dont le compte ne suit pas la valeur.
 * Le verdict est rendu sur la sélection courante : un compte sans valeur sur la
 * période filtrée n'est pas mesurable sur cette période, quoi qu'il en soit
 * ailleurs.
 */
function splitByValueTracking(rows) {
  const valueByAccount = new Map();
  for (const r of rows) {
    valueByAccount.set(r.accountIdx, (valueByAccount.get(r.accountIdx) || 0) + r.convValue);
  }
  const tracked = [];
  const untracked = [];
  for (const r of rows) {
    ((valueByAccount.get(r.accountIdx) > 0) ? tracked : untracked).push(r);
  }
  return { tracked, untracked };
}

function renderMargin(rows) {
  const m = MARGIN_MEASURES[S.marginMeasure];
  const { tracked, untracked } = splitByValueTracking(rows.filter((r) => r.cost > 0));

  const enriched = tracked.map((r) => ({
    ...r,
    margin: r.convValue - r.cost,
    marginRate: r.convValue > 0 ? (r.convValue - r.cost) / r.convValue : NaN,
  }));

  const totCost = enriched.reduce((s, r) => s + r.cost, 0);
  const totValue = enriched.reduce((s, r) => s + r.convValue, 0);
  const totMargin = totValue - totCost;
  const winners = enriched.filter((r) => r.margin > 0).length;
  const losers = enriched.filter((r) => r.margin < 0).length;

  const bits = [
    `Valeur de conversion moins coût, sur la période filtrée`,
    `${winners} campagne(s) bénéficiaire(s), ${losers} déficitaire(s)`,
    `marge totale ${fmtMoney(totMargin)}`,
  ];
  if (S.marginMeasure === 'rate') {
    bits.push('taux de marge = marge ÷ valeur de conversion');
  }
  // Le graphique ne montre qu'une tête de liste : le dire, sinon 14 barres se
  // liraient comme l'ensemble du portefeuille.
  if (S.views.margin !== 'table') {
    if (enriched.length > MARGIN_CHART_ROWS) {
      bits.push(`graphique : les ${MARGIN_CHART_ROWS / 2} meilleures et les `
        + `${MARGIN_CHART_ROWS / 2} plus déficitaires`);
    }
    if (S.marginMeasure === 'rate') {
      bits.push(`campagnes sous ${fmtPct(MARGIN_RATE_FLOOR)} du coût total `
        + `écartées du graphique, leur taux serait du bruit`);
    }
  }
  els.marginSub.textContent = bits.join(' · ');

  // Le coût écarté est nommé, pas seulement compté : « 3 campagnes exclues »
  // ne dit pas si l'angle mort pèse 500 EUR ou 50 000.
  if (untracked.length) {
    const uCost = untracked.reduce((s, r) => s + r.cost, 0);
    const uAccounts = [...new Set(untracked.map((r) => r.account))].sort();
    els.marginNote.replaceChildren();
    const s = document.createElement('strong');
    s.textContent = 'Périmètre.';
    els.marginNote.appendChild(s);
    const d = document.createElement('span');
    d.textContent =
      `${untracked.length} campagne(s) écartée(s), ${fmtMoney(uCost)} de coût `
      + `(${fmtPct(totCost + uCost ? uCost / (totCost + uCost) : 0)} du total) : `
      + `leur compte ne remonte aucune valeur de conversion sur cette période, `
      + `leur marge serait l'opposé de leur coût plutôt qu'un résultat. `
      + `Compte(s) concerné(s) : ${uAccounts.join(', ')}.`;
    els.marginNote.appendChild(d);
    els.marginNote.hidden = false;
  } else {
    els.marginNote.hidden = true;
  }

  if (!enriched.length) {
    // Des compteurs à zéro se liraient comme un résultat ; il n'y a pas de
    // mesure du tout.
    els.marginSub.textContent = 'Valeur de conversion moins coût, sur la période filtrée.';
    emptyState(els.marginBody, untracked.length
      ? `Aucun compte de cette sélection ne remonte de valeur de conversion : `
        + `la marge n'y est pas mesurable.`
      : `Aucune dépense sur cette sélection.`);
    return;
  }

  if (S.views.margin === 'table') {
    const { col, dir } = S.marginSort;
    const sorted = [...enriched].sort((a, b) => {
      const av = a[col];
      const bv = b[col];
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv), 'fr') * -dir;
      }
      // Un taux non calculable ne doit pas s'intercaler dans le classement.
      const an = isFinite(av) ? av : -Infinity;
      const bn = isFinite(bv) ? bv : -Infinity;
      return (an - bn) * dir;
    });

    renderTable(els.marginBody, {
      scroll: true,
      caption: 'Marge par campagne',
      cols: MARGIN_COLS,
      sort: S.marginSort,
      onSort: (key) => {
        if (S.marginSort.col === key) S.marginSort.dir *= -1;
        else S.marginSort = { col: key, dir: key === 'name' ? 1 : -1 };
        render();
      },
      rows: sorted.map((r) => ({
        ...r, _sub: r.account, _swatch: seriesColor(entitySlot(r.accountIdx)),
      })),
      foot: {
        name: `Total · ${enriched.length} campagnes`,
        cost: totCost,
        convValue: totValue,
        margin: totMargin,
        marginRate: totValue > 0 ? totMargin / totValue : NaN,
        roas: totCost ? totValue / totCost : NaN,
      },
    });
    return;
  }

  // Graphique : les campagnes qui pèsent le plus dans un sens ou dans l'autre.
  // Le classement se fait sur la valeur absolue, sinon une moitié du graphique
  // ne montrerait que des queues proches de zéro.
  const key = S.marginMeasure === 'rate' ? 'marginRate' : 'margin';

  // Un taux n'a de sens que sur un volume suffisant : 40 EUR de valeur face à
  // 900 EUR de coût donnent −2 000 %, un chiffre exact et sans portée, qui
  // écraserait l'échelle de toutes les autres barres. Le seuil est relatif au
  // périmètre affiché, pour rester valable quel que soit le filtre. Le tableau,
  // lui, garde tout : la colonne Coût y rend le bruit visible.
  const floor = S.marginMeasure === 'rate' ? totCost * MARGIN_RATE_FLOOR : 0;
  const eligible = enriched.filter((r) => isFinite(r[key]) && r.cost >= floor);

  // Les deux extrémités, pas les plus grosses valeurs absolues : classer sur
  // |marge| peut ne remonter que des bénéfices et laisser croire que rien ne
  // perd d'argent. Un graphique divergent doit montrer ses deux versants.
  const ranked = [...eligible].sort((a, b) => b[key] - a[key]);
  const half = Math.floor(MARGIN_CHART_ROWS / 2);
  const shown = ranked.length <= MARGIN_CHART_ROWS
    ? ranked
    : [...ranked.slice(0, half), ...ranked.slice(-half)];

  if (!shown.length) {
    emptyState(els.marginBody, S.marginMeasure === 'rate'
      ? `Aucune campagne ne pèse assez sur cette sélection pour qu'un taux de `
        + `marge y soit lisible. Le tableau les liste toutes.`
      : 'Aucune marge calculable sur cette sélection.');
    return;
  }

  renderDivergingBars(els.marginBody, {
    rows: shown.map((r) => ({
      label: r.name,
      recent: r.convValue, prev: r.cost, delta: r[key],
      examples: [r.account],
    })),
    fmt: m.fmt,
    upLabel: 'Marge positive', downLabel: 'Marge négative',
    axisRight: m.axisRight, axisLeft: m.axisLeft,
    tipRows: (r) => [
      { name: 'Valeur de conversion', value: fmtMoney(r.recent), color: seriesColor(1) },
      { name: 'Coût', value: fmtMoney(r.prev), color: seriesColor(8) },
      { name: m.label, value: (r.delta >= 0 ? '+' : '−') + m.fmt(Math.abs(r.delta)), total: true },
    ],
    ariaLabel: `${m.label} par campagne, des plus fortes aux plus faibles`,
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   AI Max

   AI Max apparaît dans l'API à trois endroits, vérifiés sur cette version via
   GoogleAdsFieldService plutôt que supposés :

     campaign.ai_max_setting.enable_ai_max      activé ou non, par campagne
     segments.search_term_match_type = AI_MAX   requêtes appariées par AI Max
     segments.search_term_match_source          AI_MAX_BROAD_MATCH (élargissement
                                                d'un mot-clé) ou AI_MAX_KEYWORDLESS
                                                (trafic sans aucun mot-clé)

   Le périmètre du jeu de données, ce sont les comptes où AI Max tourne, pas le
   MCC entier : comparer AI Max aux autres correspondances n'a de sens qu'à
   l'intérieur des comptes qui l'ont activé. Ailleurs, sa part serait diluée
   dans un total sans rapport.

   Fenêtre fixe, indépendante du filtre de période — comme les sections
   sémantique et types de correspondance, qui reposent sur le même genre
   d'agrégat pré-calculé. Le filtre de comptes, lui, s'applique.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Colonnes de cells : [compte, type, source, mois, impr, clics, coût, conv, valeur] */
const AX = { ACC: 0, MT: 1, SRC: 2, MONTH: 3, IMPR: 4, CLICKS: 5, COST: 6, CONV: 7, VALUE: 8 };
/* Colonnes de terms : [terme, compte, source, impr, clics, coût, conv, valeur] */
const AT = { TERM: 0, ACC: 1, SRC: 2, IMPR: 3, CLICKS: 4, COST: 5, CONV: 6, VALUE: 7 };
/* Colonnes de campaigns : [nom, compte, activé, impr, clics, coût, conv, valeur] */
const AC = { NAME: 0, ACC: 1, ON: 2, IMPR: 3, CLICKS: 4, COST: 5, CONV: 6, VALUE: 7 };

const AIMAX_TYPE = 'AI_MAX';

/**
 * Mesures disponibles sur la comparaison.
 *
 * Les ratios sont recalculés sur les totaux agrégés, jamais moyennés depuis des
 * ratios déjà dérivés — une moyenne de ROAS n'est pas le ROAS des totaux.
 */
const AIMAX_METRICS = {
  cost:     { label: 'Coût',            calc: (t) => t.cost,                          fmt: fmtMoney, dir: 0 },
  clicks:   { label: 'Clics',           calc: (t) => t.clicks,                        fmt: fmtInt,   dir: 0 },
  impr:     { label: 'Impressions',     calc: (t) => t.impr,                          fmt: fmtInt,   dir: 0 },
  conv:     { label: 'Conversions',     calc: (t) => t.conv,                          fmt: fmtNum1,  dir: 1 },
  value:    { label: 'Valeur de conv.', calc: (t) => t.value,                         fmt: fmtMoney, dir: 1 },
  roas:     { label: 'ROAS',            calc: (t) => (t.cost ? t.value / t.cost : NaN), fmt: fmtRatio, dir: 1 },
  cpa:      { label: 'CPA',             calc: (t) => (t.conv ? t.cost / t.conv : NaN),  fmt: fmtMoney, dir: -1 },
  convRate: { label: 'Taux de conv.',   calc: (t) => (t.clicks ? t.conv / t.clicks : NaN), fmt: fmtPct, dir: 1 },
};

const AIMAX_TERM_ROWS = 20;

const emptyAx = () => ({ impr: 0, clicks: 0, cost: 0, conv: 0, value: 0 });

function addAx(t, row, base) {
  t.impr   += row[base + 0];
  t.clicks += row[base + 1];
  t.cost   += row[base + 2];
  t.conv   += row[base + 3];
  t.value  += row[base + 4];
  return t;
}

/** Indices de comptes AI Max retenus par le filtre du haut ; null = tous. */
function selectedAimaxAccounts() {
  const a = S.aimax;
  if (!a || !S.accounts.size) return null;
  const names = new Set(
    [...S.accounts].map((i) => S.data.accounts[i] && S.data.accounts[i].name)
  );
  return new Set(a.accounts.map((n, i) => (names.has(n) ? i : -1)).filter((i) => i >= 0));
}

/** Le filtre exclut-il tout le périmètre AI Max ? */
function aimaxOutOfScope() {
  const s = selectedAimaxAccounts();
  return !!(s && !s.size);
}

function aimaxScopeMsg() {
  const a = S.aimax;
  return `Aucun des comptes filtrés n'utilise AI Max. Seuls ces comptes l'ont `
    + `activé : ${a.accounts.join(', ')}.`;
}

/** Cellules retenues par le filtre de comptes. */
function aimaxCells() {
  const allowed = selectedAimaxAccounts();
  const cells = S.aimax.cells;
  return allowed ? cells.filter((c) => allowed.has(c[AX.ACC])) : cells;
}

/** Totaux par type de correspondance, sur le périmètre filtré. */
function aimaxByType() {
  const a = S.aimax;
  const out = new Map();
  for (const c of aimaxCells()) {
    const key = a.matchTypes[c[AX.MT]];
    addAx(out.get(key) || out.set(key, emptyAx()).get(key), c, AX.IMPR);
  }
  return out;
}

function renderAimaxKpis() {
  const byType = aimaxByType();
  const ai = byType.get(AIMAX_TYPE) || emptyAx();
  const rest = emptyAx();
  for (const [k, v] of byType) {
    if (k === AIMAX_TYPE) continue;
    for (const f of ['impr', 'clicks', 'cost', 'conv', 'value']) rest[f] += v[f];
  }
  const totalCost = ai.cost + rest.cost;

  const allowed = selectedAimaxAccounts();
  const termRows = S.aimax.terms.filter((t) => !allowed || allowed.has(t[AT.ACC]));
  const distinct = new Set(termRows.map((t) => t[AT.TERM])).size;

  els.aimaxKpi.replaceChildren();

  const tiles = [
    { label: 'Part du coût', value: totalCost ? ai.cost / totalCost : NaN, fmt: fmtPct,
      note: `${compactly(fmtMoney, ai.cost)} sur ${compactly(fmtMoney, totalCost)}`, ref: null },
    { label: 'Requêtes captées', value: distinct, fmt: fmtInt,
      note: 'requêtes distinctes', ref: null },
    { label: 'Clics', value: ai.clicks, fmt: fmtInt, ref: null,
      note: `${compactly(fmtInt, ai.impr)} impressions` },
    { label: 'Conversions', value: ai.conv, fmt: fmtNum1, ref: null,
      note: `taux ${fmtPct(ai.clicks ? ai.conv / ai.clicks : NaN)}` },
    { label: 'ROAS', value: ai.cost ? ai.value / ai.cost : NaN, fmt: fmtRatio, dir: 1,
      ref: rest.cost ? rest.value / rest.cost : NaN, refLabel: 'hors AI Max' },
    { label: 'CPA', value: ai.conv ? ai.cost / ai.conv : NaN, fmt: fmtMoney, dir: -1,
      ref: rest.conv ? rest.cost / rest.conv : NaN, refLabel: 'hors AI Max' },
  ];

  for (const def of tiles) {
    const tile = document.createElement('div');
    tile.className = 'kpi';

    const lab = document.createElement('div');
    lab.className = 'kpi__label';
    lab.textContent = def.label;
    tile.appendChild(lab);

    const val = document.createElement('div');
    val.className = 'kpi__value';
    val.textContent = compactly(def.fmt, def.value);
    tile.appendChild(val);

    const foot = document.createElement('div');
    foot.className = 'kpi__foot';
    const d = document.createElement('span');

    if (def.ref !== null && isFinite(def.ref) && def.ref !== 0 && isFinite(def.value)) {
      // Le point de comparaison n'est pas une période antérieure mais le reste
      // du trafic des mêmes comptes : c'est la seule référence qui réponde à
      // « AI Max fait-il mieux que ce que je faisais déjà ? ».
      const pct = (def.value - def.ref) / Math.abs(def.ref);
      const flat = Math.abs(pct) < 0.005;
      const good = flat ? null : (pct > 0) === (def.dir > 0);
      d.className = 'kpi__delta ' + (good === null ? 'kpi__delta--flat'
        : good ? 'kpi__delta--good' : 'kpi__delta--bad');
      const g = document.createElement('span');
      g.textContent = flat ? '=' : (pct > 0 ? '↑' : '↓');
      d.appendChild(g);
      const t = document.createElement('span');
      t.textContent = `${nf1.format(Math.abs(pct) * 100)} %`;
      d.appendChild(t);
      const em = document.createElement('em');
      em.textContent = `vs ${def.refLabel}`;
      d.appendChild(em);
      d.title = `Reste du trafic des mêmes comptes : ${def.fmt(def.ref)}`;
    } else {
      d.className = 'kpi__delta kpi__delta--flat';
      d.textContent = def.note || '—';
    }
    foot.appendChild(d);
    tile.appendChild(foot);
    els.aimaxKpi.appendChild(tile);
  }
}

function renderAimaxMatchTypes() {
  const a = S.aimax;
  const m = AIMAX_METRICS[S.aimaxMetric];
  const byType = aimaxByType();

  const rows = a.matchTypes
    .map((name) => ({ name, t: byType.get(name) || emptyAx() }))
    .filter((r) => r.t.cost > 0 || r.t.clicks > 0)
    .map((r) => ({ ...r, v: m.calc(r.t) }))
    .filter((r) => isFinite(r.v))
    .sort((x, y) => y.v - x.v);

  const rank = rows.findIndex((r) => r.name === AIMAX_TYPE);
  els.aimaxMtSub.textContent =
    `${m.label} par type de correspondance, sur les comptes où AI Max tourne · `
    + (rank >= 0
        ? `AI Max au ${rank + 1}ᵉ rang sur ${rows.length}`
        : `AI Max non mesurable sur cette mesure`)
    + ` · ${aimaxScopeLabel()}`;

  if (!rows.length) {
    emptyState(els.aimaxMtBody, 'Aucune donnée sur cette sélection.');
    return;
  }

  if (S.views.aimaxmt === 'table') {
    renderTable(els.aimaxMtBody, {
      scroll: true,
      caption: 'Performances par type de correspondance',
      cols: [
        { key: 'name', label: 'Correspondance', text: true },
        { key: 'impr', label: 'Impressions', fmt: (v) => fmtInt(v) },
        { key: 'clicks', label: 'Clics', fmt: (v) => fmtInt(v) },
        { key: 'cost', label: 'Coût', fmt: (v) => fmtMoney(v) },
        { key: 'share', label: 'Part du coût', fmt: fmtPct },
        { key: 'conv', label: 'Conv.', fmt: fmtNum1 },
        { key: 'cpa', label: 'CPA', fmt: (v) => fmtMoney(v) },
        { key: 'value', label: 'Valeur conv.', fmt: (v) => fmtMoney(v) },
        { key: 'roas', label: 'ROAS', fmt: fmtRatio },
      ],
      rows: (() => {
        const tot = rows.reduce((s, r) => s + r.t.cost, 0);
        return [...rows].sort((x, y) => y.t.cost - x.t.cost).map((r) => ({
          name: label(MATCH_TYPE_LABELS, r.name),
          impr: r.t.impr, clicks: r.t.clicks, cost: r.t.cost,
          share: tot ? r.t.cost / tot : NaN,
          conv: r.t.conv, value: r.t.value,
          cpa: r.t.conv ? r.t.cost / r.t.conv : NaN,
          roas: r.t.cost ? r.t.value / r.t.cost : NaN,
        }));
      })(),
    });
    return;
  }

  // AI Max porte la teinte d'accent, les autres types une teinte neutre : la
  // question posée ici est « AI Max face au reste », pas « sept catégories ».
  renderBarChart(els.aimaxMtBody, {
    items: rows.map((r) => ({
      label: label(MATCH_TYPE_LABELS, r.name),
      value: r.v,
      // AI Max porte l'accent, le reste une teinte neutre : la question posée
      // est « AI Max face au reste », pas « six catégories à comparer ».
      color: r.name === AIMAX_TYPE ? seriesColor(1) : 'var(--neutral-bar)',
      rows: [
        { name: m.label, value: m.fmt(r.v) },
        { name: 'Coût', value: fmtMoney(r.t.cost) },
        { name: 'Clics', value: fmtInt(r.t.clicks) },
        { name: 'Conversions', value: fmtNum1(r.t.conv) },
        { name: 'ROAS', value: fmtRatio(r.t.cost ? r.t.value / r.t.cost : NaN) },
      ],
    })),
    fmt: m.fmt, color: seriesColor(1), metricLabel: m.label,
    // Sur un ROAS, les écarts se jouent autour de 1 : sans repère au seuil de
    // rentabilité, six barres de longueur quasi identique ne diraient rien.
    refLine: S.aimaxMetric === 'roas' ? { value: 1, label: 'seuil de rentabilité' } : null,
    ariaLabel: `${m.label} par type de correspondance`,
  });
}

/** Libellé du périmètre, pour les sous-titres. */
function aimaxScopeLabel() {
  const s = selectedAimaxAccounts();
  return s ? `${s.size} compte(s) sur ${S.aimax.accounts.length}`
           : `${S.aimax.accounts.length} comptes`;
}

function renderAimaxTerms() {
  const a = S.aimax;
  const allowed = selectedAimaxAccounts();
  const srcFilter = S.aimaxSource;

  const rows = a.terms.filter((t) =>
    (!allowed || allowed.has(t[AT.ACC]))
    && (srcFilter === 'all' || a.sources[t[AT.SRC]] === srcFilter));

  // Une requête peut arriver par les deux sources : on la regroupe, sinon elle
  // occuperait deux lignes du classement pour un même mot.
  const merged = new Map();
  for (const t of rows) {
    const k = t[AT.TERM];
    let e = merged.get(k);
    if (!e) merged.set(k, (e = { term: k, ...emptyAx(), sources: new Set(), accounts: new Set() }));
    e.impr += t[AT.IMPR];
    e.clicks += t[AT.CLICKS];
    e.cost += t[AT.COST];
    e.conv += t[AT.CONV];
    e.value += t[AT.VALUE];
    e.sources.add(a.sources[t[AT.SRC]]);
    e.accounts.add(a.accounts[t[AT.ACC]]);
  }
  const list = [...merged.values()].sort((x, y) => y.cost - x.cost);

  // Les totaux annoncés viennent des cellules, exhaustives, et non de la liste
  // plafonnée : sinon le ROAS affiché ici contredirait celui du bandeau, tous
  // deux justes mais calculés sur des ensembles différents.
  const exact = emptyAx();
  for (const c of aimaxCells()) {
    if (a.matchTypes[c[AX.MT]] !== AIMAX_TYPE) continue;
    if (srcFilter !== 'all' && a.sources[c[AX.SRC]] !== srcFilter) continue;
    addAx(exact, c, AX.IMPR);
  }
  const shownCost = list.reduce((s, r) => s + r.cost, 0);

  els.aimaxTermsSub.textContent =
    `${compactly(fmtMoney, exact.cost)} · ${fmtNum1(exact.conv)} conversions · `
    + `ROAS ${fmtRatio(exact.cost ? exact.value / exact.cost : NaN)} · ${aimaxScopeLabel()}`
    + (S.views.aimaxterms !== 'table' && list.length > AIMAX_TERM_ROWS
        ? ` · graphique : les ${AIMAX_TERM_ROWS} plus coûteuses` : '')
    + ` · liste détaillée : ${list.length.toLocaleString('fr-CH')} requête(s), soit `
    + `${fmtPct(exact.cost ? shownCost / exact.cost : NaN)} de ce coût — au-delà, `
    + `la traîne n'est pas publiée`;

  if (!list.length) {
    emptyState(els.aimaxTermsBody, 'Aucune requête captée sur cette sélection.');
    return;
  }

  if (S.views.aimaxterms === 'table') {
    renderTable(els.aimaxTermsBody, {
      scroll: true,
      caption: 'Requêtes captées par AI Max',
      cols: [
        { key: 'term', label: 'Requête', text: true },
        { key: 'source', label: 'Source', text: true },
        { key: 'impr', label: 'Impressions', fmt: (v) => fmtInt(v) },
        { key: 'clicks', label: 'Clics', fmt: (v) => fmtInt(v) },
        { key: 'cost', label: 'Coût', fmt: (v) => fmtMoney(v) },
        { key: 'conv', label: 'Conv.', fmt: fmtNum1 },
        { key: 'roas', label: 'ROAS', fmt: fmtRatio },
      ],
      rows: list.map((r) => ({
        term: r.term,
        source: [...r.sources].map(aimaxSourceLabel).join(' + '),
        impr: r.impr, clicks: r.clicks, cost: r.cost, conv: r.conv,
        roas: r.cost ? r.value / r.cost : NaN,
        _sub: [...r.accounts].join(', '),
      })),
      // Le pied totalise ce que la table montre, pas le périmètre entier : une
      // somme de colonnes doit correspondre aux lignes qu'on peut faire défiler.
      foot: {
        term: `Total des ${list.length} requêtes listées`,
        impr: list.reduce((s, r) => s + r.impr, 0),
        clicks: list.reduce((s, r) => s + r.clicks, 0),
        cost: shownCost,
        conv: list.reduce((s, r) => s + r.conv, 0),
        roas: shownCost ? list.reduce((s, r) => s + r.value, 0) / shownCost : NaN,
      },
    });
    return;
  }

  renderBarChart(els.aimaxTermsBody, {
    items: list.slice(0, AIMAX_TERM_ROWS).map((r) => ({
      label: r.term,
      sub: [...r.accounts].join(', '),
      value: r.cost,
      rows: [
        { name: 'Coût', value: fmtMoney(r.cost) },
        { name: 'Clics', value: fmtInt(r.clicks) },
        { name: 'Impressions', value: fmtInt(r.impr) },
        { name: 'Conversions', value: fmtNum1(r.conv) },
        { name: 'ROAS', value: fmtRatio(r.cost ? r.value / r.cost : NaN) },
        { name: 'Source', value: [...r.sources].map(aimaxSourceLabel).join(' + ') },
      ],
    })),
    fmt: fmtMoney, color: seriesColor(1), metricLabel: 'Coût',
    ariaLabel: 'Requêtes captées par AI Max, des plus coûteuses aux moins coûteuses',
  });
}

const AIMAX_SOURCE_LABELS = {
  AI_MAX_BROAD_MATCH: 'Élargissement de mot-clé',
  AI_MAX_KEYWORDLESS: 'Sans mot-clé',
};
const aimaxSourceLabel = (s) => AIMAX_SOURCE_LABELS[s] || s;

function renderAimaxRamp() {
  const a = S.aimax;
  const cells = aimaxCells();
  const n = a.months.length;

  const ai = a.months.map(() => emptyAx());
  const all = a.months.map(() => emptyAx());
  for (const c of cells) {
    addAx(all[c[AX.MONTH]], c, AX.IMPR);
    if (a.matchTypes[c[AX.MT]] === AIMAX_TYPE) addAx(ai[c[AX.MONTH]], c, AX.IMPR);
  }

  const share = ai.map((t, i) => (all[i].cost ? t.cost / all[i].cost * 100 : NaN));
  const roas = ai.map((t) => (t.cost ? t.value / t.cost : NaN));

  // Le dernier mois est presque toujours incomplet : la fenêtre s'arrête à la
  // veille de l'extraction. Une part reste lisible sur un mois partiel, un
  // ROAS beaucoup moins — les conversions y remontent encore.
  const partial = a.meta.end.slice(0, 7) === a.months[n - 1];

  els.aimaxRampSub.textContent =
    `Part du coût captée par AI Max, mois par mois · ${aimaxScopeLabel()}`
    + (partial ? ` · ${fmtMonth(a.months[n - 1])} est un mois partiel, arrêté au `
                 + `${fmtDateLong(a.meta.end)}` : '');

  if (!cells.length) {
    emptyState(els.aimaxRampBody, 'Aucune donnée sur cette sélection.');
    return;
  }

  if (S.views.aimaxramp === 'table') {
    renderTable(els.aimaxRampBody, {
      caption: 'Montée en charge d\'AI Max',
      cols: [
        { key: 'month', label: 'Mois', text: true },
        { key: 'cost', label: 'Coût AI Max', fmt: (v) => fmtMoney(v) },
        { key: 'total', label: 'Coût total', fmt: (v) => fmtMoney(v) },
        { key: 'share', label: 'Part', fmt: (v) => (isFinite(v) ? `${nf1.format(v)} %` : '—') },
        { key: 'conv', label: 'Conv.', fmt: fmtNum1 },
        { key: 'roas', label: 'ROAS', fmt: fmtRatio },
      ],
      rows: a.months.map((mo, i) => ({
        month: fmtMonth(mo) + (partial && i === n - 1 ? ' (partiel)' : ''),
        cost: ai[i].cost, total: all[i].cost, share: share[i],
        conv: ai[i].conv, roas: roas[i],
      })),
    });
    return;
  }

  renderLineChart(els.aimaxRampBody, {
    xLabels: a.months.map(fmtMonth),
    xFull: a.months.map((mo, i) =>
      fmtMonth(mo) + (partial && i === n - 1 ? ' — mois partiel' : '')),
    series: [{ key: 'share', name: 'Part du coût AI Max', color: seriesColor(1), values: share }],
    fmt: (v) => (isFinite(v) ? `${nf1.format(v)} %` : '—'),
    area: true, endLabel: true, height: 240, summable: false,
    // Pas de repère vertical sur le dernier point : il se superposerait à
    // l'étiquette de fin, et le sous-titre dit déjà que le mois est partiel.
    ariaLabel: 'Part du coût captée par AI Max, mois par mois',
  });
}

function renderAimaxCampaigns() {
  const a = S.aimax;
  const allowed = selectedAimaxAccounts();
  const rows = a.campaigns.filter((c) => !allowed || allowed.has(c[AC.ACC]));

  const withTraffic = rows.filter((c) => c[AC.COST] > 0);
  const silent = rows.filter((c) => c[AC.ON] && c[AC.COST] <= 0);

  els.aimaxCampSub.textContent =
    `${rows.filter((c) => c[AC.ON]).length} campagne(s) avec AI Max activé · `
    + `${withTraffic.length} captent effectivement du trafic`
    + (silent.length
        ? ` · ${silent.length} activée(s) sans une seule requête captée sur la période`
        : '');

  if (!withTraffic.length) {
    emptyState(els.aimaxCampBody, silent.length
        ? `AI Max est activé sur ${silent.length} campagne(s) mais n'a capté aucune `
          + `requête sur la période.`
        : 'Aucune campagne AI Max sur cette sélection.');
    return;
  }

  const sorted = [...withTraffic].sort((x, y) => y[AC.COST] - x[AC.COST]);

  if (S.views.aimaxcamp === 'table') {
    renderTable(els.aimaxCampBody, {
      scroll: true,
      caption: 'Campagnes captant du trafic AI Max',
      cols: [
        { key: 'name', label: 'Campagne', text: true },
        { key: 'clicks', label: 'Clics', fmt: (v) => fmtInt(v) },
        { key: 'cost', label: 'Coût', fmt: (v) => fmtMoney(v) },
        { key: 'conv', label: 'Conv.', fmt: fmtNum1 },
        { key: 'roas', label: 'ROAS', fmt: fmtRatio },
      ],
      rows: sorted.map((c) => ({
        name: c[AC.NAME], clicks: c[AC.CLICKS], cost: c[AC.COST], conv: c[AC.CONV],
        roas: c[AC.COST] ? c[AC.VALUE] / c[AC.COST] : NaN,
        _sub: a.accounts[c[AC.ACC]],
      })),
    });
    return;
  }

  renderBarChart(els.aimaxCampBody, {
    items: sorted.slice(0, 12).map((c) => ({
      label: c[AC.NAME],
      // Les campagnes portent des noms proches d'un compte à l'autre : le compte
      // prend une seconde ligne sous le nom, pas seulement l'infobulle.
      sub2: a.accounts[c[AC.ACC]],
      value: c[AC.COST],
      rows: [
        { name: 'Coût AI Max', value: fmtMoney(c[AC.COST]) },
        { name: 'Clics', value: fmtInt(c[AC.CLICKS]) },
        { name: 'Conversions', value: fmtNum1(c[AC.CONV]) },
        { name: 'ROAS', value: fmtRatio(c[AC.COST] ? c[AC.VALUE] / c[AC.COST] : NaN) },
      ],
    })),
    fmt: fmtMoney, color: seriesColor(1), metricLabel: 'Coût AI Max',
    ariaLabel: 'Campagnes captant le plus de trafic AI Max',
  });
}

function renderAimaxSection() {
  if (S.aimaxState !== 'ready') return;
  const a = S.aimax;
  els.aimaxSection.hidden = false;

  const allowed = selectedAimaxAccounts();
  const scopedCampaigns = a.campaigns.filter(
    (c) => (!allowed || allowed.has(c[AC.ACC])) && c[AC.ON]);

  els.aimaxMeta.textContent =
    `${fmtDateLong(a.meta.start)} – ${fmtDateLong(a.meta.end)} · ${a.meta.days} jours · `
    + `${scopedCampaigns.length} campagne(s) AI Max`
    + (allowed ? '' : ` sur ${a.meta.campaigns_search} campagnes Recherche du MCC`)
    + ` · fenêtre fixe, indépendante du filtre de période`;

  els.aimaxNote.replaceChildren();
  const notes = [];

  if (aimaxOutOfScope()) {
    // Le message ne paraît qu'une fois, ici : répété dans les quatre cartes
    // avec la liste des comptes, il noierait la section.
    notes.push(aimaxScopeMsg());
  } else {
    // Ce que le lecteur ne peut pas deviner et qui change la lecture des parts.
    notes.push(
      `Le périmètre est celui des ${a.accounts.length} comptes où AI Max est activé, `
      + `pas le MCC entier : ailleurs sa part serait diluée dans un total sans rapport.`
    );
    const ai = aimaxByType().get(AIMAX_TYPE) || emptyAx();
    const kwl = aimaxCells().filter((c) => a.sources[c[AX.SRC]] === 'AI_MAX_KEYWORDLESS');
    if (kwl.length) {
      const kc = kwl.reduce((s, c) => s + c[AX.COST], 0);
      const kv = kwl.reduce((s, c) => s + c[AX.VALUE], 0);
      notes.push(
        `Deux sources se cachent derrière « AI Max » : l'élargissement d'un mot-clé `
        + `existant, et le sans-mot-clé — du trafic qu'aucun mot-clé ne déclenchait. `
        + `Ce dernier pèse ${compactly(fmtMoney, kc)} `
        + `(${fmtPct(ai.cost ? kc / ai.cost : NaN)} d'AI Max) pour un ROAS de `
        + `${fmtRatio(kc ? kv / kc : NaN)}.`
      );
    }
  }

  for (const n of notes) {
    const s = document.createElement('span');
    s.textContent = n;
    els.aimaxNote.appendChild(s);
  }
  els.aimaxNote.hidden = !notes.length;

  if (aimaxOutOfScope()) {
    const short = 'Hors périmètre AI Max.';
    els.aimaxKpi.replaceChildren();
    els.aimaxMtSub.textContent = '';
    els.aimaxTermsSub.textContent = '';
    els.aimaxRampSub.textContent = '';
    els.aimaxCampSub.textContent = '';
    emptyState(els.aimaxMtBody, short);
    emptyState(els.aimaxTermsBody, short);
    emptyState(els.aimaxRampBody, short);
    emptyState(els.aimaxCampBody, short);
    return;
  }

  renderAimaxKpis();
  renderAimaxMatchTypes();
  renderAimaxTerms();
  renderAimaxRamp();
  renderAimaxCampaigns();
}

async function loadAimax() {
  if (S.aimaxState !== 'idle') return;
  S.aimaxState = 'loading';
  try {
    const res = await fetch('data/aimax.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S.aimax = await res.json();
  } catch (err) {
    // Absence de fichier ≠ erreur : un dépôt cloné sans exécuter le
    // récupérateur n'a pas de données AI Max. La section reste masquée
    // plutôt que d'afficher un cadre vide.
    S.aimaxState = 'error';
    console.info(`AI Max indisponible (${err.message}) — section masquée. `
      + `Générez data/aimax.json avec « python scripts/fetch_aimax.py ».`);
    return;
  }
  if (!S.aimax || !Array.isArray(S.aimax.cells) || !S.aimax.cells.length) {
    S.aimaxState = 'error';
    return;
  }
  S.aimaxState = 'ready';

  fillSelectFrom(els.aimaxMetric, AIMAX_METRICS, S.aimaxMetric);
  els.aimaxMetric.addEventListener('change', () => {
    S.aimaxMetric = els.aimaxMetric.value;
    renderAimaxSection();
  });

  const sources = S.aimax.sources.filter((s) => s.startsWith('AI_MAX_'));
  // Un lien peut porter une source absente de ce jeu de données : on retombe
  // sur « toutes » plutôt que d'afficher une carte vide sans raison visible.
  if (S.aimaxSource !== 'all' && !sources.includes(S.aimaxSource)) S.aimaxSource = 'all';
  buildSegmented(els.aimaxSource,
    [{ key: 'all', label: 'Toutes sources' },
     ...sources.map((s) => ({ key: s, label: aimaxSourceLabel(s) }))],
    () => S.aimaxSource,
    (k) => { S.aimaxSource = k; renderAimaxSection(); });

  buildViewToggles();
  renderAimaxSection();
}

/* ── Rendu : répartition par compte ───────────────────────────────────────── */

function renderMix(sel) {
  const d = S.data;
  const dim = S.mixDim;
  // « device100 » n'est pas une dimension de plus : c'est la ventilation par
  // appareil, lue en composition plutôt qu'en volume.
  const isDevice = dim === 'device' || dim === 'device100';
  const share = dim === 'device100';
  const dimValues = isDevice ? d.devices : d.networks;
  const dimIdx = isDevice ? F.DEV : F.NET;
  const labels = isDevice ? DEVICE_LABELS : NETWORK_LABELS;
  const dimName = isDevice ? 'appareil' : 'réseau';

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

  els.mixSub.textContent = share
    ? `Composition du coût par appareil, chaque compte ramené à 100 % — `
      + `les volumes ne sont plus comparables entre lignes, les compositions le sont`
    : `Coût par compte, ventilé par ${dimName}`;
  if (allRows.length > MAX_ROWS) {
    els.mixSub.textContent += ` · ${MAX_ROWS} premiers sur ${allRows.length}`;
  }

  if (S.views.mix === 'table') {
    // Le tableau suit l'échelle du graphique : en base 100 il donne les parts,
    // et garde la dépense en dernière colonne — sans elle, on ne saurait pas si
    // une composition à 90 % mobile porte 200 EUR ou 200 000.
    const cols = [{ key: 'label', label: 'Compte', text: true }];
    for (const s of series) {
      cols.push({
        key: s.key,
        label: s.name,
        fmt: share ? ((v) => fmtPct(v || 0)) : ((v) => fmtMoney(v || 0)),
      });
    }
    cols.push({ key: 'total', label: share ? 'Dépense' : 'Total', fmt: (v) => fmtMoney(v) });

    const foot = { label: 'Total', total: allRows.reduce((a, r) => a + r.total, 0) };
    for (const s of series) {
      const sum = allRows.reduce((a, r) => a + (r.values[s.key] || 0), 0);
      foot[s.key] = share ? (foot.total ? sum / foot.total : 0) : sum;
    }

    renderTable(els.mixBody, {
      cols, foot, scroll: true,
      caption: share
        ? 'Composition du coût par compte et par appareil, en part'
        : `Coût par compte et par ${dimName}`,
      rows: allRows.map((r) => {
        const out = { label: r.label, total: r.total };
        for (const s of series) {
          const v = r.values[s.key] || 0;
          out[s.key] = share ? (r.total ? v / r.total : 0) : v;
        }
        return out;
      }),
    });
    return;
  }

  renderStackedBars(els.mixBody, {
    rows, series, fmt: fmtMoney, normalize: share,
    ariaLabel: share
      ? 'Composition du coût par appareil, chaque compte ramené à 100 %'
      : `Coût par compte ventilé par ${dimName}`,
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

const MARGIN_COLS = [
  { key: 'name',        label: 'Campagne',       text: true },
  { key: 'cost',        label: 'Coût',           fmt: (v) => fmtMoney(v) },
  { key: 'convValue',   label: 'Valeur conv.',   fmt: (v) => fmtMoney(v) },
  { key: 'margin',      label: 'Marge',          fmt: (v) => fmtMoney(v) },
  { key: 'marginRate',  label: 'Taux de marge',  fmt: fmtPct },
  { key: 'conversions', label: 'Conv.',          fmt: fmtNum1 },
  { key: 'roas',        label: 'ROAS',           fmt: fmtRatio },
];

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

/* ════════════════════════════════════════════════════════════════════════════
   Sémantique & requêtes

   Jeu de données distinct (data/terms.json), chargé à la demande : il pèse
   plusieurs centaines de kilo-octets et n'est pas nécessaire au reste du
   rapport. Indices figés d'une paire :
     0 terme  1 mot-clé  2 correspondance  3 compte
     4 impressions  5 clics  6 coût  7 conversions  8 valeur
     9 recouvrement lexical  10 score sémantique  11 intention  12 coût par mois
   ═══════════════════════════════════════════════════════════════════════════ */

const P = {
  TERM: 0, KW: 1, MATCH: 2, ACC: 3, IMPR: 4, CLICKS: 5, COST: 6,
  CONV: 7, VALUE: 8, OVERLAP: 9, SEM: 10, INTENT: 11, MONTHS: 12,
};

// L'index 5 n'est produit que par la classification par règles : un modèle
// tranche toujours, les règles non — et il vaut mieux le montrer que le cacher.
const INTENT_LABELS = [
  'Transactionnel', 'Informationnel', 'Marque', 'Comparateur', 'Longue traîne',
  'Indéterminé',
];

/* Seuil de dérive : sous 40, la requête n'a plus qu'un rapport lointain au
   mot-clé — c'est la frontière décrite au modèle dans le prompt de scoring. */
const DRIFT_THRESHOLD = 40;

const DRIFT_X = {
  cost: { label: 'Coût', fmt: fmtMoney, axis: fmtMoney, get: (p) => p[P.COST] },
  clicks: { label: 'Clics', fmt: fmtInt, axis: fmtInt, get: (p) => p[P.CLICKS] },
  conversions: { label: 'Conversions', fmt: fmtNum1, axis: fmtInt, get: (p) => p[P.CONV] },
};

const NGRAM_METRICS = {
  cost: { label: 'Coût', fmt: fmtMoney, recent: 1, prev: 2 },
  clicks: { label: 'Clics', fmt: fmtInt, recent: 3, prev: 4 },
};

Object.assign(S, {
  terms: null,
  termsState: 'idle',   // idle | loading | ready | error
  driftX: 'cost',
  intentDim: 'account',
  // Base 100 par défaut : la question posée à ce graphique est « de quoi est
  // faite la dépense de ce compte », pas « lequel dépense le plus » — cette
  // dernière est déjà répondue ailleurs dans le rapport.
  intentScale: 'share',
  ngramMetric: 'cost',
});

/** Paires visibles compte tenu du filtre de comptes de la barre du haut. */
function termPairs() {
  const t = S.terms;
  if (!t) return [];
  const allowed = selectedTermAccounts();
  if (!allowed) return t.pairs;
  return t.pairs.filter((p) => allowed.has(p[P.ACC]));
}

const isEnriched = () => !!(S.terms && S.terms.meta && S.terms.meta.enriched);

/**
 * Indices de comptes de terms.json retenus par le filtre de la barre du haut.
 *
 * data.json indexe les comptes sur les 86 du MCC, terms.json seulement sur les
 * comptes récupérés : les deux numérotations ne coïncident pas, le rapprochement
 * se fait par nom. Retourne null quand aucun filtre n'est actif, ce qui évite un
 * test d'appartenance inutile dans les boucles.
 */
function selectedTermAccounts() {
  const t = S.terms;
  if (!t || !S.accounts.size) return null;
  const names = new Set(
    [...S.accounts].map((i) => S.data.accounts[i] && S.data.accounts[i].name)
  );
  return new Set(t.accounts.map((n, i) => (names.has(n) ? i : -1)).filter((i) => i >= 0));
}

/** Message commun quand le filtre ne laisse aucun compte présent dans terms.json. */
function noAccountInScope() {
  const t = S.terms;
  return `Aucun des comptes filtrés n'est présent dans ce jeu de données. `
    + `Il ne couvre que : ${t.accounts.join(', ')}.`;
}

/**
 * État vide qui distingue « le filtre exclut tout » de « pas de données ».
 * Sans cette distinction, filtrer sur un compte absent de terms.json donnerait
 * un graphique vide sans dire pourquoi.
 */
function emptyScoped(container, fallback) {
  const allowed = selectedTermAccounts();
  emptyState(container, allowed && !allowed.size ? noAccountInScope() : fallback);
}

/* ── Dérive sémantique ────────────────────────────────────────────────────── */

/**
 * Deux mesures possibles sur l'axe des ordonnées, jamais confondues.
 *
 * Le score sémantique vient d'un modèle et mesure le sens. À défaut, on
 * retombe sur le recouvrement lexical, déjà présent dans les données — mais
 * c'est une mesure de surface : deux synonymes y obtiennent 0 tout en étant
 * parfaitement pertinents. L'axe, le seuil et l'avertissement changent avec la
 * mesure, pour qu'un recouvrement faible ne se lise jamais comme une dérive avérée.
 */
function driftMeasure() {
  const scored = S.terms.pairs.some((p) => p[P.SEM] !== null);
  return scored
    ? {
        key: 'sem',
        get: (p) => p[P.SEM],
        has: (p) => p[P.SEM] !== null,
        axis: 'Pertinence sémantique (0-100)',
        threshold: DRIFT_THRESHOLD,
        thresholdLabel: `seuil de dérive (${DRIFT_THRESHOLD})`,
        rowLabel: 'Pertinence',
      }
    : {
        key: 'lex',
        get: (p) => Math.round(p[P.OVERLAP] * 100),
        has: (p) => p[P.OVERLAP] !== null && p[P.OVERLAP] !== undefined,
        axis: 'Recouvrement lexical (0-100)',
        threshold: 30,
        thresholdLabel: 'faible recouvrement (30)',
        rowLabel: 'Recouvrement',
      };
}

function renderDrift() {
  const t = S.terms;
  const meas = driftMeasure();
  const pairs = termPairs().filter(meas.has);
  const xDef = DRIFT_X[S.driftX];

  if (!pairs.length) {
    els.driftSub.textContent = 'Aucune paire mesurable sur cette sélection.';
    emptyScoped(els.driftBody, 'Aucune donnée sur cette sélection.');
    return;
  }

  const below = pairs.filter((p) => meas.get(p) < meas.threshold);
  const wasted = below.reduce((a, p) => a + p[P.COST], 0);

  // La distribution des coûts est très asymétrique : quelques paires à
  // plusieurs milliers d'euros écrasent des milliers d'autres à quelques
  // centimes contre l'axe. Tracer tout donnerait une bande illisible collée à
  // gauche. On garde donc les paires où une dérive coûte réellement quelque
  // chose — c'est aussi le seul sous-ensemble sur lequel on peut agir. Le
  // tableau, lui, reste exhaustif.
  const MAX_POINTS = 500;
  const plotted = [...pairs].sort((a, b) => b[P.COST] - a[P.COST]).slice(0, MAX_POINTS);
  const capped = pairs.length > MAX_POINTS;

  const nb = ' ';   // insécable : « 30 % » ne doit pas se couper en fin de ligne
  const head = meas.key === 'sem'
    ? `${pairs.length.toLocaleString('fr-CH')} paires scorées par modèle · `
      + `${below.length} sous le seuil de ${meas.threshold}, soit `
      + `${compactly(fmtMoney, wasted)} de dépense probablement dérivée`
    : `Recouvrement lexical, à défaut de scoring sémantique · `
      + `${below.length} paires sous ${meas.threshold}${nb}% de mots partagés, soit `
      + `${compactly(fmtMoney, wasted)} — à vérifier, un synonyme y tombe aussi`;
  els.driftSub.textContent = head
    + (capped && S.views.drift !== 'table'
        ? ` · graphique limité aux ${MAX_POINTS} paires les plus coûteuses, tableau complet`
        : '');

  // La couleur porte le type de correspondance, pas la distance : celle-ci est
  // déjà l'axe des ordonnées, la redoubler gâcherait le seul canal libre.
  // Trois créneaux au plus — c'est la limite validée en comparaison toutes-paires.
  const usedMatches = [...new Set(plotted.map((p) => p[P.MATCH]))].slice(0, 3);
  const series = usedMatches.map((mi, k) => ({
    key: String(mi), name: t.matchTypes[mi], color: seriesColor(k + 1),
  }));
  const colorOf = (mi) => {
    const k = usedMatches.indexOf(mi);
    return seriesColor(k >= 0 ? k + 1 : FOLD_SLOT);
  };

  if (S.views.drift === 'table') {
    renderTable(els.driftBody, {
      scroll: true,
      caption: 'Dérive sémantique par requête',
      cols: [
        { key: 'term', label: 'Terme recherché', text: true },
        { key: 'kw', label: 'Mot-clé déclencheur', text: true },
        { key: 'match', label: 'Corresp.', text: true },
        { key: 'sem', label: meas.rowLabel, fmt: (v) => `${v} / 100` },
        { key: 'cost', label: 'Coût', fmt: (v) => fmtMoney(v) },
        { key: 'clicks', label: 'Clics', fmt: (v) => fmtInt(v) },
        { key: 'conv', label: 'Conv.', fmt: fmtNum1 },
      ],
      rows: [...pairs].sort((a, b) => meas.get(a) - meas.get(b) || b[P.COST] - a[P.COST])
        .map((p) => ({
          term: t.terms[p[P.TERM]],
          kw: t.keywords[p[P.KW]],
          match: t.matchTypes[p[P.MATCH]],
          sem: meas.get(p), cost: p[P.COST], clicks: p[P.CLICKS], conv: p[P.CONV],
          _sub: t.accounts[p[P.ACC]],
          _swatch: colorOf(p[P.MATCH]),
        })),
    });
    return;
  }

  renderScatter(els.driftBody, {
    series,
    points: plotted.map((p) => ({
      x: xDef.get(p),
      y: meas.get(p),
      color: colorOf(p[P.MATCH]),
      name: t.terms[p[P.TERM]],
      sub: `déclenché par « ${t.keywords[p[P.KW]]} » · ${t.accounts[p[P.ACC]]}`,
      rows: [
        { name: meas.rowLabel, value: `${meas.get(p)} / 100` },
        { name: 'Correspondance', value: t.matchTypes[p[P.MATCH]] },
        { name: 'Coût', value: fmtMoney(p[P.COST]) },
        { name: 'Clics', value: fmtInt(p[P.CLICKS]) },
        { name: 'Conversions', value: fmtNum1(p[P.CONV]) },
      ],
    })),
    xFmt: xDef.fmt, xAxisFmt: xDef.axis,
    yFmt: fmtInt, yAxisFmt: fmtInt,
    xLabel: S.driftX === 'cost' ? `Coût (${CURRENCY})` : xDef.label,
    yLabel: meas.axis,
    threshold: { y: meas.threshold, label: meas.thresholdLabel },
    color: seriesColor(1),
    height: 320,
    ariaLabel: 'Pertinence sémantique face au coût, par requête',
  });
}

/* ── Clustering d'intention ───────────────────────────────────────────────── */

function renderIntent() {
  const t = S.terms;
  const pairs = termPairs().filter((p) => p[P.INTENT] !== null);

  if (!pairs.length) {
    els.intentSub.textContent = 'Intentions non classifiées.';
    emptyScoped(
      els.intentBody,
      'Aucune classification d\'intention — lancez python scripts/classify_terms.py '
      + '(par règles, sans clé API) ou python scripts/enrich_terms.py (par modèle).'
    );
    return;
  }

  const byMonth = S.intentDim === 'month';
  const share = S.intentScale === 'share';
  const method = (S.terms.meta || {}).intent_method === 'llm'
    ? 'classées par modèle' : 'classées par règles lexicales';
  // La fenêtre de terms.json tombe rarement sur des mois entiers : le premier
  // et le dernier sont tronqués. En base 100 c'est sans effet — une part reste
  // juste — mais en absolu le dernier mois se lirait comme un effondrement.
  const partialMonths = byMonth && !share ? ' — premier et dernier mois tronqués' : '';
  els.intentSub.textContent = (share
    ? `Répartition du coût par intention, base 100 par ${byMonth ? 'mois' : 'compte'} · `
      + `total absolu en bout de barre · ${method}`
    : `Coût par intention, ventilé par ${byMonth ? 'mois' : 'compte'} · ${method}`)
    + partialMonths;

  const seriesDefs = INTENT_LABELS.map((name, i) => ({
    key: String(i), name, slot: i + 1,
  }));

  // Accumulateur : ligne (compte ou mois) → intention → coût.
  const acc = new Map();
  const bump = (rowKey, intent, cost) => {
    let r = acc.get(rowKey);
    if (!r) acc.set(rowKey, (r = {}));
    r[String(intent)] = (r[String(intent)] || 0) + cost;
  };

  for (const p of pairs) {
    if (byMonth) {
      // Le coût mensuel est déjà ventilé dans la paire ; on ne réestime rien.
      (p[P.MONTHS] || []).forEach((c, mi) => {
        if (c > 0) bump(t.months[mi], p[P.INTENT], c);
      });
    } else {
      bump(t.accounts[p[P.ACC]], p[P.INTENT], p[P.COST]);
    }
  }

  let rows = [...acc.entries()]
    .map(([label, values]) => ({
      label, values,
      total: Object.values(values).reduce((a, b) => a + b, 0),
    }))
    .filter((r) => r.total > 0);

  // Par mois l'ordre chronologique prime ; par compte, le poids.
  if (byMonth) rows.sort((a, b) => a.label.localeCompare(b.label));
  else rows.sort((a, b) => b.total - a.total);

  const MAX_ROWS = 12;
  const capped = !byMonth && rows.length > MAX_ROWS;
  if (capped) {
    const tail = rows.slice(MAX_ROWS);
    const merged = { label: `Autres (${tail.length} comptes)`, values: {}, total: 0 };
    for (const r of tail) {
      for (const k in r.values) merged.values[k] = (merged.values[k] || 0) + r.values[k];
      merged.total += r.total;
    }
    rows = [...rows.slice(0, MAX_ROWS), merged];
  }

  const series = seriesDefs
    .filter((s) => rows.some((r) => (r.values[s.key] || 0) > 0))
    .map((s) => ({ ...s, color: seriesColor(s.slot) }));

  if (S.views.intent === 'table') {
    // Le tableau suit l'échelle choisie : en base 100 il donne les parts, ce
    // qui est la lecture demandée au graphique.
    const cellFmt = share
      ? (v) => (v === null || v === undefined ? '—' : `${nf1.format(v)} %`)
      : (v) => fmtMoney(v || 0);
    const cols = [{ key: 'label', label: byMonth ? 'Mois' : 'Compte', text: true }];
    for (const s of series) cols.push({ key: s.key, label: s.name, fmt: cellFmt });
    cols.push({ key: 'total', label: 'Total', fmt: (v) => fmtMoney(v) });

    const grand = rows.reduce((a, r) => a + r.total, 0);
    const foot = { label: 'Total', total: grand };
    for (const s of series) {
      const sum = rows.reduce((a, r) => a + (r.values[s.key] || 0), 0);
      foot[s.key] = share ? (grand ? sum / grand * 100 : 0) : sum;
    }

    renderTable(els.intentBody, {
      cols, foot, scroll: true,
      caption: share
        ? `Part de chaque intention par ${byMonth ? 'mois' : 'compte'}`
        : `Coût par intention et par ${byMonth ? 'mois' : 'compte'}`,
      rows: rows.map((r) => {
        const out = { label: r.label, total: r.total };
        for (const s of series) {
          const v = r.values[s.key] || 0;
          out[s.key] = share ? (r.total ? v / r.total * 100 : 0) : v;
        }
        return out;
      }),
    });
    return;
  }

  renderStackedBars(els.intentBody, {
    rows, series, fmt: fmtMoney, normalize: share,
    ariaLabel: share
      ? `Part de chaque intention par ${byMonth ? 'mois' : 'compte'}, base 100`
      : `Coût par intention et par ${byMonth ? 'mois' : 'compte'}`,
  });
}

/* ── N-grammes émergents et déclinants ────────────────────────────────────── */

/**
 * Diagramme en barres divergentes.
 *
 * Préféré au treemap suggéré : un treemap ne peut pas représenter une valeur
 * négative, or la moitié du sujet ici est le déclin. La paire bleu ↔ rouge avec
 * un milieu gris neutre est le couple divergent validé — deux teintes qui se
 * lisent comme opposées, et un zéro qui se lit comme « rien ».
 */
function renderDivergingBars(container, cfg) {
  const { rows, fmt } = cfg;
  container.replaceChildren();
  if (!rows.length) {
    emptyState(container, 'Aucune donnée sur cette sélection.');
    return;
  }

  container.appendChild(buildLegend([
    { key: 'up', name: cfg.upLabel || 'En hausse', color: seriesColor(1) },
    { key: 'down', name: cfg.downLabel || 'En baisse', color: seriesColor(8) },
  ], { shape: 'rect' }));

  const wrap = document.createElement('div');
  wrap.className = 'chart';
  container.appendChild(wrap);

  const W = measureWidth(container);
  const rowH = 26;
  const barH = 16;
  const padT = 8;
  const H = rows.length * rowH + padT + 26;

  const LABEL_MAX = 26;
  const trunc = (s) => shortenMiddle(s, LABEL_MAX, 0.45);
  const padL = Math.min(200, Math.max(90, Math.max(...rows.map((r) => trunc(r.label).length)) * 6.4 + 12));
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.delta)), 1);
  const axisFmt = axisFormatter(fmt, maxAbs);
  const padR = Math.max(...rows.map((r) => axisFmt(r.delta).length)) * 6.9 + 18;
  const plotW = Math.max(60, W - padL - Math.min(150, padR));

  // Axe symétrique : le zéro est au centre, sinon la comparaison hausse/baisse
  // serait faussée par l'échelle.
  const mid = padL + plotW / 2;
  const scale = (v) => (v / maxAbs) * (plotW / 2);

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    role: 'img', 'aria-label': cfg.ariaLabel || 'Barres divergentes',
  }, wrap);

  el('line', { class: 'zero-line', x1: mid, x2: mid, y1: padT, y2: padT + rows.length * rowH }, svg);

  rows.forEach((r, i) => {
    const yTop = padT + i * rowH + (rowH - barH) / 2;
    const w = Math.abs(scale(r.delta));
    const up = r.delta >= 0;
    const x = up ? mid : mid - w;

    textNode('text', {
      class: 'axis-label', x: padL - 10, y: yTop + barH / 2 + 3.5, 'text-anchor': 'end',
    }, trunc(r.label), svg);

    const d = up
      ? barPath(x, yTop, w, barH, 4, 'h')
      // Miroir horizontal : l'extrémité arrondie doit rester du côté de la donnée.
      : `M${x + w},${yTop} H${x + 4} A4,4 0 0 0 ${x},${yTop + 4}`
        + ` V${yTop + barH - 4} A4,4 0 0 0 ${x + 4},${yTop + barH} H${x + w} Z`;

    const bar = el('path', {
      class: 'bar-mark', d, fill: seriesColor(up ? 1 : 8),
    }, svg);

    // Une barre proche du maximum pousse son étiquette dans la gouttière des
    // noms. Elle bascule alors à l'intérieur de la barre, encrée selon la
    // luminance du remplissage plutôt que de se superposer au libellé.
    const txt = (up ? '+' : '−') + axisFmt(Math.abs(r.delta));
    const outerX = up ? mid + w + 8 : mid - w - 8;
    const needed = txt.length * 6.9 + 8;
    const inside = up ? (outerX + needed > W) : (outerX - needed < padL);
    const fill = seriesColor(up ? 1 : 8);
    textNode('text', {
      class: 'mark-label',
      x: inside ? (up ? mid + w - 8 : mid - w + 8) : outerX,
      y: yTop + barH / 2 + 3.5,
      'text-anchor': inside ? (up ? 'end' : 'start') : (up ? 'start' : 'end'),
      ...(inside ? { fill: inkOn(fill) } : {}),
    }, txt, svg);

    const hit = el('rect', {
      class: 'hit hit--mark', x: 0, y: padT + i * rowH, width: W,
      height: Math.max(24, rowH), tabindex: 0, role: 'button',
      'aria-label': `${r.label}, ${up ? 'hausse' : 'baisse'} de ${fmt(Math.abs(r.delta))}`,
    }, svg);

    const show = (mx, my) => {
      bar.classList.add('bar-mark--hover');
      Tip.show(mx, my, (n) => {
        tipHead(n, r.label);
        if (r.examples && r.examples.length) {
          const ex = document.createElement('div');
          ex.className = 'tooltip__name';
          ex.textContent = r.examples.slice(0, 3).join(' · ');
          n.appendChild(ex);
        }
        // Par défaut deux périodes comparées ; un appelant qui compare autre
        // chose (une marge, deux jours) fournit ses propres lignes plutôt que
        // d'hériter d'un libellé qui décrirait mal sa mesure.
        const tips = cfg.tipRows ? cfg.tipRows(r) : [
          { name: 'Période récente', value: fmt(r.recent), color: seriesColor(1) },
          { name: 'Période précédente', value: fmt(r.prev), color: seriesColor(8) },
          { name: 'Variation', value: (up ? '+' : '−') + fmt(Math.abs(r.delta)), total: true },
        ];
        for (const t of tips) tipRow(n, t);
      });
    };
    const hide = () => { bar.classList.remove('bar-mark--hover'); Tip.hide(); };
    hit.addEventListener('pointermove', (ev) => show(ev.clientX, ev.clientY));
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => {
      const b = hit.getBoundingClientRect();
      show(b.left + b.width / 2, b.top + b.height / 2);
    });
    hit.addEventListener('blur', hide);
  });

  const base = padT + rows.length * rowH;
  textNode('text', { class: 'axis-title', x: mid + 6, y: base + 16, 'text-anchor': 'start' },
    cfg.axisRight || '→ émergents', svg);
  textNode('text', { class: 'axis-title', x: mid - 6, y: base + 16, 'text-anchor': 'end' },
    cfg.axisLeft || 'déclinants ←', svg);
}

function renderNgrams() {
  const t = S.terms;
  const m = NGRAM_METRICS[S.ngramMetric];
  const allowed = selectedTermAccounts();

  // Colonnes de ngramsByAccount : [gramme, compte, coûtRécent, coûtPréc,
  // clicsRécents, clicsPréc]. m.recent/m.prev indexent la table globale, d'où
  // le décalage de 1 sur la table par compte.
  const col = { recent: m.recent + 1, prev: m.prev + 1 };
  const examples = new Map((t.ngrams || []).map((g) => [g[0], g[5] || []]));

  let all;
  if (allowed && t.ngramsByAccount) {
    if (!allowed.size) {
      els.ngramSub.textContent = 'Hors périmètre.';
      emptyState(els.ngramBody, noAccountInScope());
      return;
    }
    // Ré-agrégation sur les comptes retenus. Exacte pour les n-grammes publiés :
    // chacun l'est avec la totalité de ses comptes.
    const acc = new Map();
    for (const row of t.ngramsByAccount) {
      if (!allowed.has(row[1])) continue;
      const cur = acc.get(row[0]) || [0, 0];
      cur[0] += row[col.recent];
      cur[1] += row[col.prev];
      acc.set(row[0], cur);
    }
    all = [...acc.entries()].map(([label, [recent, prev]]) => ({
      label, recent, prev, delta: recent - prev, examples: examples.get(label) || [],
    })).filter((r) => r.delta !== 0);
  } else {
    all = (t.ngrams || []).map((g) => ({
      label: g[0],
      recent: g[m.recent],
      prev: g[m.prev],
      delta: g[m.recent] - g[m.prev],
      examples: g[5] || [],
    })).filter((r) => r.delta !== 0);
  }

  const mid = t.meta.midpoint;
  const scope = allowed ? `${allowed.size} compte(s) filtré(s)` : 'tous comptes';
  els.ngramSub.textContent =
    `Bi- et trigrammes des termes de recherche · ${m.label} depuis le ${fmtDateShort(mid)} `
    + `face à la période précédente · ${scope} · `
    + `${t.meta.ngrams_total.toLocaleString('fr-CH')} n-grammes observés, `
    + `minimum ${t.meta.min_clicks_ngram} clics`;

  if (S.views.ngram === 'table') {
    renderTable(els.ngramBody, {
      scroll: true,
      caption: 'N-grammes émergents et déclinants',
      cols: [
        { key: 'label', label: 'N-gramme', text: true },
        { key: 'recent', label: 'Récent', fmt: (v) => m.fmt(v) },
        { key: 'prev', label: 'Précédent', fmt: (v) => m.fmt(v) },
        { key: 'delta', label: 'Variation', fmt: (v) => (v >= 0 ? '+' : '−') + m.fmt(Math.abs(v)) },
      ],
      rows: [...all].sort((a, b) => b.delta - a.delta)
        .map((r) => ({ ...r, _sub: r.examples.slice(0, 2).join(' · ') })),
    });
    return;
  }

  // Les deux extrêmes, pas le haut du classement : une tendance est un delta,
  // et le déclin compte autant que l'émergence.
  const sorted = [...all].sort((a, b) => b.delta - a.delta);
  const rows = [...sorted.slice(0, 12), ...sorted.slice(-12)]
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .sort((a, b) => b.delta - a.delta);

  renderDivergingBars(els.ngramBody, {
    rows, fmt: m.fmt,
    upLabel: 'Émergents', downLabel: 'Déclinants',
    ariaLabel: `N-grammes par variation de ${m.label}`,
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   Types de correspondance
   ═══════════════════════════════════════════════════════════════════════════ */

const CANNIB_METRIC = {
  // « Part de la ligne » est la lecture actionnable : en valeur absolue, le type
  // qui dépense le plus domine forcément la matrice, ce qui masque le fait qu'un
  // type minoritaire peut consacrer l'essentiel de SON budget à des requêtes
  // déjà couvertes ailleurs.
  rowshare: { label: 'Part de la ligne', fmt: (v) => `${nf1.format(v)} %`, idx: P.COST, share: true },
  cost: { label: 'Coût', fmt: fmtMoney, idx: P.COST },
  clicks: { label: 'Clics', fmt: fmtInt, idx: P.CLICKS },
  impressions: { label: 'Impressions', fmt: fmtInt, idx: P.IMPR },
};

Object.assign(S, { cannibMetric: 'rowshare', velocityBid: 'all' });

/**
 * Rampe séquentielle : une seule teinte, six paliers. Le sens s'inverse en
 * thème sombre — c'est le CSS qui s'en charge, pas ce code.
 *
 * La racine carrée écrase la dynamique : la dépense est très concentrée, et une
 * échelle linéaire laisserait toutes les cellules sauf une au premier palier.
 */
const HEAT_STEPS = ['--heat-1', '--heat-2', '--heat-3', '--heat-4', '--heat-5', '--heat-6'];

function seqColor(ratio) {
  if (!(ratio > 0)) return 'transparent';
  const eased = Math.sqrt(Math.min(1, ratio));
  const i = Math.min(HEAT_STEPS.length - 1, Math.floor(eased * HEAT_STEPS.length));
  return cssVar(HEAT_STEPS[i]) || cssVar('--seq-450');
}

/**
 * Carte de chaleur.
 *
 * Encodage séquentiel — une grandeur continue, donc une seule teinte du clair
 * au foncé, jamais un arc-en-ciel. La valeur est écrite dans chaque cellule :
 * la couleur seule ne doit pas être le seul moyen de lire un nombre.
 */
function renderHeatmap(container, cfg) {
  const { rows, cols, cells, fmt } = cfg;
  container.replaceChildren();
  if (!rows.length || !cols.length) {
    emptyState(container, 'Aucune donnée sur cette sélection.');
    return;
  }

  const max = Math.max(...cells.flat().map((v) => v || 0), 1);

  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.className = 'data heatmap';

  const cap = document.createElement('caption');
  cap.className = 'sr-only';
  cap.textContent = cfg.caption || 'Matrice';
  table.appendChild(cap);

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'txt';
  corner.scope = 'col';
  corner.textContent = cfg.cornerLabel || '';
  htr.appendChild(corner);
  for (const c of cols) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = c;
    htr.appendChild(th);
  }
  if (!cfg.hideTotal) {
    const thTot = document.createElement('th');
    thTot.scope = 'col';
    thTot.textContent = 'Total';
    htr.appendChild(thTot);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((r, ri) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.className = 'txt';
    th.textContent = r;
    tr.appendChild(th);

    let rowTotal = 0;
    cols.forEach((c, ci) => {
      const v = cells[ri][ci] || 0;
      rowTotal += v;
      const td = document.createElement('td');
      td.className = 'heat-cell';
      if (v > 0) {
        const bg = seqColor(v / max);
        td.style.background = bg;
        // Encre choisie sur la luminance réelle du fond : la rampe couvre du
        // très clair au très foncé et s'inverse en thème sombre, aucune couleur
        // de texte fixe ne tient sur les deux extrêmes.
        td.style.color = inkOn(bg);
      }
      td.textContent = v > 0 ? fmt(v) : '—';
      td.title = `${r} → ${c} : ${fmt(v)}`;
      tr.appendChild(td);
    });

    if (!cfg.hideTotal) {
      const tdTot = document.createElement('td');
      tdTot.style.fontWeight = '600';
      tdTot.textContent = fmt(rowTotal);
      tr.appendChild(tdTot);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

/**
 * Courbes sur deux axes continus.
 *
 * renderLineChart pose ses points sur des catégories régulièrement espacées ;
 * ici l'abscisse est une grandeur (dépense cumulée), donc l'espacement doit
 * refléter les écarts réels — sinon la pente, qui est tout le propos d'une
 * courbe de rendement, serait fausse.
 */
function renderXYLines(container, cfg) {
  const { series, xFmt, yFmt, xLabel, yLabel } = cfg;
  container.replaceChildren();
  const usable = series.filter((s) => s.points.length > 1);
  if (!usable.length) {
    emptyState(container, 'Pas assez de points pour tracer une courbe.');
    return;
  }

  container.appendChild(buildLegend(usable, { shape: 'line' }));

  const wrap = document.createElement('div');
  wrap.className = 'chart';
  container.appendChild(wrap);

  const W = measureWidth(container);
  const plotH = cfg.height || 260;

  const xs = niceTicks(0, Math.max(...usable.flatMap((s) => s.points.map((p) => p[0])), 1), 5);
  const ys = niceTicks(0, Math.max(...usable.flatMap((s) => s.points.map((p) => p[1])), 1), 5);
  const xAxisFmt = axisFormatter(xFmt, xs.max);
  const yAxisFmt = axisFormatter(yFmt, ys.max);

  const yTexts = ys.ticks.map(yAxisFmt);
  const padL = Math.max(46, Math.max(...yTexts.map((s) => s.length)) * 6.6 + 12);
  const padR = 16;
  const padT = 20;
  const padB = 44;
  const H = plotH + padT + padB;
  const plotW = Math.max(60, W - padL - padR);

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    role: 'img', 'aria-label': cfg.ariaLabel || 'Courbes',
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
  textNode('text', { class: 'axis-title', x: padL + plotW, y: padT + plotH + 34, 'text-anchor': 'end' },
    xLabel, svg);
  textNode('text', { class: 'axis-title', x: padL, y: padT - 8, 'text-anchor': 'start' }, yLabel, svg);

  for (const s of usable) {
    el('path', {
      d: linePath(s.points.map((p) => [X(p[0]), Y(p[1])])),
      fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }, svg);
    const last = s.points[s.points.length - 1];
    el('circle', {
      cx: X(last[0]), cy: Y(last[1]), r: 4, fill: s.color,
      stroke: cssVar('--surface-1'), 'stroke-width': 2,
    }, svg);
  }

  // Réticule : à chaque abscisse, la valeur de chaque courbe par interpolation
  // — les courbes n'ont pas les mêmes abscisses, on ne peut pas lire un index.
  const crosshair = el('line', {
    class: 'crosshair', y1: padT, y2: padT + plotH, x1: -99, x2: -99, style: 'display:none',
  }, svg);
  const dots = usable.map((s) => el('circle', {
    r: 4.5, fill: s.color, stroke: cssVar('--surface-1'), 'stroke-width': 2,
    style: 'display:none',
  }, svg));

  const interp = (pts, x) => {
    if (x < pts[0][0] || x > pts[pts.length - 1][0]) return null;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i][0] >= x) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        const f = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
        return y0 + (y1 - y0) * f;
      }
    }
    return pts[pts.length - 1][1];
  };

  const overlay = el('rect', {
    class: 'hit', x: padL, y: padT, width: plotW, height: plotH, tabindex: 0,
    'aria-label': cfg.ariaLabel || 'Courbes',
  }, svg);

  overlay.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const xv = xs.min + ((px - padL) / plotW) * (xs.max - xs.min);
    crosshair.setAttribute('x1', px);
    crosshair.setAttribute('x2', px);
    crosshair.style.display = '';
    Tip.show(ev.clientX, ev.clientY, (n) => {
      tipHead(n, `${xLabel} : ${xFmt(xv)}`);
      usable.forEach((s, si) => {
        const yv = interp(s.points, xv);
        if (yv === null) { dots[si].style.display = 'none'; return; }
        dots[si].style.display = '';
        dots[si].setAttribute('cx', X(xv));
        dots[si].setAttribute('cy', Y(yv));
        tipRow(n, { name: s.name, value: yFmt(yv), color: s.color });
      });
    });
  });
  overlay.addEventListener('pointerleave', () => {
    crosshair.style.display = 'none';
    dots.forEach((d) => { d.style.display = 'none'; });
    Tip.hide();
  });
}

/* ── Matrice de cannibalisation ───────────────────────────────────────────── */

/**
 * Qui dépense sur les requêtes que couvre aussi un autre type ?
 *
 * Un Sankey mot-clé → correspondance → requête était l'idée initiale, mais avec
 * 4 000 requêtes et autant de mots-clés il devient un enchevêtrement illisible.
 * La matrice répond directement à la question posée — « combien le Large
 * dépense-t-il sur des requêtes que mon Exact couvre déjà » — en une grille de
 * 3 × 3 qu'on lit d'un coup d'œil.
 *
 * Lecture : ligne = le type qui a dépensé, colonne = un type qui couvre aussi
 * cette requête. La diagonale est la dépense sur les requêtes exclusives.
 */
function cannibMatrix(pairs, nMatch) {
  const byTerm = new Map();
  for (const p of pairs) {
    let a = byTerm.get(p[P.TERM]);
    if (!a) byTerm.set(p[P.TERM], (a = []));
    a.push(p);
  }
  const cells = Array.from({ length: nMatch }, () => new Array(nMatch).fill(0));
  const idx = CANNIB_METRIC[S.cannibMetric].idx;
  let contestedTerms = 0;
  let contestedValue = 0;

  for (const [, ps] of byTerm) {
    const present = new Set(ps.map((p) => p[P.MATCH]));
    const multi = present.size > 1;
    if (multi) contestedTerms++;
    for (const p of ps) {
      const v = p[idx] || 0;
      if (multi) contestedValue += v;
      if (!multi) {
        cells[p[P.MATCH]][p[P.MATCH]] += v;   // exclusif
      } else {
        for (const other of present) {
          if (other !== p[P.MATCH]) cells[p[P.MATCH]][other] += v;
        }
      }
    }
  }
  return { cells, contestedTerms, contestedValue, totalTerms: byTerm.size };
}

function renderCannib() {
  const t = S.terms;
  const pairs = termPairs();
  const m = CANNIB_METRIC[S.cannibMetric];
  if (!pairs.length) {
    els.cannibSub.textContent = 'Hors périmètre.';
    emptyScoped(els.cannibBody, 'Aucune donnée sur cette sélection.');
    return;
  }

  const raw = cannibMatrix(pairs, t.matchTypes.length);
  const { contestedTerms, contestedValue, totalTerms } = raw;
  let cells = raw.cells;
  const total = pairs.reduce((a, p) => a + (p[m.idx] || 0), 0);

  if (m.share) {
    cells = cells.map((row) => {
      const sum = row.reduce((a, v) => a + v, 0);
      return row.map((v) => (sum ? v / sum * 100 : 0));
    });
  }

  // La part non exclusive de chaque ligne : quelle fraction de son propre
  // budget un type consacre à des requêtes déjà couvertes ailleurs.
  const shares = raw.cells.map((row, i) => {
    const sum = row.reduce((a, v) => a + v, 0);
    return sum ? (sum - row[i]) / sum * 100 : 0;
  });
  const worst = shares.indexOf(Math.max(...shares));

  els.cannibSub.textContent =
    `${contestedTerms.toLocaleString('fr-CH')} requêtes sur ${totalTerms.toLocaleString('fr-CH')} `
    + `captées par plusieurs types (${(contestedTerms / totalTerms * 100).toFixed(1)} %), `
    + `soit ${compactly(CANNIB_METRIC.cost.fmt, contestedValue)} — `
    + `${(contestedValue / total * 100).toFixed(1)} % du total. `
    + `Ligne = type qui dépense, colonne = type couvrant aussi la requête ; `
    + `la diagonale est l'exclusif. `
    + `Le plus recouvrant : ${t.matchTypes[worst]}, `
    + `${shares[worst].toFixed(0)} % de son budget sur des requêtes déjà couvertes.`;

  if (S.views.cannib === 'table') {
    // Vue tableau : le détail des requêtes contestées les plus coûteuses,
    // qui est ce sur quoi on agit concrètement.
    const byTerm = new Map();
    for (const p of pairs) {
      let a = byTerm.get(p[P.TERM]);
      if (!a) byTerm.set(p[P.TERM], (a = []));
      a.push(p);
    }
    const rows = [];
    for (const [ti, ps] of byTerm) {
      if (new Set(ps.map((p) => p[P.MATCH])).size < 2) continue;
      const row = { term: t.terms[ti], total: ps.reduce((a, p) => a + (p[m.idx] || 0), 0) };
      for (let i = 0; i < t.matchTypes.length; i++) {
        row[`m${i}`] = ps.filter((p) => p[P.MATCH] === i)
          .reduce((a, p) => a + (p[m.idx] || 0), 0);
      }
      rows.push(row);
    }
    rows.sort((a, b) => b.total - a.total);
    const cols = [{ key: 'term', label: 'Requête contestée', text: true }];
    t.matchTypes.forEach((name, i) => cols.push({ key: `m${i}`, label: name, fmt: m.fmt }));
    cols.push({ key: 'total', label: 'Total', fmt: m.fmt });
    renderTable(els.cannibBody, {
      cols, rows, scroll: true,
      caption: 'Requêtes captées par plusieurs types de correspondance',
    });
    return;
  }

  // Un type absent de la sélection laisserait une ligne et une colonne
  // entièrement vides : on les retire plutôt que d'afficher une grille de tirets.
  const present = t.matchTypes
    .map((_, i) => i)
    .filter((i) => raw.cells[i].some((v) => v > 0)
      || raw.cells.some((row) => row[i] > 0));

  renderHeatmap(els.cannibBody, {
    rows: present.map((i) => t.matchTypes[i]),
    cols: present.map((i) => t.matchTypes[i]),
    cells: present.map((i) => present.map((j) => cells[i][j])),
    fmt: m.share ? m.fmt : (v) => compactly(m.fmt, v),
    // En part de ligne chaque total vaut 100 % : l'afficher n'apprendrait rien.
    hideTotal: !!m.share,
    cornerLabel: 'dépense ↓ / couvre →',
    caption: 'Matrice de cannibalisation entre types de correspondance',
  });
}

/* ── Vélocité de dérive ───────────────────────────────────────────────────── */

function renderVelocity() {
  const t = S.terms;
  const drift = t.drift || [];
  if (!drift.length) {
    els.velocitySub.textContent = 'Pas de série hebdomadaire dans ce jeu de données.';
    emptyState(els.velocityBody, 'Régénérez terms.json avec la version actuelle du script.');
    return;
  }

  const bidFilter = S.velocityBid;
  const allowed = selectedTermAccounts();
  if (allowed && !allowed.size) {
    els.velocitySub.textContent = 'Hors périmètre.';
    emptyState(els.velocityBody, noAccountInScope());
    return;
  }

  const weeks = t.weeks || [];
  // Colonnes de drift : [semaine, corresp., enchères, compte, clics, coût,
  // conv, somme(recouvrement × clics)]. La somme pondérée est publiée brute :
  // on ne peut moyenner qu'après avoir ré-agrégé, sinon une moyenne de moyennes
  // donnerait le même poids à un compte de 20 clics qu'à un compte de 9 000.
  const acc = new Map();
  const seenMatch = new Set();
  for (const [wi, mi, bi, ai, clicks, , , ovsum] of drift) {
    if (bidFilter !== 'all' && String(bi) !== bidFilter) continue;
    if (allowed && !allowed.has(ai)) continue;
    seenMatch.add(mi);
    const k = `${mi}|${wi}`;
    const cur = acc.get(k) || [0, 0];
    cur[0] += clicks;
    cur[1] += ovsum;
    acc.set(k, cur);
  }

  const usedMatch = [...seenMatch].sort((a, b) => a - b);
  const series = usedMatch.map((mi, k) => ({
    key: String(mi),
    name: t.matchTypes[mi],
    color: seriesColor(k + 1),
    values: weeks.map((_, wi) => {
      const cur = acc.get(`${mi}|${wi}`);
      // Le seuil s'applique ici, sur le volume ré-agrégé de la sélection —
      // pas à la source, où chaque cellule est découpée par compte. Sous ce
      // volume la courbe est coupée plutôt que tracée à zéro, qui se lirait
      // comme une dérive totale.
      if (!cur || cur[0] < (t.meta.min_week_clicks || 30)) return null;
      return Math.round(cur[1] / cur[0] * 100);
    }),
  })).filter((s) => s.values.some((v) => v !== null));

  const bidLabel = bidFilter === 'all'
    ? 'toutes stratégies'
    : (t.biddingTypes || [])[Number(bidFilter)] || '';
  const scope = allowed ? `${allowed.size} compte(s) filtré(s)` : 'tous comptes';
  els.velocitySub.textContent =
    `Recouvrement lexical moyen, pondéré par les clics, semaine par semaine · ${bidLabel} · `
    + `${scope} · minimum ${t.meta.min_week_clicks} clics par semaine. `
    + `Une courbe qui baisse signifie un ciblage qui s'élargit.`;

  if (S.views.velocity === 'table') {
    const cols = [{ key: 'week', label: 'Semaine', text: true }];
    for (const s of series) cols.push({ key: s.key, label: s.name, fmt: (v) => (v === null ? '—' : `${v} / 100`) });
    renderTable(els.velocityBody, {
      cols, scroll: true,
      caption: 'Recouvrement lexical moyen par semaine et type de correspondance',
      rows: weeks.map((w, wi) => {
        const r = { week: fmtDateShort(w) };
        for (const s of series) r[s.key] = s.values[wi];
        return r;
      }),
    });
    return;
  }

  renderLineChart(els.velocityBody, {
    xLabels: weeks.map((w) => fmtDateShort(w)),
    xFull: weeks.map((w) => `Semaine du ${fmtDateLong(w)}`),
    series,
    fmt: (v, o) => fmtInt(v, o),
    endLabel: true, height: 240, summable: false,
    ariaLabel: 'Recouvrement lexical moyen par semaine et type de correspondance',
  });
}

/* ── Efficacité marginale ─────────────────────────────────────────────────── */

function renderMarginal() {
  const t = S.terms;
  const pairs = termPairs();
  if (!pairs.length) {
    els.marginalSub.textContent = 'Hors périmètre.';
    emptyScoped(els.marginalBody, 'Aucune donnée sur cette sélection.');
    return;
  }

  // Chaque type dépense « au mieux d'abord » : on trie ses paires par coût par
  // conversion croissant, puis on cumule. La pente de la courbe est le
  // rendement marginal ; son aplatissement marque le point où l'euro suivant
  // rapporte moins. Comparer deux types à une même abscisse répond à la
  // question posée : à dépense égale, lequel convertit le plus.
  const byMatch = new Map();
  for (const p of pairs) {
    let a = byMatch.get(p[P.MATCH]);
    if (!a) byMatch.set(p[P.MATCH], (a = []));
    a.push(p);
  }

  const series = [...byMatch.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([mi, ps], k) => {
      const ordered = [...ps].sort((x, y) => {
        const cx = x[P.CONV] > 0 ? x[P.COST] / x[P.CONV] : Infinity;
        const cy = y[P.CONV] > 0 ? y[P.COST] / y[P.CONV] : Infinity;
        return cx - cy;
      });
      const points = [[0, 0]];
      let cc = 0;
      let cv = 0;
      for (const p of ordered) {
        cc += p[P.COST];
        cv += p[P.CONV];
        points.push([cc, cv]);
      }
      return {
        key: String(mi), name: t.matchTypes[mi], color: seriesColor(k + 1),
        points, totalCost: cc, totalConv: cv,
      };
    })
    .filter((s) => s.totalCost > 0);

  const best = [...series].sort((a, b) => (b.totalConv / b.totalCost) - (a.totalConv / a.totalCost))[0];
  els.marginalSub.textContent =
    `Conversions cumulées face à la dépense cumulée, meilleures paires d'abord. `
    + `Plus une courbe s'aplatit tôt, plus le rendement se dégrade. `
    + (best ? `Rendement global le plus élevé : ${best.name} `
        + `(${fmtMoney(best.totalCost / best.totalConv)} par conversion).` : '');

  if (S.views.marginal === 'table') {
    renderTable(els.marginalBody, {
      caption: 'Rendement par type de correspondance',
      cols: [
        { key: 'name', label: 'Correspondance', text: true },
        { key: 'pairs', label: 'Paires', fmt: (v) => fmtInt(v) },
        { key: 'cost', label: 'Coût', fmt: (v) => fmtMoney(v) },
        { key: 'conv', label: 'Conv.', fmt: fmtNum1 },
        { key: 'cpa', label: 'CPA', fmt: (v) => fmtMoney(v) },
      ],
      rows: series.map((s) => ({
        name: s.name,
        pairs: s.points.length - 1,
        cost: s.totalCost,
        conv: s.totalConv,
        cpa: s.totalConv ? s.totalCost / s.totalConv : NaN,
        _swatch: s.color,
      })),
    });
    return;
  }

  renderXYLines(els.marginalBody, {
    series,
    xFmt: fmtMoney, yFmt: fmtNum1,
    xLabel: `Dépense cumulée (${CURRENCY})`,
    yLabel: 'Conversions cumulées',
    height: 240,
    ariaLabel: 'Rendement décroissant par type de correspondance',
  });
}

function renderMatchSection() {
  if (S.termsState !== 'ready') return;
  els.matchSection.hidden = false;
  const t = S.terms;
  els.matchMeta.textContent =
    `${t.matchTypes.join(' · ')} · ${fmtDateLong(t.meta.date_start)} – ${fmtDateLong(t.meta.date_end)}`;
  renderCannib();
  renderVelocity();
  renderMarginal();
}

/* ── Orchestration de la section ──────────────────────────────────────────── */

function renderTermsSection() {
  if (S.termsState !== 'ready') return;
  const t = S.terms;

  const cov = t.meta.cost_coverage_pct;
  const scope = t.accounts.length === 1
    ? t.accounts[0]
    : `${t.accounts.length} comptes`;
  els.semMeta.textContent =
    `${scope} · ${t.meta.pairs_published.toLocaleString('fr-CH')} paires publiées sur `
    + `${t.meta.pairs_total.toLocaleString('fr-CH')} · ${cov} % de la dépense retenue · `
    + `${fmtDateLong(t.meta.date_start)} – ${fmtDateLong(t.meta.date_end)}`;

  // Limites que le lecteur ne peut pas deviner et qui changent la lecture.
  const notes = [];

  // À signaler en premier : un seuil de clics écarte de la dépense réelle en
  // amont, si bien qu'un taux de couverture élevé porterait à confusion — il
  // porte sur ce qui reste après le seuil, pas sur la dépense totale.
  const minClicks = t.meta.min_clicks || 0;
  if (minClicks > 0 && t.meta.excluded_cost > 0) {
    const grand = t.meta.cost_total + t.meta.excluded_cost;
    const pct = grand ? (t.meta.excluded_cost / grand * 100) : 0;
    notes.push(
      `Seuil appliqué à la source : seuls les termes de plus de ${minClicks} clic`
      + `${minClicks > 1 ? 's' : ''} sont récupérés. Cela écarte `
      + `${compactly(fmtMoney, t.meta.excluded_cost)} de dépense réelle `
      + `(${pct.toFixed(1)} % des termes cliqués), qui n'apparaît nulle part ici. `
      + `Les ${cov} % ci-dessous portent sur ce qui reste après ce seuil, pas sur la dépense totale.`
    );
  }

  if (cov < 95) {
    notes.push(
      `Les ${t.meta.pairs_published.toLocaleString('fr-CH')} paires les plus coûteuses `
      + `représentent ${cov} % de la dépense en termes de recherche ; la traîne restante `
      + `n'est pas représentée dans les deux premiers graphiques. Les n-grammes, eux, sont `
      + `calculés sur la totalité des ${t.meta.ngrams_total.toLocaleString('fr-CH')} n-grammes observés.`
    );
  }
  // Chaque graphique dit par quelle méthode il a été produit : les deux
  // n'ont pas la même fiabilité et le lecteur doit pouvoir en tenir compte.
  const semScored = t.pairs.some((p) => p[P.SEM] !== null);
  if (!semScored) {
    notes.push(
      'Pertinence sémantique non calculée : le premier graphique utilise le '
      + 'recouvrement lexical (mots partagés entre la requête et le mot-clé). '
      + 'C\'est une mesure de surface — deux synonymes y obtiennent un score nul '
      + 'tout en étant parfaitement pertinents, donc un point bas est une piste '
      + 'à vérifier, pas une dérive avérée. Pour une vraie distance de sens : '
      + 'python scripts/enrich_terms.py (nécessite une clé API Anthropic).'
    );
  }

  if (t.meta.intent_method === 'rules') {
    notes.push(
      'Intentions classées par règles lexicales, sans modèle : la catégorie '
      + '« Indéterminé » regroupe les requêtes courtes sans marqueur reconnu, '
      + 'que les règles ne savent pas trancher.'
    );
  } else if (!t.meta.intent_method) {
    notes.push(
      'Intentions non classées — lancez python scripts/classify_terms.py.'
    );
  }

  if (notes.length) {
    els.semStatus.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = 'Portée des données.';
    els.semStatus.appendChild(strong);
    const span = document.createElement('span');
    span.textContent = notes.join(' ');
    els.semStatus.appendChild(span);
    els.semStatus.hidden = false;
  } else {
    els.semStatus.hidden = true;
  }

  renderDrift();
  renderIntent();
  renderNgrams();
  renderMatchSection();
}

async function loadTerms() {
  if (S.termsState === 'loading' || S.termsState === 'ready') return;
  S.termsState = 'loading';
  els.semLoad.disabled = true;
  els.semLoad.textContent = 'Chargement…';

  try {
    const res = await fetch('data/terms.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S.terms = await res.json();
  } catch (err) {
    S.termsState = 'error';
    els.semLoad.disabled = false;
    els.semLoad.textContent = 'Réessayer';
    els.semLoadNote.textContent =
      `Échec du chargement de data/terms.json (${err.message}). `
      + 'Générez-le avec python scripts/fetch_search_terms.py.';
    return;
  }

  S.termsState = 'ready';
  els.semLoader.hidden = true;
  els.semContent.hidden = false;

  fillSelectFrom(els.driftX, DRIFT_X, S.driftX);
  els.driftX.addEventListener('change', () => { S.driftX = els.driftX.value; renderTermsSection(); });

  fillSelectFrom(els.ngramMetric, NGRAM_METRICS, S.ngramMetric);
  els.ngramMetric.addEventListener('change', () => {
    S.ngramMetric = els.ngramMetric.value;
    renderTermsSection();
  });

  buildSegmented(els.intentDim,
    [{ key: 'account', label: 'Par compte' }, { key: 'month', label: 'Par mois' }],
    () => S.intentDim, (k) => { S.intentDim = k; renderTermsSection(); });

  buildSegmented(els.intentScale,
    [{ key: 'share', label: 'Base 100' }, { key: 'abs', label: 'Absolu' }],
    () => S.intentScale, (k) => { S.intentScale = k; renderTermsSection(); });

  fillSelectFrom(els.cannibMetric, CANNIB_METRIC, S.cannibMetric);
  els.cannibMetric.addEventListener('change', () => {
    S.cannibMetric = els.cannibMetric.value;
    renderMatchSection();
  });

  const bidOpts = [{ key: 'all', label: 'Toutes' }].concat(
    (S.terms.biddingTypes || []).map((name, i) => ({ key: String(i), label: name }))
  );
  buildSegmented(els.velocityBid, bidOpts,
    () => S.velocityBid, (k) => { S.velocityBid = k; renderMatchSection(); });

  buildViewToggles();
  renderTermsSection();
}

function fillSelectFrom(sel, defs, active) {
  sel.replaceChildren();
  for (const k in defs) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = defs[k].label;
    if (k === active) o.selected = true;
    sel.appendChild(o);
  }
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
  if (S.view !== 'report') p.set('vue', S.view);
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
  if (S.marginMeasure !== 'margin') p.set('mg', S.marginMeasure);
  if (S.genderScale !== 'share') p.set('gs', S.genderScale);
  if (S.trkDim !== 'account') p.set('td', S.trkDim);
  if (S.trkGrain !== 'week') p.set('tg', S.trkGrain);
  if (S.trkScale !== 'index') p.set('ts', S.trkScale);
  if (S.trkLagScale !== 'share') p.set('tl', S.trkLagScale);
  if (S.aimaxMetric !== 'cost') p.set('am', S.aimaxMetric);
  if (S.aimaxSource !== 'all') p.set('as', S.aimaxSource);
  if (S.liveAction !== null) p.set('ac', S.liveAction);
  // Permet de partager un lien qui ouvre directement la section sémantique,
  // sans obliger le destinataire à trouver puis cliquer le bouton de chargement.
  if (S.termsState === 'ready') {
    p.set('sem', '1');
    if (S.driftX !== 'cost') p.set('dx', S.driftX);
    if (S.intentDim !== 'account') p.set('id', S.intentDim);
    if (S.intentScale !== 'share') p.set('is', S.intentScale);
    if (S.ngramMetric !== 'cost') p.set('nm', S.ngramMetric);
  }
  const hash = p.toString();
  // replaceState : on ne pollue pas l'historique à chaque clic de filtre.
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

function readHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return;
  const p = new URLSearchParams(raw);
  const nums = (v) => new Set((v || '').split(',').filter((s) => s !== '').map(Number).filter(Number.isInteger));

  // « gender » a existé comme troisième onglet : un ancien lien retombe sur le
  // rapport, où la répartition par sexe vit désormais.
  if (['report', 'live', 'tracking'].includes(p.get('vue'))) S.view = p.get('vue');
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
  if (['device', 'device100', 'network'].includes(p.get('x'))) S.mixDim = p.get('x');
  if (['volume', 'share'].includes(p.get('gs'))) S.genderScale = p.get('gs');
  if (['account', 'market'].includes(p.get('td'))) S.trkDim = p.get('td');
  if (['day', 'week', 'month'].includes(p.get('tg'))) S.trkGrain = p.get('tg');
  if (['index', 'volume'].includes(p.get('ts'))) S.trkScale = p.get('ts');
  if (['volume', 'share'].includes(p.get('tl'))) S.trkLagScale = p.get('tl');

  if (AIMAX_METRICS[p.get('am')]) S.aimaxMetric = p.get('am');
  // La source est validée à l'arrivée du fichier, seul juge de ce qui existe.
  if (p.get('as')) S.aimaxSource = p.get('as');
  if (MARGIN_MEASURES[p.get('mg')]) {
    S.marginMeasure = p.get('mg');
    S.marginSort = { col: S.marginMeasure === 'rate' ? 'marginRate' : 'margin', dir: -1 };
  }
  // Le nom d'action est repris tel quel : s'il a disparu du jour, renderLive()
  // le remet à « toutes » plutôt que de laisser des graphiques vides.
  if (p.get('ac')) S.liveAction = p.get('ac');

  if (DRIFT_X[p.get('dx')]) S.driftX = p.get('dx');
  if (['account', 'month'].includes(p.get('id'))) S.intentDim = p.get('id');
  if (['share', 'abs'].includes(p.get('is'))) S.intentScale = p.get('is');
  if (NGRAM_METRICS[p.get('nm')]) S.ngramMetric = p.get('nm');
  // Chargement différé : la section sémantique n'est demandée que si le lien
  // le réclame, le reste du rapport ne doit pas l'attendre.
  S.autoLoadTerms = p.get('sem') === '1';

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
  // Le filtre de comptes vaut sur les deux vues : le Live doit se redessiner
  // même quand on le change depuis le rapport.
  if (S.liveState === 'ready') renderLive();
  if (S.trackingState === 'ready') renderTracking();
  if (S.view === 'tracking') { updateFilterSummaries(); writeHash(); return; }
  if (S.view === 'live') {
    // Le rapport ne se redessine pas ici : c'est lui qui écrit l'URL d'ordinaire.
    updateFilterSummaries();
    writeHash();
    return;
  }
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
  // Le rapport se redessine aussi quand le Live est affiché (le rAF de render()
  // peut arriver après setView) : il ne doit pas écraser le statut du direct,
  // qui décrit un tout autre périmètre.
  if (S.view === 'report') els.filterStatus.textContent = bits.join(' · ');

  renderKpis(sel);
  renderTimeSeries(sel);
  renderRoi(sel);
  renderEfficiency(rows);
  renderTop(rows);
  renderMargin(rows);
  renderGenderSection();
  renderAimaxSection();
  renderMix(sel);
  renderDetail(rows, sel);
  // La section sémantique suit le filtre de comptes, mais pas celui de période :
  // terms.json a sa propre fenêtre, annoncée dans son en-tête.
  if (S.termsState === 'ready') renderTermsSection();
}

/* ════════════════════════════════════════════════════════════════════════════
   Onglet Live — la journée en cours face au même jour, semaine précédente
   ═══════════════════════════════════════════════════════════════════════════ */

const LIVE_METRIC = {
  cost: { label: 'Dépense', key: 'cost', fmt: fmtMoney, dir: 0 },
  allconv: { label: 'Conversions (toutes)', key: 'allconv', fmt: fmtNum1, dir: 1 },
  clicks: { label: 'Clics', key: 'clicks', fmt: fmtInt, dir: 1 },
  impr: { label: 'Impressions', key: 'impr', fmt: fmtInt, dir: 0 },
  value: { label: 'Valeur de conv.', key: 'value', fmt: fmtMoney, dir: 1 },
};

const LIVE_KPIS = [
  { key: 'cost', label: 'Dépense', fmt: fmtMoney, dir: 0 },
  { key: 'allconv', label: 'Conversions (toutes)', fmt: fmtNum1, dir: 1 },
  { key: 'clicks', label: 'Clics', fmt: fmtInt, dir: 1 },
  { key: 'impr', label: 'Impressions', fmt: fmtInt, dir: 0 },
  { key: 'value', label: 'Valeur de conv.', fmt: fmtMoney, dir: 1 },
];

/* Au-delà de ce écart relatif, on met le changement en évidence. */
const LIVE_HIGHLIGHT = 0.25;

Object.assign(S, {
  view: 'report',
  live: null,
  liveState: 'idle',
  liveMetric: 'cost',
  liveCumul: 'cumul',
  liveAction: null,   // null = toutes les actions
});

function liveDelta(cur, ref) {
  if (!isFinite(ref) || ref === 0) return null;
  return (cur - ref) / Math.abs(ref);
}

/** Indices de comptes de live.json retenus par le filtre. null = tous. */
function selectedLiveAccounts() {
  const L = S.live;
  if (!L || !S.accounts.size) return null;
  const names = new Set(
    [...S.accounts].map((i) => S.data.accounts[i] && S.data.accounts[i].name)
  );
  return new Set(L.accounts.map((n, i) => (names.has(n) ? i : -1)).filter((i) => i >= 0));
}

/** Une métrique est-elle rattachable à une action de conversion ? */
const isConvMetric = (key) => key === 'allconv' || key === 'value';

/**
 * Série horaire d'une métrique, sur les comptes retenus.
 *
 * Quand une action de conversion est sélectionnée, les métriques de conversion
 * viennent de la table des actions ; les autres (coût, clics, impressions) sont
 * inchangées, car une dépense n'est pas rattachable à une action. Confondre les
 * deux laisserait croire à un « coût par action » qui n'existe pas.
 */
function liveSeries(day, metricKey) {
  const L = S.live;
  const allowed = selectedLiveAccounts();
  const out = new Array(24).fill(0);

  if (S.liveAction !== null && isConvMetric(metricKey)) {
    // Colonnes d'une ligne action : [nom, compte, convAuj, convRef, valAuj, valRef]
    const base = metricKey === 'allconv' ? 2 : 4;
    const col = base + (day === 'reference' ? 1 : 0);
    for (const row of L.actions) {
      if (row[0] !== S.liveAction) continue;
      if (allowed && !allowed.has(row[1])) continue;
      const arr = row[col] || [];
      for (let h = 0; h < 24; h++) out[h] += arr[h] || 0;
    }
    return out;
  }

  const matrix = L[day][metricKey] || [];
  matrix.forEach((row, ai) => {
    if (allowed && !allowed.has(ai)) return;
    for (let h = 0; h < 24; h++) out[h] += row[h] || 0;
  });
  return out;
}

/** Cumul d'une série jusqu'à l'heure en cours. */
function liveHtd(series) {
  const nowH = S.live.meta.current_hour;
  let acc = 0;
  for (let h = 0; h <= nowH && h < series.length; h++) acc += series[h] || 0;
  return acc;
}

/**
 * Alerte, recalculée dans le navigateur pour suivre les filtres.
 *
 * Évaluée sur la dernière heure consolidée uniquement — la plus récente sur
 * laquelle un zéro veut dire quelque chose plutôt que « pas encore remonté ».
 * La frontière, elle, reste celle calculée tous comptes confondus : le retard
 * de remontée est une propriété de la plateforme, et la déduire d'un compte à
 * faible volume la rendrait instable.
 */
function computeLiveAlert() {
  const L = S.live;
  const h = L.meta.settled_through;
  if (h < 0) return null;
  const minRef = L.meta.min_ref_conv || 3;
  const cur = liveSeries('today', 'allconv')[h] || 0;
  const ref = liveSeries('reference', 'allconv')[h] || 0;
  if (ref < minRef) return null;   // référence trop faible pour conclure
  if (cur <= 0) return { level: 'alerte', hour: h, current: 0, reference: ref };
  if (cur < ref * 0.5) return { level: 'vigilance', hour: h, current: cur, reference: ref };
  return null;
}

/**
 * Le filtre de comptes exclut-il tout le périmètre du direct ?
 *
 * Le rapport porte sur 86 comptes, le direct sur ceux qui diffusent aujourd'hui.
 * Filtrer sur un compte absent du direct donnerait des graphiques vides sans
 * dire pourquoi — on distingue donc ce cas d'une vraie absence de données.
 */
function liveOutOfScope() {
  const a = selectedLiveAccounts();
  return !!(a && !a.size);
}

/** Libellé du périmètre courant, pour les sous-titres. */
function liveScopeLabel() {
  const allowed = selectedLiveAccounts();
  const parts = [allowed ? `${allowed.size} compte(s)` : 'tous comptes'];
  if (S.liveAction !== null) parts.push(`action « ${S.liveAction} »`);
  return parts.join(' · ');
}

/** Tuile d'indicateur : valeur du jour, écart à la référence, mise en évidence. */
function liveTile(def, cur, ref) {
  const tile = document.createElement('div');
  tile.className = 'kpi';

  const lab = document.createElement('div');
  lab.className = 'kpi__label';
  lab.textContent = def.label;
  tile.appendChild(lab);

  const val = document.createElement('div');
  val.className = 'kpi__value';
  val.textContent = compactly(def.fmt, cur);
  tile.appendChild(val);

  const foot = document.createElement('div');
  foot.className = 'kpi__foot';

  const pct = liveDelta(cur, ref);
  const d = document.createElement('span');
  if (pct === null) {
    d.className = 'kpi__delta kpi__delta--flat';
    d.textContent = '—';
  } else {
    const flat = Math.abs(pct) < 0.005;
    const glyph = flat ? '=' : (pct > 0 ? '↑' : '↓');
    // Une hausse de dépense n'est ni bonne ni mauvaise en soi : seul le sens
    // déclaré par l'indicateur colore l'écart.
    const good = def.dir === 0 || flat ? null : (pct > 0) === (def.dir > 0);
    d.className = 'kpi__delta ' + (good === null ? 'kpi__delta--flat'
      : good ? 'kpi__delta--good' : 'kpi__delta--bad');
    const g = document.createElement('span');
    g.textContent = glyph;
    d.appendChild(g);
    const t = document.createElement('span');
    t.textContent = `${nf1.format(Math.abs(pct) * 100)} %`;
    d.appendChild(t);
    const em = document.createElement('em');
    em.textContent = 'vs J-7';
    d.appendChild(em);
    if (Math.abs(pct) >= LIVE_HIGHLIGHT) {
      // Un écart marquant se signale par le glyphe et le libellé, pas
      // seulement par la couleur.
      const strong = document.createElement('strong');
      strong.textContent = '!';
      strong.title = 'Écart marquant';
      d.appendChild(strong);
    }
  }
  d.title = `Référence à la même heure il y a 7 jours : ${def.fmt(ref)}`;
  foot.appendChild(d);
  tile.appendChild(foot);
  return tile;
}

function renderLiveKpis() {
  els.liveKpi.replaceChildren();
  for (const def of LIVE_KPIS) {
    const today = liveHtd(liveSeries('today', def.key));
    const ref = liveHtd(liveSeries('reference', def.key));
    const tile = liveTile(def, today, ref);
    // Quand une action est sélectionnée, seules les conversions la reflètent :
    // il faut le dire sur les tuiles qui restent tous périmètres confondus.
    if (S.liveAction !== null && !isConvMetric(def.key)) {
      const note = document.createElement('div');
      note.className = 'kpi__note';
      note.textContent = 'toutes actions';
      note.title = 'Une dépense n\'est pas rattachable à une action de conversion : '
        + 'ce chiffre ignore le filtre d\'action.';
      tile.appendChild(note);
    }
    els.liveKpi.appendChild(tile);
  }
}

function renderLiveHourly() {
  const L = S.live;
  const m = LIVE_METRIC[S.liveMetric];
  const cumul = S.liveCumul === 'cumul';
  const nowH = L.meta.current_hour;
  const settled = L.meta.settled_through;

  const shape = (arr, limit) => {
    let acc = 0;
    return arr.map((v, h) => {
      acc += v;
      // Au-delà de l'heure en cours il n'y a pas de donnée : couper plutôt que
      // tracer un plateau, qui se lirait comme un arrêt de diffusion.
      if (limit !== null && h > limit) return null;
      return cumul ? acc : v;
    });
  };

  const rawToday = liveSeries('today', m.key);
  const rawRef = liveSeries('reference', m.key);

  const series = [
    {
      key: 'today', name: `Aujourd'hui`, color: seriesColor(1),
      values: shape(rawToday, nowH),
    },
    {
      // La référence est coupée à l'heure courante elle aussi. Tracer la
      // journée entière ferait comparer un jour partiel à un jour complet :
      // le lecteur verrait un effondrement là où il n'y a qu'une heure moins
      // avancée. La journée de référence complète reste dans la vue tableau.
      key: 'ref', name: `Même jour, J-7`, color: seriesColor(2),
      values: shape(rawRef, nowH),
    },
  ];

  const isConv = isConvMetric(m.key);
  const ignoresAction = S.liveAction !== null && !isConv;
  els.liveHourlySub.textContent =
    `${m.label} · ${cumul ? 'cumul depuis minuit' : 'par heure'} · `
    + `${fmtDateLong(L.meta.date)} face au ${fmtDateLong(L.meta.reference_date)} · `
    + `${liveScopeLabel()} · heure du compte (${L.meta.timezone})`
    + (ignoresAction
        ? ` — cette mesure ignore le filtre d'action : une dépense n'est pas `
          + `rattachable à une action de conversion`
        : '')
    + (isConv && settled >= 0
        ? ` · les heures après ${settled}h remontent encore, elles sous-estiment le réel`
        : '');

  if (S.views.livehourly === 'table') {
    renderTable(els.liveHourlyBody, {
      scroll: true,
      caption: `${m.label} heure par heure`,
      cols: [
        { key: 'h', label: 'Heure', text: true },
        { key: 'today', label: `Aujourd'hui`, fmt: (v) => (v === null ? '—' : m.fmt(v)) },
        { key: 'ref', label: 'J-7', fmt: (v) => (v === null ? '—' : m.fmt(v)) },
        { key: 'delta', label: 'Écart', fmt: (v) => (v === null ? '—' : `${v >= 0 ? '+' : '−'}${nf1.format(Math.abs(v))} %`) },
        { key: 'state', label: 'État', text: true },
      ],
      // Le tableau garde la journée de référence entière, que le graphique
      // coupe à l'heure courante : c'est ici qu'on va voir où la journée a fini.
      rows: (() => {
        const refFull = shape(rawRef, null);
        return L.hours.map((h) => {
        const a = series[0].values[h];
        const b = refFull[h];
        const pct = liveDelta(a === null ? 0 : a, b);
        return {
          h: `${String(h).padStart(2, '0')}h`,
          today: a, ref: b,
          delta: a === null || pct === null ? null : pct * 100,
          state: h > nowH ? 'à venir'
            : (isConv && settled >= 0 && h > settled) ? 'en consolidation' : 'consolidé',
        };
        });
      })(),
    });
    return;
  }

  renderLineChart(els.liveHourlyBody, {
    xLabels: L.hours.map((h) => `${String(h).padStart(2, '0')}h`),
    xFull: L.hours.map((h) => `${String(h).padStart(2, '0')}h — heure du compte`),
    series,
    fmt: m.fmt,
    endLabel: true,
    height: 300,
    summable: false,
    // La frontière n'a de sens que pour les conversions : le coût, lui, remonte
    // quasiment en temps réel.
    vmark: (isConv && settled >= 0 && settled < nowH)
      ? { at: settled, label: `consolidé jusqu'ici` } : null,
    ariaLabel: `${m.label} heure par heure, aujourd'hui face à J-7`,
  });
}

/** Actions agrégées sur les comptes retenus : [{name, today, ref}]. */
function liveActionTotals() {
  const L = S.live;
  const allowed = selectedLiveAccounts();
  const acc = new Map();
  for (const row of L.actions || []) {
    if (allowed && !allowed.has(row[1])) continue;
    const cur = acc.get(row[0]) || [0, 0];
    cur[0] += liveHtd(row[2]);
    cur[1] += liveHtd(row[3]);
    acc.set(row[0], cur);
  }
  return [...acc.entries()]
    .map(([name, [today, ref]]) => ({ name, today, ref }))
    .filter((r) => r.today > 0 || r.ref > 0)
    .sort((a, b) => b.today - a.today);
}

function renderLiveActions() {
  const L = S.live;
  const rows = liveActionTotals();
  const allowed = selectedLiveAccounts();
  els.liveActionsSub.textContent =
    `Cumul jusqu'à ${L.meta.current_hour}h, face à la même heure J-7 · `
    + `${allowed ? `${allowed.size} compte(s)` : 'tous comptes'} · `
    + `mesure « toutes conversions », qui remonte plus vite que la colonne de conversions`
    // Ce panneau est la répartition par action : le réduire à la seule action
    // filtrée le viderait de son objet. Il reste donc complet, et on le dit.
    + (S.liveAction !== null
        ? ` — ce panneau garde toutes les actions, c'est lui qui donne la répartition`
        : '');

  if (!rows.length) {
    emptyState(els.liveActionsBody, 'Aucune conversion remontée aujourd\'hui.');
    return;
  }

  if (S.views.liveactions === 'table') {
    renderTable(els.liveActionsBody, {
      scroll: true,
      caption: 'Conversions par action',
      cols: [
        { key: 'name', label: 'Action de conversion', text: true },
        { key: 'today', label: `Aujourd'hui`, fmt: fmtNum1 },
        { key: 'ref', label: 'J-7', fmt: fmtNum1 },
        { key: 'delta', label: 'Écart', fmt: (v) => (v === null ? '—' : `${v >= 0 ? '+' : '−'}${nf1.format(Math.abs(v))} %`) },
      ],
      rows: rows.map((r) => {
        const pct = liveDelta(r.today, r.ref);
        return { name: r.name, today: r.today, ref: r.ref,
                 delta: pct === null ? null : pct * 100 };
      }),
    });
    return;
  }

  // Barres groupées jour / J-7 : deux séries, une échelle, comparaison directe.
  // Barres groupées et non empilées : aujourd'hui et J-7 sont deux alternatives,
  // pas les parts d'un tout — les empiler afficherait une somme dénuée de sens.
  renderStackedBars(els.liveActionsBody, {
    grouped: true,
    rows: rows.slice(0, 10).map((r) => ({
      label: r.name,
      values: { today: r.today, ref: r.ref },
      total: Math.max(r.today, r.ref),
    })),
    series: [
      { key: 'today', name: `Aujourd'hui`, color: seriesColor(1) },
      { key: 'ref', name: 'J-7 à la même heure', color: seriesColor(2) },
    ],
    fmt: fmtNum1,
    ariaLabel: 'Conversions par action, aujourd\'hui et J-7',
  });
}

function renderLiveCampaigns() {
  const L = S.live;
  const allowed = selectedLiveAccounts();
  const rows = (L.campaigns || [])
    .filter((r) => !allowed || allowed.has(r[1]))
    .map((r) => ({
      name: r[0], account: L.accounts[r[1]] || '', today: r[2], ref: r[3],
      conv: r[4], convRef: r[5], delta: r[2] - r[3],
    }));

  els.liveCampSub.textContent =
    `Écart de dépense à heure égale, du plus grand au plus petit · `
    + `${allowed ? `${allowed.size} compte(s)` : 'tous comptes'}`
    + (S.liveAction !== null
        ? ` — le filtre d'action ne s'applique pas ici, une dépense n'étant pas `
          + `rattachable à une action` : '');

  if (!rows.length) {
    emptyState(els.liveCampBody, 'Aucune dépense aujourd\'hui ni il y a 7 jours.');
    return;
  }

  if (S.views.livecamp === 'table') {
    renderTable(els.liveCampBody, {
      scroll: true,
      caption: 'Écarts de dépense par campagne',
      cols: [
        { key: 'name', label: 'Campagne', text: true },
        { key: 'today', label: `Dépense auj.`, fmt: (v) => fmtMoney(v) },
        { key: 'ref', label: 'J-7', fmt: (v) => fmtMoney(v) },
        { key: 'delta', label: 'Écart', fmt: (v) => `${v >= 0 ? '+' : '−'}${fmtMoney(Math.abs(v))}` },
        { key: 'conv', label: 'Conv. auj.', fmt: fmtNum1 },
        { key: 'convRef', label: 'Conv. J-7', fmt: fmtNum1 },
      ],
      rows: rows.map((r) => ({ ...r, _sub: r.account })),
    });
    return;
  }

  renderDivergingBars(els.liveCampBody, {
    rows: rows.slice(0, 14).map((r) => ({
      label: r.name,
      recent: r.today, prev: r.ref, delta: r.delta,
      examples: [r.account],
    })),
    fmt: fmtMoney,
    upLabel: 'Dépense en hausse', downLabel: 'Dépense en baisse',
    axisRight: '→ dépensent plus', axisLeft: 'dépensent moins ←',
    tipRows: (r) => [
      { name: `Aujourd'hui`, value: fmtMoney(r.recent), color: seriesColor(1) },
      { name: 'J-7 à la même heure', value: fmtMoney(r.prev), color: seriesColor(8) },
      { name: 'Écart', value: (r.delta >= 0 ? '+' : '−') + fmtMoney(Math.abs(r.delta)), total: true },
    ],
    ariaLabel: 'Écarts de dépense par campagne face à J-7',
  });
}

function renderLiveAlert() {
  const L = S.live;
  const slot = els.liveAlertSlot;
  slot.replaceChildren();

  const a = computeLiveAlert();
  const settled = L.meta.settled_through;
  const box = document.createElement('div');

  if (!a) {
    if (settled < 0) {
      box.className = 'alert-live';
      const t = document.createElement('span');
      t.className = 'alert-live__title';
      t.textContent = 'Surveillance impossible pour l\'instant.';
      box.appendChild(t);
      const s = document.createElement('span');
      s.textContent =
        'Aucune heure n\'est encore consolidée : le volume de référence est trop '
        + 'faible pour distinguer une absence de conversions d\'un simple retard de remontée.';
      box.appendChild(s);
      slot.appendChild(box);
    }
    return;
  }

  const critical = a.level === 'alerte';
  const scope = liveScopeLabel();
  box.className = 'alert-live' + (critical ? ' alert-live--critical' : '');
  const title = document.createElement('span');
  title.className = 'alert-live__title';
  title.textContent = critical
    ? `Alerte — aucune conversion sur la dernière heure consolidée (${a.hour}h).`
    : `Vigilance — conversions en net retrait sur la dernière heure consolidée (${a.hour}h).`;
  box.appendChild(title);

  const detail = document.createElement('span');
  detail.textContent = (critical
    ? `La même heure il y a 7 jours en comptait ${fmtNum1(a.reference)}. `
      + `Les heures plus récentes ne sont pas évaluées : elles remontent encore.`
    : `${fmtNum1(a.current)} contre ${fmtNum1(a.reference)} il y a 7 jours, `
      + `soit ${nf1.format((1 - a.current / a.reference) * 100)} % de moins.`)
    + ` Périmètre : ${scope}.`;
  box.appendChild(detail);
  slot.appendChild(box);
}

function buildActionPanel() {
  const panel = els.actionPanel;
  panel.replaceChildren();
  const rows = liveActionTotals();

  panel.appendChild(optionRow({
    checked: S.liveAction === null,
    label: 'Toutes les actions',
    meta: String(rows.length),
    onClick: () => { S.liveAction = null; renderLive(); },
  }));
  panel.appendChild(document.createElement('hr')).className = 'dropdown__sep';

  for (const r of rows) {
    panel.appendChild(optionRow({
      // Une seule action à la fois : ce filtre sert à isoler, pas à composer.
      checked: S.liveAction === r.name,
      label: r.name,
      meta: fmtNum1(r.today),
      onClick: () => {
        S.liveAction = S.liveAction === r.name ? null : r.name;
        renderLive();
      },
    }));
  }

  els.actionSummary.textContent = S.liveAction === null
    ? 'Toutes'
    : (S.liveAction.length > 26 ? S.liveAction.slice(0, 25) + '…' : S.liveAction);
}

function renderLive() {
  const L = S.live;
  if (!L) return;
  writeHash();

  // Le filtre d'action est reconstruit à chaque rendu : la liste et les
  // volumes affichés dépendent des comptes sélectionnés.
  buildActionPanel();
  // Une action peut disparaître de la sélection de comptes : sans ce garde-fou
  // tous les graphiques resteraient vides sans que le filtre le laisse voir.
  if (S.liveAction !== null
      && !liveActionTotals().some((r) => r.name === S.liveAction)) {
    S.liveAction = null;
    buildActionPanel();
  }

  const gen = new Date(L.meta.generated_at);
  const ageMin = Math.round((Date.now() - gen.getTime()) / 60000);
  const stale = ageMin > 45;

  els.liveMeta.replaceChildren();
  const scoped = selectedLiveAccounts();
  const nSel = scoped ? scoped.size : L.accounts.length;
  const meta = document.createElement('span');
  meta.textContent =
    `${nSel} compte(s) sur ${L.accounts.length} · cumul jusqu'à ${L.meta.current_hour}h `
    + `(${L.meta.timezone}) · données arrêtées à `;
  els.liveMeta.appendChild(meta);
  const stamp = document.createElement('span');
  if (stale) stamp.className = 'live-stale';
  stamp.textContent = `${String(gen.getHours()).padStart(2, '0')}:`
    + `${String(gen.getMinutes()).padStart(2, '0')}`
    + ` (${humanAge(ageMin)})`;
  els.liveMeta.appendChild(stamp);

  // La ligne sous les filtres décrit ce que les filtres cadrent réellement :
  // en direct ce n'est ni la période ni les campagnes du rapport.
  const status = [`${fmtDateLong(L.meta.date)}, jusqu'à ${L.meta.current_hour}h`];
  if (S.accounts.size) status.push(`${nSel} compte(s) en direct sur ${L.accounts.length}`);
  if (S.liveAction !== null) status.push(`action « ${S.liveAction} »`);
  els.filterStatus.textContent = status.join(' · ');

  if (L.meta.timezone_warning) {
    els.liveTz.replaceChildren();
    const s = document.createElement('strong');
    s.textContent = 'Fuseau horaire.';
    els.liveTz.appendChild(s);
    const d = document.createElement('span');
    d.textContent = L.meta.timezone_warning;
    els.liveTz.appendChild(d);
    els.liveTz.hidden = false;
  } else {
    els.liveTz.hidden = true;
  }

  if (liveOutOfScope()) {
    const msg = `Aucun des comptes filtrés ne diffuse aujourd'hui. Le direct ne `
      + `couvre que : ${L.accounts.join(', ')}.`;
    els.liveAlertSlot.replaceChildren();
    els.liveKpi.replaceChildren();
    // Sous-titres vidés : l'état vide de chaque carte porte déjà le message,
    // le répéter juste au-dessus ne ferait que du bruit.
    els.liveHourlySub.textContent = '';
    els.liveActionsSub.textContent = '';
    els.liveCampSub.textContent = '';
    emptyState(els.liveHourlyBody, msg);
    emptyState(els.liveActionsBody, msg);
    emptyState(els.liveCampBody, msg);
    return;
  }

  renderLiveAlert();
  renderLiveKpis();
  renderLiveHourly();
  renderLiveActions();
  renderLiveCampaigns();
}

async function loadLive() {
  if (S.liveState === 'loading') return;
  S.liveState = 'loading';
  try {
    const res = await fetch('data/live.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S.live = await res.json();
  } catch (err) {
    S.liveState = 'error';
    els.liveError.replaceChildren();
    const s = document.createElement('strong');
    s.textContent = 'Données du jour indisponibles.';
    els.liveError.appendChild(s);
    const d = document.createElement('span');
    d.textContent = `Impossible de charger data/live.json (${err.message}). `
      + `Générez-le avec « python scripts/fetch_live.py ».`;
    els.liveError.appendChild(d);
    els.liveError.hidden = false;
    return;
  }
  S.liveState = 'ready';
  els.liveError.hidden = true;

  fillSelectFrom(els.liveMetric, LIVE_METRIC, S.liveMetric);
  els.liveMetric.addEventListener('change', () => {
    S.liveMetric = els.liveMetric.value;
    renderLive();
  });
  buildSegmented(els.liveCumul,
    [{ key: 'cumul', label: 'Cumulé' }, { key: 'hour', label: 'Par heure' }],
    () => S.liveCumul, (k) => { S.liveCumul = k; renderLive(); });
  buildViewToggles();

  els.liveRefresh.addEventListener('click', () => refreshLive(false));
  // Le lien part vers GitHub dans un autre onglet : on rappelle ici la suite,
  // faute de quoi on revient sur un tableau inchangé sans savoir qu'il faut
  // attendre puis actualiser.
  els.liveRegen.addEventListener('click', () => {
    els.liveRefreshNote.textContent =
      'Sur GitHub : cliquez « Run workflow ». Revenez actualiser dans deux minutes.';
    els.liveRefreshNote.className = 'live-refresh__note';
  });
  // Reprendre la relecture au retour sur l'onglet, et l'arrêter en le quittant :
  // une minuterie qui tourne sur une fenêtre en arrière-plan ne sert personne.
  document.addEventListener('visibilitychange', updateLiveAutoRefresh);

  renderLive();
  noteLiveFreshness();
  updateLiveAutoRefresh();
}

/* ══════════════════════════════════════════════════════════════════════════
   Actualisation du direct

   Ce que ce bouton fait, et ce qu'il ne peut pas faire.

   Il relit `data/live.json` sans recharger la page. Il ne REGÉNÈRE pas les
   données : sur GitHub Pages, la page est un fichier statique servi par un
   hébergeur qui n'exécute rien. Régénérer suppose d'appeler l'API Google Ads,
   donc de détenir un jeton — et un jeton posé dans une page publique est un
   jeton compromis, définitivement. Il n'y a pas de version prudente de cette
   idée.

   La régénération appartient donc au workflow GitHub Actions, qui détient les
   secrets. Ce bouton sert à récupérer son dernier résultat sans F5, et à dire
   franchement quand ce résultat n'a pas bougé.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Dépôt qui héberge les workflows de régénération.
 *
 * Déduit de l'URL quand la page est servie par GitHub Pages, ce qui évite une
 * constante à maintenir en double — un fork ou un renommage casserait un lien
 * codé en dur sans que rien ne le signale. En local, l'URL ne dit rien du dépôt
 * et les boutons se masquent : mieux vaut pas de bouton qu'un bouton qui mène
 * ailleurs.
 */
function repoBase() {
  const m = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
  if (!m) return null;
  const project = location.pathname.split('/').filter(Boolean)[0];
  if (!project) return null;
  return `https://github.com/${m[1]}/${project}`;
}

/** Câble les deux liens vers les workflows, ou les masque si l'origine est locale. */
function wireRegenLinks() {
  const base = repoBase();
  const targets = [
    { el: els.liveRegen, file: 'refresh-live.yml' },
    { el: els.reportRegen, file: 'refresh-data.yml' },
  ];
  for (const t of targets) {
    if (!t.el) continue;
    if (!base) {
      t.el.hidden = true;
      continue;
    }
    t.el.hidden = false;
    t.el.href = `${base}/actions/workflows/${t.file}`;
  }
}

const LIVE_AUTO_MS = 5 * 60 * 1000;
let liveAutoTimer = null;

/**
 * Âge en clair, dans l'unité qui convient.
 *
 * « il y a 2 724 min » demande un calcul mental pour comprendre qu'on regarde
 * l'avant-veille. L'unité doit changer avec l'ordre de grandeur, faute de quoi
 * un tableau périmé passe pour un tableau frais.
 */
function humanAge(min) {
  if (min < 1) return 'à l\'instant';
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  return `il y a ${d} jour${d > 1 ? 's' : ''}`;
}

async function refreshLive(auto) {
  if (S.liveState === 'loading') return;
  const before = S.live && S.live.meta ? String(S.live.meta.generated_at) : '';

  els.liveRefresh.disabled = true;
  els.liveRefresh.classList.add('is-busy');
  els.liveRefreshLabel.textContent = 'Lecture…';

  let fresh = null;
  try {
    // Paramètre d'anti-cache en plus de `no-store` : GitHub Pages sert derrière
    // un CDN qui ignore parfois l'en-tête, et rien n'est plus trompeur qu'un
    // bouton d'actualisation qui renvoie la version précédente.
    const res = await fetch(`data/live.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fresh = await res.json();
  } catch (err) {
    els.liveRefresh.disabled = false;
    els.liveRefresh.classList.remove('is-busy');
    els.liveRefreshLabel.textContent = 'Actualiser';
    els.liveRefreshNote.textContent = `Lecture impossible (${err.message}).`;
    els.liveRefreshNote.className = 'live-refresh__note live-refresh__note--bad';
    return;
  }

  S.live = fresh;
  const after = fresh.meta ? String(fresh.meta.generated_at) : '';
  renderLive();

  els.liveRefresh.disabled = false;
  els.liveRefresh.classList.remove('is-busy');
  els.liveRefreshLabel.textContent = 'Actualiser';
  noteLiveFreshness(after !== before ? 'neuf' : (auto ? 'auto' : 'identique'));
}

/**
 * Message de fraîcheur sous le bouton.
 *
 * Un bouton qu'on presse et qui ne change rien à l'écran passe pour cassé. Il
 * faut donc distinguer trois issues : les données ont changé, elles n'ont pas
 * changé, ou le fichier est vieux de plusieurs heures — ce dernier cas voulant
 * dire que la régénération automatique ne tourne pas, ce qu'aucun rechargement
 * ne corrigera.
 */
function noteLiveFreshness(outcome) {
  if (!S.live || !S.live.meta) return;
  const gen = new Date(S.live.meta.generated_at);
  const min = Math.round((Date.now() - gen.getTime()) / 60000);

  let text;
  let cls = 'live-refresh__note';

  if (outcome === 'neuf') {
    text = 'Données mises à jour.';
    cls += ' live-refresh__note--good';
  } else if (outcome === 'identique') {
    text = 'Aucun changement : le fichier est le même.';
  } else if (min >= 24 * 60) {
    const days = Math.floor(min / (24 * 60));
    text = `Données figées depuis ${days} jour${days > 1 ? 's' : ''}.`;
    cls += ' live-refresh__note--bad';
  } else if (min >= 60) {
    text = `Dernière extraction il y a ${Math.floor(min / 60)} h.`;
    cls += ' live-refresh__note--bad';
  } else {
    text = `Extraites il y a ${Math.max(0, min)} min.`;
  }

  // Quand le fichier est vieux, relire ne sert à rien : c'est la régénération
  // qui manque. Le dire, plutôt que laisser presser un bouton sans effet.
  if (min >= 60) {
    text += ' La régénération automatique ne tourne pas — voir le README, section 3.4.';
  }

  els.liveRefreshNote.textContent = text;
  els.liveRefreshNote.className = cls;
}

/**
 * Relecture périodique, seulement quand l'onglet Live est à l'écran.
 *
 * Sur un onglet masqué ou une fenêtre en arrière-plan, la requête ne servirait
 * personne. La minuterie est donc liée à la vue courante et à la visibilité du
 * document.
 */
function updateLiveAutoRefresh() {
  const wanted = S.view === 'live'
    && S.liveState === 'ready'
    && document.visibilityState === 'visible';

  if (wanted && !liveAutoTimer) {
    liveAutoTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && S.view === 'live') refreshLive(true);
    }, LIVE_AUTO_MS);
  } else if (!wanted && liveAutoTimer) {
    clearInterval(liveAutoTimer);
    liveAutoTimer = null;
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   Répartition du coût par sexe — une carte du rapport

   Jeu de données distinct (data/gender.json), au grain (jour × compte × sexe).
   Il suit la période et le filtre de comptes de la barre du haut, comme le
   reste du rapport. Chargé sans bouton : à ce grain il pèse une fraction de
   data.json, et la section se masque d'elle-même si le fichier n'existe pas.

   Ce que « sexe » veut dire ici, et pourquoi « Inconnu » reste au premier plan.

   La donnée vient de `gender_view`. MALE et FEMALE sont ce que Google a déduit
   de l'internaute ; UNDETERMINED est l'aveu qu'il n'a pas su trancher. Sur ce
   MCC cette catégorie porte 40 % du coût — la ranger dans un « autres » la
   ferait passer pour un résidu, alors qu'elle pèse dix fois les femmes. Elle
   garde donc sa teinte, sa colonne, et une mention explicite sous la carte.

   Vérifié avant de construire : sur les trois comptes les plus dépensiers, la
   somme des coûts par sexe égale à 100 % le coût total des campagnes. Aucun
   angle mort de couverture à signaler.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Colonnes de facts : [date, compte, sexe, impr, clics, coût, conv, valeur] */
const G = { DATE: 0, ACC: 1, GENDER: 2, IMPR: 3, CLICKS: 4, COST: 5, CONV: 6, VALUE: 7 };

/**
 * Teintes fixes, jamais dérivées du volume.
 *
 * Un sexe qui changerait de couleur d'un filtre à l'autre rendrait deux
 * captures d'écran incomparables. Les trois créneaux sont donc figés.
 */
const GENDER_SLOT = { MALE: 1, FEMALE: 5, UNDETERMINED: 4 };

/* Comptes tracés, du plus dépensier au moins. Le tableau reste exhaustif. */
const GENDER_MAX = 8;

/* Sous ce seuil, la mention « Inconnu » n'apparaît pas : elle ne servirait plus
   qu'à répéter ce que la barre montre déjà. */
const GENDER_NOTE_MIN = 0.05;

const emptyG = () => ({ impr: 0, clicks: 0, cost: 0, conv: 0, value: 0 });

function addG(t, f) {
  t.impr += f[G.IMPR];
  t.clicks += f[G.CLICKS];
  t.cost += f[G.COST];
  t.conv += f[G.CONV];
  t.value += f[G.VALUE];
  return t;
}

/**
 * Indices de comptes retenus par le filtre du haut ; null = tous.
 *
 * L'appariement se fait par nom : gender.json a sa propre liste de comptes,
 * qui ne couvre que ceux ayant du volume démographique, donc pas les mêmes
 * indices que data.json.
 */
function selectedGenderAccounts() {
  const g = S.gender;
  if (!g || !S.accounts.size) return null;
  const names = new Set(
    [...S.accounts].map((i) => S.data.accounts[i] && S.data.accounts[i].name)
  );
  return new Set(g.accounts.map((a, i) => (names.has(a.name) ? i : -1)).filter((i) => i >= 0));
}

/**
 * Lignes retenues par les filtres de la barre du haut.
 *
 * La période vient du filtre partagé : cette carte n'a pas son propre
 * sélecteur, pour qu'on ne puisse pas lire une répartition sur 180 jours à
 * côté d'un rapport sur 30.
 */
function genderRows() {
  const g = S.gender;
  const allowed = selectedGenderAccounts();
  const lo = g.dates.findIndex((d) => d >= S.start);
  let hi = -1;
  for (let i = g.dates.length - 1; i >= 0; i--) {
    if (g.dates[i] <= S.end) { hi = i; break; }
  }
  if (lo < 0 || hi < lo) return [];

  const out = [];
  for (const f of g.facts) {
    if (f[G.DATE] < lo || f[G.DATE] > hi) continue;
    if (allowed && !allowed.has(f[G.ACC])) continue;
    out.push(f);
  }
  return out;
}

function genderLabel(i) {
  return S.gender.genderLabels[i] || S.gender.genders[i];
}

function genderColor(i) {
  return seriesColor(GENDER_SLOT[S.gender.genders[i]] || (i + 1));
}

function renderGenderSection() {
  if (S.genderState !== 'ready') return;
  const g = S.gender;
  const share = S.genderScale === 'share';
  const rows = genderRows();
  els.genderSection.hidden = false;

  const perAccount = new Map();
  for (const f of rows) {
    let slot = perAccount.get(f[G.ACC]);
    if (!slot) perAccount.set(f[G.ACC], (slot = g.genders.map(() => emptyG())));
    addG(slot[f[G.GENDER]], f);
  }

  const all = [...perAccount.entries()]
    .map(([ai, slots]) => {
      const values = {};
      let total = 0;
      slots.forEach((t, i) => { values[String(i)] = t.cost; total += t.cost; });
      return { label: g.accounts[ai].name, values, total, slots };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);

  const grand = all.reduce((s, r) => s + r.total, 0);
  const shown = all.slice(0, GENDER_MAX);
  const covered = shown.reduce((s, r) => s + r.total, 0);

  // Le plafond ne vaut que pour le graphique : le tableau liste tout, et lui
  // annoncer une troncature qu'il n'applique pas serait faux.
  const asTable = S.views.gender === 'table';
  const bits = [share
    ? 'Composition du coût par sexe, chaque compte ramené à 100 %'
    : 'Coût par compte, ventilé par sexe'];
  if (asTable || all.length <= GENDER_MAX) {
    if (all.length) bits.push(`${all.length} compte(s)`);
  } else {
    // Aucun plafond muet : ce que le graphique laisse de côté est annoncé, et
    // la vue tableau le rattrape.
    bits.push(`${GENDER_MAX} plus gros comptes sur ${all.length}`);
    bits.push(`${fmtPct(grand ? covered / grand : NaN)} du coût de la sélection`);
  }
  els.genderSub.textContent = bits.join(' · ');

  // Part de l'indéterminé sur la sélection, recalculée à chaque filtre : sur un
  // seul compte elle peut passer de 40 % à 0.
  const undet = g.genders.indexOf('UNDETERMINED');
  let undetShare = NaN;
  if (undet >= 0 && grand) {
    undetShare = all.reduce((s, r) => s + (r.values[String(undet)] || 0), 0) / grand;
  }
  els.genderNote.replaceChildren();
  if (undetShare >= GENDER_NOTE_MIN) {
    const strong = document.createElement('strong');
    strong.textContent = `« Inconnu » : ${fmtPct(undetShare)} du coût.`;
    els.genderNote.appendChild(strong);
    const span = document.createElement('span');
    span.textContent = "Ce n'est pas une troisième catégorie de personnes, mais l'aveu que "
      + 'Google n\'a pas su déterminer le sexe. Un CPA « Hommes » ne se compare donc pas à un '
      + 'CPA global. Réduire ce bloc passe par le ciblage démographique des campagnes, pas par '
      + 'ce rapport.';
    els.genderNote.appendChild(span);
    els.genderNote.hidden = false;
  } else {
    els.genderNote.hidden = true;
  }

  if (!all.length) {
    emptyState(els.genderBody, 'Aucune dépense par sexe sur cette sélection.');
    return;
  }

  const series = g.genders.map((_, i) => ({
    key: String(i), name: genderLabel(i), color: genderColor(i),
  }));

  if (S.views.gender === 'table') {
    renderTable(els.genderBody, {
      scroll: true,
      caption: 'Coût par compte et par sexe',
      cols: [
        { key: 'label', label: 'Compte', text: true },
        ...series.map((s) => ({
          key: s.key, label: s.name,
          fmt: share ? ((v) => fmtPct(v || 0)) : ((v) => fmtMoney(v || 0)),
        })),
        { key: 'total', label: share ? 'Dépense' : 'Total', fmt: (v) => fmtMoney(v) },
        { key: 'conv', label: 'Conv.', fmt: fmtNum1 },
        { key: 'roas', label: 'ROAS', fmt: fmtRatio },
      ],
      rows: all.map((r) => {
        const conv = r.slots.reduce((s, t) => s + t.conv, 0);
        const value = r.slots.reduce((s, t) => s + t.value, 0);
        const out = { label: r.label, total: r.total, conv, roas: r.total ? value / r.total : NaN };
        for (const s of series) {
          const v = r.values[s.key] || 0;
          out[s.key] = share ? (r.total ? v / r.total : 0) : v;
        }
        return out;
      }),
      foot: (() => {
        const conv = all.reduce((a, r) => a + r.slots.reduce((s, t) => s + t.conv, 0), 0);
        const value = all.reduce((a, r) => a + r.slots.reduce((s, t) => s + t.value, 0), 0);
        const f = {
          label: `Total — ${all.length} compte(s)`,
          total: grand, conv, roas: grand ? value / grand : NaN,
        };
        for (const s of series) {
          const sum = all.reduce((a, r) => a + (r.values[s.key] || 0), 0);
          f[s.key] = share ? (grand ? sum / grand : 0) : sum;
        }
        return f;
      })(),
    });
    return;
  }

  renderStackedBars(els.genderBody, {
    rows: shown, series, fmt: fmtMoney, normalize: share,
    ariaLabel: 'Coût par compte ventilé par sexe',
  });
}

async function loadGender() {
  if (S.genderState !== 'idle') return;
  S.genderState = 'loading';
  try {
    const res = await fetch('data/gender.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S.gender = await res.json();
  } catch (err) {
    // Absence de fichier ≠ erreur : un dépôt cloné sans exécuter le
    // récupérateur n'a pas de données démographiques. La section reste masquée
    // plutôt que d'afficher un cadre vide.
    S.genderState = 'error';
    console.info(`Données par sexe indisponibles (${err.message}) — section masquée. `
      + `Générez data/gender.json avec « python scripts/fetch_gender.py ».`);
    return;
  }
  if (!S.gender || !Array.isArray(S.gender.facts) || !S.gender.facts.length) {
    S.genderState = 'error';
    return;
  }
  S.genderState = 'ready';

  buildSegmented(els.genderScale,
    [{ key: 'volume', label: 'Volume' }, { key: 'share', label: 'Base 100' }],
    () => S.genderScale, (k) => { S.genderScale = k; renderGenderSection(); });

  buildViewToggles();
  renderGenderSection();
}

/* ════════════════════════════════════════════════════════════════════════════
   Onglet Tracking / Consent Mode

   CE QUE CET ONGLET NE PEUT PAS MONTRER, ET POURQUOI
   -------------------------------------------------
   Le taux de Consent Mode (granted / denied) n'existe pas dans l'API Google Ads :
   sondé sur la v25, `name LIKE '%consent%'` renvoie zéro champ. Les conversions
   modélisées ne sont pas non plus séparables des conversions observées
   (`%modeled%`, `%modelled%` : zéro champ). Ces deux données vivent dans la CMP,
   dans GTM et dans GA4.

   Afficher « 98 % de consentement » à partir de rien serait le pire service à
   rendre à quelqu'un qui cherche une cassure de mesure. Cet onglet mesure donc le
   tracking par ses EFFETS, ce qui suffit à répondre à la seule question qui
   compte : cette baisse de conversions vient-elle de la performance ou de la
   mesure ?

   Le raisonnement, en une phrase : une cassure de balise fait tomber les
   conversions sans toucher aux clics. Une vraie baisse de performance déplace les
   deux. Le rapport conversions / clic sépare les deux cas.

   Le taux de consentement, quand il est fourni via data/changelog.json (export
   de la CMP), est superposé aux mêmes dates — mais il vient de là, jamais d'ici.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Colonnes des tableaux de tracking.json */
const TD = { DATE: 0, ACC: 1, IMPR: 2, CLICKS: 3, COST: 4, CONV: 5, ALL: 6, VALUE: 7 };
const TS = { DATE: 0, ACC: 1, ACTION: 2, CONV: 3, ALL: 4, VALUE: 5 };
const TM = { DATE: 0, ACC: 1, MARKET: 2, CLICKS: 3, COST: 4, CONV: 5, ALL: 6, VALUE: 7 };
const TL = { MONTH: 0, ACC: 1, GROUP: 2, ALL: 3 };
const TC = { DATE: 0, ACC: 1, TYPE: 2, OP: 3, CLIENT: 4, COUNT: 5 };

/**
 * Réglages du diagnostic. Nommés et affichés dans l'interface : un seuil caché
 * transforme un diagnostic en oracle, et personne ne peut discuter un oracle.
 */
const TRK_RECENT_DAYS = 7;    // la période jugée
const TRK_BASE_DAYS = 28;     // la référence, juste avant
const TRK_DROP = 0.30;        // baisse relative jugée significative
const TRK_STABLE = 0.20;      // au-delà, le trafic n'est plus « stable »
const TRK_SILENCE_MIN = 3;    // jours sans conversion avant de signaler une action
const TRK_MIN_CONV = 20;      // volume minimal pour qu'un silence soit interprétable
const TRK_MIN_CLICKS = 200;   // sous ce trafic, un taux de conversion est du bruit

/**
 * Verdicts. L'ordre est celui du tri : ce qui exige une action d'abord.
 *
 * La teinte n'est pas décorative — rouge et orange disent « mesure », les autres
 * disent « marché ». C'est la distinction que tout l'onglet cherche à établir.
 */
const TRK_VERDICTS = {
  break:   { rank: 0, label: 'Cassure de mesure', slot: 8,
             hint: 'plus aucune conversion alors que les clics continuent' },
  measure: { rank: 1, label: 'Mesure suspecte', slot: 2,
             hint: 'le taux de conversion chute, le trafic non' },
  perf:    { rank: 2, label: 'Performance', slot: 4,
             hint: 'taux de conversion et trafic baissent ensemble' },
  volume:  { rank: 3, label: 'Volume', slot: 7,
             hint: 'le trafic baisse, le taux de conversion tient' },
  stable:  { rank: 4, label: 'Stable', slot: 3, hint: 'rien à signaler' },
  thin:    { rank: 5, label: 'Trop peu de trafic', slot: 6,
             hint: `moins de ${TRK_MIN_CLICKS} clics sur la période de référence` },
};

const CHANGE_TYPE_SLOT = {
  GTM: 7, CONTAINER: 5, DIDOMI: 2, ADS: 1, SITE: 4, AUTRE: 6,
};

/* Types de ressources du journal Google Ads, en français. */
const ADS_CHANGE_LABELS = {
  CAMPAIGN: 'Campagne', AD_GROUP: 'Groupe d\'annonces', AD: 'Annonce',
  AD_GROUP_AD: 'Annonce', AD_GROUP_CRITERION: 'Mot-clé / critère',
  CAMPAIGN_CRITERION: 'Ciblage de campagne', CAMPAIGN_BUDGET: 'Budget',
  AD_GROUP_BID_MODIFIER: 'Ajustement d\'enchère', ASSET: 'Asset',
  AD_GROUP_ASSET: 'Asset de groupe', CAMPAIGN_ASSET: 'Asset de campagne',
  ASSET_SET: 'Groupe d\'assets', ASSET_SET_ASSET: 'Groupe d\'assets',
  FEED: 'Flux', FEED_ITEM: 'Élément de flux', AD_GROUP_FEED: 'Flux de groupe',
  CAMPAIGN_FEED: 'Flux de campagne', BIDDING_STRATEGY: 'Stratégie d\'enchères',
  CUSTOMER_ASSET: 'Asset du compte', SHARED_SET: 'Liste partagée',
  CAMPAIGN_SHARED_SET: 'Liste partagée', UNKNOWN: 'Autre',
};

const emptyT = () => ({ impr: 0, clicks: 0, cost: 0, conv: 0, all: 0, value: 0 });

function addT(t, impr, clicks, cost, conv, all, value) {
  t.impr += impr; t.clicks += clicks; t.cost += cost;
  t.conv += conv; t.all += all; t.value += value;
  return t;
}

function trkVerdictColor(key) {
  return seriesColor(TRK_VERDICTS[key].slot);
}

/** Indices de comptes retenus par le filtre du haut ; null = tous. */
function selectedTrackingAccounts() {
  const t = S.tracking;
  if (!t || !S.accounts.size) return null;
  const names = new Set(
    [...S.accounts].map((i) => S.data.accounts[i] && S.data.accounts[i].name)
  );
  return new Set(t.accounts.map((a, i) => (names.has(a.name) ? i : -1)).filter((i) => i >= 0));
}

/** Bornes d'index de dates correspondant à la période filtrée. */
function trkWindow() {
  const t = S.tracking;
  const lo = t.dates.findIndex((d) => d >= S.start);
  let hi = -1;
  for (let i = t.dates.length - 1; i >= 0; i--) {
    if (t.dates[i] <= S.end) { hi = i; break; }
  }
  return { lo, hi, ok: lo >= 0 && hi >= lo };
}

/**
 * Découpe la fenêtre en « récent » et « référence ».
 *
 * Les deux blocs sont accolés et pris en jours calendaires : comparer sept jours
 * à vingt-huit exige de ramener chaque bloc à une moyenne par jour, ce que fait
 * l'appelant. Si la fenêtre filtrée est trop courte pour contenir les deux, on le
 * dit plutôt que de comparer sept jours à trois.
 */
function trkBlocks() {
  const { lo, hi, ok } = trkWindow();
  if (!ok) return null;
  const span = hi - lo + 1;
  const recentDays = Math.min(TRK_RECENT_DAYS, Math.floor(span / 2));
  if (recentDays < 3) return null;
  const baseDays = Math.min(TRK_BASE_DAYS, span - recentDays);
  if (baseDays < 7) return null;
  return {
    lo, hi, span,
    recentFrom: hi - recentDays + 1, recentTo: hi, recentDays,
    baseFrom: hi - recentDays - baseDays + 1, baseTo: hi - recentDays, baseDays,
  };
}

/**
 * Verdict d'une entité à partir de ses deux blocs.
 *
 * Tout est exprimé en moyennes par jour : un bloc de 7 jours et un de 28 ne se
 * comparent pas autrement. Le taux de conversion est all_conversions / clic —
 * la santé d'une balise se lit sur toutes les actions, pas seulement celles que
 * les enchères comptent.
 */
function trkDiagnose(recent, base, recentDays, baseDays) {
  const rClicks = recent.clicks / recentDays;
  const bClicks = base.clicks / baseDays;
  const rCvr = recent.clicks ? recent.all / recent.clicks : NaN;
  const bCvr = base.clicks ? base.all / base.clicks : NaN;

  const clickDelta = bClicks ? (rClicks - bClicks) / bClicks : NaN;
  const cvrDelta = isFinite(bCvr) && bCvr ? (rCvr - bCvr) / bCvr : NaN;

  let verdict = 'stable';
  if (base.clicks < TRK_MIN_CLICKS || !isFinite(bCvr) || !bCvr) {
    verdict = 'thin';
  } else if (recent.all === 0 && recent.clicks > 0) {
    verdict = 'break';
  } else if (cvrDelta <= -TRK_DROP && Math.abs(clickDelta) <= TRK_STABLE) {
    verdict = 'measure';
  } else if (cvrDelta <= -TRK_DROP && clickDelta <= -TRK_DROP) {
    verdict = 'perf';
  } else if (cvrDelta <= -TRK_DROP) {
    // Le taux chute et le trafic MONTE : une hausse de trafic peut diluer un taux
    // sans qu'aucune balise ne soit en cause. On reste sur « performance ».
    verdict = 'perf';
  } else if (clickDelta <= -TRK_DROP) {
    verdict = 'volume';
  }
  return { rClicks, bClicks, rCvr, bCvr, clickDelta, cvrDelta, verdict };
}

/* ── Agrégations ───────────────────────────────────────────────────────────── */

/** Totaux par entité (compte ou marché) sur un intervalle d'index de dates. */
function trkTotalsBy(dim, from, to) {
  const t = S.tracking;
  const allowed = selectedTrackingAccounts();
  const out = new Map();
  if (dim === 'market') {
    for (const r of t.market) {
      if (r[TM.DATE] < from || r[TM.DATE] > to) continue;
      if (allowed && !allowed.has(r[TM.ACC])) continue;
      const k = r[TM.MARKET];
      let slot = out.get(k);
      if (!slot) out.set(k, (slot = emptyT()));
      addT(slot, 0, r[TM.CLICKS], r[TM.COST], r[TM.CONV], r[TM.ALL], r[TM.VALUE]);
    }
  } else {
    for (const r of t.daily) {
      if (r[TD.DATE] < from || r[TD.DATE] > to) continue;
      if (allowed && !allowed.has(r[TD.ACC])) continue;
      const k = r[TD.ACC];
      let slot = out.get(k);
      if (!slot) out.set(k, (slot = emptyT()));
      addT(slot, r[TD.IMPR], r[TD.CLICKS], r[TD.COST], r[TD.CONV], r[TD.ALL], r[TD.VALUE]);
    }
  }
  return out;
}

/**
 * Noms de pays, côté interface.
 *
 * Le portefeuille livre dans vingt-deux pays, dont une majorité de territoires
 * d'outre-mer que le récupérateur ne connaissait pas : « RE » et « MQ » ne
 * disent rien à la lecture, « Réunion » et « Martinique » oui. La table vit ici
 * plutôt que dans le JSON pour qu'un pays nouveau soit nommé sans réextraction.
 */
const MARKET_FR = {
  FR: 'France', ES: 'Espagne', BE: 'Belgique', CH: 'Suisse', IT: 'Italie',
  PT: 'Portugal', DE: 'Allemagne', GB: 'Royaume-Uni', NL: 'Pays-Bas',
  LU: 'Luxembourg', MC: 'Monaco', PL: 'Pologne', BR: 'Brésil', CA: 'Canada',
  US: 'États-Unis', RE: 'La Réunion', GP: 'Guadeloupe', MQ: 'Martinique',
  GF: 'Guyane', YT: 'Mayotte', NC: 'Nouvelle-Calédonie',
  PF: 'Polynésie française', PM: 'Saint-Pierre-et-Miquelon',
  WF: 'Wallis-et-Futuna', BL: 'Saint-Barthélemy', SX: 'Saint-Martin',
  VC: 'Saint-Vincent', MF: 'Saint-Martin', TF: 'Terres australes',
  '?': 'Pays non résolu',
};

function trkEntityLabel(dim, key) {
  const t = S.tracking;
  if (dim === 'market') {
    const code = t.markets[key];
    return MARKET_FR[code] || (t.marketLabels && t.marketLabels[code]) || code || '?';
  }
  return (t.accounts[key] && t.accounts[key].name) || '?';
}

/** Séries journalières agrégées sur la sélection, pour la carte temporelle. */
function trkDailySeries() {
  const t = S.tracking;
  const allowed = selectedTrackingAccounts();
  const { lo, hi, ok } = trkWindow();
  if (!ok) return null;
  const byDate = new Map();
  for (const r of t.daily) {
    if (r[TD.DATE] < lo || r[TD.DATE] > hi) continue;
    if (allowed && !allowed.has(r[TD.ACC])) continue;
    let slot = byDate.get(r[TD.DATE]);
    if (!slot) byDate.set(r[TD.DATE], (slot = emptyT()));
    addT(slot, r[TD.IMPR], r[TD.CLICKS], r[TD.COST], r[TD.CONV], r[TD.ALL], r[TD.VALUE]);
  }
  return byDate;
}

/* ── Événements superposés ─────────────────────────────────────────────────── */

/**
 * Fusionne le Sheet des changements techniques et le journal Google Ads.
 *
 * Deux sources, deux natures : le Sheet dit ce qui a été déployé côté site et
 * balises ; le journal Ads dit ce qui a bougé dans les comptes. Les mélanger sans
 * les distinguer laisserait croire qu'un changement d'enchère et une republication
 * de conteneur GTM ont le même statut de suspect.
 *
 * Le journal Ads est plafonné à 28 jours par l'API : au-delà, il n'existe pas, et
 * l'absence de repère ancien ne veut pas dire absence de changement.
 */
function trkEvents() {
  const t = S.tracking;
  const out = [];
  const allowed = selectedTrackingAccounts();
  const accountNames = new Set(
    (allowed ? [...allowed] : t.accounts.map((_, i) => i)).map((i) => t.accounts[i].name)
  );

  const cl = S.changelog;
  if (cl && Array.isArray(cl.events)) {
    for (const e of cl.events) {
      if (e.date < S.start || e.date > S.end) continue;
      // Un événement qui nomme des comptes ne concerne que ceux-là. Sans compte
      // nommé, il vaut pour tout le portefeuille.
      if (e.accounts && e.accounts.length
          && !e.accounts.some((n) => accountNames.has(n))) continue;
      out.push({
        date: e.date, source: 'sheet', type: e.type || 'AUTRE',
        title: e.title, detail: e.detail || '',
        accounts: e.accounts || [], markets: e.markets || [],
        impact: e.impact || '',
      });
    }
  }
  return out;
}

/** Changements Google Ads agrégés par jour sur la sélection. */
function trkAdsChanges() {
  const t = S.tracking;
  const allowed = selectedTrackingAccounts();
  const byDate = new Map();
  for (const r of t.changes) {
    if (allowed && !allowed.has(r[TC.ACC])) continue;
    const d = t.dates[r[TC.DATE]];
    if (!d || d < S.start || d > S.end) continue;
    let slot = byDate.get(d);
    if (!slot) byDate.set(d, (slot = { total: 0, types: new Map() }));
    slot.total += r[TC.COUNT];
    const label = ADS_CHANGE_LABELS[r[TC.TYPE]] || r[TC.TYPE];
    slot.types.set(label, (slot.types.get(label) || 0) + r[TC.COUNT]);
  }
  return byDate;
}

/* ── Rendu : indicateurs ───────────────────────────────────────────────────── */

function renderTrkKpis(rows) {
  const t = S.tracking;
  els.trkKpi.replaceChildren();

  const tile = (label, value, foot, note) => {
    const box = document.createElement('div');
    box.className = 'kpi';
    const l = document.createElement('div');
    l.className = 'kpi__label';
    l.textContent = label;
    box.appendChild(l);
    const v = document.createElement('div');
    v.className = 'kpi__value';
    v.textContent = value;
    box.appendChild(v);
    if (foot) {
      const f = document.createElement('div');
      f.className = 'kpi__foot';
      const d = document.createElement('span');
      d.className = 'kpi__delta kpi__delta--flat';
      d.textContent = foot;
      f.appendChild(d);
      box.appendChild(f);
    }
    if (note) {
      const n = document.createElement('div');
      n.className = 'kpi__note';
      n.textContent = note;
      box.appendChild(n);
    }
    els.trkKpi.appendChild(box);
  };

  const alerts = rows.filter((r) => r.verdict === 'break' || r.verdict === 'measure');
  const costAtRisk = alerts.reduce((s, r) => s + r.recent.cost, 0);
  const totalAll = rows.reduce((s, r) => s + r.recent.all + r.base.all, 0);
  const totalConv = rows.reduce((s, r) => s + r.recent.conv + r.base.conv, 0);

  tile('Entités surveillées', fmtInt(rows.length),
    `${rows.filter((r) => r.verdict === 'thin').length} sous le seuil de trafic`,
    `au moins ${TRK_MIN_CLICKS} clics sur la référence pour être diagnostiquées`);

  tile('Mesure en cause', fmtInt(alerts.length),
    alerts.length ? `${fmtMoney(costAtRisk, { compact: true })} dépensés sur ${TRK_RECENT_DAYS} j`
                  : 'aucune alerte sur cette sélection',
    alerts.length ? 'dépense engagée pendant que la mesure est douteuse'
                  : 'taux de conversion et trafic évoluent ensemble partout');

  tile('Conversions vues par les enchères',
    fmtPct(totalAll ? totalConv / totalAll : NaN),
    `${fmtNum1(totalConv)} sur ${fmtNum1(totalAll)}`,
    'part des conversions incluses dans la colonne « Conversions » — le reste est '
    + 'suivi mais n\'optimise rien');

  const silent = S.trkSilent || [];
  tile('Actions muettes', fmtInt(silent.length),
    silent.length ? `la plus ancienne depuis ${Math.max(...silent.map((s) => s.days))} j`
                  : 'aucune action à l\'arrêt',
    `action ayant converti puis silencieuse ${TRK_SILENCE_MIN} jours ou plus`);
}

/* ── Rendu : diagnostic ────────────────────────────────────────────────────── */

function trkDiagRows() {
  const b = trkBlocks();
  if (!b) return { rows: [], blocks: null };
  const dim = S.trkDim;
  const recent = trkTotalsBy(dim, b.recentFrom, b.recentTo);
  const base = trkTotalsBy(dim, b.baseFrom, b.baseTo);

  const keys = new Set([...recent.keys(), ...base.keys()]);
  const rows = [];
  // Les marchés minuscules sont repliés en un seul : le portefeuille livre dans
  // vingt-deux pays, dont une quinzaine de territoires à quelques dizaines de
  // clics. Les lister un par un noierait FR, ES et BE sous du bruit ; les
  // supprimer ferait un total faux. Le repli est annoncé sous le titre.
  const folded = [];
  let fold = null;
  for (const k of keys) {
    const r = recent.get(k) || emptyT();
    const p = base.get(k) || emptyT();
    if (!r.clicks && !p.clicks) continue;
    if (dim === 'market' && r.clicks + p.clicks < TRK_MIN_CLICKS) {
      if (!fold) fold = { recent: emptyT(), base: emptyT() };
      addT(fold.recent, r.impr, r.clicks, r.cost, r.conv, r.all, r.value);
      addT(fold.base, p.impr, p.clicks, p.cost, p.conv, p.all, p.value);
      folded.push(trkEntityLabel(dim, k));
      continue;
    }
    const d = trkDiagnose(r, p, b.recentDays, b.baseDays);
    rows.push({ key: k, label: trkEntityLabel(dim, k), recent: r, base: p, ...d });
  }
  if (fold) {
    const d = trkDiagnose(fold.recent, fold.base, b.recentDays, b.baseDays);
    rows.push({
      key: '__fold__', label: `Autres marchés (${folded.length})`,
      recent: fold.recent, base: fold.base, folded, ...d,
    });
  }
  rows.sort((a, z) => {
    const ra = TRK_VERDICTS[a.verdict].rank;
    const rz = TRK_VERDICTS[z.verdict].rank;
    if (ra !== rz) return ra - rz;
    return z.recent.cost - a.recent.cost;
  });
  return { rows, blocks: b, folded };
}

function renderTrkDiag(rows, b, folded) {
  const t = S.tracking;
  const dim = S.trkDim;

  if (!b) {
    els.trkDiagSub.textContent = '';
    els.trkDiagNote.hidden = true;
    emptyState(els.trkDiagBody,
      `Période trop courte : il faut au moins ${TRK_RECENT_DAYS + 7} jours pour comparer `
      + `une semaine récente à une référence.`);
    return;
  }

  const fmtRange = (from, to) => `${fmtDateShort(t.dates[from])} – ${fmtDateShort(t.dates[to])}`;
  els.trkDiagSub.textContent =
    `${b.recentDays} derniers jours (${fmtRange(b.recentFrom, b.recentTo)}) face aux `
    + `${b.baseDays} précédents (${fmtRange(b.baseFrom, b.baseTo)}) · `
    + `taux = conversions toutes actions / clic · seuils : baisse ${fmtPct(TRK_DROP)}, `
    + `trafic stable à ±${fmtPct(TRK_STABLE)} · ${dim === 'market' ? 'par pays de livraison réelle' : 'par compte'}`
    + (folded && folded.length
      ? ` · ${folded.length} marché(s) sous ${TRK_MIN_CLICKS} clics repliés : ${folded.join(', ')}`
      : '');

  const alerts = rows.filter((r) => r.verdict === 'break' || r.verdict === 'measure');
  els.trkDiagNote.replaceChildren();
  if (alerts.length) {
    const strong = document.createElement('strong');
    strong.textContent = alerts.length === 1
      ? 'Une entité à vérifier côté mesure.'
      : `${alerts.length} entités à vérifier côté mesure.`;
    els.trkDiagNote.appendChild(strong);
    const span = document.createElement('span');
    span.textContent = alerts.map((r) =>
      `${r.label} (${TRK_VERDICTS[r.verdict].label.toLowerCase()}, taux ${
        r.cvrDelta >= 0 ? '+' : '−'}${fmtPct(Math.abs(r.cvrDelta))} pour un trafic ${
        r.clickDelta >= 0 ? '+' : '−'}${fmtPct(Math.abs(r.clickDelta))})`).join(' · ')
      + '. Un taux qui chute sans que le trafic bouge ne s\'explique pas par le marché.';
    els.trkDiagNote.appendChild(span);
    els.trkDiagNote.hidden = false;
  } else {
    els.trkDiagNote.hidden = true;
  }

  if (!rows.length) {
    emptyState(els.trkDiagBody, 'Aucune donnée sur cette sélection.');
    return;
  }

  if (S.views.trkdiag === 'table') {
    renderTable(els.trkDiagBody, {
      scroll: true,
      caption: 'Diagnostic de mesure par entité',
      cols: [
        { key: 'label', label: dim === 'market' ? 'Marché' : 'Compte', text: true },
        { key: 'verdictLabel', label: 'Verdict', text: true },
        { key: 'cvrDelta', label: 'Δ taux de conv.', fmt: (v) => trkSigned(v) },
        { key: 'clickDelta', label: 'Δ clics', fmt: (v) => trkSigned(v) },
        { key: 'rCvr', label: 'Taux récent', fmt: (v) => fmtPct(v) },
        { key: 'bCvr', label: 'Taux référence', fmt: (v) => fmtPct(v) },
        { key: 'rClicks', label: 'Clics / j', fmt: (v) => fmtInt(v) },
        { key: 'cost', label: `Coût ${b.recentDays} j`, fmt: fmtMoney },
      ],
      rows: rows.map((r) => ({
        label: r.label,
        _swatch: trkVerdictColor(r.verdict),
        _sub: TRK_VERDICTS[r.verdict].hint,
        verdictLabel: TRK_VERDICTS[r.verdict].label,
        cvrDelta: r.cvrDelta, clickDelta: r.clickDelta,
        rCvr: r.rCvr, bCvr: r.bCvr, rClicks: r.rClicks,
        cost: r.recent.cost,
      })),
    });
    return;
  }

  // Barres divergentes sur la variation du taux de conversion : c'est le signal
  // de mesure. Le trafic reste dans l'infobulle et dans le tableau — le porter
  // sur le même graphique en ferait un double axe déguisé.
  // Le graphique se lit de la pire variation à la meilleure ; le tableau garde
  // l'ordre des verdicts, qui répond à « par quoi je commence ».
  const shown = rows
    .filter((r) => r.verdict !== 'thin' && isFinite(r.cvrDelta))
    .sort((a, z) => a.cvrDelta - z.cvrDelta)
    .slice(0, 16);
  if (!shown.length) {
    emptyState(els.trkDiagBody,
      `Aucune entité n'atteint ${TRK_MIN_CLICKS} clics sur la période de référence. `
      + `Le tableau les liste toutes.`);
    return;
  }
  renderDivergingBars(els.trkDiagBody, {
    rows: shown.map((r) => ({
      label: r.label,
      recent: r.rCvr, prev: r.bCvr, delta: r.cvrDelta,
      examples: [TRK_VERDICTS[r.verdict].label],
      clickDelta: r.clickDelta,
    })),
    fmt: (v) => fmtPct(v),
    upLabel: 'Taux en hausse', downLabel: 'Taux en baisse',
    axisLeft: 'taux en baisse ←', axisRight: '→ taux en hausse',
    tipRows: (r) => [
      { name: 'Taux récent', value: fmtPct(r.recent), color: seriesColor(1) },
      { name: 'Taux de référence', value: fmtPct(r.prev), color: seriesColor(8) },
      { name: 'Δ clics', value: trkSigned(r.clickDelta) },
      { name: 'Verdict', value: r.examples[0], total: true },
    ],
    ariaLabel: 'Variation du taux de conversion par entité',
  });
}

function trkSigned(v) {
  if (!isFinite(v)) return '—';
  return (v >= 0 ? '+' : '−') + fmtPct(Math.abs(v));
}

/* ── Rendu : actions muettes ───────────────────────────────────────────────── */

/**
 * Une action qui a converti puis s'est tue, alors que le compte reçoit toujours
 * des clics. C'est la signature d'une balise cassée, et le cas le plus coûteux :
 * les enchères continuent d'optimiser sur un signal disparu.
 */
function trkSilentActions() {
  const t = S.tracking;
  const { lo, hi, ok } = trkWindow();
  if (!ok) return [];
  const allowed = selectedTrackingAccounts();

  // (compte, action) → dernier jour converti, total, premier jour vu
  const seen = new Map();
  for (const r of t.series) {
    if (r[TS.DATE] < lo || r[TS.DATE] > hi) continue;
    if (allowed && !allowed.has(r[TS.ACC])) continue;
    if (!r[TS.ALL]) continue;
    const k = `${r[TS.ACC]}|${r[TS.ACTION]}`;
    let s = seen.get(k);
    if (!s) seen.set(k, (s = { acc: r[TS.ACC], action: r[TS.ACTION], last: -1, first: 1e9, total: 0, days: 0 }));
    s.total += r[TS.ALL];
    s.days += 1;
    if (r[TS.DATE] > s.last) s.last = r[TS.DATE];
    if (r[TS.DATE] < s.first) s.first = r[TS.DATE];
  }

  // Clics par compte et par jour, pour vérifier que le compte tourne encore.
  const clicksByAccDate = new Map();
  for (const r of t.daily) {
    if (r[TD.DATE] < lo || r[TD.DATE] > hi) continue;
    if (allowed && !allowed.has(r[TD.ACC])) continue;
    clicksByAccDate.set(`${r[TD.ACC]}|${r[TD.DATE]}`, r[TD.CLICKS]);
  }
  const clicksSince = (acc, from) => {
    let n = 0;
    for (let d = from; d <= hi; d++) n += clicksByAccDate.get(`${acc}|${d}`) || 0;
    return n;
  };
  const costSince = new Map();
  for (const r of t.daily) {
    if (r[TD.DATE] < lo || r[TD.DATE] > hi) continue;
    if (allowed && !allowed.has(r[TD.ACC])) continue;
    costSince.set(`${r[TD.ACC]}|${r[TD.DATE]}`, r[TD.COST]);
  }

  const out = [];
  for (const s of seen.values()) {
    const silence = hi - s.last;
    if (silence < TRK_SILENCE_MIN) continue;
    if (s.total < TRK_MIN_CONV) continue;   // trop peu vu pour qu'un silence parle
    const clicks = clicksSince(s.acc, s.last + 1);
    if (!clicks) continue;                  // compte à l'arrêt : ce n'est pas la balise
    let cost = 0;
    for (let d = s.last + 1; d <= hi; d++) cost += costSince.get(`${s.acc}|${d}`) || 0;
    out.push({
      account: t.accounts[s.acc].name,
      action: t.actions[s.action],
      last: t.dates[s.last],
      days: silence,
      perDay: s.total / Math.max(1, s.days),
      total: s.total,
      clicks,
      cost,
    });
  }
  out.sort((a, b) => b.cost - a.cost || b.days - a.days);
  return out;
}

function renderTrkSilent(list) {
  els.trkSilentSub.textContent =
    `Actions ayant converti au moins ${TRK_MIN_CONV} fois sur la période, puis silencieuses `
    + `${TRK_SILENCE_MIN} jours ou plus alors que le compte recevait encore des clics · `
    + `classées par dépense engagée depuis le silence`;

  if (!list.length) {
    emptyState(els.trkSilentBody,
      'Aucune action muette sur cette sélection : chaque action qui a converti '
      + 'converti encore.');
    return;
  }

  renderTable(els.trkSilentBody, {
    scroll: true,
    caption: 'Actions de conversion silencieuses',
    cols: [
      { key: 'action', label: 'Action de conversion', text: true },
      { key: 'last', label: 'Dernière conversion', text: true },
      { key: 'days', label: 'Jours de silence', fmt: fmtInt },
      { key: 'perDay', label: 'Conv. / j avant', fmt: fmtNum1 },
      { key: 'clicks', label: 'Clics depuis', fmt: fmtInt },
      { key: 'cost', label: 'Coût depuis', fmt: fmtMoney },
    ],
    rows: list.map((r) => ({
      action: r.action,
      _sub: r.account,
      _swatch: trkVerdictColor(r.days >= 7 ? 'break' : 'measure'),
      last: fmtDateShort(r.last),
      days: r.days, perDay: r.perDay, clicks: r.clicks, cost: r.cost,
    })),
    foot: {
      action: `Total — ${list.length} action(s)`,
      cost: list.reduce((s, r) => s + r.cost, 0),
      clicks: list.reduce((s, r) => s + r.clicks, 0),
    },
  });
}

/* ── Rendu : conversions face aux clics ────────────────────────────────────── */

function renderTrkTime() {
  const t = S.tracking;
  const byDate = trkDailySeries();
  const { lo, hi, ok } = trkWindow();
  if (!ok || !byDate || !byDate.size) {
    els.trkTimeSub.textContent = '';
    els.trkTimeLegend.textContent = '';
    emptyState(els.trkTimeBody, 'Aucune donnée sur cette sélection.');
    return;
  }

  const grain = S.trkGrain;
  const share = S.trkScale === 'index';
  const buckets = new Map();
  for (let d = lo; d <= hi; d++) {
    const slot = byDate.get(d);
    if (!slot) continue;
    const k = grainKey(t.dates[d], grain);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { ...emptyT(), first: t.dates[d], days: 0 }));
    b.days += 1;
    addT(b, slot.impr, slot.clicks, slot.cost, slot.conv, slot.all, slot.value);
  }
  let keys = [...buckets.keys()].sort();
  if (!keys.length) {
    emptyState(els.trkTimeBody, 'Aucune donnée sur cette sélection.');
    return;
  }

  // Périodes partielles aux deux bouts : une fenêtre de 90 jours commence et
  // finit rarement un lundi. Sur une base 100, une première semaine tronquée
  // sert de référence à tout le reste, et une dernière semaine d'un seul jour
  // ressemble à un effondrement. Les deux sont écartées du graphique — et le
  // tableau les garde, marquées « partiel ».
  const expectedDays = (k) => {
    if (grain === 'day') return 1;
    if (grain === 'week') return 7;
    const [y, m] = k.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  };
  const partial = new Set(keys.filter((k, i) =>
    (i === 0 || i === keys.length - 1) && buckets.get(k).days < expectedDays(k)));
  const chartKeys = keys.filter((k) => !partial.has(k));
  const partialLabels = [...partial].map((k) => grainLabel(k, grain));

  const clicks = chartKeys.map((k) => buckets.get(k).clicks);
  const conv = chartKeys.map((k) => buckets.get(k).all);
  const cvr = chartKeys.map((k) => {
    const b = buckets.get(k);
    return b.clicks ? b.all / b.clicks : null;
  });

  // Base 100 sur la première période : c'est la seule façon de mettre des clics
  // (dizaines de milliers) et un taux (quelques pourcents) sur une même échelle
  // sans double axe. La vue « valeurs » garde les grandeurs brutes, sur deux
  // cartes de tableau plutôt qu'un axe truqué.
  const idx = (arr) => {
    const base = arr.find((v) => v !== null && isFinite(v) && v > 0);
    return base ? arr.map((v) => (v === null || !isFinite(v) ? null : v / base * 100)) : arr;
  };

  const series = share
    ? [
      { key: 'clicks', name: 'Clics', color: seriesColor(1), values: idx(clicks) },
      { key: 'conv', name: 'Conversions', color: seriesColor(3), values: idx(conv) },
      { key: 'cvr', name: 'Taux de conversion', color: seriesColor(2), values: idx(cvr) },
    ]
    : [
      { key: 'clicks', name: 'Clics', color: seriesColor(1), values: clicks },
      { key: 'conv', name: 'Conversions', color: seriesColor(3), values: conv },
    ];

  // Repères : un par événement du Sheet, plus les journées de forte activité
  // dans le journal Google Ads.
  const events = trkEvents();
  const adsChanges = trkAdsChanges();
  const posOf = (iso) => chartKeys.indexOf(grainKey(iso, grain));

  const vmarks = [];
  const legend = [];
  events.forEach((e) => {
    const at = posOf(e.date);
    if (at < 0) return;
    const n = vmarks.length + 1;
    vmarks.push({
      at, label: `${n}. ${e.title}`, tick: String(n),
      color: seriesColor(CHANGE_TYPE_SLOT[e.type] || 6),
      tipValue: fmtDateShort(e.date),
    });
    legend.push(`${n}. ${fmtDateShort(e.date)} — ${e.title}`);
  });

  els.trkTimeSub.textContent =
    (share
      ? 'Base 100 sur la première période : clics, conversions et taux sur une seule échelle'
      : 'Volumes bruts — le taux de conversion vit dans la carte de diagnostic, pas sur un second axe')
    + ` · ${grain === 'day' ? 'par jour' : grain === 'week' ? 'par semaine' : 'par mois'}`
    + (vmarks.length ? ` · ${vmarks.length} changement(s) repéré(s)` : ' · aucun changement déclaré sur la période')
    + (partialLabels.length
      ? ` · période(s) partielle(s) écartée(s) du graphique : ${partialLabels.join(', ')}`
      : '');

  if (S.views.trktime === 'table') {
    renderTable(els.trkTimeBody, {
      scroll: true,
      caption: 'Clics, conversions et taux par période',
      cols: [
        { key: 'k', label: grain === 'month' ? 'Mois' : grain === 'week' ? 'Semaine' : 'Jour', text: true },
        { key: 'clicks', label: 'Clics', fmt: fmtInt },
        { key: 'conv', label: 'Conversions', fmt: fmtNum1 },
        { key: 'cvr', label: 'Taux', fmt: (v) => fmtPct(v) },
        { key: 'cost', label: 'Coût', fmt: fmtMoney },
        { key: 'events', label: 'Changements', text: true },
      ],
      rows: keys.map((k) => {
        const b = buckets.get(k);
        const evs = events.filter((e) => grainKey(e.date, grain) === k).map((e) => e.title);
        const ads = [...adsChanges.entries()]
          .filter(([d]) => grainKey(d, grain) === k)
          .reduce((s, [, v]) => s + v.total, 0);
        const bits = [...evs];
        if (ads) bits.push(`${ads} modif. Google Ads`);
        return {
          k: grainLabel(k, grain) + (partial.has(k) ? ' (partiel)' : ''),
          clicks: b.clicks, conv: b.all, cvr: b.clicks ? b.all / b.clicks : NaN,
          cost: b.cost, events: bits.join(' · ') || '—',
        };
      }),
    });
    els.trkTimeLegend.textContent = '';
    return;
  }

  renderLineChart(els.trkTimeBody, {
    xLabels: chartKeys.map((k) => grainLabel(k, grain)),
    series,
    fmt: share ? ((v) => `${nf0.format(v)}`) : fmtInt,
    endLabel: true,
    height: 320,
    summable: false,
    vmarks,
    ariaLabel: 'Clics et conversions dans le temps, avec les changements techniques',
  });

  els.trkTimeLegend.textContent = legend.length
    ? `Repères : ${legend.join(' · ')}`
    : (S.changelogState === 'ready'
      ? 'Aucun changement technique déclaré sur cette période.'
      : 'Aucun journal de changements chargé : renseignez data/changelog.json pour '
        + 'superposer les déploiements GTM, Didomi et conteneurs.');
}

/* ── Rendu : consentement ──────────────────────────────────────────────────── */

function renderTrkConsent() {
  const cl = S.changelog;
  const pts = (cl && cl.consent ? cl.consent : [])
    .filter((p) => p.date >= S.start && p.date <= S.end)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Pas de donnée = carte masquée. Une carte vide laisserait croire à un bug,
  // alors que la cause est ailleurs : Google Ads n'expose pas le consentement.
  els.trkConsentCard.hidden = !pts.length;
  if (!pts.length) return;

  els.trkConsentSub.textContent =
    `${pts.length} relevé(s) issus de la CMP, via data/changelog.json · `
    + `l'API Google Ads n'expose aucun taux de consentement`;

  if (S.views.trkconsent === 'table') {
    renderTable(els.trkConsentBody, {
      caption: 'Taux de consentement relevés',
      cols: [
        { key: 'date', label: 'Date', text: true },
        { key: 'rate', label: 'Consentement', fmt: (v) => fmtPct(v) },
        { key: 'scope', label: 'Périmètre', text: true },
      ],
      rows: pts.map((p) => ({
        date: fmtDateShort(p.date),
        rate: p.rate,
        scope: [...(p.markets || []), ...(p.accounts || [])].join(', ') || 'portefeuille',
      })),
    });
    return;
  }

  renderLineChart(els.trkConsentBody, {
    xLabels: pts.map((p) => fmtDateShort(p.date)),
    series: [{
      key: 'rate', name: 'Consentement', color: seriesColor(3),
      values: pts.map((p) => p.rate * 100),
    }],
    fmt: (v) => `${nf1.format(v)} %`,
    area: true,
    height: 220,
    summable: false,
    ariaLabel: 'Taux de consentement dans le temps',
  });
}

/* ── Rendu : retard de conversion ──────────────────────────────────────────── */

function renderTrkLag() {
  const t = S.tracking;
  const allowed = selectedTrackingAccounts();
  const share = S.trkLagScale === 'share';

  const byMonth = new Map();
  for (const r of t.lag) {
    if (allowed && !allowed.has(r[TL.ACC])) continue;
    const month = t.months[r[TL.MONTH]];
    if (!month) continue;
    // Le mois est comparé aux bornes de la période : un mois entamé compte, un
    // mois hors fenêtre non.
    if (month + '-31' < S.start || month + '-01' > S.end) continue;
    let slot = byMonth.get(month);
    if (!slot) byMonth.set(month, (slot = t.lagGroups.map(() => 0)));
    slot[r[TL.GROUP]] += r[TL.ALL];
  }

  const months = [...byMonth.keys()].sort();
  // Le mois en cours est mécaniquement faussé : une conversion à quinze jours de
  // retard survenue cette semaine n'est pas encore arrivée. Sa part de « moins
  // d'un jour » est donc artificiellement haute — ce n'est pas un tagging qui
  // s'améliore, c'est une fenêtre qui se ferme trop tôt. Le dire, sinon la carte
  // se lit à l'envers.
  const lastMonth = months[months.length - 1];
  const nowMonth = (S.tracking.meta && S.tracking.meta.date_end || '').slice(0, 7);
  const truncated = lastMonth && lastMonth === nowMonth;
  els.trkLagSub.textContent = (share
    ? 'Profil du délai entre le clic et la conversion, chaque mois ramené à 100 %'
    : 'Conversions par délai entre le clic et la conversion')
    + (truncated
      ? ` · ${fmtMonth(lastMonth)} est incomplet : les retards longs n'y sont pas encore `
        + `arrivés, sa part de « moins d'un jour » est donc surévaluée`
      : '');

  if (!months.length) {
    emptyState(els.trkLagBody, 'Aucune donnée de retard sur cette sélection.');
    return;
  }

  const series = t.lagGroups.map((g, i) => ({
    key: String(i), name: g, color: seriesColor(i + 1),
  }));
  const rows = months.map((m) => {
    const slot = byMonth.get(m);
    const values = {};
    let total = 0;
    slot.forEach((v, i) => { values[String(i)] = v; total += v; });
    return { label: fmtMonth(m) + (m === lastMonth && truncated ? ' (partiel)' : ''),
      values, total };
  }).filter((r) => r.total > 0);

  if (S.views.trklag === 'table') {
    renderTable(els.trkLagBody, {
      scroll: true,
      caption: 'Retard de conversion par mois',
      cols: [
        { key: 'label', label: 'Mois', text: true },
        ...series.map((s) => ({
          key: s.key, label: s.name,
          fmt: share ? ((v) => fmtPct(v || 0)) : ((v) => fmtNum1(v || 0)),
        })),
        { key: 'total', label: 'Total', fmt: fmtNum1 },
      ],
      rows: rows.map((r) => {
        const out = { label: r.label, total: r.total };
        for (const s of series) {
          const v = r.values[s.key] || 0;
          out[s.key] = share ? (r.total ? v / r.total : 0) : v;
        }
        return out;
      }),
    });
    return;
  }

  renderStackedBars(els.trkLagBody, {
    rows, series, fmt: fmtNum1, normalize: share,
    ariaLabel: 'Retard de conversion par mois',
  });
}

/* ── Rendu : journal des changements ──────────────────────────────────────── */

function renderTrkLog() {
  const t = S.tracking;
  const events = trkEvents();
  const adsChanges = trkAdsChanges();
  const meta = t.meta || {};

  const adsRows = [...adsChanges.entries()].map(([date, v]) => {
    const top = [...v.types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, n]) => `${k} ×${n}`).join(', ');
    return {
      date, source: 'Google Ads', type: 'ADS',
      title: `${v.total} modification(s) dans les comptes`,
      detail: top,
    };
  });

  const all = [...events.map((e) => ({
    date: e.date, source: 'Sheet',
    type: e.type,
    title: e.title,
    detail: [e.detail, e.accounts.join(', '), e.markets.join(', '),
      e.impact ? `impact ${e.impact}` : ''].filter(Boolean).join(' · '),
  })), ...adsRows].sort((a, b) => b.date.localeCompare(a.date));

  const labels = (S.changelog && S.changelog.typeLabels) || {};
  els.trkLogSub.textContent =
    `${events.length} changement(s) déclarés dans le Sheet · `
    + `${adsRows.length} journée(s) de modifications côté Google Ads · du plus récent au plus ancien`;

  // Le plafond de l'API doit être dit : sans ça, un mois sans repère se lit comme
  // « rien n'a bougé » alors qu'il signifie « l'API ne sait plus ».
  els.trkLogNote.replaceChildren();
  const notes = [];
  // Un jeu d'exemple ne doit jamais passer pour des données réelles. Le
  // récupérateur marque sa source ; l'interface le répète, faute de quoi cinq
  // événements inventés se liraient comme cinq déploiements.
  if (S.changelog && S.changelog.meta && S.changelog.meta.source === 'exemple') {
    notes.push('Les changements listés viennent du JEU D\'EXEMPLE '
      + '(scripts/fetch_changelog.py --sample), pas de votre Sheet : ce sont des événements '
      + 'inventés pour vérifier l\'affichage.');
  }
  if (Array.isArray(S.changelog && S.changelog.meta && S.changelog.meta.skipped)
      && S.changelog.meta.skipped.length) {
    notes.push(`${S.changelog.meta.skipped.length} ligne(s) du Sheet ont été ignorées à `
      + `l'extraction (${S.changelog.meta.skipped.slice(0, 4).join(', ')}) : date illisible `
      + `ou titre vide.`);
  }
  if (meta.change_window_days) {
    notes.push(`Le journal Google Ads ne remonte que ${meta.change_window_days} jours `
      + `(limite de l'API, depuis le ${fmtDateLong(meta.change_start)}) : une période sans `
      + `repère plus ancienne ne veut pas dire qu'aucun changement n'a eu lieu.`);
  }
  if (S.changelogState !== 'ready') {
    notes.push('Aucun Sheet de changements chargé : seuls les changements internes à '
      + 'Google Ads sont listés. Les déploiements GTM, Didomi et conteneurs viennent de '
      + 'data/changelog.json.');
  }
  if (notes.length) {
    const strong = document.createElement('strong');
    strong.textContent = 'Portée du journal.';
    els.trkLogNote.appendChild(strong);
    const span = document.createElement('span');
    span.textContent = notes.join(' ');
    els.trkLogNote.appendChild(span);
    els.trkLogNote.hidden = false;
  } else {
    els.trkLogNote.hidden = true;
  }

  if (!all.length) {
    emptyState(els.trkLogBody, 'Aucun changement sur cette période.');
    return;
  }

  renderTable(els.trkLogBody, {
    scroll: true,
    caption: 'Journal des changements techniques',
    cols: [
      { key: 'date', label: 'Date', text: true },
      { key: 'kind', label: 'Nature', text: true },
      { key: 'title', label: 'Changement', text: true },
      { key: 'detail', label: 'Détail', text: true },
      { key: 'source', label: 'Source', text: true },
    ],
    rows: all.slice(0, 120).map((e) => ({
      date: fmtDateShort(e.date),
      _swatch: seriesColor(CHANGE_TYPE_SLOT[e.type] || 6),
      kind: labels[e.type] || e.type,
      title: e.title,
      detail: e.detail || '—',
      source: e.source,
    })),
  });
}

/* ── Rendu : configuration du suivi ───────────────────────────────────────── */

const TRK_STATUS_LABELS = {
  CONVERSION_TRACKING_MANAGED_BY_SELF: 'Géré par le compte',
  CONVERSION_TRACKING_MANAGED_BY_THIS_MANAGER: 'Géré par ce MCC',
  CONVERSION_TRACKING_MANAGED_BY_ANOTHER_MANAGER: 'Géré par un autre MCC',
  NOT_CONVERSION_TRACKED: 'Aucun suivi de conversion',
  UNKNOWN: 'Inconnu', UNSPECIFIED: 'Non renseigné',
};

function renderTrkConfig() {
  const t = S.tracking;
  const allowed = selectedTrackingAccounts();
  const rows = (t.config || []).filter((c) => !allowed || allowed.has(c.account));

  // Un identifiant de conversion partagé par plusieurs comptes est normal sur un
  // MCC ; un compte seul sur le sien mérite un œil, c'est souvent l'oubli d'une
  // migration. On compte donc les occurrences plutôt que de juger.
  const idCount = new Map();
  for (const c of rows) {
    const id = c.crossAccountId || c.trackingId || '';
    if (id) idCount.set(id, (idCount.get(id) || 0) + 1);
  }

  const untracked = rows.filter((c) => c.status === 'NOT_CONVERSION_TRACKED').length;
  els.trkConfigSub.textContent =
    `${rows.length} compte(s) · ${idCount.size} identifiant(s) de conversion distinct(s)`
    + (untracked ? ` · ${untracked} sans suivi` : '');

  if (!rows.length) {
    emptyState(els.trkConfigBody, 'Aucun compte sur cette sélection.');
    return;
  }

  renderTable(els.trkConfigBody, {
    scroll: true,
    caption: 'Configuration du suivi de conversion par compte',
    cols: [
      { key: 'name', label: 'Compte', text: true },
      { key: 'status', label: 'Suivi', text: true },
      { key: 'id', label: 'Identifiant', text: true },
      { key: 'shared', label: 'Comptes sur cet id', fmt: fmtInt },
      { key: 'actions', label: 'Actions actives', fmt: fmtInt },
      { key: 'primary', label: 'Principales', fmt: fmtInt },
      { key: 'counted', label: 'Comptées', fmt: fmtInt },
      { key: 'upload', label: 'Import hors ligne', fmt: fmtInt },
      { key: 'auto', label: 'Suivi auto', text: true },
    ],
    rows: rows.map((c) => {
      const id = c.crossAccountId || c.trackingId || '';
      return {
        name: (t.accounts[c.account] && t.accounts[c.account].name) || '?',
        _sub: (t.accounts[c.account] && t.accounts[c.account].cid) || '',
        _swatch: c.status === 'NOT_CONVERSION_TRACKED'
          ? trkVerdictColor('break') : trkVerdictColor('stable'),
        status: TRK_STATUS_LABELS[c.status] || c.status,
        id: id || '—',
        shared: idCount.get(id) || 0,
        actions: c.actionsEnabled ?? 0,
        primary: c.actionsPrimary ?? 0,
        counted: c.actionsCounted ?? 0,
        upload: c.actionsUpload ?? 0,
        auto: c.autoTagging ? 'oui' : 'non',
      };
    }),
  });
}

/* ── Orchestration ────────────────────────────────────────────────────────── */

function renderTracking() {
  if (S.trackingState !== 'ready') return;
  resolveRange();
  const t = S.tracking;
  const meta = t.meta || {};

  const scoped = selectedTrackingAccounts();
  const nAcc = scoped ? scoped.size : t.accounts.length;
  els.trkMeta.textContent =
    `${fmtDateLong(S.start)} – ${fmtDateLong(S.end)} · `
    + `${nAcc} compte(s) actif(s) sur ${meta.accounts_scanned || t.accounts.length} scannés · `
    + `données disponibles du ${fmtDateLong(meta.date_start)} au ${fmtDateLong(meta.date_end)}`;
  if (S.view === 'tracking') {
    els.filterStatus.textContent =
      `${fmtDateLong(S.start)} – ${fmtDateLong(S.end)} · ${nAcc} compte(s) · santé de la mesure`;
  }

  const { rows, blocks, folded } = trkDiagRows();
  S.trkSilent = trkSilentActions();

  renderTrkKpis(rows);
  renderTrkDiag(rows, blocks, folded);
  renderTrkSilent(S.trkSilent);
  renderTrkTime();
  renderTrkConsent();
  renderTrkLag();
  renderTrkLog();
  renderTrkConfig();
}

/** Le bandeau qui dit ce que cet onglet ne peut pas savoir. */
function renderTrkLimits() {
  els.trkLimits.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = 'Le Consent Mode n\'est pas dans l\'API Google Ads.';
  els.trkLimits.appendChild(strong);
  const span = document.createElement('span');
  span.textContent =
    'Sondé sur la v25 : aucun champ pour le taux granted / denied, aucun champ pour '
    + 'séparer les conversions modélisées des conversions observées. Cet onglet mesure donc '
    + 'la santé du tracking par ses effets — une balise cassée fait tomber les conversions '
    + 'sans toucher aux clics. Le taux de consentement, lui, vient de la CMP via '
    + 'data/changelog.json.';
  els.trkLimits.appendChild(span);
  els.trkLimits.hidden = false;
}

async function loadTracking() {
  if (S.trackingState !== 'idle') return;
  S.trackingState = 'loading';
  renderTrkLimits();

  // Le journal est facultatif : son absence ne doit pas empêcher le diagnostic.
  loadChangelog();

  try {
    const res = await fetch('data/tracking.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S.tracking = await res.json();
  } catch (err) {
    S.trackingState = 'error';
    els.trkError.replaceChildren();
    const s = document.createElement('strong');
    s.textContent = 'Données de tracking indisponibles.';
    els.trkError.appendChild(s);
    const d = document.createElement('span');
    d.textContent = `Impossible de charger data/tracking.json (${err.message}). `
      + `Générez-le avec « python scripts/fetch_tracking.py ».`;
    els.trkError.appendChild(d);
    els.trkError.hidden = false;
    return;
  }
  if (!S.tracking || !Array.isArray(S.tracking.daily) || !S.tracking.daily.length) {
    S.trackingState = 'error';
    els.trkError.replaceChildren();
    const s = document.createElement('strong');
    s.textContent = 'Fichier de tracking vide.';
    els.trkError.appendChild(s);
    els.trkError.hidden = false;
    return;
  }
  S.trackingState = 'ready';
  els.trkError.hidden = true;

  buildSegmented(els.trkDiagDim,
    [{ key: 'account', label: 'Comptes' }, { key: 'market', label: 'Marchés' }],
    () => S.trkDim, (k) => { S.trkDim = k; renderTracking(); writeHash(); });

  buildSegmented(els.trkTimeGrain,
    [{ key: 'day', label: 'Jour' }, { key: 'week', label: 'Semaine' },
     { key: 'month', label: 'Mois' }],
    () => S.trkGrain, (k) => { S.trkGrain = k; renderTracking(); writeHash(); });

  buildSegmented(els.trkTimeScale,
    [{ key: 'index', label: 'Base 100' }, { key: 'volume', label: 'Volumes' }],
    () => S.trkScale, (k) => { S.trkScale = k; renderTracking(); writeHash(); });

  buildSegmented(els.trkLagScale,
    [{ key: 'volume', label: 'Volume' }, { key: 'share', label: 'Base 100' }],
    () => S.trkLagScale, (k) => { S.trkLagScale = k; renderTracking(); writeHash(); });

  buildViewToggles();
  renderTracking();
}

async function loadChangelog() {
  if (S.changelogState !== 'idle') return;
  S.changelogState = 'loading';
  try {
    const res = await fetch('data/changelog.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S.changelog = await res.json();
  } catch (err) {
    // Absence de journal ≠ erreur : l'onglet fonctionne sans, et le dit.
    S.changelogState = 'error';
    console.info(`Journal des changements absent (${err.message}). `
      + `Générez data/changelog.json avec « python scripts/fetch_changelog.py --sheet <ID> ».`);
    return;
  }
  S.changelogState = 'ready';
  if (S.trackingState === 'ready') renderTracking();
}

/* ── Navigation entre vues ────────────────────────────────────────────────── */

function setView(view) {
  S.view = view;
  els.contenu.hidden = view !== 'report';
  els.viewLive.hidden = view !== 'live';
  els.viewTracking.hidden = view !== 'tracking';
  // La barre reste visible sur les trois vues : le filtre de comptes vaut
  // partout. Les contrôles sans objet ailleurs sont masqués — appareil, réseau
  // et recherche de campagne ne cadrent que le rapport ; la période cadre aussi
  // le Tracking, mais pas le Live qui porte sur la seule journée en cours.
  els.filterbar.hidden = false;
  for (const n of document.querySelectorAll('[data-report-only]')) {
    n.hidden = view !== 'report';
  }
  for (const n of document.querySelectorAll('[data-no-live]')) {
    n.hidden = view === 'live';
  }
  els.filterAction.hidden = view !== 'live';
  for (const b of els.viewTabs.querySelectorAll('button')) {
    const on = b.dataset.key === view;
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-selected', String(on));
  }
  writeHash();
  if (view === 'live' && S.liveState === 'idle') loadLive();
  if (view === 'tracking' && S.trackingState === 'idle') loadTracking();
  // Les SVG sont dimensionnés sur une largeur mesurée : un conteneur masqué
  // mesure zéro, il faut redessiner en revenant sur la vue.
  if (view === 'report') render();
  else if (view === 'tracking') {
    if (S.trackingState === 'ready') renderTracking();
    els.filterStatus.textContent = S.trackingState === 'ready'
      ? `${fmtDateLong(S.start)} – ${fmtDateLong(S.end)} · santé de la mesure`
      : 'Signaux de tracking en cours de chargement…';
  } else if (S.liveState === 'ready') renderLive();
  else els.filterStatus.textContent = 'Direct en cours de chargement…';

  updateLiveAutoRefresh();
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
    roiBody: 'roi-body', roiSub: 'roi-sub', effBody: 'eff-body', effSub: 'eff-sub',
    topBody: 'top-body', topSub: 'top-sub', topMetric: 'top-metric',
    mixBody: 'mix-body', mixSub: 'mix-sub', mixDim: 'mix-dim',
    marginBody: 'margin-body', marginSub: 'margin-sub',
    marginMeasure: 'margin-measure', marginNote: 'margin-note',
    aimaxSection: 'aimax-section', aimaxMeta: 'aimax-meta', aimaxNote: 'aimax-note',
    aimaxKpi: 'aimax-kpi', aimaxMetric: 'aimax-metric', aimaxSource: 'aimax-source',
    aimaxMtBody: 'aimax-mt-body', aimaxMtSub: 'aimax-mt-sub',
    aimaxTermsBody: 'aimax-terms-body', aimaxTermsSub: 'aimax-terms-sub',
    aimaxRampBody: 'aimax-ramp-body', aimaxRampSub: 'aimax-ramp-sub',
    aimaxCampBody: 'aimax-camp-body', aimaxCampSub: 'aimax-camp-sub',
    detailBody: 'detail-body', detailSub: 'detail-sub', exportCsv: 'export-csv',
    semMeta: 'sem-meta', semStatus: 'sem-status', semLoader: 'sem-loader',
    semLoad: 'sem-load', semLoadNote: 'sem-load-note', semContent: 'sem-content',
    driftBody: 'drift-body', driftSub: 'drift-sub', driftX: 'drift-x',
    intentBody: 'intent-body', intentSub: 'intent-sub', intentDim: 'intent-dim',
    intentScale: 'intent-scale',
    ngramBody: 'ngram-body', ngramSub: 'ngram-sub', ngramMetric: 'ngram-metric',
    matchSection: 'match-section', matchMeta: 'match-meta',
    cannibBody: 'cannib-body', cannibSub: 'cannib-sub', cannibMetric: 'cannib-metric',
    velocityBody: 'velocity-body', velocitySub: 'velocity-sub', velocityBid: 'velocity-bid',
    marginalBody: 'marginal-body', marginalSub: 'marginal-sub',
    contenu: 'contenu', viewLive: 'view-live', viewTabs: 'view-tabs',
    genderSection: 'gender-section', genderSub: 'gender-sub',
    genderNote: 'gender-note', genderScale: 'gender-scale', genderBody: 'gender-body',
    viewTracking: 'view-tracking', trkError: 'trk-error', trkLimits: 'trk-limits',
    trkMeta: 'trk-meta', trkKpi: 'trk-kpi',
    trkDiagDim: 'trk-diag-dim', trkDiagSub: 'trk-diag-sub',
    trkDiagNote: 'trk-diag-note', trkDiagBody: 'trk-diag-body',
    trkSilentSub: 'trk-silent-sub', trkSilentBody: 'trk-silent-body',
    trkTimeGrain: 'trk-time-grain', trkTimeScale: 'trk-time-scale',
    trkTimeSub: 'trk-time-sub', trkTimeBody: 'trk-time-body',
    trkTimeLegend: 'trk-time-legend',
    trkConsentCard: 'trk-consent-card', trkConsentSub: 'trk-consent-sub',
    trkConsentBody: 'trk-consent-body',
    trkLagScale: 'trk-lag-scale', trkLagSub: 'trk-lag-sub', trkLagBody: 'trk-lag-body',
    trkLogSub: 'trk-log-sub', trkLogNote: 'trk-log-note', trkLogBody: 'trk-log-body',
    trkConfigSub: 'trk-config-sub', trkConfigBody: 'trk-config-body',
    filterbar: 'filterbar',
    liveError: 'live-error', liveTz: 'live-tz', liveAlertSlot: 'live-alert-slot',
    liveMeta: 'live-meta', liveKpi: 'live-kpi',
    liveRefresh: 'live-refresh', liveRefreshLabel: 'live-refresh-label',
    liveRefreshNote: 'live-refresh-note',
    liveRegen: 'live-regen', reportRegen: 'report-regen',
    liveHourlyBody: 'live-hourly-body', liveHourlySub: 'live-hourly-sub',
    liveMetric: 'live-metric', liveCumul: 'live-cumul',
    liveActionsBody: 'live-actions-body', liveActionsSub: 'live-actions-sub',
    liveCampBody: 'live-camp-body', liveCampSub: 'live-camp-sub',
    filterAction: 'filter-action', actionPanel: 'action-panel',
    actionSummary: 'action-summary',
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
  buildSegmented(els.viewTabs,
    [{ key: 'report', label: 'Rapport' }, { key: 'live', label: 'Live' },
     { key: 'tracking', label: 'Tracking' }],
    () => S.view, setView);

  // La période cadre le rapport et le Tracking : le redessin doit suivre la vue
  // affichée, sinon changer de période sur le Tracking ne fait rien de visible.
  const refreshPeriod = () => {
    if (S.view === 'tracking') {
      renderTracking();
      updateFilterSummaries();
      writeHash();
      return;
    }
    render();
  };

  buildSegmented(els.rangePresets, RANGE_PRESETS, () => S.range, (k) => {
    S.range = k;
    refreshPeriod();
  });

  els.rangeApply.addEventListener('click', () => {
    const s = els.rangeStart.value;
    const e = els.rangeEnd.value;
    if (!s || !e) return;
    S.range = 'custom';
    S.start = s <= e ? s : e;
    S.end = s <= e ? e : s;
    els.rangeCustomWrap.open = false;
    refreshPeriod();
  });

  fillSelect(els.tsMetric, TS_METRICS, S.tsMetric);
  els.tsMetric.addEventListener('change', () => { S.tsMetric = els.tsMetric.value; render(); });

  fillSelect(els.topMetric, TOP_METRICS, S.topMetric);
  els.topMetric.addEventListener('change', () => { S.topMetric = els.topMetric.value; render(); });

  fillSelectFrom(els.marginMeasure, MARGIN_MEASURES, S.marginMeasure);
  els.marginMeasure.addEventListener('change', () => {
    S.marginMeasure = els.marginMeasure.value;
    // Le tri suit la mesure affichée : passer au taux sans reclasser laisserait
    // un tableau ordonné sur une colonne qui n'est plus celle qu'on regarde.
    if (S.marginSort.col === 'margin' || S.marginSort.col === 'marginRate') {
      S.marginSort = {
        col: S.marginMeasure === 'rate' ? 'marginRate' : 'margin',
        dir: S.marginSort.dir,
      };
    }
    render();
  });

  buildSegmented(els.tsGrain,
    [{ key: 'day', label: 'Jour' }, { key: 'week', label: 'Semaine' }, { key: 'month', label: 'Mois' }],
    () => S.tsGrain, (k) => { S.tsGrain = k; render(); });

  buildSegmented(els.tsMode,
    [{ key: 'account', label: 'Par compte' }, { key: 'total', label: 'Total' }],
    () => S.tsMode, (k) => { S.tsMode = k; render(); });

  // « Base 100 » est la même ventilation par appareil, chaque compte ramené à
  // 100 % : elle répond à « quelle est la composition » quand la vue en volume
  // répond à « qui dépense ». Sur un portefeuille où un compte pèse dix fois
  // les autres, la seconde écrase la première.
  buildSegmented(els.mixDim,
    [{ key: 'device', label: 'Appareil' },
     { key: 'device100', label: 'Base 100' },
     { key: 'network', label: 'Réseau' }],
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
  els.semLoad.addEventListener('click', loadTerms);

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
  wireRegenLinks();
  readHash();
  wireControls();
  onFilterChange();
  setView(S.view);

  // Chargés sans bouton : ces deux agrégats pèsent une fraction de data.json,
  // déjà chargé d'office. Leur section se dévoile seule quand le fichier
  // arrive, et reste masquée s'il n'existe pas.
  loadAimax();
  loadGender();

  if (S.autoLoadTerms) loadTerms();
}

document.addEventListener('DOMContentLoaded', init);
