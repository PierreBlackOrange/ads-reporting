#!/usr/bin/env python3
"""
Récupère ce qu'AI Max capte dans le MCC et produit data/aimax.json.

AI Max apparaît dans l'API à trois endroits, tous vérifiés sur cette version
via GoogleAdsFieldService :

  campaign.ai_max_setting.enable_ai_max      — activé ou non, par campagne
  segments.search_term_match_type = AI_MAX   — requêtes appariées par AI Max
  segments.search_term_match_source          — AI_MAX_BROAD_MATCH (élargissement
                                               d'un mot-clé) ou AI_MAX_KEYWORDLESS
                                               (trafic sans aucun mot-clé)

Les deux segments partitionnent les mêmes lignes : leurs totaux de coût
coïncident au centime, ce qui a été vérifié avant de les croiser. Contrairement
à l'action de conversion, les croiser ne duplique donc aucune dépense.

    python scripts/fetch_aimax.py
    python scripts/fetch_aimax.py --days 90 --max-terms 3000

Le plafond de termes publiés ne concerne que la liste détaillée. Les totaux, le
nombre de requêtes distinctes et la couverture atteinte sont calculés sur
l'intégralité des lignes, et la couverture est écrite dans meta — un plafond
tacite se lirait comme un inventaire complet.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

import fetch_ads_data as F  # noqa: E402

# ── Requêtes ─────────────────────────────────────────────────────────────────

# Le réglage se lit sur les campagnes Recherche, actives ou en pause : une
# campagne en pause qui a capté du trafic sur la période doit rester visible.
SETTING_QUERY = """
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.ai_max_setting.enable_ai_max
    FROM campaign
    WHERE campaign.advertising_channel_type = 'SEARCH'
      AND campaign.status IN ('ENABLED', 'PAUSED')
"""

# Type × source × mois : une seule requête pour la comparaison, la ventilation
# par source et la montée en charge. Quelques dizaines de lignes par compte.
CELLS_QUERY = """
    SELECT
      segments.search_term_match_type,
      segments.search_term_match_source,
      segments.month,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM search_term_view
    WHERE segments.date BETWEEN '{start}' AND '{end}'
"""

# Requêtes captées par AI Max. « clics > 0 » ne perd aucune dépense : une
# requête sans clic ne coûte rien. Le filtre s'applique côté API, sans quoi la
# traîne d'impressions rendrait la récupération impraticable.
TERMS_QUERY = """
    SELECT
      search_term_view.search_term,
      segments.search_term_match_type,
      segments.search_term_match_source,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM search_term_view
    WHERE segments.date BETWEEN '{start}' AND '{end}'
      AND segments.search_term_match_type = 'AI_MAX'
      AND metrics.clicks > 0
