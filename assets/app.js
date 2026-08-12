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

  // Repère vertical : marque une frontière sur l'axe des abscisses (fin de la
  // zone consolidée, par exemple). Trait plein teinté et étiqueté — sans
  // étiquette, un lecteur ne peut pas deviner ce qu'il sépare.
  if (cfg.vmark && cfg.vmark.at >= 0 && cfg.vmark.at < xLabels.length) {
    const vx = x(cfg.vmark.at);
    el('line', {
      class: 'threshold-line', x1: vx, x2: vx, y1: padT, y2: padT + plotH,
    }, svg);
    textNode('text', {
      class: 'threshold-label', x: vx + 5, y: padT + 10, 'text-anchor': 'start',
    }, cfg.vmark.label || '', svg);
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
  const shorten = (s) => {
    if (s.length <= LABEL_MAX) return s;
    const head = Math.ceil((LABEL_MAX - 1) * 0.55);
    return s.slice(0, head) + '…' + s.slice(s.length - (LABEL_MAX - 1 - head));
  };
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

  // Seuil optionnel : trait plein teinté, étiqueté — un lecteur ne devine pas
  // où commence la zone problématique.
  if (cfg.threshold && cfg.threshold.y !== undefined) {
    const ty = Y(cfg.threshold.y);
    el('line', { class: 'threshold-line', x1: padL, x2: padL + plotW, y1: ty, y2: ty }, svg);
    textNode('text', {
      class: 'threshold-label', x: padL + plotW, y: ty - 5, 'text-anchor': 'end',
    }, cfg.threshold.label || '', svg);
  }

  // Anneau de 2px en couleur de surface : les points restent lisibles en chevauchement.
  const marks = points.map((p) => el('circle', {
    cx: X(p.x), cy: Y(p.y), r: p.r || 5, fill: p.color || color,
    stroke: cssVar('--surface-1'), 'stroke-width': 2,
  }, svg));

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
  const trunc = (s) => (s.length > LABEL_MAX ? s.slice(0, LABEL_MAX - 1) + '…' : s);
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

    textNode('text', {
      class: 'mark-label',
      x: up ? mid + w + 8 : mid - w - 8,
      y: yTop + barH / 2 + 3.5,
      'text-anchor': up ? 'start' : 'end',
    }, (up ? '+' : '−') + axisFmt(Math.abs(r.delta)), svg);

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
        tipRow(n, { name: 'Période récente', value: fmt(r.recent), color: seriesColor(1) });
        tipRow(n, { name: 'Période précédente', value: fmt(r.prev), color: seriesColor(8) });
        tipRow(n, {
          name: 'Variation',
          value: (up ? '+' : '−') + fmt(Math.abs(r.delta)),
          total: true,
        });
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
    '→ émergents', svg);
  textNode('text', { class: 'axis-title', x: mid - 6, y: base + 16, 'text-anchor': 'end' },
    'déclinants ←', svg);
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

  if (['report', 'live'].includes(p.get('vue'))) S.view = p.get('vue');
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
});

function liveDelta(cur, ref) {
  if (!isFinite(ref) || ref === 0) return null;
  return (cur - ref) / Math.abs(ref);
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
  const L = S.live;
  els.liveKpi.replaceChildren();
  for (const def of LIVE_KPIS) {
    const t = L.totals[def.key];
    if (!t) continue;
    els.liveKpi.appendChild(liveTile(def, t.today, t.ref));
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

  const series = [
    {
      key: 'today', name: `Aujourd'hui`, color: seriesColor(1),
      values: shape(L.today[m.key], nowH),
    },
    {
      // La référence est coupée à l'heure courante elle aussi. Tracer la
      // journée entière ferait comparer un jour partiel à un jour complet :
      // le lecteur verrait un effondrement là où il n'y a qu'une heure moins
      // avancée. La journée de référence complète reste dans la vue tableau.
      key: 'ref', name: `Même jour, J-7`, color: seriesColor(2),
      values: shape(L.reference[m.key], nowH),
    },
  ];

  const isConv = m.key === 'allconv' || m.key === 'value';
  els.liveHourlySub.textContent =
    `${m.label} · ${cumul ? 'cumul depuis minuit' : 'par heure'} · `
    + `${fmtDateLong(L.meta.date)} face au ${fmtDateLong(L.meta.reference_date)} · `
    + `heure du compte (${L.meta.timezone})`
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
        const refFull = shape(L.reference[m.key], null);
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

function renderLiveActions() {
  const L = S.live;
  const rows = (L.actions || []).filter((r) => r[1] > 0 || r[2] > 0);
  els.liveActionsSub.textContent =
    `Cumul jusqu'à ${L.meta.current_hour}h, face à la même heure J-7 · `
    + `mesure « toutes conversions », qui remonte plus vite que la colonne de conversions`;

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
        const pct = liveDelta(r[1], r[2]);
        return { name: r[0], today: r[1], ref: r[2], delta: pct === null ? null : pct * 100 };
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
      label: r[0],
      values: { today: r[1], ref: r[2] },
      total: Math.max(r[1], r[2]),
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
  const rows = (L.campaigns || []).map((r) => ({
    name: r[0], account: r[1], today: r[2], ref: r[3],
    conv: r[4], convRef: r[5], delta: r[2] - r[3],
  }));

  els.liveCampSub.textContent =
    `Écart de dépense à heure égale, du plus grand au plus petit · `
    + `au-delà de ${Math.round(LIVE_HIGHLIGHT * 100)} % d'écart relatif, le changement est signalé`;

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
    ariaLabel: 'Écarts de dépense par campagne face à J-7',
  });
}

