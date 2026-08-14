#!/usr/bin/env python3
"""
Publie un export de cannibalisation sémantique comme page du dashboard.

L'export autonome est produit par l'autre projet
(bo-cannibalisation-semantique → menu « Export HTML autonome »), qui le dépose
sur Google Drive. Ce script le reprend, y ajoute la navigation vers le reste du
dashboard, et l'écrit à la racine du dépôt sous cannibalisation.html.

    python scripts/publish_cannibalisation.py chemin/vers/export.html

Pourquoi un script plutôt qu'un copier-coller : cet export sera régénéré à
chaque nouvelle analyse. Une étape reproductible évite d'oublier la navigation,
et le prochain qui republiera n'aura pas à deviner ce qu'il fallait ajouter.

Le fichier reste autonome : la navigation injectée est du HTML et du CSS en
ligne, sans dépendance au reste du dossier. Ouvert depuis un disque ou envoyé
par courriel, il continue de s'afficher — seuls les liens de retour pointent
alors dans le vide.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent

# Bandeau de navigation, inséré juste après <body>. Le style est en ligne pour
# ne pas dépendre de assets/styles.css, que l'export ne charge pas.
NAV = """
<div style="max-width:1400px;margin:0 auto 4px;padding:16px 24px 0;
            font:14px system-ui,-apple-system,'Segoe UI',sans-serif;">
  <a href="index.html" style="color:#2a78d6;text-decoration:none;">
    &#8592; Reporting Google Ads</a>
  <span style="opacity:.45;padding:0 8px;">·</span>
  <a href="index.html#vue=live" style="color:#2a78d6;text-decoration:none;">Live</a>
</div>
"""

# Note ajoutée au pied de page : d'où vient ce fichier, et à quelle date il a
# été figé. Sans elle, un lecteur qui tombe dessus dans six mois ne peut pas
# savoir s'il regarde des chiffres courants.
FOOTNOTE = """
<div style="max-width:1400px;margin:0 auto;padding:0 24px 28px;
            font:12px system-ui,-apple-system,'Segoe UI',sans-serif;color:#898781;">
  Page figée, produite par le pipeline de cannibalisation sémantique et publiée
  à la main. Elle ne se rafraîchit pas avec le reste du dashboard : la date
  d'extraction en tête de page fait foi.
</div>
"""


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("source", help="export HTML autonome à publier")
    p.add_argument("--out", default=None, help="fichier de sortie")
    args = p.parse_args()

    src = Path(args.source)
    if not src.exists():
        print(f"Erreur : {src} est introuvable.", file=sys.stderr)
        return 1

    html = src.read_text(encoding="utf-8")

    # Garde-fou : republier le gabarit vide est arrivé une fois côté Apps
    # Script, et rien ne le signalait. On refuse plutôt que de mettre en ligne
    # une page qui affiche « ce fichier est le gabarit, pas un export ».
    if re.search(r"var\s+DATA\s*=\s*null\s*;", html):
        print("Erreur : cet export ne contient aucune donnée (var DATA = null). "
              "Relancez « Export HTML autonome » depuis le Sheet.", file=sys.stderr)
        return 1

    if "<body>" not in html:
        print("Erreur : pas de <body> dans le fichier — est-ce bien un export ?",
              file=sys.stderr)
        return 1

    html = html.replace("<body>", "<body>" + NAV, 1)
    html = html.replace("</main>", "</main>" + FOOTNOTE, 1)

    out = Path(args.out) if args.out else PROJECT_DIR / "cannibalisation.html"
    out.write_text(html, encoding="utf-8")

    size = out.stat().st_size
    print(f"Écrit {out} ({size / 1024:.0f} Ko)")
    print("Pensez à commiter puis pousser : GitHub Pages sert la branche main.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