"""

AI_SOURCES = ("AI_MAX_BROAD_MATCH", "AI_MAX_KEYWORDLESS")


class Indexer:
    """Table de chaînes déduplifiée, pour ne pas répéter les libellés en JSON."""

    def __init__(self) -> None:
        self.values: list[str] = []
        self._pos: dict[str, int] = {}

    def get(self, value: str) -> int:
        pos = self._pos.get(value)
        if pos is None:
            pos = self._pos[value] = len(self.values)
            self.values.append(value)
        return pos


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Extrait les données AI Max du MCC.")
    p.add_argument("--days", type=int, default=90,
                   help="profondeur en jours (défaut : 90)")
    p.add_argument("--end", default=None,
                   help="dernier jour inclus, AAAA-MM-JJ (défaut : hier)")
    p.add_argument("--max-terms", type=int, default=3000,
                   help="nombre de requêtes publiées, les plus coûteuses (défaut : 3000)")
    p.add_argument("--accounts", default=None,
                   help="liste d'identifiants clients, séparés par des virgules")
    p.add_argument("--config", default=None, help="chemin d'un config.json")
    p.add_argument("--out", default=None, help="fichier de sortie")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    cfg = F.load_config(args.config)

    end = args.end or (dt.date.today() - dt.timedelta(days=1)).isoformat()
    start = (dt.date.fromisoformat(end) - dt.timedelta(days=args.days - 1)).isoformat()
    print(f"Période : {start} → {end} ({args.days} jours)")

    token = F.get_access_token(cfg)
    accounts = F.list_child_accounts(cfg, token)
    if args.accounts:
        wanted = {F.digits_only(a) for a in args.accounts.split(",") if a.strip()}
        accounts = [a for a in accounts if a["id"] in wanted]
    if not accounts:
        F.die("Aucun compte client actif à interroger.")

    acc_idx = Indexer()
    mt_idx = Indexer()
    src_idx = Indexer()
    months: set[str] = set()

    # (accIdx, mtIdx, srcIdx, mois) → [impr, clics, coût, conv, valeur]
    cells: dict[tuple, list] = collections.defaultdict(lambda: [0, 0, 0.0, 0.0, 0.0])
    # (terme, accIdx, srcIdx) → mêmes compteurs
    terms: dict[tuple, list] = collections.defaultdict(lambda: [0, 0, 0.0, 0.0, 0.0])
    # (campagne, accIdx) → [activé, impr, clics, coût, conv, valeur]
    campaigns: dict[tuple, list] = {}

    failures: list[tuple[str, str]] = []
    campaigns_search = 0
    campaigns_enabled = 0
    term_rows = 0

    # ── Passe 1 : où AI Max tourne-t-il ? ────────────────────────────────────
    #
    # Le périmètre de la section, ce sont les comptes concernés par AI Max, pas
    # le MCC entier. Comparer AI Max aux autres correspondances n'a de sens qu'à
    # l'intérieur des comptes qui l'ont activé : y mêler des comptes qui ne
    # l'utilisent pas diluerait sa part dans un total sans rapport, et ferait
    # entrer d'autres devises dans l'agrégat.
    #
    # Le réglage lu est l'état actuel. Une campagne activée puis désactivée
    # pendant la fenêtre n'y figure plus, d'où la seconde détection par le
    # trafic effectivement appairé en AI_MAX.
    scoped: list[dict] = []
    raw_cells: dict[str, list[dict]] = {}
    enabled_by_account: dict[str, list[str]] = {}

    for i, account in enumerate(accounts, 1):
        label = f"{account['name']} ({F.fmt_cid(account['id'])})"
        print(f"[{i}/{len(accounts)}] {label}…", end=" ", flush=True)
        name = account["name"]

        try:
            rows = F.ads_search(cfg, token, account["id"], SETTING_QUERY)
        except F.ApiError as exc:
            if exc.is_version_error:
                F.die(f"L'API refuse la version {F.API_VERSION} : {exc}")
            print(f"ÉCHEC réglage ({exc})")
            failures.append((label, str(exc)))
            rows = []

        on: list[str] = []
        for r in rows:
            c = r.get("campaign") or {}
            campaigns_search += 1
            if (c.get("aiMaxSetting") or {}).get("enableAiMax"):
                on.append(c.get("name") or "?")

        try:
            crows = F.ads_search(cfg, token, account["id"],
                                 CELLS_QUERY.format(start=start, end=end))
        except F.ApiError as exc:
            print(f"ÉCHEC cellules ({exc})")
            failures.append((label, str(exc)))
            crows = []

        has_traffic = any(
            (r.get("segments") or {}).get("searchTermMatchType") == "AI_MAX"
            for r in crows
        )
        if on or has_traffic:
            scoped.append(account)
            raw_cells[name] = crows
            enabled_by_account[name] = on
            campaigns_enabled += len(on)
            print(f"AI Max : {len(on)} campagne(s) activée(s)"
                  f"{', trafic capté' if has_traffic else ''}")
        else:
            print("pas d'AI Max")

    if not scoped:
        F.die("Aucun compte du MCC n'utilise AI Max : la section serait vide.")

    print(f"\n{len(scoped)} compte(s) concerné(s) par AI Max.\n")

    # ── Passe 2 : les requêtes captées, sur ces comptes seulement ────────────
    for i, account in enumerate(scoped, 1):
        name = account["name"]
        label = f"{name} ({F.fmt_cid(account['id'])})"
        print(f"[{i}/{len(scoped)}] {label}…", end=" ", flush=True)

        for r in raw_cells.get(name, []):
            seg = r.get("segments") or {}
            m = r.get("metrics") or {}
            mt = seg.get("searchTermMatchType") or "UNKNOWN"
            src = seg.get("searchTermMatchSource") or "UNKNOWN"
            month = (seg.get("month") or "")[:7]
            if not month:
                continue
            months.add(month)
            slot = cells[(acc_idx.get(name), mt_idx.get(mt), src_idx.get(src), month)]
            slot[0] += F.to_int(m.get("impressions"))
            slot[1] += F.to_int(m.get("clicks"))
            slot[2] += F.to_int(m.get("costMicros")) / 1e6
            slot[3] += F.to_float(m.get("conversions"))
            slot[4] += F.to_float(m.get("conversionsValue"))

        for cname in enabled_by_account.get(name, []):
            campaigns.setdefault((cname, acc_idx.get(name)), [True, 0, 0, 0.0, 0.0, 0.0])

        try:
            trows = F.ads_search(cfg, token, account["id"],
                                 TERMS_QUERY.format(start=start, end=end))
        except F.ApiError as exc:
            print(f"ÉCHEC requêtes ({exc})")
            failures.append((label, str(exc)))
            trows = []

        print(f"{len(trows)} ligne(s) de requête AI Max")
        term_rows += len(trows)
        for r in trows:
            seg = r.get("segments") or {}
            m = r.get("metrics") or {}
            term = ((r.get("searchTermView") or {}).get("searchTerm") or "").strip()
            if not term:
                continue
            src = seg.get("searchTermMatchSource") or "UNKNOWN"
            impr = F.to_int(m.get("impressions"))
            clicks = F.to_int(m.get("clicks"))
            cost = F.to_int(m.get("costMicros")) / 1e6
            conv = F.to_float(m.get("conversions"))
            value = F.to_float(m.get("conversionsValue"))

            slot = terms[(term, acc_idx.get(name), src_idx.get(src))]
            slot[0] += impr
            slot[1] += clicks
            slot[2] += cost
            slot[3] += conv
            slot[4] += value

            # Une campagne peut capter du trafic AI Max sans que le réglage ait
            # été lu (campagne supprimée depuis, ou lecture en échec) : on la
            # crée alors avec « activé » inconnu plutôt que de perdre la ligne.
            cname = (r.get("campaign") or {}).get("name") or "?"
            ckey = (cname, acc_idx.get(name))
            centry = campaigns.get(ckey)
            if centry is None:
                centry = campaigns[ckey] = [False, 0, 0, 0.0, 0.0, 0.0]
            centry[1] += impr
            centry[2] += clicks
            centry[3] += cost
            centry[4] += conv
            centry[5] += value

    if not cells:
        F.die("Aucune donnée de requête récupérée.")

    # ── Sélection des requêtes publiées ──────────────────────────────────────
    total_cost = sum(v[2] for v in terms.values())
    ordered = sorted(terms.items(), key=lambda kv: -kv[1][2])
    kept = ordered[:args.max_terms]
    kept_cost = sum(v[2] for _, v in kept)
    coverage = (kept_cost / total_cost * 100) if total_cost else 0.0

    month_list = sorted(months)
    mpos = {m: i for i, m in enumerate(month_list)}

    out_cells = [
        [a, mt, s, mpos[mo], v[0], v[1], round(v[2], 2), round(v[3], 2), round(v[4], 2)]
        for (a, mt, s, mo), v in sorted(cells.items())
    ]
    out_terms = [
        [term, a, s, v[0], v[1], round(v[2], 2), round(v[3], 2), round(v[4], 2)]
        for (term, a, s), v in kept
    ]
    out_campaigns = [
        [name, a, bool(v[0]), v[1], v[2], round(v[3], 2), round(v[4], 2), round(v[5], 2)]
        for (name, a), v in sorted(campaigns.items(), key=lambda kv: -kv[1][3])
    ]

    ai_types = {mt_idx.get("AI_MAX")} if "AI_MAX" in mt_idx.values else set()
    ai_cost = sum(c[6] for c in out_cells if c[1] in ai_types)
    all_cost = sum(c[6] for c in out_cells)

    # Comme ailleurs, la devise ne se déduit que des comptes qui ont des
    # données : un compte dormant dans une autre devise ferait basculer à tort
    # un périmètre homogène en « MIXED ».
    seen_names = set(acc_idx.values)
    active = [a for a in accounts if a["name"] in seen_names]
    currency, _rates = F.resolve_currency(active or accounts, cfg)

    payload = {
        "meta": {
            "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "start": start,
            "end": end,
            "days": args.days,
            "currency": currency,
            "accounts_scanned": len(accounts),
            "campaigns_search": campaigns_search,
            "campaigns_enabled": campaigns_enabled,
            "terms_distinct": len({t for t, _, _ in terms}),
            "terms_rows": term_rows,
            "terms_published": len(out_terms),
            "terms_coverage": round(coverage, 1),
            "aimax_cost": round(ai_cost, 2),
            "total_cost": round(all_cost, 2),
            "ai_sources": list(AI_SOURCES),
            "failures": [{"account": a, "error": e} for a, e in failures],
        },
        "accounts": acc_idx.values,
        "matchTypes": mt_idx.values,
        "sources": src_idx.values,
        "months": month_list,
        "cells": out_cells,
        "terms": out_terms,
        "campaigns": out_campaigns,
    }

    out = Path(args.out) if args.out else PROJECT_DIR / "data" / "aimax.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")

    size = out.stat().st_size
    print(f"\nÉcrit {out} ({size / 1024:.0f} Ko)")
    print(f"  {campaigns_enabled} campagne(s) AI Max activé sur "
          f"{campaigns_search} campagne(s) Recherche")
    print(f"  AI Max : {ai_cost:,.0f} {currency} sur {all_cost:,.0f} "
          f"({ai_cost / all_cost * 100 if all_cost else 0:.1f} % du coût des requêtes)")
    print(f"  {len({t for t, _, _ in terms})} requête(s) distincte(s) captée(s), "
          f"{len(out_terms)} publiée(s) → {coverage:.1f} % du coût AI Max")
    if failures:
        print(f"  {len(failures)} échec(s) de compte")


if __name__ == "__main__":
    main()
