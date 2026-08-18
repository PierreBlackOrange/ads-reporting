#!/usr/bin/env python3
"""
Capture les pages de destination des A/B tests → assets/lp/*.jpg

    python scripts/capture_lp.py
    python scripts/capture_lp.py --only c27          # une seule entrée
    python scripts/capture_lp.py --width 624 --scale 0.75

POURQUOI CAPTURER PLUTÔT QUE POINTER VERS LE SITE
-------------------------------------------------
Une balise <img> vers spiice.com afficherait la page telle qu'elle est
AUJOURD'HUI. Or l'intérêt d'un A/B test est de comparer deux pages à un moment
donné : si la variante est modifiée pendant le test, ou promue à la fin, le
dashboard afficherait rétroactivement la mauvaise image et le test deviendrait
illisible. Les captures sont donc versionnées dans le dépôt, datées, et ne
changent que sur commande.

Elles pèsent une cinquantaine de kilo-octets chacune.

CE QUI EST RENSEIGNÉ À LA MAIN, ET POURQUOI
-------------------------------------------
L'appariement bras → URL vient de data/landing-pages.json. L'API Google Ads ne
donne pas l'URL finale d'un bras d'expérience : deux campagnes d'un même test
peuvent pointer vers des pages différentes sans que rien dans les données ne le
dise. Deviner à partir des noms de campagne serait une invention.

⚠️ Ce dépôt est public : les captures le seront aussi.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
MANIFEST = PROJECT_DIR / "data" / "landing-pages.json"

# Navigateurs acceptés, dans l'ordre de préférence. Edge et Chrome partagent les
# mêmes options de capture ; sur un runner Linux c'est chromium qu'on trouvera.
CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "msedge", "google-chrome", "chromium", "chromium-browser",
]


def find_browser() -> str:
    for c in CANDIDATES:
        if os.path.sep in c or (len(c) > 2 and c[1] == ":"):
            if Path(c).exists():
                return c
        else:
            found = shutil.which(c)
            if found:
                return found
    sys.exit("Aucun navigateur basé sur Chromium trouvé (Edge, Chrome ou Chromium).")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Captures des pages de destination.")
    p.add_argument("--width", type=int, default=624,
                   help="largeur de la fenêtre de capture (défaut : 624)")
    p.add_argument("--height", type=int, default=1355)
    p.add_argument("--scale", type=float, default=0.75,
                   help="réduction appliquée à l'image finale (défaut : 0,75)")
    p.add_argument("--quality", type=int, default=82, help="qualité JPEG")
    p.add_argument("--only", default=None, help="ne traiter que les URL contenant ce texte")
    p.add_argument("--wait", type=int, default=25000,
                   help="temps virtuel accordé au chargement, en ms")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    if not MANIFEST.exists():
        sys.exit(f"Manifeste absent : {MANIFEST}")
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    pages = data.get("pages") or []
    if args.only:
        pages = [p for p in pages if args.only in p.get("url", "")]
    if not pages:
        sys.exit("Aucune page à capturer.")

    browser = find_browser()
    print(f"Navigateur : {browser}")
    print(f"Fenêtre : {args.width}×{args.height} · réduction {args.scale:g} · "
          f"qualité {args.quality}")

    try:
        from PIL import Image  # noqa: F401
        pillow = True
    except ImportError:
        pillow = False
        print("Pillow absent : les captures resteront en PNG non réduit. "
              "« pip install pillow » pour obtenir des JPEG légers.")

    today = dt.date.today().isoformat()
    changed = False

    for page in pages:
        url = page.get("url")
        rel = page.get("image")
        if not url or not rel:
            print(f"  entrée incomplète, ignorée : {page}")
            continue
        out = PROJECT_DIR / rel
        out.parent.mkdir(parents=True, exist_ok=True)

        with tempfile.TemporaryDirectory() as tmp:
            shot = Path(tmp) / "shot.png"
            cmd = [
                browser, "--headless=new", "--disable-gpu", "--no-first-run",
                "--no-default-browser-check", "--hide-scrollbars",
                f"--window-size={args.width},{args.height}",
                f"--virtual-time-budget={args.wait}",
                f"--user-data-dir={Path(tmp) / 'profile'}",
                f"--screenshot={shot}", url,
            ]
            res = subprocess.run(cmd, capture_output=True, text=True)
            if not shot.exists():
                print(f"  ÉCHEC {url}\n    {res.stderr.strip()[:300]}")
                continue

            if pillow:
                from PIL import Image
                img = Image.open(shot).convert("RGB")
                if args.scale != 1:
                    w = max(1, int(img.width * args.scale))
                    h = max(1, int(img.height * args.scale))
                    img = img.resize((w, h), Image.LANCZOS)
                img.save(out, "JPEG", quality=args.quality, optimize=True,
                         progressive=True)
            else:
                # Sans Pillow, on conserve le PNG brut sous le nom demandé plutôt
                # que de prétendre produire un JPEG.
                out = out.with_suffix(".png")
                shutil.copyfile(shot, out)

        page["captured_at"] = today
        changed = True
        size = out.stat().st_size / 1024
        print(f"  {out.relative_to(PROJECT_DIR)}  {size:.0f} Ko  ← {url}")

    if changed:
        data.setdefault("meta", {})["last_capture"] = today
        MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n",
                            encoding="utf-8")
        print(f"\nManifeste mis à jour : {MANIFEST.relative_to(PROJECT_DIR)}")
    print("\nPensez à commiter les images ET le manifeste : le dashboard lit les deux.")


if __name__ == "__main__":
    main()
