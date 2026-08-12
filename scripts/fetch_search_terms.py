#!/usr/bin/env python3
"""
Récupère les termes de recherche du MCC et produit data/terms.json.

Alimente trois analyses sémantiques du dashboard :
  - dérive sémantique (terme de recherche face au mot-clé déclencheur) ;
  - clustering d'intention ;
  - n-grammes émergents et déclinants.

Le scoring sémantique et l'intention ne sont PAS calculés ici : ils sont
ajoutés ensuite par enrich_terms.py, qui appelle l'API Claude. Ce script
produit les champs `sem` et `intent` à null.

    python scripts/fetch_search_terms.py
    python scripts/fetch_search_terms.py --days 90 --max-pairs 3000

Deux décisions de volumétrie, mesurées sur le compte le plus dépensier :

  clics > 0        — 33 542 lignes deviennent 7 482 sur 7 jours, pour un coût
                     total identique (38 314 EUR). Un terme sans clic ne dépense
                     rien : le filtre ne perd aucune dépense. Il s'applique côté
                     API, ce qui rend la récupération praticable — sans lui,
                     90 jours × 21 comptes représentent ~14 millions de lignes.

  plafond de paires — le coût est très concentré : les 100 premières paires
                     portent 55 % de la dépense, les 1 263 premières 80 %, les
                     4 100 premières 95 %. Publier la traîne entière alourdirait
                     la page sans rien révéler. Le plafond est explicite et la
                     couverture réellement atteinte est écrite dans meta.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

import fetch_ads_data as F  # noqa: E402

# ── Requête ──────────────────────────────────────────────────────────────────

TERMS_QUERY = """
    SELECT
      search_term_view.search_term,
      segments.keyword.info.text,
      segments.keyword.info.match_type,
      segments.date,
      campaign.name,
      campaign.bidding_strategy_type,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM search_term_view
    WHERE segments.date BETWEEN '{start}' AND '{end}'
      AND metrics.clicks > 0
"""

# Le Smart Bidding est ce qui autorise Google à élargir le ciblage : c'est la
# distinction qui compte pour lire une dérive, pas le nom exact de la stratégie.
SMART_BIDDING = {
    "TARGET_CPA", "TARGET_ROAS", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE",
    "TARGET_SPEND", "MAXIMIZE_CLICKS", "TARGET_IMPRESSION_SHARE",
}
BID_SMART, BID_MANUAL = 0, 1
BID_LABELS = ["Smart Bidding", "Enchères manuelles"]

MATCH_LABELS = {
    "EXACT": "Exact",
    "PHRASE": "Expression",
    "BROAD": "Large",
    "NEAR_EXACT": "Exact (variante)",
    "NEAR_PHRASE": "Expression (variante)",
    "UNKNOWN": "Inconnu",
}

# ── N-grammes ────────────────────────────────────────────────────────────────

# Mots vides français + anglais : sans cela les n-grammes ne remontent que
# « de la », « pour le »… Volontairement court — un mot vide de trop efface un
# signal réel (« plan cul » perdrait son sens si « plan » était filtré).
STOPWORDS = {
    "le", "la", "les", "un", "une", "des", "du", "de", "d", "l", "et", "ou",
    "a", "à", "au", "aux", "en", "dans", "sur", "pour", "par", "avec", "sans",
    "ce", "cet", "cette", "ces", "se", "sa", "son", "ses", "mon", "ma", "mes",
    "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles", "qui",
    "que", "quoi", "dont", "est", "sont", "être", "avoir", "plus", "moins",
    "the", "of", "for", "and", "or", "to", "in", "on", "with", "is", "are",
}

TOKEN_RE = re.compile(r"[a-zà-öø-ÿ0-9]+", re.IGNORECASE)


def tokenize(text: str) -> list[str]:
    return [t for t in TOKEN_RE.findall(text.lower()) if t not in STOPWORDS and len(t) > 1]


def stem(token: str) -> str:
    """
    Racinisation minimale du français : pluriels et féminins courants.

    Sans elle, « rencontre » et « rencontres » sont deux tokens distincts et
    « site de rencontre gratuit » face à « rencontres gratuites » obtient un
    recouvrement nul alors que les deux requêtes sont quasi identiques. Mesuré
    sur le jeu réel, c'était la première cause de faux positifs de dérive.

    Volontairement grossière : pas de Porter ni de dictionnaire. Elle ne doit
    corriger que la morphologie de surface, pas rapprocher des mots différents.
    """
    if len(token) <= 3:
        return token
    # L'ordre est porteur : « es » avant « s » et avant « e », sinon
    # « rencontres » perdrait « s » et « rencontre » son « e », donnant deux
    # racines différentes — précisément le faux positif à corriger.
    for suffix in ("aux", "es", "s", "x", "e"):
        if token.endswith(suffix) and len(token) - len(suffix) >= 3:
            return token[: -len(suffix)]
    return token


def stem_set(text: str) -> set[str]:
    return {stem(t) for t in tokenize(text)}


def ngrams_of(tokens: list[str], n: int) -> list[str]:
    return [" ".join(tokens[i:i + n]) for i in range(len(tokens) - n + 1)]


def normalize_flat(text: str) -> str:
    """Texte réduit à ses lettres et chiffres — « plan cul » et « plancul » s'y rejoignent."""
    return "".join(TOKEN_RE.findall(text.lower()))


