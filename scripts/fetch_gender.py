#!/usr/bin/env python3
"""
Récupère les performances par sexe et produit data/gender.json.

    python scripts/fetch_gender.py
    python scripts/fetch_gender.py --days 90

CE QUE DIT « SEXE » ICI
-----------------------
La donnée vient de `gender_view`, au grain critère démographique. Trois valeurs
utiles : MALE, FEMALE, UNDETERMINED. La dernière n'est pas une catégorie de
personnes mais l'aveu que Google n'a pas su trancher — elle pèse 40 % du coût
sur ce MCC et doit rester visible, pas être rangée dans un « autres » qui la
ferait passer pour marginale.

Vérifié avant d'être écrit : sur les trois comptes les plus dépensiers, la somme
des coûts de `gender_view` égale à 100 % le coût total des campagnes. Il n'y a
donc aucun angle mort à signaler, contrairement à ce qu'on pourrait craindre
d'une vue par critère. `segments.adjusted_gender`, l'autre voie possible, est
refusé avec des métriques (PROHIBITED_SEGMENT_WITH_METRIC_IN_SELECT_OR_WHERE_CLAUSE).

Le fichier est séparé de data.json plutôt qu'ajouté comme dimension : le sexe
multiplierait par trois le nombre de lignes d'un fichier déjà à 1,5 Mo, chargé
d'office. Ici il ne se charge qu'à l'ouverture de l'onglet.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

import fetch_ads_data as F  # noqa: E402

GENDER_QUERY = """
    SELECT
      ad_group_criterion.gender.type,
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      segments.date,
      segments.device,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM gender_view
    WHERE segments.date BETWEEN '{start}' AND '{end}'
      AND metrics.impressions > 0
