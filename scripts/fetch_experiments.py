#!/usr/bin/env python3
"""
Récupère les A/B tests Google Ads et produit data/experiments.json.

    python scripts/fetch_experiments.py
    python scripts/fetch_experiments.py --window 120

CE QUE L'API DONNE
------------------
`experiment` et `experiment_arm` existent et répondent. Chaque expérience porte un
type, un statut, des dates, et deux bras — un témoin, une variante — chacun
rattaché à une campagne et portant sa part de trafic. On peut donc reconstituer un
test complet et comparer les deux côtés sur les mêmes métriques.

« ENABLED » NE VEUT PAS DIRE « EN COURS »
----------------------------------------
Sur ce MCC, 385 expériences sont enregistrées et 43 portent le statut ENABLED —
dont certaines se terminaient en 2022. D'autres sont INITIATED depuis 2018 avec une
date de fin au 31/12/2037. Le statut seul ne dit donc rien : une expérience est
« en cours » si son statut est actif ET que sa fenêtre de dates couvre aujourd'hui.

Deux dates sentinelles à traduire, sinon l'affichage devient absurde :
  · 1970-01-01 → date de début non définie (brouillon jamais lancé)
  · 2037-12-31 → pas de fin programmée

Le reste — statut actif mais fenêtre passée, ou brouillon jamais lancé — est
classé « abandonnée ». Ce n'est pas un jugement : c'est ce que disent les dates,
et ces reliquats encombrent les comptes.

MESURE
------
Pour les expériences récentes, les métriques quotidiennes de chaque campagne de
bras sont collectées sur la fenêtre du test. Le dashboard en tire la comparaison
témoin / variante et un indice de confiance — calculé sur le taux de conversion,
avec les réserves que cela impose (voir le README).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

import fetch_ads_data as F  # noqa: E402

Q_EXP = """
    SELECT experiment.resource_name, experiment.experiment_id, experiment.name,
           experiment.description, experiment.suffix, experiment.type,
           experiment.status, experiment.start_date, experiment.end_date,
           experiment.sync_enabled, experiment.promote_status
    FROM experiment
"""

Q_ARM = """
    SELECT experiment_arm.resource_name, experiment_arm.experiment,
           experiment_arm.name, experiment_arm.control, experiment_arm.traffic_split,
           experiment_arm.campaigns, experiment_arm.in_design_campaigns
    FROM experiment_arm
"""

Q_CAMPAIGNS = """
    SELECT campaign.id, campaign.name, campaign.status, campaign.experiment_type,
           campaign.advertising_channel_type
    FROM campaign
"""

Q_METRICS = """
    SELECT campaign.id, segments.date,
           metrics.impressions, metrics.clicks, metrics.cost_micros,
           metrics.conversions, metrics.all_conversions, metrics.conversions_value
    FROM campaign
    WHERE campaign.id IN ({ids})
      AND segments.date BETWEEN '{start}' AND '{end}'
"""

STATUS_FR = {
    "ENABLED": "active", "SETUP": "brouillon", "INITIATED": "initialisée",
    "GRADUATED": "diplômée", "PROMOTED": "promue", "HALTED": "arrêtée",
    "REMOVED": "supprimée", "UNKNOWN": "inconnu", "UNSPECIFIED": "non renseigné",
}

TYPE_FR = {
    "SEARCH_CUSTOM": "Search personnalisée",
    "DISPLAY_CUSTOM": "Display personnalisée",
    "AD_VARIATION": "Variante d'annonce",
    "SEARCH_AUTOMATED_BIDDING_STRATEGY": "Enchères Search",
    "DISPLAY_AUTOMATED_BIDDING_STRATEGY": "Enchères Display",
    "SHOPPING_AUTOMATED_BIDDING_STRATEGY": "Enchères Shopping",
    "COMPARE_CAMPAIGNS": "Comparaison de campagnes",
    "ADOPT_AI_MAX": "Adoption AI Max",
    "ADOPT_BROAD_MATCH_KEYWORDS": "Adoption du large",
    "OPTIMIZE_ASSETS": "Optimisation d'assets",
    "PMAX_REPLACEMENT_SHOPPING": "Remplacement PMax",
    "PMAX_TEXT_CUSTOMIZATION_FINAL_URL_EXPANSION": "PMax texte / URL",
    "HOTEL_CUSTOM": "Hôtel", "DISPLAY_AND_VIDEO_360": "DV360",
}

# Statuts que Google considère comme non terminaux.
ACTIVE_STATUS = {"ENABLED", "INITIATED", "SETUP"}

SENTINEL_START = "1970-01-01"
SENTINEL_END = "2037-12-31"


def norm_date(raw) -> str | None:
    """Sentinelles ramenées à None : les afficher ferait croire à un test lancé
    en 1970 et courant jusqu'en 2037."""
    s = str(raw or "").strip()[:10]
    if not s or s in (SENTINEL_START, SENTINEL_END) or s.startswith("1970"):
        return None
    return s


