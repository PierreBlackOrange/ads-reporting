#!/usr/bin/env python3
"""
Récupère la journée en cours, heure par heure, et la compare au même jour de la
semaine précédente. Produit data/live.json pour l'onglet Live.

    python scripts/fetch_live.py
    python scripts/fetch_live.py --accounts 3384610932,9875320091

Aucune dépendance.

LE DÉLAI DE CONSOLIDATION, MESURÉ AVANT D'ÊTRE CONTOURNÉ
--------------------------------------------------------
Les conversions n'apparaissent pas à l'heure où elles surviennent : Google les
rattache à l'heure du clic et les remonte avec retard. Relevé sur le compte
principal à 11h :

    heure         0h   1h   2h   3h   4h   5h .. 10h  11h
    conversions  4.0  3.2  1.0  5.0  3.0  0.0 ..  0.0  0.0
    la veille    7.0  2.0  1.3  2.0  2.0  0.3 ..  2.0  6.7

La veille et J-7 ont des conversions sur les 24 heures ; le trou de sept heures
du jour est donc du retard, pas une absence. Une alerte « aucune conversion sur
la dernière heure » sonnerait en permanence.

Deux conséquences dans ce script :
  - on privilégie all_conversions, dont le retard est bien moindre
    (données jusqu'à 10h contre 4h pour conversions) ;
  - les dernières heures sont marquées « en consolidation » et exclues de
    l'alerte. La frontière n'est pas codée en dur : elle se déduit du rapport
    entre le jour courant et la même heure la semaine précédente.

Le coût, lui, remonte quasiment en temps réel : la comparaison de dépense
heure par heure est fiable dès l'heure en cours.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

import fetch_ads_data as F  # noqa: E402

# Coût et volume : sûrs dès l'heure en cours.
HOURLY_QUERY = """
    SELECT
      segments.hour,
      campaign.id,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.all_conversions,
      metrics.all_conversions_value
    FROM campaign
    WHERE segments.date = '{date}'
"""

# Requête séparée pour les actions de conversion : la segmentation par action
# duplique la ligne de coût une fois par action, et sommer donnerait une dépense
# fantaisiste. Ici on ne lit QUE des métriques de conversion.
ACTIONS_QUERY = """
    SELECT
      segments.hour,
      segments.conversion_action_name,
      metrics.all_conversions,
      metrics.all_conversions_value
    FROM campaign
    WHERE segments.date = '{date}'
