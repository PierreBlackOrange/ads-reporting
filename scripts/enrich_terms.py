#!/usr/bin/env python3
"""
Enrichit data/terms.json avec un score de pertinence sémantique et une
intention, via l'API Claude.

    pip install anthropic
    python scripts/enrich_terms.py --dry-run     # estime le coût, n'appelle rien
    python scripts/enrich_terms.py --limit 100   # essai sur 100 paires
    python scripts/enrich_terms.py               # tout

Pour chaque paire (terme de recherche, mot-clé déclencheur) le modèle produit :

  relevance  0-100  — proximité sémantique entre ce que l'internaute a tapé et
                      le mot-clé qui a déclenché l'annonce. Un score bas sur du
                      Large ou de l'Expression signale une dérive, donc un
                      gaspillage probable.
  intent            — transactionnel | informationnel | marque | comparateur |
                      longue-traîne

Le script est réentrant : les paires déjà scorées sont ignorées, donc une
exécution interrompue reprend où elle s'était arrêtée.

Authentification : ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ou un profil créé
par `ant auth login` — le SDK les résout dans cet ordre, et le constructeur
sans argument suffit dans les trois cas.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent

try:
    import anthropic
except ImportError:
    print(
        "Le paquet « anthropic » est requis pour cette étape.\n"
        "  pip install anthropic\n"
        "(fetch_search_terms.py et fetch_ads_data.py, eux, n'ont aucune dépendance.)",
        file=sys.stderr,
    )
    raise SystemExit(1)

MODEL = "claude-opus-5"
BATCH_SIZE = 40

INTENTS = ["transactionnel", "informationnel", "marque", "comparateur", "longue-traîne"]

# Tarifs publics $/M tokens, pour l'estimation affichée avant lancement.
PRICING = {
    "claude-opus-5": (5.0, 25.0),
    "claude-sonnet-5": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}

SYSTEM_PROMPT = """\
Tu analyses des données de performance publicitaire Google Ads pour un annonceur \
qui audite ses propres campagnes. Les comptes opèrent dans le secteur de la \
rencontre en ligne, y compris pour adultes : les termes de recherche reflètent \
donc ce que des internautes ont réellement tapé, parfois en langage cru. C'est \
une analyse de gestion de campagne, pas une production de contenu — classe les \
termes tels qu'ils sont, sans les reformuler ni les censurer.

Pour chaque paire, tu produis deux valeurs.

1. relevance — entier de 0 à 100
   Proximité SÉMANTIQUE entre la requête tapée et le mot-clé qui a déclenché \
l'annonce. C'est une mesure de sens, pas de similarité de surface.
     90-100  même intention, même objet — synonymes et fautes de frappe compris
     70-89   intention proche, nuance ou spécificité en plus
     40-69   thème voisin mais intention divergente
     10-39   rapport lointain : le déclenchement est probablement du gaspillage
     0-9     sans rapport
   Deux formulations différentes du même besoin méritent un score élevé : \
« site de rencontre coquine » face au mot-clé « rencontre libertine » est une \
correspondance forte malgré un recouvrement de mots faible. Inversement, un \
mot partagé ne suffit pas : « emploi rencontre » face à « site de rencontre » \
est une dérive.

2. intent — exactement l'une de ces valeurs
     transactionnel   veut agir maintenant : s'inscrire, s'abonner, rencontrer
     informationnel   cherche à comprendre : « comment », « c'est quoi », avis
     marque           nomme une marque précise, la sienne ou une concurrente
     comparateur      cherche un classement, un « top », un comparatif, « meilleur »
     longue-traîne    requête longue et très spécifique qui n'entre pas ci-dessus

Réponds pour chaque identifiant reçu, dans l'ordre, sans en omettre aucun.\
"""

SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "relevance": {"type": "integer"},
                    "intent": {"type": "string", "enum": INTENTS},
                },
                "required": ["id", "relevance", "intent"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["results"],
    "additionalProperties": False,
}


