#!/usr/bin/env python3
"""
Récupère les performances Google Ads d'un MCC (tous les comptes enfants)
et écrit un fichier data.json consommé par le dashboard.

Aucune dépendance externe : urllib de la stdlib uniquement.

Usage
-----
    python scripts/fetch_ads_data.py                     # 180 derniers jours
    python scripts/fetch_ads_data.py --days 90
    python scripts/fetch_ads_data.py --start 2026-01-01 --end 2026-06-30
    python scripts/fetch_ads_data.py --accounts 1234567890,9876543210
    python scripts/fetch_ads_data.py --out data/data.json

Configuration
-------------
Les identifiants sont lus depuis scripts/config.json (jamais commité) ou,
à défaut, depuis les variables d'environnement :

    GOOGLE_ADS_DEVELOPER_TOKEN
    GOOGLE_ADS_CLIENT_ID
    GOOGLE_ADS_CLIENT_SECRET
    GOOGLE_ADS_REFRESH_TOKEN
    GOOGLE_ADS_LOGIN_CUSTOMER_ID     # l'ID du MCC, chiffres uniquement

Voir scripts/config.example.json et le README pour l'obtention du
refresh token.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# ── Constantes ────────────────────────────────────────────────────────────────

API_VERSION = "v21"  # si Google sunsette cette version, changez ce seul champ
ADS_ENDPOINT = "https://googleads.googleapis.com/{v}/customers/{cid}/googleAds:searchStream"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent

CONFIG_KEYS = (
    "developer_token",
    "client_id",
    "client_secret",
    "refresh_token",
    "login_customer_id",
)

MAX_RETRIES = 4
RETRY_BACKOFF = 2.0  # secondes, doublé à chaque tentative


# ── Configuration ────────────────────────────────────────────────────────────


def load_config() -> dict:
    """config.json en priorité, puis variables d'environnement."""
    cfg: dict = {}
    cfg_path = SCRIPT_DIR / "config.json"
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            die(f"scripts/config.json est illisible (JSON invalide) : {exc}")

    for key in CONFIG_KEYS:
        if not cfg.get(key):
            env_val = os.environ.get(f"GOOGLE_ADS_{key.upper()}")
            if env_val:
                cfg[key] = env_val

    missing = [k for k in CONFIG_KEYS if not cfg.get(k)]
    if missing:
        die(
            "Identifiants manquants : " + ", ".join(missing) + "\n\n"
            "Créez scripts/config.json à partir de scripts/config.example.json,\n"
            "ou exportez les variables GOOGLE_ADS_* correspondantes.\n"
            "Le README détaille la procédure d'obtention du refresh token."
        )

    # Les IDs Google Ads sont manipulés sans tirets côté API.
    cfg["login_customer_id"] = digits_only(cfg["login_customer_id"])

    # Normalisation devise : optionnel, permet d'agréger un MCC multi-devises.
    cfg.setdefault("report_currency", None)
    cfg.setdefault("currency_rates", {})
    return cfg


def digits_only(value: str) -> str:
    return "".join(ch for ch in str(value) if ch.isdigit())


def die(message: str, code: int = 1) -> "NoReturn":  # type: ignore[valid-type]
    print(f"\nErreur : {message}", file=sys.stderr)
    raise SystemExit(code)


# ── Couche HTTP ──────────────────────────────────────────────────────────────


def http_post_json(url: str, payload: dict | None, headers: dict, *, form: dict | None = None) -> dict | list:
    """POST avec retry sur erreurs transitoires. Retourne le JSON décodé."""
    if form is not None:
        body = urllib.parse.urlencode(form).encode("utf-8")
        headers = {**headers, "Content-Type": "application/x-www-form-urlencoded"}
    else:
        body = json.dumps(payload).encode("utf-8")
        headers = {**headers, "Content-Type": "application/json"}

    ctx = ssl.create_default_context()
    last_error: Exception | None = None

    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=180, context=ctx) as resp:
                raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            # 429 / 5xx sont transitoires ; le reste est définitif.
            if exc.code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES - 1:
                wait = RETRY_BACKOFF * (2**attempt)
                print(f"    HTTP {exc.code}, nouvelle tentative dans {wait:.0f}s…")
                time.sleep(wait)
                last_error = exc
                continue
            raise ApiError(exc.code, detail) from exc
        except urllib.error.URLError as exc:
            if attempt < MAX_RETRIES - 1:
                wait = RETRY_BACKOFF * (2**attempt)
                print(f"    Réseau indisponible ({exc.reason}), nouvelle tentative dans {wait:.0f}s…")
                time.sleep(wait)
                last_error = exc
                continue
            raise

    raise last_error if last_error else RuntimeError("échec HTTP inexpliqué")


