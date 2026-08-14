#!/usr/bin/env python3
"""
Récupère les signaux de santé du tracking et produit data/tracking.json.

    python scripts/fetch_tracking.py
    python scripts/fetch_tracking.py --days 90

CE QUE CE FICHIER NE CONTIENT PAS, ET POURQUOI
----------------------------------------------
Le taux de Consent Mode (granted / denied) n'existe pas dans l'API Google Ads.
Sondé sur la v25 : `name LIKE '%consent%'` renvoie **zéro champ**. Il est visible
dans l'interface (Outils → Diagnostics de balise) et dans la CMP, jamais en API.
De même, `%modeled%` et `%modelled%` renvoient zéro champ : les conversions
modélisées ne sont pas séparables des conversions observées.

Afficher « 0 % de refus » parce que le champ est absent serait pire que ne rien
afficher. Ce script mesure donc le tracking par ses **effets** — ce qui suffit
pour répondre à la seule question qui compte : cette baisse de conversions vient-
elle de la performance ou de la mesure ?

Le taux de consentement, lui, entre par data/changelog.json (voir
scripts/fetch_changelog.py) : il vient de la CMP, seule source qui le connaisse.

CE QU'IL CONTIENT
-----------------
1. `daily`     — clics, impressions, coût, conversions par (jour × compte).
                 Le dénominateur : une cassure de mesure fait tomber les
                 conversions sans toucher aux clics.
2. `series`    — conversions par (jour × compte × action de conversion). Une
                 balise qui casse fait taire UNE action, pas toutes.
3. `config`    — paramétrage du suivi par compte : statut, identifiant de
                 conversion, conversions étendues, nombre d'actions actives.
4. `lag`       — répartition du retard de conversion par mois. Un basculement de
                 tagging déplace ce profil.
5. `market`    — pays de LIVRAISON par jour, via geographic_view. Le ciblage des
                 campagnes a été essayé d'abord et écarté : il dit une intention,
                 pas où la dépense est partie.
6. `changes`   — journal des changements Google Ads, **30 jours maximum** (limite
                 de l'API : START_DATE_TOO_OLD au-delà).

DONNÉES PERSONNELLES
--------------------
`change_event.user_email` existe et nomme la personne qui a fait chaque
modification. Ce dépôt est public : le champ est lu pour compter les auteurs
distincts, jamais écrit dans le fichier. Un journal de modifications nominatif
publié sur Internet est un problème de RGPD, pas une fonctionnalité.

`metrics.conversions` vs `metrics.all_conversions` : segmenté par action, le
premier ne compte que les actions incluses dans la colonne « Conversions »
(celles que les enchères voient). Le second compte tout. La santé d'une balise
se lit sur `all_conversions` ; ce que l'algorithme optimise, sur `conversions`.
Les deux sont collectés.
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

# ── Requêtes ───────────────────────────────────────────────────────────────────

Q_DAILY = """
    SELECT segments.date,
           metrics.clicks, metrics.impressions, metrics.cost_micros,
           metrics.conversions, metrics.all_conversions, metrics.conversions_value
    FROM customer
    WHERE segments.date BETWEEN '{start}' AND '{end}'
"""

Q_ACTIONS_SERIES = """
    SELECT segments.date, segments.conversion_action_name,
           metrics.conversions, metrics.all_conversions, metrics.conversions_value
    FROM customer
    WHERE segments.date BETWEEN '{start}' AND '{end}'
"""

Q_CONFIG = """
    SELECT customer.id, customer.descriptive_name, customer.auto_tagging_enabled,
           customer.conversion_tracking_setting.conversion_tracking_id,
           customer.conversion_tracking_setting.conversion_tracking_status,
           customer.conversion_tracking_setting.cross_account_conversion_tracking_id,
           customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled
    FROM customer
"""

Q_ACTIONS = """
    SELECT conversion_action.name, conversion_action.status, conversion_action.type,
           conversion_action.primary_for_goal,
           conversion_action.include_in_conversions_metric
    FROM conversion_action
    WHERE conversion_action.status = 'ENABLED'
