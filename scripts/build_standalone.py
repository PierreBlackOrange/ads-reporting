#!/usr/bin/env python3
"""
Assemble le dashboard en UN seul fichier HTML autonome.

    python scripts/build_standalone.py
    python scripts/build_standalone.py --out ~/Bureau/dashboard.html
    python scripts/build_standalone.py --skip terms,tracking   # allège le fichier

POURQUOI CE SCRIPT EXISTE
-------------------------
Copier le dossier sur une clé USB ne suffit pas : la page charge ses données par
`fetch`, et un navigateur qui ouvre un fichier en `file://` refuse ces requêtes
(politique d'origine). Le dashboard s'afficherait vide, sans message d'erreur
visible autre qu'une ligne de console.

Ce script inline donc tout — CSS, JavaScript, les onze jeux de données et les
captures de pages — et neutralise le problème en interceptant `fetch` avant que
l'application ne démarre. Le résultat s'ouvre d'un double-clic, sur n'importe
quel appareil, sans Python, sans serveur, sans réseau.

CE QUE LE FICHIER AUTONOME NE FAIT PAS
--------------------------------------
· Il ne se met plus à jour : c'est un instantané, daté dans son pied de page.
· Les boutons « Régénérer » disparaissent d'eux-mêmes — ils pointent vers GitHub
  Actions, que l'application ne sait localiser qu'en étant servie depuis Pages.
· Le lien « Cannibalisation » est retiré : il mène à une seconde page, qu'un
  fichier unique ne peut pas embarquer (les navigateurs bloquent la navigation
  vers une URL `data:`).

Tout le reste fonctionne, y compris les filtres, les vues tableau, l'export CSV
et l'impression PDF.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import mimetypes
import re
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent

# Tout ce que l'application peut demander à l'exécution. Un fichier absent est
# simplement omis : la section correspondante se masque d'elle-même, exactement
# comme sur la version en ligne.
DATA_FILES = [
    "data/data.json",
    "data/live.json",
    "data/terms.json",
    "data/aimax.json",
    "data/gender.json",
    "data/tracking.json",
    "data/changes.json",
    "data/changelog.json",
    "data/experiments.json",
    "data/releases.json",
    "data/landing-pages.json",
]


def js_safe(raw: str) -> str:
    """Neutralise « < » dans un texte JSON destiné à une balise <script>.

    En JSON valide, « < » n'apparaît qu'à l'intérieur d'une chaîne : le
    remplacer par son échappement Unicode est donc sans effet sur la valeur, et
    empêche une séquence « </script> » présente dans une donnée de refermer la
    balise — ce qui casserait la page entière.
    """
    return raw.replace("<", "\\u003c")


def inline_images(manifest_text: str, report: list[str]) -> str:
    """Remplace les chemins d'images du manifeste par des URI de données."""
    try:
        manifest = json.loads(manifest_text)
    except json.JSONDecodeError:
        return manifest_text
    for page in manifest.get("pages", []):
        rel = page.get("image")
        if not rel:
            continue
        path = PROJECT_DIR / rel
        if not path.exists():
            report.append(f"    image absente, laissée telle quelle : {rel}")
            continue
        mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
        b64 = base64.b64encode(path.read_bytes()).decode("ascii")
        page["image"] = f"data:{mime};base64,{b64}"
        report.append(f"    image intégrée : {rel} ({path.stat().st_size / 1024:.0f} Ko)")
    return json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))


