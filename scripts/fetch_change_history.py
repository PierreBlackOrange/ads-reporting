#!/usr/bin/env python3
"""
Récupère l'historique des modifications Google Ads → data/changes.json.

    python scripts/fetch_change_history.py
    python scripts/fetch_change_history.py --days 14
    python scripts/fetch_change_history.py --with-authors     # voir l'avertissement

CE QUE C'EST
------------
L'équivalent de l'écran « Historique des modifications » de l'interface : qui a
changé quoi, quand, et de quelle valeur à quelle valeur. Chaque événement porte
`old_resource` et `new_resource`, qui ne contiennent QUE les champs modifiés —
on lit donc « ROAS cible 1,5 → 1,2 » et non un objet entier à comparer soi-même.

LA FENÊTRE EST DE 28 JOURS, ET CE N'EST PAS UN CHOIX
----------------------------------------------------
`change_event` refuse toute requête au-delà de 30 jours, et exige une fenêtre
bornée des deux côtés. Sondé :

    DURING LAST_30_DAYS        → changeEventError.START_DATE_TOO_OLD
    change_date_time >= 'J-29' → changeEventError.CHANGE_DATE_RANGE_INFINITE
    BETWEEN 'J-28' AND 'J'     → 710 événements sur un compte

Un rafraîchissement quotidien est donc la seule façon d'en garder une trace
continue : ce que l'API oublie, personne ne le retrouvera.

LES MODIFICATIONS EN MASSE SONT REGROUPÉES
------------------------------------------
Ajouter 190 mots-clés négatifs produit 190 événements à la même minute. Les lister
un par un noierait les changements qui comptent — un budget, une enchère cible, une
mise en pause — sous une avalanche de lignes identiques. Ils sont donc regroupés
par (minute, compte, campagne, type d'objet, action, champs touchés), avec le
nombre et quelques exemples. C'est ainsi que l'interface les présente, et pour la
même raison.

⚠️ AUTEURS DES MODIFICATIONS
----------------------------
`change_event.user_email` nomme la personne qui a fait chaque changement. Ce dépôt
est public : le champ est **exclu par défaut**. Un journal nominatif publié sur
Internet est un problème de RGPD, pas une fonctionnalité.

`--with-authors` publie la partie avant l'arobase (« ben » pour
ben@black-orange.ch). C'est un choix délibéré à faire en connaissance de cause,
pas un réglage par défaut.
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

MAX_DAYS = 28          # plafond imposé par l'API, pas une préférence
MAX_GROUPS = 6000      # garde-fou de taille de fichier ; annoncé s'il mord
SAMPLES = 4            # exemples de valeurs conservés par groupe

QUERY = """
    SELECT change_event.change_date_time, change_event.change_resource_type,
           change_event.change_resource_name, change_event.client_type,
           change_event.resource_change_operation, change_event.changed_fields,
           change_event.user_email, change_event.campaign, change_event.ad_group,
           change_event.old_resource, change_event.new_resource,
           campaign.name, ad_group.name
    FROM change_event
    WHERE change_event.change_date_time BETWEEN '{start} 00:00:00' AND '{end} 23:59:59'
    ORDER BY change_event.change_date_time DESC
    LIMIT 10000
