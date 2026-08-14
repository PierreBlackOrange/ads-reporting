#!/usr/bin/env python3
"""
Sonde : que l'API Google Ads expose-t-elle sur le sexe de l'audience ?

Avant de construire un dashboard démographique, deux questions doivent être
tranchées sur les vraies données : quels champs existent, et y a-t-il du volume.
Un onglet vide serait pire qu'un onglet absent.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_ads_data as F  # noqa: E402

FIELD_ENDPOINT = "https://googleads.googleapis.com/{v}/googleAdsFields:search"


def search_fields(cfg: dict, token: str, where: str) -> list[dict]:
    url = FIELD_ENDPOINT.format(v=F.API_VERSION)
    headers = {
        "Authorization": f"Bearer {token}",
        "developer-token": cfg["developer_token"],
        "login-customer-id": cfg["login_customer_id"],
    }
    query = ("SELECT name, category, data_type, selectable, filterable, enum_values "
             f"WHERE {where}")
    payload = F.http_post_json(url, {"query": query, "pageSize": 500}, headers)
    return payload.get("results", []) or []


GENDER_QUERY = """
    SELECT
      ad_group_criterion.gender.type,
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM gender_view
    WHERE segments.date DURING LAST_30_DAYS
      AND metrics.impressions > 0
"""


def main() -> None:
    cfg = F.load_config(None)
    token = F.get_access_token(cfg)

    print(f"API {F.API_VERSION}\n")
    for needle in ("gender", "demographic", "age_range"):
        rows = search_fields(cfg, token, f"name LIKE '%{needle}%'")
        print(f"=== « {needle} » ({len(rows)}) ===")
        for r in sorted(rows, key=lambda x: x.get("name", "")):
            flags = "sel" if r.get("selectable") else "—"
            print(f"  {r.get('name'):<58} {r.get('dataType','?'):<14} {flags}")
            for v in (r.get("enumValues") or []):
                print(f"        · {v}")
        print()

    accounts = F.list_child_accounts(cfg, token)
    print(f"{len(accounts)} compte(s) — recherche de volume par sexe\n")

    totals: dict[str, list[float]] = {}
    channels: dict[str, float] = {}
    with_data = 0

    for i, acc in enumerate(accounts, 1):
        try:
            rows = F.ads_search(cfg, token, acc["id"], GENDER_QUERY)
        except F.ApiError as exc:
            if i == 1:
                print(f"REFUSÉ : {exc}")
                return
            continue
        if not rows:
            continue
        with_data += 1
        local: dict[str, float] = {}
        for r in rows:
            g = ((r.get("adGroupCriterion") or {}).get("gender") or {}).get("type", "?")
            m = r.get("metrics") or {}
            cost = F.to_int(m.get("costMicros")) / 1e6
            slot = totals.setdefault(g, [0.0, 0.0, 0.0, 0.0, 0.0])
            slot[0] += F.to_int(m.get("impressions"))
            slot[1] += F.to_int(m.get("clicks"))
            slot[2] += cost
            slot[3] += F.to_float(m.get("conversions"))
            slot[4] += F.to_float(m.get("conversionsValue"))
            local[g] = local.get(g, 0.0) + cost
            ch = (r.get("campaign") or {}).get("advertisingChannelType", "?")
            channels[ch] = channels.get(ch, 0.0) + cost
        if local:
            top = ", ".join(f"{k}={v:,.0f}" for k, v in sorted(local.items(), key=lambda x: -x[1]))
            print(f"  {acc['name'][:38]:<40} {len(rows):>6} lignes · {top}")

    print(f"\n{with_data} compte(s) avec du volume par sexe\n")
    print("=== totaux sur 30 jours ===")
    grand = sum(v[2] for v in totals.values()) or 1.0
    print(f"  {'type':<24} {'impr.':>12} {'clics':>10} {'coût':>12} {'part':>7} "
          f"{'conv.':>9} {'ROAS':>7}")
    for g, v in sorted(totals.items(), key=lambda x: -x[1][2]):
        roas = v[4] / v[2] if v[2] else 0
        print(f"  {g:<24} {v[0]:>12,.0f} {v[1]:>10,.0f} {v[2]:>12,.0f} "
              f"{v[2]/grand*100:>6.1f}% {v[3]:>9,.1f} {roas:>7.2f}")

    print("\n=== par type de campagne ===")
    for ch, v in sorted(channels.items(), key=lambda x: -x[1]):
        print(f"  {ch:<24} {v:>12,.0f}")


if __name__ == "__main__":
    main()
