#!/usr/bin/env python3
"""
Lit le Google Sheet des changements techniques et produit data/changelog.json.

    python scripts/fetch_changelog.py --sheet <ID_ou_URL>
    python scripts/fetch_changelog.py --sheet <ID> --gid 0
    python scripts/fetch_changelog.py --csv chemin/local.csv      # hors ligne
    python scripts/fetch_changelog.py --sample                    # jeu d'exemple

POURQUOI CE FICHIER EXISTE
--------------------------
Deux données indispensables au diagnostic n'existent pas dans l'API Google Ads
(sondé sur la v25, `%consent%` et `%model%led%` renvoient zéro champ) :

  · le taux de Consent Mode (granted / denied) ;
  · la part de conversions modélisées.

Elles vivent dans la CMP (Didomi), dans GTM et dans GA4. Ce script est la porte
d'entrée : ce que vous savez et que Google Ads ignore entre par le Sheet, et le
dashboard le superpose aux courbes de performance.

ACCÈS AU SHEET
--------------
Le Sheet doit être lisible sans authentification, parce que ce script tourne
aussi dans GitHub Actions où il n'y a pas de session Google. Deux options :

  a) Fichier → Partager → **Publier sur le web** (onglet, format CSV) ;
  b) Partage → « Tous les utilisateurs disposant du lien » en lecture.

Le script tente l'export CSV standard, puis l'URL de publication. Il ne stocke
aucun identifiant : rien à mettre dans config.json.

⚠️ Ce dépôt est public. Tout ce que contient le Sheet finira dans
data/changelog.json, donc en ligne. N'y mettez pas d'URL de conteneur privée,
de jeton GTM ni d'adresse e-mail nominative — un libellé suffit.

FORMAT ATTENDU
--------------
Une ligne = un événement. Les en-têtes sont reconnus sans tenir compte de la
casse, des accents ni de l'ordre. Colonnes :

  date          (obligatoire)  AAAA-MM-JJ, ou JJ/MM/AAAA
  fin           (optionnel)    pour un événement qui dure : AAAA-MM-JJ
  type          (optionnel)    GTM | DIDOMI | CONTAINER | ADS | SITE | AUTRE
  titre         (obligatoire)  « Déploiement conteneur sGTM v14 »
  detail        (optionnel)    texte libre
  comptes       (optionnel)    noms de comptes, séparés par des virgules
  marches       (optionnel)    FR, ES, BE…
  impact        (optionnel)    attendu | inattendu | neutre
  consent_rate  (optionnel)    taux de consentement, 0-1 ou 0-100 %

Une ligne sans date ou sans titre est ignorée et signalée : mieux vaut un
avertissement à l'extraction qu'un marqueur muet sur une courbe.

Les lignes portant `consent_rate` alimentent aussi la carte « consentement » ;
avec `comptes` ou `marches` renseigné, la courbe se filtre comme le reste.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent

TYPES = {
    "GTM": "GTM",
    "GOOGLE TAG MANAGER": "GTM",
    "TAG MANAGER": "GTM",
    "SGTM": "CONTAINER",
    "CONTAINER": "CONTAINER",
    "CONTENEUR": "CONTAINER",
    "DIDOMI": "DIDOMI",
    "CMP": "DIDOMI",
    "CONSENT": "DIDOMI",
    "CONSENTEMENT": "DIDOMI",
    "ADS": "ADS",
    "GOOGLE ADS": "ADS",
    "SITE": "SITE",
    "DEV": "SITE",
}

TYPE_LABELS = {
    "GTM": "GTM",
    "CONTAINER": "Conteneur",
    "DIDOMI": "Didomi / CMP",
    "ADS": "Google Ads",
    "SITE": "Site",
    "AUTRE": "Autre",
}

IMPACTS = {"ATTENDU": "attendu", "INATTENDU": "inattendu", "NEUTRE": "neutre"}


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s)
                   if unicodedata.category(c) != "Mn")


def norm_header(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", strip_accents(s or "").lower())


# Plusieurs libellés possibles pour la même colonne : le Sheet est rempli à la
# main, exiger un intitulé exact ne tiendrait pas trois semaines.
HEADERS = {
    "date": {"date", "datedebut", "debut", "jour", "when"},
    "end": {"fin", "datefin", "jusqua", "end"},
    "type": {"type", "categorie", "nature", "outil", "source"},
    "title": {"titre", "title", "changement", "libelle", "evenement", "event", "resume"},
    "detail": {"detail", "details", "description", "commentaire", "notes", "note"},
    "accounts": {"comptes", "compte", "account", "accounts", "cid"},
    "markets": {"marches", "marche", "market", "markets", "pays", "country"},
    "impact": {"impact", "effet", "consequence"},
    "consent": {"consentrate", "consent", "tauxconsentement", "consentement",
                "tauxdeconsentement", "granted", "tauxgranted"},
}


def sheet_urls(ref: str, gid: str | None) -> list[str]:
    """Un identifiant, une URL d'édition ou une URL déjà publiée : on accepte les
    trois et on décline les formes d'export possibles."""
    ref = ref.strip()
    if ref.startswith("http") and "/pub" in ref:
        return [ref if "output=csv" in ref else ref + "&output=csv"]

    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", ref)
    sid = m.group(1) if m else ref
    g = gid or "0"
    return [
        f"https://docs.google.com/spreadsheets/d/{sid}/export?format=csv&gid={g}",
        f"https://docs.google.com/spreadsheets/d/{sid}/gviz/tq?tqx=out:csv&gid={g}",
        f"https://docs.google.com/spreadsheets/d/e/{sid}/pub?gid={g}&single=true&output=csv",
    ]