"""

# En deçà, comparer un rapport n'a pas de sens : le bruit domine.
MIN_REF_CONV = 3.0
# Une heure dont le volume atteint cette part de la référence est considérée
# comme consolidée. Volontairement bas : on préfère déclarer « en cours » une
# heure déjà complète que l'inverse, qui produirait une fausse alerte.
SETTLED_RATIO = 0.55
MAX_LAG_HOURS = 12


def fetch_day(cfg, token, accounts, date, query):
    """Agrège une requête horaire sur plusieurs comptes."""
    out = []
    for acc in accounts:
        try:
            rows = F.ads_search(cfg, token, acc["id"], query.format(date=date))
        except F.ApiError as exc:
            if exc.is_version_error:
                F.die(f"L'API refuse la version {F.API_VERSION} : {exc}")
            print(f"    {acc['name']} : ÉCHEC ({exc})")
            continue
        for r in rows:
            r["_account"] = acc["name"]
        out.extend(rows)
    return out


def blank_hours():
    return [0.0] * 24


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Récupère la journée en cours heure par heure pour l'onglet Live."
    )
    parser.add_argument("--accounts", help="IDs clients séparés par des virgules")
    parser.add_argument("--config")
    parser.add_argument("--out", default=str(PROJECT_DIR / "data" / "live.json"))
    args = parser.parse_args()

    cfg = F.load_config(args.config)
    token = F.get_access_token(cfg)
    accounts = F.list_child_accounts(cfg, token)

    if args.accounts:
        wanted = {F.digits_only(a) for a in args.accounts.split(",") if a.strip()}
        accounts = [a for a in accounts if a["id"] in wanted]
    if not accounts:
        F.die("Aucun compte à interroger.")

    # Google Ads rapporte dans le fuseau du compte : « l'heure en cours » doit
    # être lue là-bas, pas sur la machine qui lance le script.
    #
    # Windows ne fournit pas la base IANA, et zoneinfo exige alors le paquet
    # tzdata. Plutôt que d'imposer une dépendance à un script qui n'en a aucune,
    # on retombe sur l'heure locale — mais jamais silencieusement : l'écart
    # décalerait toutes les heures du rapport, et l'alerte avec.
    tz_name = accounts[0].get("time_zone") or ""
    tz_warning = None
    now = None
    if tz_name:
        try:
            now = dt.datetime.now(ZoneInfo(tz_name))
        except Exception:
            tz_warning = (
                f"Fuseau du compte « {tz_name} » non résolu sur cette machine "
                f"(base IANA absente — « pip install tzdata » la fournit). "
                f"L'heure locale de la machine est utilisée à la place : si les deux "
                f"fuseaux diffèrent, toutes les heures de ce rapport sont décalées."
            )
    if now is None:
        now = dt.datetime.now().astimezone()
        if not tz_name:
            tz_warning = ("Fuseau du compte inconnu ; heure locale de la machine "
                          "utilisée à la place.")
        tz_name = tz_name or str(now.tzinfo)
    today = now.date()
    ref_day = today - dt.timedelta(days=7)
    current_hour = now.hour

    print(f"\nFuseau des comptes : {tz_name} — il est {now:%H:%M}")
    if tz_warning:
        print(f"  ATTENTION — {tz_warning}")
    print(f"Jour courant : {today}   Référence : {ref_day} (même jour, semaine précédente)")
    print(f"{len(accounts)} compte(s)")

    print("\nJournée en cours…")
    rows_today = fetch_day(cfg, token, accounts, today, HOURLY_QUERY)
    print(f"  {len(rows_today)} ligne(s)")
    print("Semaine précédente…")
    rows_ref = fetch_day(cfg, token, accounts, ref_day, HOURLY_QUERY)
    print(f"  {len(rows_ref)} ligne(s)")
    print("Actions de conversion…")
    acts_today = fetch_day(cfg, token, accounts, today, ACTIONS_QUERY)
    acts_ref = fetch_day(cfg, token, accounts, ref_day, ACTIONS_QUERY)
    print(f"  {len(acts_today)} + {len(acts_ref)} ligne(s)")

    def aggregate(rows):
        """→ (totaux horaires, {campagne: {compte, coût horaire, conv horaires}})"""
        hourly = {k: blank_hours() for k in
                  ("impr", "clicks", "cost", "conv", "allconv", "value")}
        camps: dict[str, dict] = {}
        for r in rows:
            h = int(r["segments"]["hour"])
            m = r.get("metrics", {})
            cost = int(m.get("costMicros") or 0) / 1_000_000
            clicks = F.to_int(m.get("clicks"))
            impr = F.to_int(m.get("impressions"))
            conv = F.to_float(m.get("conversions"))
            allc = F.to_float(m.get("allConversions"))
            val = F.to_float(m.get("allConversionsValue"))

            hourly["impr"][h] += impr
            hourly["clicks"][h] += clicks
            hourly["cost"][h] += cost
            hourly["conv"][h] += conv
            hourly["allconv"][h] += allc
            hourly["value"][h] += val

            name = (r.get("campaign") or {}).get("name") or "(sans nom)"
            c = camps.get(name)
            if c is None:
                c = camps[name] = {"account": r.get("_account", ""),
                                   "cost": blank_hours(), "allconv": blank_hours()}
            c["cost"][h] += cost
            c["allconv"][h] += allc
        return hourly, camps

    today_h, today_c = aggregate(rows_today)
    ref_h, ref_c = aggregate(rows_ref)

    def aggregate_actions(rows):
        acts: dict[str, list] = {}
        for r in rows:
            h = int(r["segments"]["hour"])
            name = r["segments"].get("conversionActionName") or "(sans nom)"
            m = r.get("metrics", {})
            a = acts.get(name)
            if a is None:
                a = acts[name] = [blank_hours(), 0.0]
            a[0][h] += F.to_float(m.get("allConversions"))
            a[1] += F.to_float(m.get("allConversionsValue"))
        return acts

    at, ar = aggregate_actions(acts_today), aggregate_actions(acts_ref)

    # ── Frontière de consolidation ───────────────────────────────────────────
    # On remonte depuis l'heure en cours tant que le volume du jour reste très
    # en deçà de la même heure de référence. La première heure qui tient la
    # comparaison marque la fin de la zone incertaine.
    settled_through = -1
    for h in range(current_hour, -1, -1):
        ref = ref_h["allconv"][h]
        cur = today_h["allconv"][h]
        if ref < MIN_REF_CONV:
            continue          # référence trop faible pour conclure
        if cur >= ref * SETTLED_RATIO:
            settled_through = h
            break
        if current_hour - h >= MAX_LAG_HOURS:
            break
    lag_hours = max(0, current_hour - settled_through) if settled_through >= 0 else None

    # ── Alerte ───────────────────────────────────────────────────────────────
    # Évaluée uniquement sur la dernière heure consolidée : c'est la plus
    # récente sur laquelle un zéro veut dire quelque chose.
    alert = None
    if settled_through >= 0:
        h = settled_through
        cur = today_h["allconv"][h]
        ref = ref_h["allconv"][h]
        if cur <= 0 and ref >= MIN_REF_CONV:
            alert = {"level": "alerte", "hour": h, "current": 0.0, "reference": round(ref, 1)}
        elif ref >= MIN_REF_CONV and cur < ref * 0.5:
            alert = {"level": "vigilance", "hour": h,
                     "current": round(cur, 1), "reference": round(ref, 1)}

    # ── Comparaison à heure égale ────────────────────────────────────────────
    # Cumul jusqu'à l'heure en cours des deux côtés : comparer une journée
    # partielle à une journée complète n'aurait aucun sens.
    def htd(series):
        return round(sum(series[: current_hour + 1]), 2)

    totals = {
        k: {"today": htd(today_h[k]), "ref": htd(ref_h[k])}
        for k in ("impr", "clicks", "cost", "conv", "allconv", "value")
    }

    # Campagnes : les plus gros écarts de dépense, en absolu.
    camp_rows = []
    for name in set(today_c) | set(ref_c):
        tc = today_c.get(name, {"cost": blank_hours(), "allconv": blank_hours(), "account": ""})
        rc = ref_c.get(name, {"cost": blank_hours(), "allconv": blank_hours(), "account": ""})
        ct, cr = htd(tc["cost"]), htd(rc["cost"])
        vt, vr = htd(tc["allconv"]), htd(rc["allconv"])
        if ct <= 0 and cr <= 0:
            continue
        camp_rows.append([
            name, tc["account"] or rc["account"],
            ct, cr, round(vt, 2), round(vr, 2),
        ])
    camp_rows.sort(key=lambda r: -abs(r[2] - r[3]))
    camp_rows = camp_rows[:40]

    action_rows = []
    for name in set(at) | set(ar):
        t_h = at.get(name, [blank_hours(), 0.0])
        r_h = ar.get(name, [blank_hours(), 0.0])
        tt, rr = htd(t_h[0]), htd(r_h[0])
        if tt <= 0 and rr <= 0:
            continue
        action_rows.append([name, round(tt, 2), round(rr, 2),
                            [round(v, 2) for v in t_h[0]]])
    action_rows.sort(key=lambda r: -r[1])

    dataset = {
        "meta": {
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "timezone": tz_name,
            "timezone_warning": tz_warning,
            "local_time": now.isoformat(timespec="minutes"),
            "date": today.isoformat(),
            "reference_date": ref_day.isoformat(),
            "current_hour": current_hour,
            "settled_through": settled_through,
            "lag_hours": lag_hours,
            "currency": cfg.get("report_currency") or "EUR",
            "accounts": [a["name"] for a in accounts],
        },
        "hours": list(range(24)),
        "today": {k: [round(v, 2) for v in today_h[k]] for k in today_h},
        "reference": {k: [round(v, 2) for v in ref_h[k]] for k in ref_h},
        "totals": totals,
        "campaigns": camp_rows,
        "actions": action_rows,
        "alert": alert,
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(dataset, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")

    cur = totals["cost"]["today"]
    ref = totals["cost"]["ref"]
    delta = ((cur - ref) / ref * 100) if ref else 0.0
    print(f"\nÉcrit : {out}  ({out.stat().st_size / 1024:,.0f} Ko)")
    print(f"  dépense à {current_hour}h : {cur:,.0f} contre {ref:,.0f} il y a 7 jours "
          f"({delta:+.1f} %)")
    print(f"  conversions (all) : {totals['allconv']['today']:,.1f} "
          f"contre {totals['allconv']['ref']:,.1f}")
    if settled_through >= 0:
        print(f"  consolidé jusqu'à {settled_through}h — les {lag_hours} dernière(s) "
              f"heure(s) sont encore en cours de remontée")
    else:
        print("  aucune heure consolidée : référence trop faible pour conclure")
    print(f"  alerte : {alert['level'] if alert else 'aucune'}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrompu.", file=sys.stderr)
        raise SystemExit(130)