def lexical_overlap(term: str, keyword: str) -> float:
    """
    Recouvrement lexical de Jaccard entre le terme et le mot-clé, après
    racinisation.

    Ce n'est PAS une distance sémantique — deux synonymes ont un recouvrement
    nul tout en étant parfaitement pertinents. Sert de pré-filtre bon marché
    pour prioriser ce qu'on envoie au scoring sémantique : un recouvrement
    faible est un candidat probable, pas un verdict.

    Deux rattrapages avant le calcul, chacun corrigeant un faux positif observé
    sur les données réelles :
      - chaînes identiques une fois la ponctuation retirée. « j&m » face à
        « j&m » tombait à 0 : le « & » disparaît, restent « j » et « m » que le
        filtre de longueur élimine, et deux ensembles vides donnaient 0.
      - concaténation. « plancul » face à « plan cul » tombait à 0 alors que
        c'est la même requête écrite sans espace.
    """
    flat_a, flat_b = normalize_flat(term), normalize_flat(keyword)
    if flat_a and flat_a == flat_b:
        return 1.0

    a = stem_set(term)
    b = stem_set(keyword)
    if not a or not b:
        # Tout a été filtré (sigles courts, ponctuation) : on retombe sur la
        # comparaison à plat plutôt que de déclarer une dérive totale.
        if flat_a and flat_b:
            return 1.0 if flat_a == flat_b else (
                0.5 if flat_a in flat_b or flat_b in flat_a else 0.0
            )
        return 0.0

    jaccard = len(a & b) / len(a | b)
    # Un mot-clé entièrement contenu dans une requête plus longue n'est pas une
    # dérive : c'est une précision ajoutée par l'internaute. Jaccard le pénalise
    # pourtant à proportion des mots en trop.
    if a >= b or b >= a:
        jaccard = max(jaccard, 0.6)
    return jaccard


# ── Agrégation ───────────────────────────────────────────────────────────────


class Indexer:
    def __init__(self) -> None:
        self._i: dict = {}
        self.values: list = []

    def get(self, key):
        if key not in self._i:
            self._i[key] = len(self.values)
            self.values.append(key)
        return self._i[key]


def month_of(iso: str) -> str:
    return iso[:7]