def fetch_csv(urls: list[str]) -> str:
    last = None
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ads-reporting/1.0"})
            with urllib.request.urlopen(req, timeout=45) as resp:
                body = resp.read().decode("utf-8-sig", errors="replace")
            # Une feuille non partagée renvoie 200 + une page de connexion : le
            # HTML est la vraie erreur, pas le code de statut.
            if body.lstrip().lower().startswith(("<!doctype", "<html")):
                last = (f"{url} renvoie une page HTML — la feuille n'est probablement pas "
                        f"partagée publiquement.")
                continue
            return body
        except urllib.error.HTTPError as exc:
            last = f"{url} → HTTP {exc.code}"
        except Exception as exc:                     # noqa: BLE001
            last = f"{url} → {exc}"
    raise SystemExit(
        "Impossible de lire le Sheet.\n"
        f"Dernière tentative : {last}\n"
        "Publiez l'onglet (Fichier → Partager → Publier sur le web, format CSV) "
        "ou passez le partage en lecture pour tous, puis relancez."
    )


def parse_date(raw: str) -> str | None:
    raw = (raw or "").strip()
    if not raw:
        return None
    raw = raw.split(" ")[0].replace(".", "/").replace("-", "/")
    parts = [p for p in raw.split("/") if p]
    if len(parts) != 3:
        return None
    try:
        if len(parts[0]) == 4:
            y, m, d = (int(p) for p in parts)
        else:
            d, m, y = (int(p) for p in parts)
            if y < 100:
                y += 2000
        return dt.date(y, m, d).isoformat()
    except ValueError:
        return None


def parse_rate(raw: str) -> float | None:
    """« 0,82 », « 82 % », « 82 » → 0.82. Au-delà de 1 on suppose des pourcents ;
    un taux de consentement de 82 est impossible, de 82 % très plausible."""
    raw = (raw or "").strip().replace("%", "").replace(",", ".")
    if not raw:
        return None
    try:
        v = float(raw)
    except ValueError:
        return None
    if v > 1:
        v /= 100
    return round(max(0.0, min(1.0, v)), 4)


def split_list(raw: str) -> list[str]:
    return [p.strip() for p in re.split(r"[,;|]", raw or "") if p.strip()]


SAMPLE = """date,type,titre,detail,comptes,marches,impact,consent_rate
2026-03-04,GTM,Migration conteneur sGTM v12,Passage du tag Ads en server-side,2lm_jacquie_et_michel_rencontre,FR,attendu,0.78
2026-04-15,DIDOMI,Nouveau bandeau Didomi,Bouton « tout refuser » ajouté au premier niveau,,FR;BE,inattendu,0.61
2026-05-02,CONTAINER,Publication conteneur GTM web,Correctif de déclencheur sur la page de confirmation,gdm_spiice-google-fr,FR,attendu,
2026-06-11,SITE,Refonte tunnel d'inscription,,fr_sexy_1,FR,inattendu,
2026-07-01,DIDOMI,Mise à jour vendor list IAB TCF 2.2,,,FR;ES;BE,neutre,0.64
"""


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Timeline des changements techniques.")
    p.add_argument("--sheet", default=None, help="ID, URL d'édition ou URL publiée")
    p.add_argument("--gid", default=None, help="identifiant de l'onglet (défaut : 0)")
    p.add_argument("--csv", default=None, help="fichier CSV local, au lieu du Sheet")
    p.add_argument("--sample", action="store_true",
                   help="écrit un jeu d'exemple, pour tester l'affichage")
    p.add_argument("--out", default=None)
    return p.parse_args()


