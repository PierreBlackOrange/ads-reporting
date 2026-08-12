#!/usr/bin/env python3
"""
Classifie l'intention des termes de recherche par règles, sans appel de modèle.

    python scripts/classify_terms.py
    python scripts/classify_terms.py --brands jacquie,michel,jm,spiice

Alternative à enrich_terms.py quand aucune clé API n'est disponible. Aucune
dépendance.

CE QUE CE SCRIPT FAIT ET NE FAIT PAS
------------------------------------
Il remplit uniquement le champ `intent`, par détection de marqueurs lexicaux.
C'est transparent et auditable — chaque décision se relit dans les tables
ci-dessous — mais nettement moins fin qu'un modèle de langage : une requête
sans marqueur reconnu tombe dans « longue-traîne » ou « transactionnel » par
défaut, et l'ironie, l'implicite ou une tournure inhabituelle lui échappent.

Il ne remplit PAS le champ `sem` (pertinence sémantique). Une distance
sémantique demande un modèle : le recouvrement lexical déjà présent dans les
données ne la remplace pas, il classerait deux synonymes comme une dérive
totale. Le dashboard le sait et bascule sur le recouvrement en l'annonçant.

meta.intent_method vaut « rules » après ce script, « llm » après enrich_terms.py.
Relancer enrich_terms.py plus tard écrase proprement ce travail.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent

INTENTS = ["transactionnel", "informationnel", "marque", "comparateur",
           "longue-traîne", "indéterminé"]
I_TRANS, I_INFO, I_BRAND, I_COMP, I_LONG, I_UNKNOWN = range(6)

TOKEN_RE = re.compile(r"[a-zà-öø-ÿ0-9]+", re.IGNORECASE)

# Marques par défaut, dérivées des comptes réellement présents dans le MCC.
# Surchargées par --brands. Un token de marque suffit à classer en « marque ».
DEFAULT_BRANDS = {
    "jacquie", "jacquie-et-michel", "jacky", "jackie", "michel", "michelle",
    "jm", "jmr", "spiice", "spice", "phoenix", "easyflirt", "onlydate",
    "franco", "disons", "demain", "elite", "meetic", "tinder", "badoo",
    "adopteunmec", "bumble", "happn", "gleeden",
}

# Ordre d'évaluation volontaire : comparateur avant informationnel, car « avis »
# et « meilleur » cohabitent souvent avec « comment ». Marque passe en premier :
# « avis jacquie et michel » est une requête de marque, pas de comparateur.
COMPARATOR = {
    "meilleur", "meilleurs", "meilleure", "meilleures", "top", "top10", "top5",
    "comparatif", "comparateur", "comparaison", "classement", "palmares",
    "avis", "test", "tests", "vs", "versus", "alternative", "alternatives",
    "lequel", "quel", "quelle", "concurrent", "concurrents",
}

INFORMATIONAL = {
    "comment", "pourquoi", "quoi", "qui", "definition", "signification",
    "explication", "guide", "tutoriel", "conseil", "conseils", "astuce",
    "astuces", "fonctionne", "fonctionnement", "ca", "est",
}

TRANSACTIONAL = {
    "inscription", "inscrire", "s'inscrire", "connexion", "connecter", "login",
    "compte", "abonnement", "abonner", "prix", "tarif", "tarifs", "cout",
    "gratuit", "gratuite", "essai", "promo", "promotion", "reduction", "code",
    "telecharger", "telechargement", "application", "appli", "app", "site",
    "acheter", "payer", "paiement", "offre",
}

LONG_TAIL_MIN_TOKENS = 4


def tokenize(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


def classify(term: str, brands: set[str]) -> int:
    tokens = set(tokenize(term))
    if not tokens:
        return I_LONG
    # L'ordre compte — voir le commentaire sur COMPARATOR.
    if tokens & brands:
        return I_BRAND
    if tokens & COMPARATOR:
        return I_COMP
    if tokens & INFORMATIONAL:
        return I_INFO
    if tokens & TRANSACTIONAL:
        return I_TRANS
    # Sans marqueur reconnu, une requête longue reste de la longue traîne — la
    # longueur est en soi le signal. Une requête courte, elle, n'est pas
    # classable : la ranger d'office en « transactionnel » gonflerait cette
    # catégorie d'un tiers du volume et ferait passer une absence de détection
    # pour un résultat. Elle est donc marquée « indéterminé », ce qui mesure
    # aussi la limite de l'approche par règles.
    return I_LONG if len(tokens) >= LONG_TAIL_MIN_TOKENS else I_UNKNOWN


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Classifie l'intention des termes de recherche par règles."
    )
    parser.add_argument("--path", default=str(PROJECT_DIR / "data" / "terms.json"))
    parser.add_argument("--brands",
                        help="Tokens de marque supplémentaires, séparés par des virgules")
    parser.add_argument("--only-brands", action="store_true",
                        help="N'utiliser que --brands, en ignorant la liste par défaut")
    args = parser.parse_args()

    path = Path(args.path)
    if not path.exists():
        print(f"Erreur : {path} est absent. Lancez d'abord fetch_search_terms.py.",
              file=sys.stderr)
        return 1

    data = json.loads(path.read_text(encoding="utf-8"))
    pairs = data["pairs"]
    terms = data["terms"]

    brands = set() if args.only_brands else set(DEFAULT_BRANDS)
    if args.brands:
        brands |= {b.strip().lower() for b in args.brands.split(",") if b.strip()}

    # Un scoring par modèle est plus fin : on ne l'écrase pas silencieusement.
    if data.get("meta", {}).get("intent_method") == "llm":
        print("Les intentions proviennent déjà d'un modèle (enrich_terms.py).")
        print("Relancez avec --path vers une copie si vous voulez comparer.")
        return 0

    counts = Counter()
    for p in pairs:
        intent = classify(terms[p[1 - 1]], brands)  # index 0 = terme
        p[11] = intent
        counts[intent] += 1

    meta = data.setdefault("meta", {})
    meta["intent_method"] = "rules"
    meta["intent_brands"] = sorted(brands)
    meta["enriched"] = True          # l'intention est exploitable
    meta["enriched_count"] = len(pairs)
    meta["sem_method"] = None        # la pertinence sémantique reste non calculée

    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")

    total = len(pairs)
    print(f"\n{total:,} paires classées par règles ({len(brands)} tokens de marque)")
    print(f"Écrit : {path}\n")
    by_cost = Counter()
    for p in pairs:
        by_cost[p[11]] += p[6]
    grand = sum(by_cost.values()) or 1
    print(f"{'Intention':<18}{'Paires':>9}{'Part':>8}{'Coût':>14}{'Part':>8}")
    for i, name in enumerate(INTENTS):
        print(f"  {name:<16}{counts[i]:>9,}{counts[i] / total * 100:>7.1f}%"
              f"{by_cost[i]:>13,.0f}{by_cost[i] / grand * 100:>7.1f}%")
    print("\nLa pertinence sémantique reste non calculée : le dashboard bascule")
    print("sur le recouvrement lexical et l'indique explicitement.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
