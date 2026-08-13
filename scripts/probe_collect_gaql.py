#!/usr/bin/env python3
"""
Valide les requêtes GAQL destinées à l'Ads Script de collecte.

Le même GAQL s'exécute côté API et côté Google Ads Scripts : autant vérifier
ici qu'il est accepté et qu'il renvoie les colonnes attendues, plutôt que de
découvrir une erreur de champ après un copier-coller dans l'UI.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_ads_data as F  # noqa: E402

QUERIES = {
    # Niveau 1 et 2 : il faut le mot-clé déclencheur ET le groupe d'annonces.
    "search_terms": """
        SELECT
          search_term_view.search_term,
          search_term_view.status,
          segments.keyword.info.text,
          segments.keyword.info.match_type,
          segments.search_term_match_type,
          campaign.id,
          campaign.name,
          ad_group.id,
          ad_group.name,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value
        FROM search_term_view
        WHERE segments.date DURING LAST_7_DAYS
          AND metrics.clicks > 0
        LIMIT 5
    """,
    # Catégorisation produite par Google, au grain campagne.
    "campaign_categories": """
        SELECT
          campaign_search_term_insight.category_label,
          campaign_search_term_insight.campaign_id,
          metrics.impressions,
          metrics.clicks,
          metrics.conversions
        FROM campaign_search_term_insight
        WHERE segments.date DURING LAST_7_DAYS
        ORDER BY metrics.impressions DESC
        LIMIT 5
    """,
    # Domaine du compte, pour rattacher les Auction Insights au portefeuille.
    "campaign_domain": """
        SELECT
          campaign.id,
          campaign.name,
          campaign.advertising_channel_type,
          campaign.status
        FROM campaign
        WHERE campaign.advertising_channel_type = 'SEARCH'
          AND campaign.status = 'ENABLED'
        LIMIT 3
    """,
}


def main() -> None:
    cfg = F.load_config(None)
    token = F.get_access_token(cfg)
    accounts = F.list_child_accounts(cfg, token)
    target = next((a for a in accounts if a["name"] == "2lm_jacquie_et_michel_rencontre"),
                  accounts[0])
    print(f"Compte d'essai : {target['name']} ({F.fmt_cid(target['id'])})\n")

    for name, q in QUERIES.items():
        print(f"=== {name} ===")
        try:
            rows = F.ads_search(cfg, token, target["id"], q)
        except F.ApiError as exc:
            print(f"  REFUSÉ : {exc}\n")
            continue
        print(f"  OK — {len(rows)} ligne(s)")
        for r in rows[:3]:
            print(f"    {r}")
        print()


if __name__ == "__main__":
    main()