def classify(status: str, start: str | None, end: str | None, today: str) -> str:
    """Où en est le test, d'après le statut ET les dates.

    Seul ENABLED signifie qu'une expérience diffuse. INITIATED veut dire que le
    brouillon a été appliqué sans que le test soit lancé — sur ce MCC, quinze
    expériences sont INITIATED depuis 2018 ou 2019 avec une date de fin
    sentinelle au 31/12/2037. Les compter comme « en cours » remplissait la page
    de tests morts et noyait les trois qui tournent vraiment.
    """
    if status in ("PROMOTED", "GRADUATED"):
        return "promue"
    if status == "HALTED":
        return "arretee"
    if status == "REMOVED":
        return "supprimee"
    if status == "SETUP":
        # Brouillon : la date de début n'a pas de sens tant qu'il n'est pas lancé.
        return "brouillon"
    if status == "INITIATED":
        if start is None or start > today:
            return "programmee"
        # Initié il y a longtemps et jamais passé en ENABLED : resté en plan.
        return "abandonnee"
    if status == "ENABLED":
        if start is None:
            return "abandonnee"
        if start > today:
            return "programmee"
        if end is not None and end < today:
            return "abandonnee"          # actif mais fenêtre passée
        return "en_cours"
    return "inconnue"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="A/B tests Google Ads.")
    p.add_argument("--window", type=int, default=120,
                   help="profondeur maximale des métriques, en jours (défaut : 120)")
    p.add_argument("--accounts", default=None, help="CID séparés par des virgules")
    p.add_argument("--config", default=None)
    p.add_argument("--out", default=None)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    cfg = F.load_config(args.config)
    today = dt.date.today()
    today_s = today.isoformat()
    floor = (today - dt.timedelta(days=args.window - 1)).isoformat()

    token = F.get_access_token(cfg)
    accounts = F.list_child_accounts(cfg, token)
    if args.accounts:
        wanted = {F.digits_only(a) for a in args.accounts.split(",") if a.strip()}
        accounts = [a for a in accounts if a["id"] in wanted]
    if not accounts:
        F.die("Aucun compte client actif à interroger.")

    currency, _ = F.resolve_currency(accounts, cfg)
    experiments: list[dict] = []
    failures: list[tuple[str, str]] = []

    for i, account in enumerate(accounts, 1):
        label = f"{account['name']} ({F.fmt_cid(account['id'])})"
        try:
            rows = F.ads_search(cfg, token, account["id"], Q_EXP)
        except F.ApiError as exc:
            if exc.is_version_error:
                F.die(f"L'API refuse la version {F.API_VERSION} : {exc}")
            failures.append((label, str(exc)))
            continue
        if not rows:
            continue

        print(f"[{i}/{len(accounts)}] {label} — {len(rows)} expérience(s)")

        # Bras, indexés par expérience.
        arms_by_exp: dict[str, list[dict]] = {}
        try:
            for r in F.ads_search(cfg, token, account["id"], Q_ARM):
                a = r.get("experimentArm") or {}
                exp = a.get("experiment") or ""
                camps = [c.rsplit("/", 1)[-1] for c in (a.get("campaigns") or [])]
                design = [c.rsplit("/", 1)[-1] for c in (a.get("inDesignCampaigns") or [])]
                arms_by_exp.setdefault(exp, []).append({
                    "name": a.get("name") or "",
                    "control": bool(a.get("control")),
                    "split": F.to_int(a.get("trafficSplit")) or None,
                    "campaigns": camps,
                    "design": design,
                })
        except F.ApiError as exc:
            print(f"    bras indisponibles ({exc})")

        # Noms de campagnes du compte, pour nommer les bras.
        camp_name: dict[str, dict] = {}
        try:
            for r in F.ads_search(cfg, token, account["id"], Q_CAMPAIGNS):
                c = r.get("campaign") or {}
                cid = str(c.get("id") or "")
                if cid:
                    camp_name[cid] = {
                        "name": c.get("name") or "?",
                        "status": c.get("status") or "?",
                        "experimentType": c.get("experimentType") or "BASE",
                    }
        except F.ApiError:
            pass

        for r in rows:
            e = r.get("experiment") or {}
            res = e.get("resourceName") or ""
            start = norm_date(e.get("startDate"))
            end = norm_date(e.get("endDate"))
            status = e.get("status") or "UNKNOWN"
            phase = classify(status, start, end, today_s)
            arms = arms_by_exp.get(res, [])
            for a in arms:
                a["campaignNames"] = [camp_name.get(c, {}).get("name", c) for c in a["campaigns"]]
            experiments.append({
                "account": account["name"],
                "cid": F.fmt_cid(account["id"]),
                "id": str(e.get("experimentId") or ""),
                "name": e.get("name") or "(sans nom)",
                "description": e.get("description") or "",
                "suffix": e.get("suffix") or "",
                "type": e.get("type") or "UNKNOWN",
                "typeLabel": TYPE_FR.get(e.get("type") or "", e.get("type") or "?"),
                "status": status,
                "statusLabel": STATUS_FR.get(status, status),
                "phase": phase,
                "start": start,
                "end": end,
                "endOpen": str(e.get("endDate") or "").startswith("2037"),
                "arms": arms,
            })

    if not experiments:
        F.die("Aucune expérience trouvée sur le périmètre.")

    # ── Métriques des bras, pour les tests qui valent la peine d'être mesurés ──
    measurable = [x for x in experiments
                  if x["phase"] in ("en_cours", "promue", "arretee")
                  and x["start"] and (x["end"] or today_s) >= floor]
    print(f"\nMétriques de {len(measurable)} expérience(s) mesurable(s) "
          f"(fenêtre plafonnée à {args.window} jours)")

    by_account: dict[str, list[dict]] = {}
    for x in measurable:
        by_account.setdefault(x["cid"], []).append(x)

    cid_of_label = {F.fmt_cid(a["id"]): a["id"] for a in accounts}
    for cid, items in by_account.items():
        ids = sorted({c for x in items for a in x["arms"] for c in a["campaigns"]})
        if not ids:
            continue
        lo = max(floor, min(x["start"] for x in items))
        hi = today_s
        try:
            rows = F.ads_search(cfg, token, cid_of_label[cid], Q_METRICS.format(
                ids=",".join(ids), start=lo, end=hi))
        except F.ApiError as exc:
            print(f"  {cid} : métriques refusées ({exc})")
            continue
        daily: dict[str, dict[str, list]] = {}
        for r in rows:
            c = str((r.get("campaign") or {}).get("id") or "")
            d = (r.get("segments") or {}).get("date")
            m = r.get("metrics") or {}
            if not c or not d:
                continue
            slot = daily.setdefault(c, {})
            slot[d] = [
                F.to_int(m.get("impressions")), F.to_int(m.get("clicks")),
                round(F.to_int(m.get("costMicros")) / 1e6, 2),
                round(F.to_float(m.get("conversions")), 2),
                round(F.to_float(m.get("allConversions")), 2),
                round(F.to_float(m.get("conversionsValue")), 2),
            ]
        for x in items:
            for a in x["arms"]:
                series = {}
                for c in a["campaigns"]:
                    for d, v in (daily.get(c) or {}).items():
                        # Un bras peut porter plusieurs campagnes : on additionne.
                        if d not in series:
                            series[d] = [0, 0, 0.0, 0.0, 0.0, 0.0]
                        for k in range(6):
                            series[d][k] += v[k]
                # Bornées à la fenêtre du test : au-delà, ce n'est plus le test.
                lo_x = x["start"]
                hi_x = x["end"] or today_s
                a["daily"] = [[d] + [round(v, 2) if isinstance(v, float) else v
                                     for v in series[d]]
                              for d in sorted(series) if lo_x <= d <= hi_x]

    phases: dict[str, int] = {}
    for x in experiments:
        phases[x["phase"]] = phases.get(x["phase"], 0) + 1

    payload = {
        "meta": {
            "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "today": today_s,
            "currency": currency,
            "window_days": args.window,
            "accounts_scanned": len(accounts),
            "experiments": len(experiments),
            "measured": len(measurable),
            "phases": phases,
            "failures": [{"account": a, "error": e} for a, e in failures],
        },
        # [date, impr, clics, coût, conv, allConv, valeur] dans arms[].daily
        "experiments": experiments,
    }

    out = Path(args.out) if args.out else PROJECT_DIR / "data" / "experiments.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")

    print(f"\nÉcrit {out} ({out.stat().st_size / 1024:.0f} Ko)")
    print(f"  {len(experiments)} expérience(s) sur {len(accounts)} compte(s)")
    ORDER = ["en_cours", "programmee", "brouillon", "promue", "arretee",
             "abandonnee", "supprimee", "inconnue"]
    LABELS = {"en_cours": "en cours", "programmee": "programmée",
              "brouillon": "brouillon", "promue": "promue",
              "arretee": "arrêtée", "abandonnee": "abandonnée",
              "supprimee": "supprimée", "inconnue": "indéterminée"}
    for k in ORDER:
        if phases.get(k):
            print(f"  {LABELS[k]:<14} {phases[k]}")
    for x in experiments:
        if x["phase"] == "en_cours":
            arms = " vs ".join(
                f"{'témoin' if a['control'] else 'variante'} "
                f"{(a['campaignNames'] or ['?'])[0][:34]}" for a in x["arms"])
            print(f"    → {x['account'][:26]:<28} {x['name'][:34]:<36} "
                  f"{x['start']} → {x['end'] or 'sans fin'}  {arms}")
    if failures:
        print(f"  {len(failures)} échec(s) de compte")


if __name__ == "__main__":
    main()