"""

Q_LAG = """
    SELECT segments.conversion_lag_bucket, segments.month, metrics.all_conversions
    FROM customer
    WHERE segments.date BETWEEN '{start}' AND '{end}'
"""

# Le marché vient de la LIVRAISON, pas du ciblage.
#
# Premier essai : le ciblage géographique des campagnes (campaign_criterion). Il
# donne des clés inexploitables — une campagne visant seize pays produit un
# marché « 16 pays », et deux campagnes visant seize pays DIFFÉRENTS tombent dans
# le même seau. Le ciblage dit une intention, pas où la dépense est partie.
#
# geographic_view donne le pays réel, par jour. Le piège : location_type vaut
# LOCATION_OF_PRESENCE (l'internaute y était) ou AREA_OF_INTEREST (il s'y
# intéressait). Les additionner compterait deux fois la même dépense — d'où le
# filtre, et non une somme des deux.
Q_MARKET = """
    SELECT geographic_view.country_criterion_id,
           segments.date,
           metrics.clicks, metrics.cost_micros,
           metrics.conversions, metrics.all_conversions, metrics.conversions_value
    FROM geographic_view
    WHERE segments.date BETWEEN '{start}' AND '{end}'
      AND geographic_view.location_type = 'LOCATION_OF_PRESENCE'
"""

# La fenêtre doit être BORNÉE des deux côtés et ne pas dépasser 30 jours. Sondé :
#   DURING LAST_30_DAYS      → START_DATE_TOO_OLD (la borne tombe à 31 jours)
#   change_date_time >= 'J-29' → CHANGE_DATE_RANGE_INFINITE (borne haute absente)
#   BETWEEN 'J-28' AND 'J'   → 710 lignes sur un compte. C'est celle-ci.
Q_CHANGES = """
    SELECT change_event.change_date_time, change_event.change_resource_type,
           change_event.client_type, change_event.resource_change_operation,
           change_event.changed_fields, change_event.user_email
    FROM change_event
    WHERE change_event.change_date_time BETWEEN '{cstart} 00:00:00' AND '{cend} 23:59:59'
    LIMIT 10000