"""

RESOURCE_FR = {
    "CAMPAIGN": "Campagne", "CAMPAIGN_BUDGET": "Budget",
    "CAMPAIGN_CRITERION": "Ciblage de campagne", "AD_GROUP": "Groupe d'annonces",
    "AD_GROUP_CRITERION": "Mot-clé / critère", "AD": "Annonce",
    "AD_GROUP_AD": "Annonce", "AD_GROUP_BID_MODIFIER": "Ajustement d'enchère",
    "ASSET": "Asset", "AD_GROUP_ASSET": "Asset de groupe",
    "CAMPAIGN_ASSET": "Asset de campagne", "ASSET_SET": "Groupe d'assets",
    "ASSET_SET_ASSET": "Groupe d'assets", "BIDDING_STRATEGY": "Stratégie d'enchères",
    "FEED": "Flux", "FEED_ITEM": "Élément de flux",
    "CAMPAIGN_SHARED_SET": "Liste partagée", "SHARED_SET": "Liste partagée",
    "CUSTOMER_ASSET": "Asset du compte", "UNKNOWN": "Autre",
}

OPERATION_FR = {"CREATE": "Ajout", "UPDATE": "Modification",
                "REMOVE": "Suppression", "UNKNOWN": "Autre"}

CLIENT_FR = {
    "GOOGLE_ADS_WEB_CLIENT": "Interface Google Ads",
    "GOOGLE_ADS_EDITOR": "Google Ads Editor",
    "GOOGLE_ADS_API": "API",
    "GOOGLE_ADS_SCRIPTS": "Script Google Ads",
    "GOOGLE_ADS_BULK_UPLOAD": "Import en masse",
    "GOOGLE_ADS_AUTOMATED_RULE": "Règle automatisée",
    "GOOGLE_ADS_RECOMMENDATIONS": "Recommandation Google",
    "GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION": "Recommandation auto-appliquée",
    "GOOGLE_ADS_MOBILE_APP": "Application mobile",
    "SEARCH_ADS_360_POST": "Search Ads 360",
    "INTERNAL_TOOL": "Outil interne", "OTHER": "Autre",
    "UNKNOWN": "Inconnu", "UNSPECIFIED": "Non renseigné",
}

# Chemins de champs traduits. Ce qui n'y figure pas garde son nom d'API : mieux
# vaut « aiMaxSetting.enableAiMax » qu'une traduction inventée qu'on ne retrouvera
# dans aucune documentation.
FIELD_FR = {
    "status": "Statut",
    "name": "Nom",
    "amountMicros": "Budget quotidien",
    "targetRoas": "ROAS cible",
    "targetCpa": "CPA cible",
    "maximizeConversionValue.targetRoas": "ROAS cible",
    "maximizeConversions.targetCpaMicros": "CPA cible",
    "targetSpend.cpcBidCeilingMicros": "Plafond de CPC",
    "cpcBidMicros": "Enchère CPC",
    "keyword.text": "Mot-clé",
    "keyword.matchType": "Type de correspondance",
    "negative": "Exclusion",
    "trackingUrlTemplate": "Modèle de suivi",
    "finalUrls": "URL finale",
    "aiMaxSetting.enableAiMax": "AI Max activé",
    "brandList.sharedSet": "Liste de marques",
    "assetAutomationSettings": "Automatisation des assets",
    "geoTargetTypeSetting.positiveGeoTargetType": "Ciblage géographique",
    "networkSettings.targetSearchNetwork": "Réseau Search",
    "networkSettings.targetContentNetwork": "Réseau Display",
    "startDate": "Date de début",
    "endDate": "Date de fin",
    "biddingStrategyType": "Type d'enchères",
    "bidModifier": "Ajustement d'enchère",
}

# Champs de structure, sans intérêt pour un lecteur : ils disent qu'un objet a été
# créé, ce que la colonne « action » dit déjà.
SKIP_FIELDS = {"resourceName", "criterionId", "campaign", "adGroup", "id",
               "type", "customer"}

MONEY_HINTS = ("micros", "Micros")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Historique des modifications Google Ads.")
    p.add_argument("--days", type=int, default=MAX_DAYS,
                   help=f"profondeur, {MAX_DAYS} au maximum (plafond de l'API)")
    p.add_argument("--end", default=None, help="dernier jour, AAAA-MM-JJ (défaut : aujourd'hui)")
    p.add_argument("--accounts", default=None, help="CID séparés par des virgules")
    p.add_argument("--with-authors", action="store_true",
                   help="publie la partie locale de l'e-mail de l'auteur (dépôt public !)")
    p.add_argument("--config", default=None)
    p.add_argument("--out", default=None)
    return p.parse_args()


def dig(obj, path: str):
    """Valeur au bout d'un chemin « a.b.c », ou None si le chemin s'interrompt."""
    cur = obj
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
        if cur is None:
            return None
    return cur


def payload_of(resource: dict | None) -> dict:
    """old_resource / new_resource enveloppent l'objet dans une clé de type
    (« campaign », « adGroup »…). On prend ce qu'il y a dedans, sans supposer
    laquelle."""
    if not isinstance(resource, dict):
        return {}
    for value in resource.values():
        if isinstance(value, dict):
            return value
    return {}


def fmt_value(field: str, value, currency: str) -> str:
    if value is None:
        return "—"
    if isinstance(value, bool):
        return "oui" if value else "non"
    if isinstance(value, (list, tuple)):
        return ", ".join(str(v) for v in value)[:160] or "—"
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)[:160]
    # Convention française : espace insécable pour les milliers, virgule décimale.
    # Un « ROAS cible 1.40 → 1.60 » au milieu d'un rapport en français se lit comme
    # une valeur importée d'ailleurs.
    def fr(x: float) -> str:
        return f"{x:,.2f}".replace(",", " ").replace(".", ",")

    if any(h in field for h in MONEY_HINTS):
        try:
            return f"{fr(int(value) / 1e6)} {currency}"
        except (TypeError, ValueError):
            return str(value)
    if isinstance(value, float):
        return fr(value)
    return str(value)[:160]


def main() -> None:
    args = parse_args()
    cfg = F.load_config(args.config)

    days = min(args.days, MAX_DAYS)
    if args.days > MAX_DAYS:
        print(f"⚠ {args.days} jours demandés ; l'API en refuse plus de {MAX_DAYS}. "
              f"Fenêtre ramenée à {MAX_DAYS}.")
    end = args.end or dt.date.today().isoformat()
    start = (dt.date.fromisoformat(end) - dt.timedelta(days=days - 1)).isoformat()
    print(f"Fenêtre : {start} → {end} ({days} jours, plafond de l'API : {MAX_DAYS})")
    if args.with_authors:
        print("⚠ Les auteurs seront publiés (partie avant l'arobase). Ce dépôt est public.")

    token = F.get_access_token(cfg)
    accounts = F.list_child_accounts(cfg, token)
    if args.accounts:
        wanted = {F.digits_only(a) for a in args.accounts.split(",") if a.strip()}
        accounts = [a for a in accounts if a["id"] in wanted]
    if not accounts:
        F.die("Aucun compte client actif à interroger.")

    currency, _ = F.resolve_currency(accounts, cfg)

    # clé de regroupement → agrégat
    groups: dict[tuple, dict] = {}
    raw_events = 0
    failures: list[tuple[str, str]] = []
    authors: set[str] = set()

    for i, account in enumerate(accounts, 1):
        label = f"{account['name']} ({F.fmt_cid(account['id'])})"
        print(f"[{i}/{len(accounts)}] {label}…", end=" ", flush=True)
        try:
            rows = F.ads_search(cfg, token, account["id"],
                                QUERY.format(start=start, end=end))
        except F.ApiError as exc:
            if exc.is_version_error:
                F.die(f"L'API refuse la version {F.API_VERSION} : {exc}")
            print(f"ÉCHEC ({exc})")
            failures.append((label, str(exc)))
            continue
        print(f"{len(rows)} événement(s)")
        raw_events += len(rows)

        for r in rows:
            e = r.get("changeEvent") or {}
            stamp = str(e.get("changeDateTime") or "")
            if not stamp:
                continue
            minute = stamp[:16].replace("/", "-")     # AAAA-MM-JJ HH:MM
            rtype = e.get("changeResourceType") or "UNKNOWN"
            op = e.get("resourceChangeOperation") or "UNKNOWN"
            client = e.get("clientType") or "UNKNOWN"
            camp = (r.get("campaign") or {}).get("name") or ""
            grp = (r.get("adGroup") or {}).get("name") or ""
            email = e.get("userEmail") or ""
            if email:
                authors.add(email)
            who = email.split("@")[0] if (args.with_authors and email) else ""

            fields = [f.strip() for f in (e.get("changedFields") or "").split(",")
                      if f.strip() and f.strip() not in SKIP_FIELDS]
            old = payload_of(e.get("oldResource"))
            new = payload_of(e.get("newResource"))

            changes = []
            for path in fields:
                before = fmt_value(path, dig(old, path), currency)
                after = fmt_value(path, dig(new, path), currency)
                if before == after:
                    continue
                changes.append({
                    "field": path,
                    "label": FIELD_FR.get(path, path),
                    "before": before,
                    "after": after,
                })

            # Un événement dont aucun champ lisible n'a bougé garde sa trace :
            # « quelque chose a changé ici » est une information, l'effacer non.
            sig = "|".join(c["field"] for c in changes)
            key = (minute, account["name"], camp, grp, rtype, op, client, who, sig)
            g = groups.get(key)
            if g is None:
                g = groups[key] = {
                    "at": minute,
                    "account": account["name"],
                    "campaign": camp,
                    "adGroup": grp,
                    "type": rtype,
                    "typeLabel": RESOURCE_FR.get(rtype, rtype),
                    "operation": op,
                    "operationLabel": OPERATION_FR.get(op, op),
                    "client": client,
                    "clientLabel": CLIENT_FR.get(client, client),
                    "author": who,
                    "count": 0,
                    "changes": changes,
                    "samples": [],
                }
            g["count"] += 1
            # Quelques valeurs d'exemple, pour qu'un groupe de 190 mots-clés dise
            # lesquels sans les lister tous.
            if len(g["samples"]) < SAMPLES:
                for c in changes:
                    if c["after"] not in ("—", "") and c["after"] not in g["samples"]:
                        g["samples"].append(c["after"])
                        break

    if not groups:
        F.die("Aucune modification sur la fenêtre. Si c'est inattendu, vérifiez "
              "que le jeton a accès à l'historique des comptes.")

    items = sorted(groups.values(), key=lambda g: g["at"], reverse=True)
    truncated = 0
    if len(items) > MAX_GROUPS:
        truncated = len(items) - MAX_GROUPS
        items = items[:MAX_GROUPS]

    payload = {
        "meta": {
            "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "date_start": start,
            "date_end": end,
            "days": days,
            "api_max_days": MAX_DAYS,
            "currency": currency,
            "raw_events": raw_events,
            "groups": len(items),
            "truncated": truncated,
            "accounts_scanned": len(accounts),
            "authors_seen": len(authors),
            "authors_published": bool(args.with_authors),
            "failures": [{"account": a, "error": e} for a, e in failures],
        },
        "events": items,
    }

    out = Path(args.out) if args.out else PROJECT_DIR / "data" / "changes.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")

    print(f"\nÉcrit {out} ({out.stat().st_size / 1024:.0f} Ko)")
    print(f"  {raw_events} événement(s) brut(s) → {len(items)} ligne(s) après regroupement")
    print(f"  {len(authors)} auteur(s) distinct(s)"
          + ("" if args.with_authors else " — non publiés"))
    if truncated:
        print(f"  ⚠ {truncated} ligne(s) écartée(s) par le plafond de {MAX_GROUPS}")
    by_type: dict[str, int] = {}
    for g in items:
        by_type[g["typeLabel"]] = by_type.get(g["typeLabel"], 0) + 1
    for k, v in sorted(by_type.items(), key=lambda x: -x[1])[:8]:
        print(f"  {k:<24} {v}")
    if failures:
        print(f"  {len(failures)} échec(s) de compte")


if __name__ == "__main__":
    main()
