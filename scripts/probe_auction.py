#!/usr/bin/env python3
"""
Sonde : l'API Google Ads expose-t-elle les Auction Insights ?

La question décide de l'architecture d'une détection de cannibalisation
inter-comptes. Si le rapport n'est pas interrogeable, le niveau « deux comptes
du portefeuille sur la même intention » doit se mesurer autrement.

On interroge GoogleAdsFieldService, qui décrit l'API elle-même, plutôt que de
se fier à un souvenir de documentation.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_ads_data as F  # noqa: E402

FIELD_ENDPOINT = "https://googleads.googleapis.com/{v}/googleAdsFields:search"

NEEDLES = [
    "auction",
    "insight",
    "impression_share",
    "overlap",
    "outranking",
    "position_above",
    "top_of_page",
    "domain",
]


def search_fields(cfg: dict, token: str, where: str) -> list[dict]:
    url = FIELD_ENDPOINT.format(v=F.API_VERSION)
    headers = {
        "Authorization": f"Bearer {token}",
        "developer-token": cfg["developer_token"],
        "login-customer-id": cfg["login_customer_id"],
    }
    query = ("SELECT name, category, data_type, selectable, filterable, enum_values "
             f"WHERE {where}")
    out: list[dict] = []
    page = None
    while True:
        body: dict = {"query": query, "pageSize": 1000}
        if page:
            body["pageToken"] = page
        payload = F.http_post_json(url, body, headers)
        out.extend(payload.get("results", []) or [])
        page = payload.get("nextPageToken")
        if not page:
            break
    return out


def main() -> None:
    cfg = F.load_config(None)
    token = F.get_access_token(cfg)
    print(f"API {F.API_VERSION}\n")

    for needle in NEEDLES:
        rows = search_fields(cfg, token, f"name LIKE '%{needle}%'")
        print(f"=== « {needle} » ({len(rows)}) ===")
        for r in sorted(rows, key=lambda x: x.get("name", "")):
            flags = "sel" if r.get("selectable") else "—"
            print(f"  {r.get('name'):<64} {r.get('dataType','?'):<14} {flags}")
        print()

    # Les ressources dont le nom évoque un rapport de mise en concurrence.
    res = search_fields(cfg, token, "category = 'RESOURCE'")
    names = sorted(r.get("name", "") for r in res)
    print(f"=== Ressources contenant auction / insight / competitor ===")
    for n in names:
        if any(k in n for k in ("auction", "insight", "competitor", "share")):
            print(f"  {n}")
    print(f"\n({len(names)} ressources au total)")


if __name__ == "__main__":
    main()