"""

CHANGE_MAX_DAYS = 28

# Ordre figé : un profil de retard qui change d'ordre d'un export à l'autre ne se
# compare plus. Les libellés sont ceux de l'API, regroupés en paliers lisibles.
LAG_ORDER = [
    "LESS_THAN_ONE_DAY", "ONE_TO_TWO_DAYS", "TWO_TO_THREE_DAYS", "THREE_TO_FOUR_DAYS",
    "FOUR_TO_FIVE_DAYS", "FIVE_TO_SIX_DAYS", "SIX_TO_SEVEN_DAYS", "SEVEN_TO_EIGHT_DAYS",
    "EIGHT_TO_NINE_DAYS", "NINE_TO_TEN_DAYS", "TEN_TO_ELEVEN_DAYS", "ELEVEN_TO_TWELVE_DAYS",
    "TWELVE_TO_THIRTEEN_DAYS", "THIRTEEN_TO_FOURTEEN_DAYS", "FOURTEEN_TO_TWENTY_ONE_DAYS",
    "TWENTY_ONE_TO_THIRTY_DAYS", "THIRTY_TO_FORTY_FIVE_DAYS", "FORTY_FIVE_TO_SIXTY_DAYS",
    "SIXTY_TO_NINETY_DAYS",
]

# Paliers d'affichage : dix-neuf tranches ne se lisent pas, quatre oui.
LAG_GROUPS = [
    ("< 1 jour", {"LESS_THAN_ONE_DAY"}),
    ("1 à 7 jours", {"ONE_TO_TWO_DAYS", "TWO_TO_THREE_DAYS", "THREE_TO_FOUR_DAYS",
                     "FOUR_TO_FIVE_DAYS", "FIVE_TO_SIX_DAYS", "SIX_TO_SEVEN_DAYS"}),
    ("7 à 14 jours", {"SEVEN_TO_EIGHT_DAYS", "EIGHT_TO_NINE_DAYS", "NINE_TO_TEN_DAYS",
                      "TEN_TO_ELEVEN_DAYS", "ELEVEN_TO_TWELVE_DAYS",
                      "TWELVE_TO_THIRTEEN_DAYS", "THIRTEEN_TO_FOURTEEN_DAYS"}),
    ("plus de 14 jours", {"FOURTEEN_TO_TWENTY_ONE_DAYS", "TWENTY_ONE_TO_THIRTY_DAYS",
                          "THIRTY_TO_FORTY_FIVE_DAYS", "FORTY_FIVE_TO_SIXTY_DAYS",
                          "SIXTY_TO_NINETY_DAYS"}),
    # UNKNOWN existe et porte du volume réel : le jeter ferait un total faux, et
    # un profil de retard amputé de sa part inconnue se lit à tort comme complet.
    ("retard non attribué", {"UNKNOWN", "UNSPECIFIED"}),
]

MARKET_LABELS = {
    "FR": "France", "ES": "Espagne", "BE": "Belgique", "CH": "Suisse",
    "IT": "Italie", "PT": "Portugal", "DE": "Allemagne", "GB": "Royaume-Uni",
    "NL": "Pays-Bas", "LU": "Luxembourg", "CA": "Canada", "US": "États-Unis",
}


class Indexer:
    def __init__(self) -> None:
        self.values: list = []
        self._pos: dict = {}

    def get(self, value):
        key = json.dumps(value, sort_keys=True) if isinstance(value, (dict, list)) else value
        pos = self._pos.get(key)
        if pos is None:
            pos = self._pos[key] = len(self.values)
            self.values.append(value)
        return pos


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Signaux de santé du tracking.")
    p.add_argument("--days", type=int, default=180, help="profondeur (défaut : 180)")
    p.add_argument("--end", default=None, help="dernier jour, AAAA-MM-JJ (défaut : hier)")
    p.add_argument("--accounts", default=None, help="CID séparés par des virgules")
    p.add_argument("--config", default=None)
    p.add_argument("--out", default=None)
    return p.parse_args()


def resolve_countries(cfg: dict, token: str, cid: str, ids: set[str]) -> dict[str, str]:
    """geoTargetConstants/2250 → « FR ». geographic_view ne renvoie que des
    identifiants de pays, donc une poignée de valeurs à résoudre."""
    out: dict[str, str] = {}
    ids = {i for i in ids if i}
    todo = sorted(ids)
    STEP = 200
    for i in range(0, len(todo), STEP):
        chunk = todo[i:i + STEP]
        names = ",".join(f"'geoTargetConstants/{g}'" for g in chunk)
        q = ("SELECT geo_target_constant.id, geo_target_constant.country_code "
             f"FROM geo_target_constant WHERE geo_target_constant.resource_name IN ({names})")
        try:
            for r in F.ads_search(cfg, token, cid, q):
                g = r.get("geoTargetConstant") or {}
                if g.get("id") and g.get("countryCode"):
                    out[str(g["id"])] = g["countryCode"]
        except F.ApiError as exc:
            print(f"  résolution géographique partielle ({exc})")
            break
    return out


def main() -> None:
    args = parse_args()
    cfg = F.load_config(args.config)

    end = args.end or (dt.date.today() - dt.timedelta(days=1)).isoformat()
    start = (dt.date.fromisoformat(end) - dt.timedelta(days=args.days - 1)).isoformat()
    change_start = (dt.date.fromisoformat(end)
                    - dt.timedelta(days=CHANGE_MAX_DAYS - 1)).isoformat()
    print(f"Période : {start} → {end} ({args.days} jours)")
    print(f"Changements Google Ads : {change_start} → {end} (plafond de l'API)")

    token = F.get_access_token(cfg)
    accounts = F.list_child_accounts(cfg, token)
    if args.accounts:
        wanted = {F.digits_only(a) for a in args.accounts.split(",") if a.strip()}
        accounts = [a for a in accounts if a["id"] in wanted]
    if not accounts:
        F.die("Aucun compte client actif à interroger.")

    acc_idx = Indexer()
    action_idx = Indexer()
    date_set: set[str] = set()
    month_set: set[str] = set()
    geo_ids: set[str] = set()

    daily: list[list] = []
    series: list[list] = []
    lag_rows: list[list] = []
    configs: list[dict] = []
    changes: list[list] = []
    change_authors: dict[int, set] = {}
    geo_daily: dict[tuple, list] = {}             # (date, accIdx, countryId) → metrics
    failures: list[tuple[str, str]] = []

    for i, account in enumerate(accounts, 1):
        label = f"{account['name']} ({F.fmt_cid(account['id'])})"
        print(f"[{i}/{len(accounts)}] {label}…", end=" ", flush=True)

        # Le quotidien d'abord : un compte sans clic sur la fenêtre n'a rien à
        # dire sur la santé de son tracking, et six requêtes de plus n'y
        # changeraient rien.
        try:
            rows = F.ads_search(cfg, token, account["id"], Q_DAILY.format(start=start, end=end))
        except F.ApiError as exc:
            if exc.is_version_error:
                F.die(f"L'API refuse la version {F.API_VERSION} : {exc}")
            print(f"ÉCHEC ({exc})")
            failures.append((label, str(exc)))
            continue

        useful = [r for r in rows if F.to_int((r.get("metrics") or {}).get("clicks"))]
        if not useful:
            print("dormant")
            continue

        ai = acc_idx.get({"name": account["name"], "currency": account["currency"],
                          "cid": F.fmt_cid(account["id"])})

        for r in useful:
            seg = r.get("segments") or {}
            m = r.get("metrics") or {}
            d = seg.get("date")
            if not d:
                continue
            date_set.add(d)
            daily.append([
                d, ai,
                F.to_int(m.get("impressions")), F.to_int(m.get("clicks")),
                round(F.to_int(m.get("costMicros")) / 1e6, 2),
                round(F.to_float(m.get("conversions")), 2),
                round(F.to_float(m.get("allConversions")), 2),
                round(F.to_float(m.get("conversionsValue")), 2),
            ])

        # ── Séries par action de conversion ──────────────────────────────────
        try:
            for r in F.ads_search(cfg, token, account["id"],
                                  Q_ACTIONS_SERIES.format(start=start, end=end)):
                seg = r.get("segments") or {}
                m = r.get("metrics") or {}
                d = seg.get("date")
                name = seg.get("conversionActionName")
                if not d or not name:
                    continue
                allc = F.to_float(m.get("allConversions"))
                conv = F.to_float(m.get("conversions"))
                if not allc and not conv:
                    continue
                date_set.add(d)
                series.append([
                    d, ai, action_idx.get(name),
                    round(conv, 2), round(allc, 2),
                    round(F.to_float(m.get("conversionsValue")), 2),
                ])
        except F.ApiError as exc:
            print(f"[actions: {exc}]", end=" ")

        # ── Paramétrage du suivi ─────────────────────────────────────────────
        cfg_row = {"account": ai}
        try:
            for r in F.ads_search(cfg, token, account["id"], Q_CONFIG):
                c = r.get("customer") or {}
                cts = c.get("conversionTrackingSetting") or {}
                cfg_row.update({
                    "autoTagging": bool(c.get("autoTaggingEnabled")),
                    "status": cts.get("conversionTrackingStatus") or "UNKNOWN",
                    "trackingId": str(cts.get("conversionTrackingId") or ""),
                    "crossAccountId": str(cts.get("crossAccountConversionTrackingId") or ""),
                    "enhancedLeads": bool(cts.get("enhancedConversionsForLeadsEnabled")),
                })
        except F.ApiError as exc:
            cfg_row["status"] = f"ERREUR ({exc})"

        try:
            acts = F.ads_search(cfg, token, account["id"], Q_ACTIONS)
            enabled = [(r.get("conversionAction") or {}) for r in acts]
            cfg_row["actionsEnabled"] = len(enabled)
            cfg_row["actionsPrimary"] = sum(1 for a in enabled if a.get("primaryForGoal"))
            cfg_row["actionsCounted"] = sum(1 for a in enabled
                                            if a.get("includeInConversionsMetric"))
            cfg_row["actionsUpload"] = sum(1 for a in enabled
                                           if (a.get("type") or "").startswith("UPLOAD"))
        except F.ApiError:
            cfg_row["actionsEnabled"] = None
        configs.append(cfg_row)

        # ── Retard de conversion ─────────────────────────────────────────────
        try:
            for r in F.ads_search(cfg, token, account["id"], Q_LAG.format(start=start, end=end)):
                seg = r.get("segments") or {}
                bucket = seg.get("conversionLagBucket")
                month = seg.get("month")
                v = F.to_float((r.get("metrics") or {}).get("allConversions"))
                if not bucket or not month or not v:
                    continue
                month_set.add(month)
                lag_rows.append([month, ai, bucket, round(v, 2)])
        except F.ApiError as exc:
            print(f"[lag: {exc}]", end=" ")

        # ── Marché par campagne ──────────────────────────────────────────────
        # ── Marché réel, par jour ────────────────────────────────────────────
        try:
            for r in F.ads_search(cfg, token, account["id"],
                                  Q_MARKET.format(start=start, end=end)):
                m = r.get("metrics") or {}
                d = (r.get("segments") or {}).get("date")
                gid = str((r.get("geographicView") or {}).get("countryCriterionId") or "")
                if not d or not gid:
                    continue
                geo_ids.add(gid)
                key = (d, ai, gid)
                b = geo_daily.get(key)
                if b is None:
                    b = geo_daily[key] = [0, 0.0, 0.0, 0.0, 0.0]
                b[0] += F.to_int(m.get("clicks"))
                b[1] += F.to_int(m.get("costMicros")) / 1e6
                b[2] += F.to_float(m.get("conversions"))
                b[3] += F.to_float(m.get("allConversions"))
                b[4] += F.to_float(m.get("conversionsValue"))
        except F.ApiError as exc:
            print(f"[marchés: {exc}]", end=" ")

        # ── Journal des changements Google Ads ───────────────────────────────
        try:
            seen_authors: set = set()
            for r in F.ads_search(cfg, token, account["id"],
                                  Q_CHANGES.format(cstart=change_start, cend=end)):
                ev = r.get("changeEvent") or {}
                stamp = ev.get("changeDateTime") or ""
                d = stamp[:10].replace("/", "-")
                if not d:
                    continue
                # L'auteur est compté, jamais écrit : voir l'avertissement en
                # tête de fichier.
                if ev.get("userEmail"):
                    seen_authors.add(ev["userEmail"])
                changes.append([
                    d, ai,
                    ev.get("changeResourceType") or "UNKNOWN",
                    ev.get("resourceChangeOperation") or "UNKNOWN",
                    ev.get("clientType") or "UNKNOWN",
                    ev.get("changedFields") or "",
                ])
            change_authors[ai] = seen_authors
        except F.ApiError as exc:
            print(f"[changements: {exc}]", end=" ")

        print("ok")

    if not daily:
        F.die("Aucune donnée quotidienne récupérée.")

    # ── Résolution des marchés ────────────────────────────────────────────────
    print(f"\nRésolution de {len(geo_ids)} cible(s) géographique(s)…")
    ref_cid = accounts[0]["id"]
    countries = resolve_countries(cfg, token, ref_cid, geo_ids)

    market_idx = Indexer()
    market_daily: dict[tuple, list] = {}
    unmapped_cost = 0.0
    for (d, ai, gid), b in geo_daily.items():
        code = countries.get(gid)
        if not code:
            # Un identifiant de pays non résolu garde sa dépense sous une clé
            # explicite : la fondre dans un autre pays serait une invention.
            code = "?"
            unmapped_cost += b[1]
        mi = market_idx.get(code)
        key = (d, ai, mi)
        slot = market_daily.get(key)
        if slot is None:
            slot = market_daily[key] = [0, 0.0, 0.0, 0.0, 0.0]
        for j in range(5):
            slot[j] += b[j]

    # ── Indexation finale ─────────────────────────────────────────────────────
    dates = sorted(date_set)
    dpos = {d: i for i, d in enumerate(dates)}
    months = sorted(month_set)
    mpos = {m: i for i, m in enumerate(months)}

    lag_group_of = {}
    for gi, (_, members) in enumerate(LAG_GROUPS):
        for b in members:
            lag_group_of[b] = gi
    unknown_buckets = sorted({b for _, _, b, _ in lag_rows if b not in lag_group_of})

    lag_out: dict[tuple, float] = {}
    for month, ai, bucket, v in lag_rows:
        gi = lag_group_of.get(bucket)
        if gi is None:
            continue
        key = (mpos[month], ai, gi)
        lag_out[key] = lag_out.get(key, 0.0) + v

    change_out: dict[tuple, int] = {}
    for d, ai, rtype, op, client, _fields in changes:
        if d not in dpos:
            continue
        key = (dpos[d], ai, rtype, op, client)
        change_out[key] = change_out.get(key, 0) + 1

    currency, _rates = F.resolve_currency(accounts, cfg)

    payload = {
        "meta": {
            "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "date_start": start,
            "date_end": end,
            "days": args.days,
            "currency": currency,
            "accounts_scanned": len(accounts),
            "accounts_with_data": len(acc_idx.values),
            "change_window_days": CHANGE_MAX_DAYS,
            "change_start": change_start,
            "change_authors": {str(k): len(v) for k, v in change_authors.items()},
            "unmapped_market_cost": round(unmapped_cost, 2),
            "unknown_lag_buckets": unknown_buckets,
            "failures": [{"account": a, "error": e} for a, e in failures],
            # Dit noir sur blanc dans le fichier, pour qu'aucune relecture du
            # JSON ne laisse croire que ces champs manquent par oubli.
            "absent_from_api": [
                "Consent Mode granted/denied — aucun champ (%consent% : 0 résultat)",
                "conversions modélisées vs observées — aucun champ (%model%led% : 0)",
            ],
        },
        "accounts": acc_idx.values,
        "actions": action_idx.values,
        "dates": dates,
        "months": months,
        "lagGroups": [g[0] for g in LAG_GROUPS],
        "markets": market_idx.values,
        "marketLabels": {c: MARKET_LABELS.get(c, c) for c in market_idx.values},
        # [dateIdx, accIdx, impr, clicks, cost, conv, allConv, value]
        "daily": [[dpos[d], ai, *rest] for d, ai, *rest in daily],
        # [dateIdx, accIdx, actionIdx, conv, allConv, value]
        "series": [[dpos[d], ai, act, *rest] for d, ai, act, *rest in series],
        # [monthIdx, accIdx, lagGroupIdx, allConv]
        "lag": [[k[0], k[1], k[2], round(v, 2)] for k, v in sorted(lag_out.items())],
        # [dateIdx, accIdx, marketIdx, clicks, cost, conv, allConv, value]
        "market": [[dpos[d], ai, mi,
                    v[0], round(v[1], 2), round(v[2], 2), round(v[3], 2), round(v[4], 2)]
                   for (d, ai, mi), v in sorted(market_daily.items()) if d in dpos],
        # [dateIdx, accIdx, resourceType, operation, clientType, count]
        "changes": [[k[0], k[1], k[2], k[3], k[4], v]
                    for k, v in sorted(change_out.items())],
        "config": configs,
    }

    out = Path(args.out) if args.out else PROJECT_DIR / "data" / "tracking.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")

    print(f"\nÉcrit {out} ({out.stat().st_size / 1024:.0f} Ko)")
    print(f"  {len(acc_idx.values)} compte(s) actif(s) · {len(action_idx.values)} action(s) "
          f"de conversion · {len(dates)} jour(s)")
    print(f"  quotidien {len(payload['daily'])} · séries {len(payload['series'])} · "
          f"marchés {len(payload['market'])} · retard {len(payload['lag'])} · "
          f"changements {len(payload['changes'])}")
    print(f"  marchés vus : {', '.join(market_idx.values) or '—'}")
    if unmapped_cost:
        print(f"  {unmapped_cost:,.0f} {currency} sans marché résolu (campagnes sans "
              f"ciblage géographique lisible)")
    if unknown_buckets:
        print(f"  paliers de retard inconnus, ignorés : {', '.join(unknown_buckets)}")
    if failures:
        print(f"  {len(failures)} échec(s) de compte")


if __name__ == "__main__":
    main()