class ApiError(RuntimeError):
    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail
        message = detail
        try:
            parsed = json.loads(detail)
            err = parsed[0] if isinstance(parsed, list) else parsed
            message = err.get("error", {}).get("message", detail)
        except (json.JSONDecodeError, KeyError, IndexError, AttributeError):
            pass
        super().__init__(f"HTTP {status} — {message}")


def get_access_token(cfg: dict) -> str:
    print("Authentification OAuth…")
    try:
        data = http_post_json(
            TOKEN_ENDPOINT,
            None,
            {},
            form={
                "client_id": cfg["client_id"],
                "client_secret": cfg["client_secret"],
                "refresh_token": cfg["refresh_token"],
                "grant_type": "refresh_token",
            },
        )
    except ApiError as exc:
        die(
            f"Échec de l'authentification OAuth ({exc}).\n"
            "Vérifiez client_id, client_secret et refresh_token. "
            "Un refresh token est révoqué si le mot de passe du compte change "
            "ou si l'accès a été retiré."
        )
    token = data.get("access_token") if isinstance(data, dict) else None
    if not token:
        die("La réponse OAuth ne contient pas d'access_token.")
    return token


def ads_search(cfg: dict, access_token: str, customer_id: str, query: str) -> list[dict]:
    """Exécute une GAQL via searchStream et retourne la liste de résultats aplatie."""
    url = ADS_ENDPOINT.format(v=API_VERSION, cid=customer_id)
    headers = {
        "Authorization": f"Bearer {access_token}",
        "developer-token": cfg["developer_token"],
        "login-customer-id": cfg["login_customer_id"],
    }
    payload = http_post_json(url, {"query": query}, headers)

    # searchStream renvoie une liste de chunks, chacun avec une clé "results".
    chunks = payload if isinstance(payload, list) else [payload]
    results: list[dict] = []
    for chunk in chunks:
        if isinstance(chunk, dict):
            results.extend(chunk.get("results", []) or [])
    return results


# ── Requêtes métier ──────────────────────────────────────────────────────────


def list_child_accounts(cfg: dict, access_token: str) -> list[dict]:
    """Comptes clients actifs et non-manager sous le MCC."""
    print("Énumération des comptes du MCC…")
    query = """
        SELECT
          customer_client.id,
          customer_client.descriptive_name,
          customer_client.currency_code,
          customer_client.time_zone
        FROM customer_client
        WHERE customer_client.manager = FALSE
          AND customer_client.status = 'ENABLED'
    """
    try:
        rows = ads_search(cfg, access_token, cfg["login_customer_id"], query)
    except ApiError as exc:
        die(
            f"Impossible de lister les comptes du MCC {fmt_cid(cfg['login_customer_id'])} ({exc}).\n"
            "Vérifiez que login_customer_id est bien un compte administrateur (MCC) "
            "et que le developer token est approuvé pour cet accès."
        )

    accounts = []
    for row in rows:
        client = row.get("customerClient", {})
        cid = digits_only(client.get("id", ""))
        if not cid:
            continue
        accounts.append(
            {
                "id": cid,
                "name": client.get("descriptiveName") or f"Compte {fmt_cid(cid)}",
                "currency": client.get("currencyCode") or "?",
            }
        )
    accounts.sort(key=lambda a: a["name"].lower())
    print(f"  {len(accounts)} compte(s) actif(s) trouvé(s).")
    return accounts


PERF_QUERY = """
    SELECT
      segments.date,
      segments.device,
      segments.ad_network_type,
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '{start}' AND '{end}'
      AND metrics.impressions > 0
"""


def fetch_account_performance(
    cfg: dict, access_token: str, account: dict, start: str, end: str
) -> list[dict]:
    query = PERF_QUERY.format(start=start, end=end)
    return ads_search(cfg, access_token, account["id"], query)


# ── Agrégation ───────────────────────────────────────────────────────────────


def fmt_cid(cid: str) -> str:
    cid = digits_only(cid)
    return f"{cid[:3]}-{cid[3:6]}-{cid[6:]}" if len(cid) == 10 else cid


