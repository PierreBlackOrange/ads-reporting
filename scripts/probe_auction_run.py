#!/usr/bin/env python3
"""
Sonde d'exécution : depuis quelle ressource les Auction Insights se lisent-ils,
et que renvoient-ils réellement ?

Les champs existent (probe_auction.py), mais aucune ressource ne s'appelle
« auction_insight_view ». Ils doivent donc s'attacher à une ressource
existante. Une architecture qui ne s'exécute pas ne vaut rien : on essaie.

On teste aussi customer_search_term_insight, la catégorisation de requêtes que
Google produit lui-même — utile comme amorce de clustering si elle est fournie.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_ads_data as F  # noqa: E402

AI_METRICS = """
      segments.auction_insight_domain,
      metrics.auction_insight_search_impression_share,
      metrics.auction_insight_search_overlap_rate,
      metrics.auction_insight_search_position_above_rate,
      metrics.auction_insight_search_outranking_share,
      metrics.auction_insight_search_top_impression_percentage
"""

CANDIDATES = {
    "campaign": f"""
        SELECT campaign.id, campaign.name, {AI_METRICS}
        FROM campaign
        WHERE segments.date DURING LAST_30_DAYS
          AND campaign.advertising_channel_type = 'SEARCH'
    """,
    "ad_group": f"""
        SELECT ad_group.id, ad_group.name, {AI_METRICS}
        FROM ad_group
        WHERE segments.date DURING LAST_30_DAYS
    """,
    "customer": f"""
        SELECT customer.id, {AI_METRICS}
        FROM customer
        WHERE segments.date DURING LAST_30_DAYS
    """,
    "keyword_view": f"""
        SELECT ad_group_criterion.keyword.text, {AI_METRICS}
        FROM keyword_view
        WHERE segments.date DURING LAST_30_DAYS
    """,
}

INSIGHT_QUERY = """
    SELECT
      customer_search_term_insight.category_label,
      customer_search_term_insight.id,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions
    FROM customer_search_term_insight
    WHERE segments.date DURING LAST_30_DAYS
    ORDER BY metrics.impressions DESC
    LIMIT 25
"""


def main() -> None:
    cfg = F.load_config(None)
    token = F.get_access_token(cfg)
    accounts = F.list_child_accounts(cfg, token)

    # Le compte le plus dépensier : c'est là qu'un rapport de mise en
    # concurrence a le plus de chances d'être peuplé.
    target = next((a for a in accounts if a["name"] == "2lm_jacquie_et_michel_rencontre"),
                  accounts[0])
    print(f"Compte d'essai : {target['name']} ({F.fmt_cid(target['id'])})\n")

    for name, query in CANDIDATES.items():
        print(f"=== FROM {name} ===")
        try:
            rows = F.ads_search(cfg, token, target["id"], query)
        except F.ApiError as exc:
            print(f"  REFUSÉ : {exc}\n")
            continue
        print(f"  OK — {len(rows)} ligne(s)")
        for r in rows[:6]:
            seg = r.get("segments") or {}
            m = r.get("metrics") or {}
            who = (r.get("campaign") or r.get("adGroup") or r.get("customer")
                   or r.get("adGroupCriterion") or {})
            lbl = who.get("name") or who.get("id") or ""
            print(f"    {str(lbl)[:38]:<40} {seg.get('auctionInsightDomain','?'):<34} "
                  f"IS {m.get('auctionInsightSearchImpressionShare','—')} "
                  f"ovl {m.get('auctionInsightSearchOverlapRate','—')} "
                  f"above {m.get('auctionInsightSearchPositionAboveRate','—')}")
        if rows:
            domains = sorted({(r.get("segments") or {}).get("auctionInsightDomain", "?")
                              for r in rows})
            print(f"  {len(domains)} domaine(s) distinct(s) : {', '.join(domains[:14])}")
        print()

    print("=== customer_search_term_insight ===")
    try:
        rows = F.ads_search(cfg, token, target["id"], INSIGHT_QUERY)
        print(f"  OK — {len(rows)} ligne(s)")
        for r in rows[:15]:
            i = r.get("customerSearchTermInsight") or {}
            m = r.get("metrics") or {}
            print(f"    {str(i.get('categoryLabel'))[:52]:<54} "
                  f"{F.to_int(m.get('impressions')):>9,} impr")
    except F.ApiError as exc:
        print(f"  REFUSÉ : {exc}")


if __name__ == "__main__":
    main()
