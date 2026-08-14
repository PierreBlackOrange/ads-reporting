#!/usr/bin/env python3
"""
Sonde : que l'API Google Ads expose-t-elle sur la santé du tracking ?

Trois questions à trancher sur les vraies données avant d'écrire un onglet
« Tracking / Consent Mode », parce que trois réponses négatives changeraient
complètement ce qu'on peut construire :

  1. Le taux de Consent Mode (granted / denied) est-il accessible en API, ou
     seulement dans l'écran Diagnostics de l'interface ?
  2. Les conversions modélisées sont-elles séparables des conversions observées ?
  3. À défaut, de quoi dispose-t-on pour distinguer une baisse de performance
     d'une cassure de mesure — journal des changements, retard de conversion,
     paramétrage des actions de conversion, marché géographique ?

Un onglet qui afficherait « 0 % de refus » parce que le champ n'existe pas serait
pire que pas d'onglet du tout.
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
    query = ("SELECT name, category, data_type, selectable, filterable, metrics, "
             "segments, enum_values "
             f"WHERE {where}")
    payload = F.http_post_json(url, {"query": query, "pageSize": 1000}, headers)
    return payload.get("results", []) or []


# Ce qu'on cherche dans le schéma. Le nom exact importe peu : on ratisse large et
# on lit ce qui remonte.
NEEDLES = [
    "consent",
    "modeled",
    "modelled",
    "diagnostic",
    "tag",
    "conversion_lag",
    "conversion_origin",
    "enhanced",
    "geo_target_country",
    "change_event",
]

# Requêtes candidates, testées telles quelles sur un compte réel. Un champ
# « selectable » au schéma peut être refusé à l'exécution (c'est arrivé sur les
# Auction Insights : présents en v25, 403 sur ce jeton).
CANDIDATES = {
    "actions de conversion": """
        SELECT conversion_action.id, conversion_action.name, conversion_action.type,
               conversion_action.status, conversion_action.category,
               conversion_action.primary_for_goal,
               conversion_action.counting_type,
               conversion_action.attribution_model_settings.attribution_model,
               conversion_action.attribution_model_settings.data_driven_model_status,
               conversion_action.include_in_conversions_metric
        FROM conversion_action
    """,
    "journal des changements": """
        SELECT change_event.change_date_time, change_event.change_resource_type,
               change_event.client_type, change_event.user_email,
               change_event.changed_fields, change_event.resource_change_operation
        FROM change_event
        WHERE change_event.change_date_time DURING LAST_14_DAYS
        LIMIT 20
    """,
    "retard de conversion": """
        SELECT segments.conversion_lag_bucket, metrics.conversions
        FROM campaign
        WHERE segments.date DURING LAST_30_DAYS
    """,
    "origine de conversion": """
        SELECT segments.conversion_action_name, segments.date, metrics.conversions
        FROM campaign
        WHERE segments.date DURING LAST_7_DAYS
        LIMIT 20
    """,
    "pays ciblé": """
        SELECT segments.geo_target_country, metrics.clicks, metrics.cost_micros
        FROM geographic_view
        WHERE segments.date DURING LAST_7_DAYS
        LIMIT 20
    """,
    "paramétrage du suivi (compte)": """
        SELECT customer.id, customer.descriptive_name,
               customer.conversion_tracking_setting.conversion_tracking_id,
               customer.conversion_tracking_setting.conversion_tracking_status,
               customer.conversion_tracking_setting.cross_account_conversion_tracking_id,
               customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled,
               customer.conversion_tracking_setting.google_ads_conversion_customer
        FROM customer
    """,
}


def main() -> None:
    cfg = F.load_config(None)
    token = F.get_access_token(cfg)

    print(f"API {F.API_VERSION}\n")
    print("═══ 1. Ce que le schéma contient ═══\n")
    for needle in NEEDLES:
        rows = search_fields(cfg, token, f"name LIKE '%{needle}%'")
        print(f"--- « {needle} » : {len(rows)} champ(s) ---")
        for r in sorted(rows, key=lambda x: x.get("name", "")):
            kind = []
            if r.get("metrics"):
                kind.append("metric")
            if r.get("segments"):
                kind.append("segment")
            flags = "selectable" if r.get("selectable") else "NON selectable"
            print(f"  {r.get('name'):<62} {r.get('dataType', '?'):<12} {flags}"
                  + (f"  [{'/'.join(kind)}]" if kind else ""))
            for v in (r.get("enumValues") or [])[:12]:
                print(f"        · {v}")
        print()

    accounts = F.list_child_accounts(cfg, token)
    # Un compte qui dépense : un compte dormant répondrait « 0 ligne » sans rien
    # dire de la disponibilité du champ.
    target = next((a for a in accounts
                   if a["name"] == "2lm_jacquie_et_michel_rencontre"), accounts[0])
    print(f"═══ 2. Ce qui répond vraiment — {target['name']} ═══\n")

    for label, query in CANDIDATES.items():
        try:
            rows = F.ads_search(cfg, token, target["id"], query)
        except F.ApiError as exc:
            print(f"--- {label} : REFUSÉ ---")
            print(f"    {str(exc)[:400]}\n")
            continue
        print(f"--- {label} : {len(rows)} ligne(s) ---")
        for r in rows[:6]:
            print(f"    {r}"[:400])
        print()


if __name__ == "__main__":
    main()