def to_float(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def to_int(value) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


class Indexer:
    """Attribue un index stable et croissant à chaque valeur vue."""

    def __init__(self) -> None:
        self._index: dict = {}
        self.values: list = []

    def get(self, key, value=None):
        if key not in self._index:
            self._index[key] = len(self.values)
            self.values.append(value if value is not None else key)
        return self._index[key]


def build_dataset(
    accounts: list[dict],
    per_account_rows: dict[str, list[dict]],
    cfg: dict,
    start: str,
    end: str,
    *,
    source: str,
) -> dict:
    """Transforme les lignes brutes de l'API en table de faits colonnaire compacte."""
    dates = Indexer()
    devices = Indexer()
    networks = Indexer()
    campaigns = Indexer()

    account_index = {acc["id"]: i for i, acc in enumerate(accounts)}

    # cost_micros → unité monétaire, avec normalisation multi-devises optionnelle.
    report_currency, rates = resolve_currency(accounts, cfg)

    # Agrégation : une ligne par (date, campagne, device, réseau).
    buckets: dict[tuple, list] = {}

    for account in accounts:
        rows = per_account_rows.get(account["id"], [])
        rate = rates.get(account["currency"], 1.0)
        for row in rows:
            seg = row.get("segments", {})
            camp = row.get("campaign", {})
            met = row.get("metrics", {})

            date = seg.get("date")
            camp_id = str(camp.get("id", ""))
            if not date or not camp_id:
                continue

            d_idx = dates.get(date)
            dev_idx = devices.get(seg.get("device") or "UNKNOWN")
            net_idx = networks.get(seg.get("adNetworkType") or "UNKNOWN")
            c_idx = campaigns.get(
                (account["id"], camp_id),
                {
                    "name": camp.get("name") or f"Campagne {camp_id}",
                    "account": account_index[account["id"]],
                    "channel": camp.get("advertisingChannelType") or "UNKNOWN",
                },
            )

            key = (d_idx, c_idx, dev_idx, net_idx)
            bucket = buckets.get(key)
            if bucket is None:
                bucket = [0, 0, 0.0, 0.0, 0.0]
                buckets[key] = bucket

            bucket[0] += to_int(met.get("impressions"))
            bucket[1] += to_int(met.get("clicks"))
            bucket[2] += to_int(met.get("costMicros")) / 1_000_000 * rate
            bucket[3] += to_float(met.get("conversions"))
            bucket[4] += to_float(met.get("conversionsValue")) * rate

    # Ordre chronologique : on réindexe les dates triées.
    sorted_dates = sorted(dates.values)
    date_remap = {dates.get(d): i for i, d in enumerate(sorted_dates)}

    facts = []
    for (d_idx, c_idx, dev_idx, net_idx), (impr, clicks, cost, conv, value) in buckets.items():
        facts.append(
            [
                date_remap[d_idx],
                c_idx,
                dev_idx,
                net_idx,
                impr,
                clicks,
                round(cost, 2),
                round(conv, 2),
                round(value, 2),
            ]
        )
    facts.sort(key=lambda f: (f[0], f[1]))

    # On ne publie que les comptes qui ont réellement des données.
    used_accounts = {c["account"] for c in campaigns.values}
    for i, acc in enumerate(accounts):
        acc["has_data"] = i in used_accounts

    return {
        "meta": {
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "date_start": start,
            "date_end": end,
            "currency": report_currency,
            "source": source,
            "row_count": len(facts),
        },
        "accounts": [
            {
                "id": fmt_cid(a["id"]),
                "name": a["name"],
                "currency": a["currency"],
                "has_data": a.get("has_data", False),
            }
            for a in accounts
        ],
        "campaigns": [
            {"name": c["name"], "account": c["account"], "channel": c["channel"]}
            for c in campaigns.values
        ],
        "devices": devices.values,
        "networks": networks.values,
        "dates": sorted_dates,
        "facts": facts,
    }


def resolve_currency(accounts: list[dict], cfg: dict) -> tuple[str, dict[str, float]]:
    """
    Détermine la devise de reporting.

    Un MCC multi-devises ne peut pas être agrégé sans taux de change : additionner
    des CHF et des EUR produirait un total faux. Trois cas :
      - une seule devise                       → on l'utilise telle quelle ;
      - plusieurs devises + currency_rates     → conversion vers report_currency ;
      - plusieurs devises sans taux            → avertissement explicite, pas de conversion.
    """
    currencies = sorted({a["currency"] for a in accounts if a["currency"] != "?"})

    if len(currencies) <= 1:
        return (currencies[0] if currencies else "?"), {}

    target = cfg.get("report_currency")
    rates = cfg.get("currency_rates") or {}

    if target and all(c == target or c in rates for c in currencies):
        resolved = {c: (1.0 if c == target else float(rates[c])) for c in currencies}
        print(f"  Normalisation multi-devises vers {target} : {resolved}")
        return target, resolved

    print(
        "\n  ATTENTION — comptes en plusieurs devises : "
        + ", ".join(currencies)
        + "\n  Les montants ne sont PAS convertis. Les totaux inter-comptes "
        "(coût, valeur de conversion, CPA, ROAS) additionnent des devises "
        "différentes et sont donc faux."
        "\n  Pour corriger : renseignez \"report_currency\" et \"currency_rates\" "
        "dans scripts/config.json.\n"
    )
    return "MIXED", {}


# ── CLI ──────────────────────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Récupère les performances Google Ads d'un MCC vers data.json."
    )
    parser.add_argument(
        "--days",
        type=int,
        default=180,
        help="Nombre de jours à récupérer, jusqu'à hier (défaut : 180). "
        "Prévoyez le double de la période que vous analyserez, pour que le "
        "dashboard puisse calculer les évolutions.",
    )
    parser.add_argument("--start", help="Date de début AAAA-MM-JJ (prime sur --days)")
    parser.add_argument("--end", help="Date de fin AAAA-MM-JJ (défaut : hier)")
    parser.add_argument(
        "--accounts",
        help="Restreint à ces IDs clients, séparés par des virgules "
        "(défaut : tous les comptes actifs du MCC)",
    )
    parser.add_argument(
        "--out",
        default=str(PROJECT_DIR / "data" / "data.json"),
        help="Chemin du fichier de sortie (défaut : data/data.json)",
    )
    return parser.parse_args()


