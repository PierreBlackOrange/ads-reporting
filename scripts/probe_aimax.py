#!/usr/bin/env python3
"""
Sonde : que l'API Google Ads expose-t-elle au sujet d'AI Max ?

AI Max est récent et son modèle de données n'est pas devinable. Plutôt que de
supposer un nom de champ, on interroge GoogleAdsFieldService, qui décrit
l'API elle-même : quels champs existent dans cette version, lesquels sont
sélectionnables, et quelles valeurs prennent les énumérations utiles.

Ce script ne lit aucune donnée de compte. Il ne sert qu'à savoir quoi demander.
"""

from __future__ import annotations

import json
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
    query = (
        "SELECT name, category, data_type, selectable, filterable, enum_values "
        f"WHERE {where}"
    )
    out: list[dict] = []
    page_token = None
    while True:
        body: dict = {"query": query, "pageSize": 1000}
        if page_token:
            body["pageToken"] = page_token
        payload = F.http_post_json(url, body, headers)
        out.extend(payload.get("results", []) or [])
        page_token = payload.get("nextPageToken")
        if not page_token:
            break
    return out


def show(title: str, rows: list[dict], with_enums: bool = False) -> None:
    print(f"\n=== {title} ({len(rows)}) ===")
    for r in sorted(rows, key=lambda x: x.get("name", "")):
        flags = []
        if r.get("selectable"):
            flags.append("sel")
        if r.get("filterable"):
            flags.append("filt")
        print(f"  {r.get('name'):<62} {r.get('dataType','?'):<12} {','.join(flags)}")
        if with_enums and r.get("enumValues"):
            for v in r["enumValues"]:
                print(f"        · {v}")


def main() -> None:
    cfg = F.load_config(None)
    token = F.get_access_token(cfg)

    print(f"API {F.API_VERSION}")

    # 1. Tout ce dont le nom évoque AI Max, sans préjuger de la ressource.
    aimax = search_fields(cfg, token, "name LIKE '%ai_max%'")
    show("Champs contenant « ai_max »", aimax, with_enums=True)

    # 2. Le type de correspondance des requêtes : c'est là que Google range
    #    d'ordinaire l'origine d'un appariement élargi.
    stmt = search_fields(cfg, token, "name = 'segments.search_term_match_type'")
    show("segments.search_term_match_type", stmt, with_enums=True)

    # 3. Toute la ressource search_term_view, pour voir ce qui s'y est ajouté.
    stv = search_fields(cfg, token, "name LIKE 'search_term_view.%'")
    show("search_term_view.*", stv, with_enums=True)

    # 4. Les segments récents susceptibles de porter l'origine du trafic.
    for needle in ("search_subcategory", "search_term", "asset_interaction"):
        rows = search_fields(cfg, token, f"name LIKE '%{needle}%'")
        show(f"« {needle} »", rows)

    # 5. Les réglages de campagne, pour savoir si l'activation d'AI Max se lit.
    camp = search_fields(cfg, token, "name LIKE 'campaign.%'")
    interesting = [
        r for r in camp
        if any(k in r.get("name", "") for k in
               ("ai_max", "keyword_match", "search_term", "url_expansion",
                "text_customization", "brand", "optimization"))
    ]
    show("campaign.* susceptibles de porter AI Max", interesting, with_enums=True)

    Path("scripts/_probe_aimax.json").write_text(
        json.dumps({"ai_max": aimax, "search_term_match_type": stmt,
                    "search_term_view": stv, "campaign": interesting},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("\nDétail complet écrit dans scripts/_probe_aimax.json")


if __name__ == "__main__":
    main()