def main() -> None:
    args = parse_args()

    if args.sample:
        body = SAMPLE
        source = "exemple"
    elif args.csv:
        body = Path(args.csv).read_text(encoding="utf-8-sig")
        source = f"csv:{Path(args.csv).name}"
    elif args.sheet:
        body = fetch_csv(sheet_urls(args.sheet, args.gid))
        source = "google-sheet"
    else:
        raise SystemExit("Passez --sheet <ID>, --csv <fichier> ou --sample.")

    # Le séparateur varie selon la locale d'export : détecté, pas supposé.
    head = body.split("\n", 1)[0]
    delim = ";" if head.count(";") > head.count(",") else ","
    reader = csv.reader(io.StringIO(body), delimiter=delim)

    rows = [r for r in reader if any((c or "").strip() for c in r)]
    if not rows:
        raise SystemExit("Le Sheet est vide.")

    header = [norm_header(c) for c in rows[0]]
    col: dict[str, int] = {}
    for key, names in HEADERS.items():
        for i, h in enumerate(header):
            if h in names and key not in col:
                col[key] = i
    missing = [k for k in ("date", "title") if k not in col]
    if missing:
        raise SystemExit(
            f"Colonnes obligatoires absentes : {', '.join(missing)}.\n"
            f"En-têtes lus : {', '.join(rows[0])}\n"
            "Attendu au minimum une colonne « date » et une colonne « titre »."
        )

    def cell(r: list[str], key: str) -> str:
        i = col.get(key)
        return (r[i] if i is not None and i < len(r) else "") or ""

    events: list[dict] = []
    skipped: list[str] = []

    for n, r in enumerate(rows[1:], start=2):
        date = parse_date(cell(r, "date"))
        title = cell(r, "title").strip()
        if not date or not title:
            why = "date illisible" if not date else "titre vide"
            skipped.append(f"ligne {n} ({why})")
            continue

        # Un type inconnu n'est pas une erreur : il devient « Autre », et le
        # libellé d'origine reste visible dans le détail plutôt que perdu.
        raw_type = strip_accents(cell(r, "type")).strip().upper()
        etype = TYPES.get(raw_type, "AUTRE")

        ev = {
            "date": date,
            "type": etype,
            "title": title[:180],
        }
        end = parse_date(cell(r, "end"))
        if end and end > date:
            ev["end"] = end
        detail = cell(r, "detail").strip()
        if raw_type and raw_type not in TYPES:
            detail = f"[{cell(r, 'type').strip()}] {detail}".strip()
        if detail:
            ev["detail"] = detail[:400]
        accounts = split_list(cell(r, "accounts"))
        if accounts:
            ev["accounts"] = accounts
        markets = [m.upper()[:12] for m in split_list(cell(r, "markets"))]
        if markets:
            ev["markets"] = markets
        impact = IMPACTS.get(strip_accents(cell(r, "impact")).strip().upper())
        if impact:
            ev["impact"] = impact
        rate = parse_rate(cell(r, "consent"))
        if rate is not None:
            ev["consentRate"] = rate
        events.append(ev)

    if not events:
        raise SystemExit("Aucune ligne exploitable : vérifiez le format des dates.")

    events.sort(key=lambda e: (e["date"], e["title"]))

    consent = [{"date": e["date"], "rate": e["consentRate"],
                "accounts": e.get("accounts", []), "markets": e.get("markets", [])}
               for e in events if "consentRate" in e]

    payload = {
        "meta": {
            "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "source": source,
            "events": len(events),
            "skipped": skipped,
            "date_start": events[0]["date"],
            "date_end": events[-1]["date"],
            "consent_points": len(consent),
        },
        "typeLabels": TYPE_LABELS,
        "events": events,
        # Extrait des lignes qui portent un taux : la seule source de vérité sur
        # le consentement, puisque l'API Google Ads ne l'expose pas.
        "consent": consent,
    }

    out = Path(args.out) if args.out else PROJECT_DIR / "data" / "changelog.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1),
                   encoding="utf-8")

    print(f"Écrit {out} ({out.stat().st_size / 1024:.1f} Ko)")
    print(f"  {len(events)} événement(s) · {events[0]['date']} → {events[-1]['date']}")
    by_type: dict[str, int] = {}
    for e in events:
        by_type[e["type"]] = by_type.get(e["type"], 0) + 1
    for t, c in sorted(by_type.items(), key=lambda x: -x[1]):
        print(f"  {TYPE_LABELS.get(t, t):<14} {c}")
    if consent:
        print(f"  {len(consent)} point(s) de consentement")
    if skipped:
        print(f"  {len(skipped)} ligne(s) ignorée(s) : {'; '.join(skipped[:6])}"
              + (" …" if len(skipped) > 6 else ""))


if __name__ == "__main__":
    main()