def resolve_dates(args: argparse.Namespace) -> tuple[str, str]:
    today = dt.date.today()
    # Les données de la journée en cours sont incomplètes : on s'arrête à hier.
    end = dt.date.fromisoformat(args.end) if args.end else today - dt.timedelta(days=1)
    if args.start:
        start = dt.date.fromisoformat(args.start)
    else:
        start = end - dt.timedelta(days=max(args.days, 1) - 1)
    if start > end:
        die(f"La date de début ({start}) est postérieure à la date de fin ({end}).")
    return start.isoformat(), end.isoformat()


def main() -> int:
    args = parse_args()
    cfg = load_config()
    start, end = resolve_dates(args)

    print(f"\nPériode : {start} → {end}")
    print(f"MCC     : {fmt_cid(cfg['login_customer_id'])}")

    access_token = get_access_token(cfg)
    accounts = list_child_accounts(cfg, access_token)

    if args.accounts:
        wanted = {digits_only(a) for a in args.accounts.split(",") if a.strip()}
        accounts = [a for a in accounts if a["id"] in wanted]
        unknown = wanted - {a["id"] for a in accounts}
        if unknown:
            print(f"  Ignorés (introuvables ou inactifs) : {', '.join(sorted(unknown))}")
        if not accounts:
            die("Aucun des comptes demandés n'est accessible sous ce MCC.")

    if not accounts:
        die("Aucun compte client actif sous ce MCC.")

    per_account_rows: dict[str, list[dict]] = {}
    failures: list[tuple[str, str]] = []

    for i, account in enumerate(accounts, 1):
        label = f"{account['name']} ({fmt_cid(account['id'])})"
        print(f"[{i}/{len(accounts)}] {label}…", end=" ", flush=True)
        try:
            rows = fetch_account_performance(cfg, access_token, account, start, end)
        except ApiError as exc:
            # Un compte inaccessible ne doit pas faire échouer tout le rapport.
            print(f"ÉCHEC ({exc})")
            failures.append((label, str(exc)))
            continue
        per_account_rows[account["id"]] = rows
        print(f"{len(rows)} ligne(s)")

    if not per_account_rows:
        die("Aucune donnée récupérée : tous les comptes ont échoué.")

    dataset = build_dataset(
        accounts, per_account_rows, cfg, start, end, source="google-ads-api"
    )
    if failures:
        dataset["meta"]["failed_accounts"] = [
            {"account": label, "error": err} for label, err in failures
        ]

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(dataset, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    size_kb = out_path.stat().st_size / 1024
    print(f"\nÉcrit : {out_path}  ({size_kb:,.0f} Ko)")
    print(
        f"  {len(dataset['accounts'])} compte(s) · "
        f"{len(dataset['campaigns'])} campagne(s) · "
        f"{len(dataset['dates'])} jour(s) · "
        f"{len(dataset['facts']):,} ligne(s) de faits"
    )
    if failures:
        print(f"  {len(failures)} compte(s) en échec — voir meta.failed_accounts dans le JSON.")
    print("\nPoussez le fichier sur GitHub pour mettre le dashboard à jour :")
    print("  git add data/data.json && git commit -m \"Mise à jour des données\" && git push")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrompu.", file=sys.stderr)
        raise SystemExit(130)