"""

# Ordre d'affichage figé, indépendant du volume : une catégorie qui change de
# place d'un mois à l'autre rend deux exports incomparables. UNDETERMINED en
# dernier, mais présent.
GENDER_ORDER = ["MALE", "FEMALE", "UNDETERMINED"]
GENDER_LABELS = {
    "MALE": "Hommes",
    "FEMALE": "Femmes",
    "UNDETERMINED": "Inconnu",
    "UNKNOWN": "Inconnu",
    "UNSPECIFIED": "Inconnu",
}


class Indexer:
    def __init__(self) -> None:
        self.values: list = []
        self._pos: dict = {}

    def get(self, value):
        key = json.dumps(value, sort_keys=True) if isinstance(value, dict) else value
        pos = self._pos.get(key)
        if pos is None:
            pos = self._pos[key] = len(self.values)
            self.values.append(value)
        return pos


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Performances par sexe.")
    p.add_argument("--days", type=int, default=180, help="profondeur (défaut : 180)")
    p.add_argument("--end", default=None, help="dernier jour, AAAA-MM-JJ (défaut : hier)")
    p.add_argument("--accounts", default=None, help="CID séparés par des virgules")
    p.add_argument("--config", default=None)
    p.add_argument("--out", default=None)
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
    camp_idx = Indexer()
    dev_idx = Indexer()
    dates: set[str] = set()

    # (date, campagne, sexe, appareil) → agrégats
    buckets: dict[tuple, list] = {}
    failures: list[tuple[str, str]] = []
    raw_rows = 0
    per_account_rows: dict[str, int] = {}

    for i, account in enumerate(accounts, 1):
        label = f"{account['name']} ({F.fmt_cid(account['id'])})"
        print(f"[{i}/{len(accounts)}] {label}…", end=" ", flush=True)
        try:
            rows = F.ads_search(cfg, token, account["id"],
                                GENDER_QUERY.format(start=start, end=end))
        except F.ApiError as exc:
            if exc.is_version_error:
                F.die(f"L'API refuse la version {F.API_VERSION} : {exc}")
            print(f"ÉCHEC ({exc})")
            failures.append((label, str(exc)))
            continue

        print(f"{len(rows)} ligne(s)")
        raw_rows += len(rows)
        per_account_rows[account["id"]] = len(rows)
        if not rows:
            continue

        ai = acc_idx.get({"name": account["name"], "currency": account["currency"]})

        for r in rows:
            seg = r.get("segments") or {}
            m = r.get("metrics") or {}
            crit = (r.get("adGroupCriterion") or {}).get("gender") or {}
            gender = crit.get("type") or "UNDETERMINED"
            # Les variantes UNKNOWN / UNSPECIFIED sont rangées avec UNDETERMINED :
            # elles disent la même chose, et trois colonnes vides à côté d'une
            # pleine n'apprendraient rien.
            if gender not in GENDER_ORDER:
                gender = "UNDETERMINED"

            date = seg.get("date")
            if not date:
                continue
            dates.add(date)

            c = r.get("campaign") or {}
            ci = camp_idx.get({
                "name": c.get("name") or "?",
                "account": ai,
                "channel": c.get("advertisingChannelType") or "UNKNOWN",
            })
            di = dev_idx.get(seg.get("device") or "UNKNOWN")

            key = (date, ci, GENDER_ORDER.index(gender), di)
            b = buckets.get(key)
            if b is None:
                b = buckets[key] = [0, 0, 0.0, 0.0, 0.0]
            b[0] += F.to_int(m.get("impressions"))
            b[1] += F.to_int(m.get("clicks"))
            b[2] += F.to_int(m.get("costMicros")) / 1e6
            b[3] += F.to_float(m.get("conversions"))
            b[4] += F.to_float(m.get("conversionsValue"))

    if not buckets:
        F.die("Aucune donnée par sexe récupérée. Les campagnes Recherche et "
              "Demand Gen en produisent ; Performance Max et Shopping, non.")

    sorted_dates = sorted(dates)
    date_pos = {d: i for i, d in enumerate(sorted_dates)}

    facts = []
    for (date, ci, gi, di), b in sorted(buckets.items()):
        facts.append([
            date_pos[date], ci, gi, di,
            b[0], b[1], round(b[2], 2), round(b[3], 2), round(b[4], 2),
        ])

    # La devise ne se déduit que des comptes qui ont des données : un compte
    # dormant dans une autre devise ferait basculer à tort un périmètre homogène.
    active = [a for a in accounts if per_account_rows.get(a["id"])]
    currency, _rates = F.resolve_currency(active or accounts, cfg)

    total_cost = sum(f[6] for f in facts)
    by_gender = {}
    for f in facts:
        g = GENDER_ORDER[f[2]]
        by_gender[g] = by_gender.get(g, 0.0) + f[6]

    payload = {
        "meta": {
            "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "date_start": start,
            "date_end": end,
            "days": args.days,
            "currency": currency,
            "accounts_scanned": len(accounts),
            "accounts_with_data": len(active),
            "raw_rows": raw_rows,
            "failures": [{"account": a, "error": e} for a, e in failures],
        },
        "genders": GENDER_ORDER,
        "genderLabels": [GENDER_LABELS[g] for g in GENDER_ORDER],
        "accounts": acc_idx.values,
        "campaigns": camp_idx.values,
        "devices": dev_idx.values,
        "dates": sorted_dates,
        # [dateIdx, campIdx, genderIdx, deviceIdx, impr, clicks, cost, conv, value]
        "facts": facts,
    }

    out = Path(args.out) if args.out else PROJECT_DIR / "data" / "gender.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")

    print(f"\nÉcrit {out} ({out.stat().st_size / 1024:.0f} Ko)")
    print(f"  {len(facts)} ligne(s) · {len(acc_idx.values)} compte(s) · "
          f"{len(camp_idx.values)} campagne(s) · {len(sorted_dates)} jour(s)")
    for g in GENDER_ORDER:
        c = by_gender.get(g, 0.0)
        pct = (c / total_cost * 100) if total_cost else 0
        print(f"  {GENDER_LABELS[g]:<10} {c:>12,.0f} {currency}  {pct:>5.1f} %")
    if failures:
        print(f"  {len(failures)} échec(s) de compte")


if __name__ == "__main__":
    main()