def build_batch_prompt(batch: list[tuple[int, str, str, str]]) -> str:
    lines = ["Paires à analyser (id | terme tapé | mot-clé déclencheur | correspondance) :", ""]
    for pid, term, keyword, match in batch:
        lines.append(f"{pid} | {term} | {keyword} | {match}")
    return "\n".join(lines)


def estimate_cost(n_pairs: int, model: str) -> tuple[float, int]:
    """Estimation grossière, volontairement pessimiste (sans cache)."""
    batches = (n_pairs + BATCH_SIZE - 1) // BATCH_SIZE
    sys_tokens = len(SYSTEM_PROMPT) // 3
    in_tokens = batches * (sys_tokens + BATCH_SIZE * 25)
    out_tokens = batches * (BATCH_SIZE * 22)
    pin, pout = PRICING.get(model, PRICING["claude-opus-5"])
    return (in_tokens / 1e6 * pin) + (out_tokens / 1e6 * pout), batches


def score_batch(client, model: str, batch, use_fallbacks: bool):
    """Retourne {id: (relevance, intent)}. Un lot refusé retourne {}."""
    kwargs = dict(
        model=model,
        max_tokens=8000,
        # Le scoring est répétitif : une faible profondeur de réflexion suffit
        # et coûte nettement moins. Désactiver la réflexion serait contre-productif
        # sur Claude Opus 5 (fuite de balises internes dans la réponse).
        thinking={"type": "adaptive"},
        output_config={
            "effort": "low",
            "format": {"type": "json_schema", "schema": SCHEMA},
        },
        system=[{
            "type": "text",
            "text": SYSTEM_PROMPT,
            # Le prompt système est identique à chaque lot : le mettre en cache
            # évite de le repayer plein tarif des dizaines de fois.
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{"role": "user", "content": build_batch_prompt(batch)}],
    )

    if use_fallbacks:
        # Les classificateurs de sûreté peuvent décliner une requête ; le
        # repli la rejoue côté serveur sur un autre modèle dans le même appel.
        resp = client.beta.messages.create(
            betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs
        )
    else:
        resp = client.messages.create(**kwargs)

    # À vérifier AVANT de lire content : sur un refus, content est vide.
    if resp.stop_reason == "refusal":
        cat = getattr(resp.stop_details, "category", None) if resp.stop_details else None
        print(f"    refus du modèle (catégorie : {cat}) — lot laissé non scoré")
        return {}

    text = next((b.text for b in resp.content if b.type == "text"), None)
    if not text:
        return {}

    data = json.loads(text)
    return {
        int(r["id"]): (max(0, min(100, int(r["relevance"]))), r["intent"])
        for r in data.get("results", [])
        if r.get("intent") in INTENTS
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Ajoute score sémantique et intention à data/terms.json via l'API Claude."
    )
    parser.add_argument("--path", default=str(PROJECT_DIR / "data" / "terms.json"))
    parser.add_argument("--model", default=MODEL,
                        help=f"Modèle Claude (défaut : {MODEL})")
    parser.add_argument("--limit", type=int,
                        help="N'enrichir que les N paires les plus coûteuses (essai)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Affiche l'estimation de coût sans appeler l'API")
    parser.add_argument("--no-fallbacks", action="store_true",
                        help="Désactive le repli serveur sur refus")
    args = parser.parse_args()

    path = Path(args.path)
    if not path.exists():
        print(f"Erreur : {path} est absent. Lancez d'abord fetch_search_terms.py.",
              file=sys.stderr)
        return 1

    data = json.loads(path.read_text(encoding="utf-8"))
    pairs = data["pairs"]
    terms, keywords, matches = data["terms"], data["keywords"], data["matchTypes"]

    # Réentrance : on ne rescore pas ce qui l'est déjà.
    todo = [i for i, p in enumerate(pairs) if p[10] is None]
    if args.limit:
        todo.sort(key=lambda i: -pairs[i][6])
        todo = todo[:args.limit]

    already = len(pairs) - len([i for i, p in enumerate(pairs) if p[10] is None])
    if not todo:
        print(f"Rien à faire : les {len(pairs):,} paires sont déjà enrichies.")
        return 0

    cost, batches = estimate_cost(len(todo), args.model)
    covered = sum(pairs[i][6] for i in todo)
    print(f"\nÀ enrichir : {len(todo):,} paires ({already:,} déjà faites)")
    print(f"  dépense couverte : {covered:,.0f} {data['meta'].get('currency', 'EUR')}")
    print(f"  modèle           : {args.model}")
    print(f"  lots             : {batches} × {BATCH_SIZE}")
    print(f"  coût API estimé  : ~{cost:.2f} USD (majorant, sans cache)")

    if args.dry_run:
        print("\n--dry-run : aucun appel effectué.")
        return 0

    try:
        client = anthropic.Anthropic()
    except Exception as exc:
        print(f"\nErreur : client Anthropic non initialisable ({exc}).\n"
              "Définissez ANTHROPIC_API_KEY, ou lancez `ant auth login`.", file=sys.stderr)
        return 1

    use_fallbacks = not args.no_fallbacks
    scored = failed = 0

    for bi in range(0, len(todo), BATCH_SIZE):
        idxs = todo[bi:bi + BATCH_SIZE]
        batch = [
            (i, terms[pairs[i][0]], keywords[pairs[i][1]], matches[pairs[i][2]])
            for i in idxs
        ]
        n = bi // BATCH_SIZE + 1
        print(f"  lot {n}/{batches}…", end=" ", flush=True)

        for attempt in range(3):
            try:
                results = score_batch(client, args.model, batch, use_fallbacks)
                for pid, (rel, intent) in results.items():
                    if 0 <= pid < len(pairs):
                        pairs[pid][10] = rel
                        pairs[pid][11] = INTENTS.index(intent)
                        scored += 1
                missing = len(idxs) - len(results)
                print(f"{len(results)} scorées" + (f", {missing} manquantes" if missing else ""))
                failed += missing
                break

            except anthropic.BadRequestError as exc:
                # Combinaison repli + sortie structurée refusée : on réessaie sans.
                if use_fallbacks:
                    print(f"400 avec repli ({exc.message[:60]}) — nouvelle tentative sans")
                    use_fallbacks = False
                    continue
                print(f"ÉCHEC requête invalide : {exc.message[:100]}")
                failed += len(idxs)
                break

            except anthropic.RateLimitError as exc:
                wait = int(exc.response.headers.get("retry-after", "30"))
                print(f"limite de débit, pause {wait}s…", end=" ", flush=True)
                time.sleep(wait)

            except (anthropic.APIConnectionError, anthropic.InternalServerError) as exc:
                wait = 5 * (attempt + 1)
                print(f"erreur transitoire ({type(exc).__name__}), reprise dans {wait}s…",
                      end=" ", flush=True)
                time.sleep(wait)

            except json.JSONDecodeError:
                print("réponse illisible — lot ignoré")
                failed += len(idxs)
                break
        else:
            print("    abandon après 3 tentatives")
            failed += len(idxs)

        # Sauvegarde après chaque lot : une interruption ne perd rien.
        data["meta"]["enriched"] = True
        data["meta"]["enriched_model"] = args.model
        data["meta"]["enriched_count"] = sum(1 for p in pairs if p[10] is not None)
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")

    total = sum(1 for p in pairs if p[10] is not None)
    print(f"\n{scored:,} paires scorées dans cette exécution"
          + (f", {failed:,} en échec" if failed else ""))
    print(f"{total:,} / {len(pairs):,} paires enrichies au total")
    print(f"Écrit : {path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrompu — la progression est sauvegardée.", file=sys.stderr)
        raise SystemExit(130)
