#!/usr/bin/env python3
"""
Génère un data.json de démonstration au schéma exact de fetch_ads_data.py.

Permet de voir et déployer le dashboard avant d'avoir les accès API.
Le premier `fetch_ads_data.py` réussi écrase ce fichier avec les vraies données.

    python scripts/gen_demo_data.py
    python scripts/gen_demo_data.py --days 180 --end 2026-08-03
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import random
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent

SEED = 20260804  # déterministe : même sortie à chaque exécution

DEVICES = ["MOBILE", "DESKTOP", "TABLET"]
NETWORKS = ["SEARCH", "SEARCH_PARTNERS", "CONTENT"]

# Chaque compte a un profil de performance distinct pour que les comparaisons
# du dashboard soient parlantes (un compte peu rentable, un compte en forte
# croissance, un compte saisonnier, etc.).
ACCOUNTS = [
    {
        "id": "4412780391",
        "name": "Alpina Immobilier",
        "budget": 480,
        "cpc": 3.10,
        "cvr": 0.043,
        "aov": 210,
        "trend": 0.15,
        "season": 0.10,
        "channels": ["SEARCH", "PERFORMANCE_MAX"],
    },
    {
        "id": "7719340226",
        "name": "Boutique Léman",
        "budget": 260,
        "cpc": 0.72,
        "cvr": 0.031,
        "aov": 96,
        "trend": 0.42,
        "season": 0.35,
        "channels": ["SHOPPING", "SEARCH", "DISPLAY"],
    },
    {
        "id": "2038875514",
        "name": "Clinique Dentaire Vaud",
        "budget": 195,
        "cpc": 4.40,
        "cvr": 0.078,
        "aov": 340,
        "trend": 0.04,
        "season": 0.06,
        "channels": ["SEARCH"],
    },
    {
        "id": "9902441763",
        "name": "Helvetia Formation",
        "budget": 340,
        "cpc": 2.25,
        "cvr": 0.052,
        "aov": 155,
        "trend": -0.18,
        "season": 0.55,
        "channels": ["SEARCH", "VIDEO", "DISPLAY"],
    },
    {
        "id": "5567013428",
        "name": "Montreux Hôtellerie",
        "budget": 410,
        "cpc": 1.55,
        "cvr": 0.028,
        "aov": 285,
        "trend": 0.22,
        "season": 0.60,
        "channels": ["SEARCH", "PERFORMANCE_MAX", "DISPLAY"],
    },
    {
        "id": "3184996207",
        "name": "TechRomandie B2B",
        "budget": 150,
        "cpc": 5.80,
        "cvr": 0.019,
        "aov": 1250,
        "trend": 0.08,
        "season": 0.05,
        "channels": ["SEARCH", "VIDEO"],
    },
]

CAMPAIGN_THEMES = {
    "SEARCH": ["Marque", "Génériques", "Concurrents", "Longue traîne", "Local"],
    "SHOPPING": ["Shopping — Catalogue", "Shopping — Best-sellers"],
    "PERFORMANCE_MAX": ["PMax — Acquisition", "PMax — Remarketing"],
    "DISPLAY": ["Display — Remarketing", "Display — Audiences"],
    "VIDEO": ["YouTube — Notoriété", "YouTube — Considération"],
}

# Un canal ne diffuse que sur les réseaux où il existe réellement.
CHANNEL_NETWORKS = {
    "SEARCH": [("SEARCH", 0.86), ("SEARCH_PARTNERS", 0.14)],
    "SHOPPING": [("SEARCH", 0.92), ("SEARCH_PARTNERS", 0.08)],
    "PERFORMANCE_MAX": [("SEARCH", 0.55), ("CONTENT", 0.45)],
    "DISPLAY": [("CONTENT", 1.0)],
    "VIDEO": [("CONTENT", 1.0)],
}

# Répartition et efficacité relative par appareil.
DEVICE_MIX = [("MOBILE", 0.58, 0.85, 0.78), ("DESKTOP", 0.33, 1.28, 1.35), ("TABLET", 0.09, 0.95, 0.90)]
#              nom       part   ×cpc   ×cvr


def build(days: int, end: dt.date) -> dict:
    rng = random.Random(SEED)
    start = end - dt.timedelta(days=days - 1)
    dates = [(start + dt.timedelta(days=i)).isoformat() for i in range(days)]

    campaigns: list[dict] = []
    campaign_meta: list[dict] = []

    for acc_idx, acc in enumerate(ACCOUNTS):
        for channel in acc["channels"]:
            themes = CAMPAIGN_THEMES[channel]
            # 2 à 4 campagnes par canal Search, 1 à 2 pour les autres.
            count = rng.randint(2, 4) if channel == "SEARCH" else rng.randint(1, 2)
            for theme in themes[:count]:
                name = theme if channel != "SEARCH" else f"Search — {theme}"
                campaigns.append({"name": name, "account": acc_idx, "channel": channel})
                campaign_meta.append(
                    {
                        "acc": acc,
                        "channel": channel,
                        # Poids budgétaire : la campagne Marque est petite mais
                        # très rentable, les génériques absorbent le budget.
                        "weight": {
                            "Marque": 0.12,
                            "Génériques": 0.34,
                            "Concurrents": 0.14,
                            "Longue traîne": 0.10,
                            "Local": 0.12,
                        }.get(theme, 0.22),
                        "cpc_mult": {"Marque": 0.35, "Concurrents": 1.9, "Longue traîne": 0.7}.get(theme, 1.0),
                        "cvr_mult": {"Marque": 3.1, "Concurrents": 0.55, "Longue traîne": 1.25}.get(theme, 1.0),
                        "pause_after": rng.random() < 0.12,
                    }
                )

    device_idx = {d: i for i, d in enumerate(DEVICES)}
    network_idx = {n: i for i, n in enumerate(NETWORKS)}

    facts: list[list] = []

    for d_i, date_str in enumerate(dates):
        date = dt.date.fromisoformat(date_str)
        progress = d_i / max(days - 1, 1)
        # Week-end : moins de volume en B2B, un peu plus en e-commerce/tourisme.
        dow = date.weekday()

        for c_i, (camp, meta) in enumerate(zip(campaigns, campaign_meta)):
            acc = meta["acc"]

            # Une campagne "pausée" s'arrête sur le dernier tiers de la période.
            if meta["pause_after"] and progress > 0.72:
                continue

            trend = 1.0 + acc["trend"] * progress
            season = 1.0 + acc["season"] * math.sin((date.timetuple().tm_yday / 365.0) * 2 * math.pi - 1.2)
            weekend = (0.72 if dow >= 5 else 1.06) if acc["name"] == "TechRomandie B2B" else (
                1.18 if dow >= 5 else 0.96
            )
            noise = rng.uniform(0.82, 1.18)

            daily_budget = acc["budget"] * meta["weight"] * trend * season * weekend * noise
            if daily_budget <= 0.5:
                continue

            for net, net_share in CHANNEL_NETWORKS[meta["channel"]]:
                for dev, dev_share, dev_cpc, dev_cvr in DEVICE_MIX:
                    spend = daily_budget * net_share * dev_share
                    if spend < 0.15:
                        continue

                    # Le réseau Display/Partners est moins cher mais convertit moins.
                    net_cpc = {"SEARCH": 1.0, "SEARCH_PARTNERS": 0.62, "CONTENT": 0.28}[net]
                    net_cvr = {"SEARCH": 1.0, "SEARCH_PARTNERS": 0.55, "CONTENT": 0.22}[net]

                    cpc = acc["cpc"] * meta["cpc_mult"] * dev_cpc * net_cpc * rng.uniform(0.9, 1.1)
                    cpc = max(cpc, 0.08)
                    clicks = spend / cpc
                    if clicks < 0.5:
                        continue
                    clicks = int(round(clicks))

                    ctr = {"SEARCH": 0.068, "SEARCH_PARTNERS": 0.041, "CONTENT": 0.0052}[net]
                    ctr *= rng.uniform(0.78, 1.22)
                    impressions = int(round(clicks / max(ctr, 0.0008)))

                    cvr = acc["cvr"] * meta["cvr_mult"] * dev_cvr * net_cvr * rng.uniform(0.7, 1.3)
                    conversions = clicks * cvr
                    # Peu de clics → conversions entières et souvent nulles.
                    if conversions < 1:
                        conversions = 1.0 if rng.random() < conversions else 0.0
                    else:
                        conversions = round(conversions + rng.uniform(-0.4, 0.4), 2)
                        conversions = max(conversions, 0.0)

                    value = conversions * acc["aov"] * rng.uniform(0.72, 1.34) if conversions else 0.0

                    facts.append(
                        [
                            d_i,
                            c_i,
                            device_idx[dev],
                            network_idx[net],
                            impressions,
                            clicks,
                            round(spend, 2),
                            round(conversions, 2),
                            round(value, 2),
                        ]
                    )

    used = {campaigns[f[1]]["account"] for f in facts}

    return {
        "meta": {
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "date_start": dates[0],
            "date_end": dates[-1],
            "currency": "CHF",
            "source": "demo",
            "row_count": len(facts),
        },
        "accounts": [
            {
                "id": f"{a['id'][:3]}-{a['id'][3:6]}-{a['id'][6:]}",
                "name": a["name"],
                "currency": "CHF",
                "has_data": i in used,
            }
            for i, a in enumerate(ACCOUNTS)
        ],
        "campaigns": campaigns,
        "devices": DEVICES,
        "networks": NETWORKS,
        "dates": dates,
        "facts": facts,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Génère des données Google Ads de démonstration.")
    parser.add_argument("--days", type=int, default=180)
    parser.add_argument("--end", help="Date de fin AAAA-MM-JJ (défaut : hier)")
    parser.add_argument("--out", default=str(PROJECT_DIR / "data" / "data.json"))
    args = parser.parse_args()

    end = (
        dt.date.fromisoformat(args.end)
        if args.end
        else dt.date.today() - dt.timedelta(days=1)
    )

    dataset = build(args.days, end)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(dataset, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    total_cost = sum(f[6] for f in dataset["facts"])
    total_conv = sum(f[7] for f in dataset["facts"])
    total_val = sum(f[8] for f in dataset["facts"])
    print(f"Écrit : {out}  ({out.stat().st_size / 1024:,.0f} Ko)")
    print(
        f"  {len(dataset['accounts'])} comptes · {len(dataset['campaigns'])} campagnes · "
        f"{len(dataset['dates'])} jours · {len(dataset['facts']):,} lignes"
    )
    print(
        f"  Coût {total_cost:,.0f} CHF · {total_conv:,.0f} conversions · "
        f"ROAS {total_val / total_cost:.2f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