SHIM = """
/* ── Mode autonome ────────────────────────────────────────────────────────────
   Les données sont embarquées dans la page. On intercepte `fetch` avant le
   démarrage de l'application : elle continue de croire qu'elle lit des fichiers,
   ce qui évite d'avoir deux versions du code à maintenir.
   Un jeu absent renvoie une réponse 404 — la section se masque alors d'elle-même,
   comme en ligne. */
(function () {
  var BUNDLE = __BUNDLE__;
  var real = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var key = String(url).split('?')[0].replace(/^\\.?\\//, '');
    if (Object.prototype.hasOwnProperty.call(BUNDLE, key)) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve(BUNDLE[key]); },
        text: function () { return Promise.resolve(JSON.stringify(BUNDLE[key])); }
      });
    }
    if (String(key).indexOf('data/') === 0) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: function () { return Promise.reject(new Error('absent du fichier autonome')); },
        text: function () { return Promise.resolve(''); }
      });
    }
    return real ? real(input, init)
                : Promise.reject(new Error('hors ligne : ' + url));
  };
})();
"""


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Dashboard en un fichier autonome.")
    p.add_argument("--out", default=None,
                   help="chemin du fichier produit (défaut : dashboard-autonome.html)")
    p.add_argument("--skip", default="",
                   help="jeux à exclure, séparés par des virgules (ex. terms,tracking)")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}

    index = PROJECT_DIR / "index.html"
    css = PROJECT_DIR / "assets" / "styles.css"
    js = PROJECT_DIR / "assets" / "app.js"
    for f in (index, css, js):
        if not f.exists():
            sys.exit(f"Fichier introuvable : {f}")

    html = index.read_text(encoding="utf-8")
    report: list[str] = []

    # ── Données ───────────────────────────────────────────────────────────────
    bundle_parts = []
    total = 0
    for rel in DATA_FILES:
        short = Path(rel).stem
        if short in skip:
            report.append(f"  {rel:<28} exclu à la demande")
            continue
        path = PROJECT_DIR / rel
        if not path.exists():
            report.append(f"  {rel:<28} absent — section masquée")
            continue
        raw = path.read_text(encoding="utf-8")
        if rel.endswith("landing-pages.json"):
            raw = inline_images(raw, report)
        size = len(raw.encode("utf-8"))
        total += size
        report.insert(len(report), f"  {rel:<28} {size / 1024:>8.0f} Ko")
        bundle_parts.append(f'{json.dumps(rel)}: {js_safe(raw)}')

    if not bundle_parts:
        sys.exit("Aucune donnée à embarquer : lancez d'abord un collecteur.")

    bundle = "{\n" + ",\n".join(bundle_parts) + "\n}"

    # ── CSS et JS ─────────────────────────────────────────────────────────────
    style = f"<style>\n{css.read_text(encoding='utf-8')}\n</style>"
    # str.replace et non re.sub : re interpreterait les antislashs du texte
    # insere — une regle CSS comme content: "\2014" serait silencieusement
    # corrompue. Aucun antislash dans la feuille actuelle, mais rien ne garantit
    # qu'il en reste ainsi.
    tag_css = '<link rel="stylesheet" href="assets/styles.css">'
    if tag_css not in html:
        sys.exit("La balise de feuille de style n'a pas ete trouvee dans index.html.")
    html = html.replace(tag_css, style, 1)

    app = js.read_text(encoding="utf-8")
    script = ("<script>\n" + SHIM.replace("__BUNDLE__", bundle) + "\n</script>\n"
              + "<script>\n" + js_safe_script(app) + "\n</script>")
    tag_js = '<script src="assets/app.js"></script>'
    if tag_js not in html:
        sys.exit("La balise de script n'a pas été trouvée dans index.html.")
    html = html.replace(tag_js, script, 1)
    if "assets/app.js" in html:
        sys.exit("La balise de script n'a pas été trouvée dans index.html.")

    # ── Retraits propres au mode autonome ─────────────────────────────────────
    # Le lien vers la page de cannibalisation mène à un second fichier : un
    # fichier unique ne peut pas l'embarquer, les navigateurs bloquant la
    # navigation vers une URL « data: ». Mieux vaut le retirer que laisser un
    # lien mort.
    html, n = re.subn(
        r'<a class="btn btn--ghost header-link"[\s\S]*?</a>\s*', "", html, count=1)
    if n:
        report.append("  lien « Cannibalisation » retiré (page externe)")

    stamp = dt.datetime.now().astimezone()
    note = (f'<p class="page-footer__note">Fichier autonome exporté le '
            f'{stamp.strftime("%d/%m/%Y à %H:%M")} — les données sont figées à cette '
            f'date et ne se rafraîchissent plus.</p>\n')
    html = html.replace("</footer>", note + "</footer>", 1)

    out = Path(args.out).expanduser() if args.out else PROJECT_DIR / "dashboard-autonome.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")

    print("Jeux embarqués :")
    for line in report:
        print(line)
    size = out.stat().st_size / 1024 / 1024
    print(f"\nÉcrit {out}")
    print(f"  {size:.1f} Mo — s'ouvre d'un double-clic, sans serveur ni réseau")
    if size > 12:
        print("  ⚠ fichier volumineux : « --skip terms,tracking » le réduit nettement")


def js_safe_script(code: str) -> str:
    """Empêche une chaîne « </script> » du code de refermer la balise.

    Le code source contient des littéraux HTML ; la séquence fermante y est
    remplacée par une forme équivalente à l'exécution.
    """
    return code.replace("</script>", "<\\/script>")


if __name__ == "__main__":
    main()