def week_of(iso: str) -> str:
    """Lundi de la semaine ISO contenant cette date."""
    d = dt.date.fromisoformat(iso)
    return (d - dt.timedelta(days=d.weekday())).isoformat()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Récupère les termes de recherche Google Ads vers data/terms.json."
    )
    parser.add_argument("--days", type=int, default=90,
                        help="Fenêtre en jours, jusqu'à hier (défaut : 90)")
    parser.add_argument("--end", help="Date de fin AAAA-MM-JJ (défaut : hier)")
    parser.add_argument("--max-pairs", type=int, default=3000,
                        help="Plafond de paires terme/mot-clé publiées, par coût "
                             "décroissant (défaut : 3000)")
    parser.add_argument("--min-clicks", type=int, default=0,
                        help="Ne récupérer que les lignes strictement au-dessus de ce "
                             "nombre de clics (défaut : 0). ATTENTION : au-delà de 0 le "
                             "filtre exclut de la dépense réelle — un terme à 1 clic "
                             "coûte de l'argent. Le coût exclu est mesuré et inscrit "
                             "dans meta.excluded_cost.")
    parser.add_argument("--config", help="Chemin d'un config.json ou google-ads.yaml")
    parser.add_argument("--accounts", help="IDs clients séparés par des virgules")
    parser.add_argument("--out", default=str(PROJECT_DIR / "data" / "terms.json"))
    args = parser.parse_args()

    cfg = F.load_config(args.config)

    today = dt.date.today()
    end = dt.date.fromisoformat(args.end) if args.end else today - dt.timedelta(days=1)
    start = end - dt.timedelta(days=max(args.days, 1) - 1)
    # Moitié récente vs moitié précédente : c'est le delta des n-grammes.
    midpoint = start + dt.timedelta(days=(end - start).days // 2)

    print(f"\nPériode : {start} → {end}  (bascule n-grammes au {midpoint})")

    token = F.get_access_token(cfg)
    accounts = F.list_child_accounts(cfg, token)

    if args.accounts:
        wanted = {F.digits_only(a) for a in args.accounts.split(",") if a.strip()}
        accounts = [a for a in accounts if a["id"] in wanted]
    if not accounts:
        F.die("Aucun compte client actif à interroger.")

    terms_idx = Indexer()
    kw_idx = Indexer()
    match_idx = Indexer()
    acc_idx = Indexer()

    months: set[str] = set()
    # (termIdx, kwIdx, matchIdx, accIdx) → totaux + coût par mois
    pairs: dict[tuple, dict] = {}
    # n-gramme → [coût récent, coût précédent, clics récents, clics précédents, {termes}]
    # Agrégat global, qui sert à choisir quels n-grammes publier.
    ngrams: dict[str, list] = collections.defaultdict(lambda: [0.0, 0.0, 0, 0, set()])
    # (n-gramme, compte) → mêmes compteurs, pour que le filtre de comptes de la
    # barre du haut s'applique aussi à ce graphique. Sans cette dimension, le
    # n-gramme resterait figé sur l'ensemble des comptes quel que soit le filtre.
    ngrams_acc: dict[tuple, list] = collections.defaultdict(lambda: [0.0, 0.0, 0, 0])

    # Vélocité de dérive : (semaine, correspondance, enchères) → agrégats.
    # Le recouvrement moyen est pondéré par les clics — une requête à 3 000 clics
    # doit peser plus qu'une à 2 dans la moyenne hebdomadaire, sinon la traîne
    # dicterait la courbe.
    weeks: set[str] = set()
    drift: dict[tuple, list] = collections.defaultdict(lambda: [0, 0.0, 0.0, 0.0])
    #                                        clics, coût, conv, somme(recouvrement × clics)

    failures: list[tuple[str, str]] = []
    raw_rows = 0
    # Un seuil au-dessus de 0 exclut de la dépense réelle. On récupère donc
    # toujours à clics > 0 et on filtre ici, ce qui permet de chiffrer
    # exactement l'exclusion au lieu de l'estimer.
    excluded_cost = 0.0
    excluded_rows = 0

    for i, account in enumerate(accounts, 1):
        label = f"{account['name']} ({F.fmt_cid(account['id'])})"
        print(f"[{i}/{len(accounts)}] {label}…", end=" ", flush=True)
        try:
            rows = F.ads_search(cfg, token, account["id"],
                                TERMS_QUERY.format(start=start, end=end))
        except F.ApiError as exc:
            if exc.is_version_error:
                F.die(f"L'API refuse la version {F.API_VERSION} : {exc}")
            print(f"ÉCHEC ({exc})")
            failures.append((label, str(exc)))
            continue

        print(f"{len(rows)} ligne(s)")
        raw_rows += len(rows)
        if not rows:
            continue

        ai = acc_idx.get(account["name"])

        for r in rows:
            stv = r.get("searchTermView", {})
            seg = r.get("segments", {})
            kwinfo = (seg.get("keyword") or {}).get("info") or {}
            met = r.get("metrics", {})

            term = (stv.get("searchTerm") or "").strip()
            if not term:
                continue
            keyword = (kwinfo.get("text") or "").strip()
            match = kwinfo.get("matchType") or "UNKNOWN"
            date = seg.get("date") or ""
            if not date:
                continue

            cost = int(met.get("costMicros") or 0) / 1_000_000
            clicks = F.to_int(met.get("clicks"))
            impr = F.to_int(met.get("impressions"))

            if clicks <= args.min_clicks:
                excluded_cost += cost
                excluded_rows += 1
                continue

            conv = F.to_float(met.get("conversions"))
            value = F.to_float(met.get("conversionsValue"))

            month = month_of(date)
            months.add(month)

            # Vélocité de dérive, calculée sur TOUTES les lignes et pas
            # seulement sur les paires publiées : une moyenne hebdomadaire
            # tronquée au plafond ne serait pas une moyenne.
            bidding = (r.get("campaign") or {}).get("biddingStrategyType") or ""
            bid = BID_SMART if bidding in SMART_BIDDING else BID_MANUAL
            wk = week_of(date)
            weeks.add(wk)
            ov = lexical_overlap(term, keyword)
            dslot = drift[(wk, match, bid, ai)]
            dslot[0] += clicks
            dslot[1] += cost
            dslot[2] += conv
            dslot[3] += ov * clicks

            key = (terms_idx.get(term), kw_idx.get(keyword), match_idx.get(match), ai)
            p = pairs.get(key)
            if p is None:
                p = pairs[key] = {"impr": 0, "clicks": 0, "cost": 0.0,
                                  "conv": 0.0, "value": 0.0, "m": collections.Counter()}
            p["impr"] += impr
            p["clicks"] += clicks
            p["cost"] += cost
            p["conv"] += conv
            p["value"] += value
            p["m"][month] += cost

            # N-grammes : calculés sur TOUS les termes, pas seulement ceux
            # publiés — c'est justement la traîne qui révèle les tendances
            # émergentes. Seuls les agrégats partent dans le JSON.
            recent = date > midpoint.isoformat()
            tokens = tokenize(term)
            seen: set[str] = set()
            for n in (2, 3):
                for g in ngrams_of(tokens, n):
                    if g in seen:
                        continue
                    seen.add(g)
                    e = ngrams[g]
                    ea = ngrams_acc[(g, ai)]
                    if recent:
                        e[0] += cost
                        e[2] += clicks
                        ea[0] += cost
                        ea[2] += clicks
                    else:
                        e[1] += cost
                        e[3] += clicks
                        ea[1] += cost
                        ea[3] += clicks
                    if len(e[4]) < 6:
                        e[4].add(term)

    if not pairs:
        F.die("Aucun terme de recherche récupéré.")

    # ── Sélection des paires publiées ────────────────────────────────────────
    total_cost = sum(p["cost"] for p in pairs.values())
    ordered = sorted(pairs.items(), key=lambda kv: -kv[1]["cost"])
    kept = ordered[:args.max_pairs]
    kept_cost = sum(p["cost"] for _, p in kept)
    coverage = (kept_cost / total_cost * 100) if total_cost else 0.0

    month_list = sorted(months)
    mpos = {m: i for i, m in enumerate(month_list)}

    out_pairs = []
    for (ti, ki, mi, ai), p in kept:
        by_month = [0.0] * len(month_list)
        for m, c in p["m"].items():
            by_month[mpos[m]] = round(c, 2)
        out_pairs.append([
            ti, ki, mi, ai,
            p["impr"], p["clicks"], round(p["cost"], 2),
            round(p["conv"], 2), round(p["value"], 2),
            round(lexical_overlap(terms_idx.values[ti], kw_idx.values[ki]), 3),
            None,   # sem    — rempli par enrich_terms.py
            None,   # intent — rempli par enrich_terms.py
            by_month,
        ])

    # Les tables de chaînes ne conservent que ce qui est référencé.
    used_t = sorted({p[0] for p in out_pairs})
    used_k = sorted({p[1] for p in out_pairs})
    remap_t = {old: new for new, old in enumerate(used_t)}
    remap_k = {old: new for new, old in enumerate(used_k)}
    for p in out_pairs:
        p[0] = remap_t[p[0]]
        p[1] = remap_k[p[1]]

    # ── N-grammes publiés ────────────────────────────────────────────────────
    # Un n-gramme vu une seule fois n'est pas une tendance, c'est du bruit.
    MIN_CLICKS = 3
    ng_rows = [
        [g, round(v[0], 2), round(v[1], 2), v[2], v[3], sorted(v[4])[:4]]
        for g, v in ngrams.items()
        if (v[2] + v[3]) >= MIN_CLICKS
    ]
    # On garde les plus gros mouvements dans les deux sens, pas les plus gros
    # volumes : une tendance est un delta.
    ng_rows.sort(key=lambda r: -abs(r[1] - r[2]))
    ng_rows = ng_rows[:600]

    # Ventilation par compte des n-grammes retenus. Un n-gramme publié l'est
    # avec la totalité de ses comptes, si bien que filtrer donne un résultat
    # exact — pas une estimation. Le seul manque est la queue des n-grammes non
    # retenus, identique avec ou sans filtre.
    kept_grams = {r[0] for r in ng_rows}
    ng_by_acc = [
        [g, ai, round(v[0], 2), round(v[1], 2), v[2], v[3]]
        for (g, ai), v in ngrams_acc.items()
        if g in kept_grams and (v[2] + v[3]) > 0
    ]

    # ── Vélocité de dérive publiée ───────────────────────────────────────────
    week_list = sorted(weeks)
    wpos = {w: i for i, w in enumerate(week_list)}
    MIN_WEEK_CLICKS = 30   # sous ce volume la moyenne hebdomadaire est du bruit
    # Les clics et la somme pondérée sont publiés bruts, pas la moyenne : le
    # navigateur doit pouvoir ré-agréger sur une sélection de comptes, et une
    # moyenne de moyennes serait fausse dès que les volumes diffèrent.
    #
    # Le seuil de volume n'est PAS appliqué ici. Avec la dimension compte, une
    # cellule descend souvent sous 30 clics alors que la semaine, tous comptes
    # confondus, en compte largement assez ; filtrer maintenant ferait sommer au
    # navigateur des semaines déjà amputées. Le seuil s'applique après
    # ré-agrégation, côté affichage.
    drift_rows = [
        [wpos[wk], match_idx.get(match), bid, ai,
         clicks, round(cost, 2), round(conv, 2), round(ovsum, 2)]
        for (wk, match, bid, ai), (clicks, cost, conv, ovsum) in sorted(drift.items())
        if clicks > 0
    ]

    dataset = {
        "meta": {
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "date_start": start.isoformat(),
            "date_end": end.isoformat(),
            "midpoint": midpoint.isoformat(),
            "currency": cfg.get("report_currency") or "EUR",
            "enriched": False,
            "raw_rows": raw_rows,
            "pairs_total": len(pairs),
            "pairs_published": len(out_pairs),
            "cost_total": round(total_cost, 2),
            "cost_published": round(kept_cost, 2),
            "cost_coverage_pct": round(coverage, 1),
            "ngrams_total": len(ngrams),
            "ngrams_published": len(ng_rows),
            "min_clicks_ngram": MIN_CLICKS,
            "min_week_clicks": MIN_WEEK_CLICKS,
            "drift_rows": len(drift_rows),
            "ngrams_by_account_rows": len(ng_by_acc),
            "overlap_method": "jaccard racinisé (pluriels, féminins, concaténation)",
            "min_clicks": args.min_clicks,
            "excluded_rows": excluded_rows,
            "excluded_cost": round(excluded_cost, 2),
        },
        "accounts": acc_idx.values,
        "matchTypes": [MATCH_LABELS.get(m, m) for m in match_idx.values],
        "biddingTypes": BID_LABELS,
        "months": month_list,
        "weeks": week_list,
        "drift": drift_rows,
        "ngramsByAccount": ng_by_acc,
        "terms": [terms_idx.values[i] for i in used_t],
        "keywords": [kw_idx.values[i] for i in used_k],
        "pairs": out_pairs,
        "ngrams": ng_rows,
    }
    if failures:
        dataset["meta"]["failed_accounts"] = [
            {"account": a, "error": e} for a, e in failures
        ]

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(dataset, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")

    print(f"\nÉcrit : {out}  ({out.stat().st_size / 1024:,.0f} Ko)")
    print(f"  {raw_rows:,} lignes brutes → {len(pairs):,} paires uniques")
    if args.min_clicks > 0:
        grand = total_cost + excluded_cost
        share = (excluded_cost / grand * 100) if grand else 0.0
        print(f"  seuil clics > {args.min_clicks} : {excluded_rows:,} lignes écartées, "
              f"soit {excluded_cost:,.0f} de dépense ({share:.1f} % du total "
              f"des termes cliqués) — cette dépense n'apparaît nulle part dans le rapport")
    print(f"  {len(out_pairs):,} paires publiées = {coverage:.1f} % du coût "
          f"({kept_cost:,.0f} / {total_cost:,.0f} {dataset['meta']['currency']})")
    print(f"  {len(ng_rows):,} n-grammes publiés sur {len(ngrams):,} observés")
    print("\nÉtape suivante — scoring sémantique et intention :")
    print("  python scripts/enrich_terms.py")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrompu.", file=sys.stderr)
        raise SystemExit(130)