function renderLiveAlert() {
  const L = S.live;
  const slot = els.liveAlertSlot;
  slot.replaceChildren();

  const a = L.alert;
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
  box.className = 'alert-live' + (critical ? ' alert-live--critical' : '');
  const title = document.createElement('span');
  title.className = 'alert-live__title';
  title.textContent = critical
    ? `Alerte — aucune conversion sur la dernière heure consolidée (${a.hour}h).`
    : `Vigilance — conversions en net retrait sur la dernière heure consolidée (${a.hour}h).`;
  box.appendChild(title);

  const detail = document.createElement('span');
  detail.textContent = critical
    ? `La même heure il y a 7 jours en comptait ${fmtNum1(a.reference)}. `
      + `Les heures plus récentes ne sont pas évaluées : elles remontent encore.`
    : `${fmtNum1(a.current)} contre ${fmtNum1(a.reference)} il y a 7 jours, `
      + `soit ${nf1.format((1 - a.current / a.reference) * 100)} % de moins.`;
  box.appendChild(detail);
  slot.appendChild(box);
}

function renderLive() {
  const L = S.live;
  if (!L) return;

  const gen = new Date(L.meta.generated_at);
  const ageMin = Math.round((Date.now() - gen.getTime()) / 60000);
  const stale = ageMin > 45;

  els.liveMeta.replaceChildren();
  const meta = document.createElement('span');
  meta.textContent =
    `${L.meta.accounts.length} compte(s) · cumul jusqu'à ${L.meta.current_hour}h `
    + `(${L.meta.timezone}) · données arrêtées à `;
  els.liveMeta.appendChild(meta);
  const stamp = document.createElement('span');
  if (stale) stamp.className = 'live-stale';
  stamp.textContent = `${String(gen.getHours()).padStart(2, '0')}:`
    + `${String(gen.getMinutes()).padStart(2, '0')}`
    + (ageMin >= 1 ? ` (il y a ${ageMin} min)` : ' (à l\'instant)');
  els.liveMeta.appendChild(stamp);

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
  renderLive();
}

/* ── Navigation entre vues ────────────────────────────────────────────────── */

function setView(view) {
  S.view = view;
  els.contenu.hidden = view !== 'report';
  els.viewLive.hidden = view !== 'live';
  els.filterbar.hidden = view !== 'report';
  for (const b of els.viewTabs.querySelectorAll('button')) {
    const on = b.dataset.key === view;
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-selected', String(on));
  }
  writeHash();
  if (view === 'live' && S.liveState === 'idle') loadLive();
  // Les SVG sont dimensionnés sur une largeur mesurée : un conteneur masqué
  // mesure zéro, il faut redessiner en revenant sur la vue.
  if (view === 'report') render();
  else if (S.liveState === 'ready') renderLive();
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
    filterbar: 'filterbar',
    liveError: 'live-error', liveTz: 'live-tz', liveAlertSlot: 'live-alert-slot',
    liveMeta: 'live-meta', liveKpi: 'live-kpi',
    liveHourlyBody: 'live-hourly-body', liveHourlySub: 'live-hourly-sub',
    liveMetric: 'live-metric', liveCumul: 'live-cumul',
    liveActionsBody: 'live-actions-body', liveActionsSub: 'live-actions-sub',
    liveCampBody: 'live-camp-body', liveCampSub: 'live-camp-sub',
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
    [{ key: 'report', label: 'Rapport' }, { key: 'live', label: 'Live' }],
    () => S.view, setView);

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
  readHash();
  wireControls();
  onFilterChange();
  setView(S.view);

  if (S.autoLoadTerms) loadTerms();
}

document.addEventListener('DOMContentLoaded', init);
