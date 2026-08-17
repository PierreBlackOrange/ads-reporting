#!/usr/bin/env python3
"""
Construit data/releases.json — l'historique des modifications du reporting.

    python scripts/build_releases.py
    python scripts/build_releases.py --limit 60

CE QUE CET HISTORIQUE RETRACE
-----------------------------
Les changements de l'OUTIL : sections ajoutées, correctifs, changements de
méthode de calcul. Pas les changements des comptes Google Ads — ceux-là ont leur
propre journal dans l'onglet Tracking, alimenté par `change_event` et par le
Sheet des déploiements techniques. Les confondre laisserait croire qu'un ajout de
graphique et une modification d'enchère sont de même nature.

POURQUOI IL EST GÉNÉRÉ ET NON ÉCRIT À LA MAIN
---------------------------------------------
Un fichier de notes de version tenu à la main se périme au premier oubli, et un
historique faux est pire qu'absent. Celui-ci se déduit du journal Git, seule
source qui ne peut pas mentir sur ce qui a été livré.

Les commits qui ne touchent QUE `data/` sont écartés : ce sont les
rafraîchissements de données, quotidiens et sans intérêt pour un lecteur qui veut
savoir ce que le rapport sait faire. Le filtre porte sur les fichiers réellement
modifiés, pas sur le libellé du commit — un intitulé peut mentir, la liste des
fichiers non.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent

# Classement par nature, déduit du sujet. L'étiquette sert au tri visuel, pas à
# une taxonomie stricte : en cas de doute, « évolution ».
KINDS = [
    ("fix", "Correctif", re.compile(
        r"\b(corrige|corrections?|correctif|répare|repare|fix)\b", re.I)),
    ("doc", "Documentation", re.compile(
        r"\b(readme|documente|documentation)\b", re.I)),
    ("probe", "Sonde API", re.compile(r"\bsondes?\b", re.I)),
    ("feat", "Évolution", re.compile(r".", re.S)),
]


def git(*args: str) -> str:
    try:
        out = subprocess.run(("git",) + args, cwd=PROJECT_DIR,
                             capture_output=True, text=True, encoding="utf-8",
                             errors="replace", check=True)
    except FileNotFoundError:
        sys.exit("git introuvable dans le PATH.")
    except subprocess.CalledProcessError as exc:
        sys.exit(f"git {' '.join(args)} a échoué : {exc.stderr.strip()}")
    return out.stdout


def classify(subject: str) -> tuple[str, str]:
    for key, label, rx in KINDS:
        if rx.search(subject):
            return key, label
    return "feat", "Évolution"


def first_sentence(body: str) -> str:
    """Première phrase utile du corps du message, si elle éclaire le sujet.

    Les corps de commit de ce dépôt expliquent le POURQUOI ; en garder une phrase
    donne au lecteur la raison sans lui imposer le paragraphe entier.

    Les intertitres en capitales sont écartés : ils structurent le message pour
    un relecteur de code, mais collés en tête d'un détail ils donnent « PERIMETRE
    L'onglet ne regarde plus que… », qui se lit comme une coquille."""
    kept = []
    for line in body.splitlines():
        s = line.strip()
        if not s:
            continue
        letters = [c for c in s if c.isalpha()]
        if letters and all(c.isupper() for c in letters) and len(s) < 90:
            continue                       # intertitre
        if set(s) <= set("-–—=_ "):
            continue                       # filet de séparation
        kept.append(s)
    text = " ".join(kept)
    if not text:
        return ""
    # On coupe à la première ponctuation forte suivie d'une majuscule ou fin.
    m = re.search(r"(.+?[.!?])(\s+[A-ZÉÈÀÇ]|$)", text)
    out = (m.group(1) if m else text).strip()
    return out[:280]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Historique des modifications du reporting.")
    # 0 = tout l'historique. Une limite basse tronquerait l'historique en silence
    # à mesure que les commits de données s'accumulent — ils sont dix fois plus
    # nombreux que les livraisons.
    p.add_argument("--limit", type=int, default=0,
                   help="nombre de commits à examiner (défaut : tous)")
    p.add_argument("--out", default=None)
    return p.parse_args()


def main() -> None:
    args = parse_args()

    SEP = "\x1e"
    FIELD = "\x1f"
    log_args = ["log", "--date=short", "--no-merges",
                f"--pretty=format:%H{FIELD}%ad{FIELD}%s{FIELD}%b{SEP}"]
    if args.limit > 0:
        log_args.insert(1, f"-{args.limit}")
    raw = git(*log_args)

    entries: list[dict] = []
    data_only = 0
    for chunk in raw.split(SEP):
        chunk = chunk.strip("\n")
        if not chunk.strip():
            continue
        parts = chunk.split(FIELD)
        if len(parts) < 3:
            continue
        sha, date, subject = parts[0].strip(), parts[1].strip(), parts[2].strip()
        body = parts[3] if len(parts) > 3 else ""

        files = [f for f in git("show", "--name-only", "--pretty=format:", sha)
                 .splitlines() if f.strip()]
        if files and all(f.startswith("data/") for f in files):
            data_only += 1
            continue

        kind, label = classify(subject)
        entries.append({
            "sha": sha[:7],
            "date": date,
            "title": subject,
            "kind": kind,
            "kindLabel": label,
            "detail": first_sentence(body),
            "files": len(files),
        })

    if not entries:
        sys.exit("Aucun commit de code trouvé — historique non écrit.")

    payload = {
        "meta": {
            "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "commits_scanned": args.limit or "tous",
            "entries": len(entries),
            "data_only_skipped": data_only,
            "first": entries[-1]["date"],
            "last": entries[0]["date"],
        },
        "entries": entries,
    }

    out = Path(args.out) if args.out else PROJECT_DIR / "data" / "releases.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1),
                   encoding="utf-8")

    print(f"Écrit {out} ({out.stat().st_size / 1024:.1f} Ko)")
    print(f"  {len(entries)} modification(s) du {entries[-1]['date']} au {entries[0]['date']}")
    print(f"  {data_only} commit(s) de données écarté(s)")
    by_kind: dict[str, int] = {}
    for e in entries:
        by_kind[e["kindLabel"]] = by_kind.get(e["kindLabel"], 0) + 1
    for k, v in sorted(by_kind.items(), key=lambda x: -x[1]):
        print(f"  {k:<16} {v}")


if __name__ == "__main__":
    main()
