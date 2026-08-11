#!/usr/bin/env python3
"""
Obtient un refresh token Google Ads et l'écrit dans scripts/config.json.

Aucune dépendance externe : stdlib uniquement (contrairement à la méthode
habituelle qui impose `pip install google-auth-oauthlib`).

    python scripts/get_refresh_token.py

Le script lit client_id et client_secret depuis scripts/config.json, ouvre votre
navigateur sur l'écran de consentement Google, récupère le code d'autorisation
sur un serveur local éphémère, l'échange contre un refresh token, puis met à jour
config.json.

Le token n'est jamais affiché à l'écran : il va directement dans le fichier, pour
qu'il ne se retrouve pas dans un historique de terminal ou un journal.

Prérequis — un ID client OAuth de type « Application de bureau » créé sur
https://console.cloud.google.com (API Google Ads activée). Si votre client est de
type « Application Web », ajoutez-y l'URI de redirection autorisée
http://localhost:8080/ .
"""

from __future__ import annotations

import base64
import hashlib
import http.server
import json
import os
import secrets
import socket
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "config.json"

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/adwords"

DEFAULT_PORT = 8080
TIMEOUT_SECONDS = 300


def die(message: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"\nErreur : {message}", file=sys.stderr)
    raise SystemExit(1)


# ── Page renvoyée au navigateur ──────────────────────────────────────────────

PAGE = """<!DOCTYPE html>
<meta charset="utf-8">
<title>{title}</title>
<style>
  body {{ font: 16px system-ui, -apple-system, "Segoe UI", sans-serif;
         display: grid; place-items: center; min-height: 100vh; margin: 0;
         background: #f9f9f7; color: #0b0b0b; }}
  .card {{ background: #fcfcfb; border: 1px solid rgba(11,11,11,.1);
           border-radius: 10px; padding: 32px 40px; max-width: 30rem;
           text-align: center; }}
  h1 {{ font-size: 18px; margin: 0 0 8px; }}
  p {{ color: #52514e; margin: 0; line-height: 1.5; }}
  .mark {{ font-size: 32px; margin-bottom: 12px; }}
</style>
<div class="card">
  <div class="mark">{mark}</div>
  <h1>{title}</h1>
  <p>{body}</p>
</div>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    """Capture le code d'autorisation renvoyé par Google sur la boucle locale."""

    result: dict = {}
    expected_state: str = ""

    def do_GET(self) -> None:  # noqa: N802  (nom imposé par BaseHTTPRequestHandler)
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        # Le navigateur réclame souvent /favicon.ico : ne pas le prendre pour un retour.
        if parsed.path not in ("/", "/callback"):
            self.send_response(404)
            self.end_headers()
            return

        error = params.get("error", [None])[0]
        code = params.get("code", [None])[0]
        state = params.get("state", [None])[0]

        if error:
            Handler.result = {"error": error}
            self._render(400, "✕", "Autorisation refusée",
                         f"Google a renvoyé : {error}. Vous pouvez fermer cet onglet.")
        elif not code:
            self._render(400, "✕", "Requête inattendue",
                         "Aucun code d'autorisation reçu.")
            return
        elif state != Handler.expected_state:
            # Protection CSRF : un state qui ne correspond pas est rejeté.
            Handler.result = {"error": "state_mismatch"}
            self._render(400, "✕", "Vérification échouée",
                         "Le paramètre de sécurité ne correspond pas. Relancez le script.")
        else:
            Handler.result = {"code": code}
            self._render(200, "✓", "Autorisation accordée",
                         "Le refresh token a été enregistré. Vous pouvez fermer cet onglet "
                         "et revenir au terminal.")

    def _render(self, status: int, mark: str, title: str, body: str) -> None:
        html = PAGE.format(mark=mark, title=title, body=body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)

    def log_message(self, *args) -> None:
        """Silence les logs HTTP : ils afficheraient le code d'autorisation."""


# ── Configuration ────────────────────────────────────────────────────────────


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        die(
            f"{CONFIG_PATH.name} est absent.\n"
            "  cp scripts/config.example.json scripts/config.json\n"
            "puis renseignez client_id et client_secret."
        )
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        die(f"scripts/config.json est un JSON invalide : {exc}")

    placeholder = ("VOTRE_", "xxxx", "GOCSPX-xxxx")
    for key in ("client_id", "client_secret"):
        val = str(cfg.get(key) or "")
        if not val or val.startswith(placeholder):
            die(
                f"« {key} » n'est pas renseigné dans scripts/config.json.\n"
                "Créez un ID client OAuth de type « Application de bureau » sur\n"
                "https://console.cloud.google.com/apis/credentials"
            )
    return cfg


def save_refresh_token(cfg: dict, token: str) -> None:
    cfg["refresh_token"] = token
    CONFIG_PATH.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def free_port(preferred: int) -> int:
    """Le port doit rester prévisible : Google exige une redirection déclarée."""
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            die(
                f"Le port {preferred} est déjà utilisé. Libérez-le puis relancez : "
                "l'URI de redirection doit correspondre à celle acceptée par Google."
            )


# ── Flux OAuth ───────────────────────────────────────────────────────────────


def exchange_code(cfg: dict, code: str, redirect_uri: str, verifier: str) -> str:
    body = urllib.parse.urlencode({
        "code": code,
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
        "code_verifier": verifier,
    }).encode("utf-8")

    req = urllib.request.Request(
        TOKEN_ENDPOINT, data=body, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        die(f"L'échange du code a échoué (HTTP {exc.code}) : {detail}")
    except urllib.error.URLError as exc:
        die(f"Réseau indisponible : {exc.reason}")

    token = payload.get("refresh_token")
    if not token:
        # Sans refresh_token, c'est presque toujours un consentement déjà accordé.
        die(
            "Google n'a pas renvoyé de refresh_token.\n"
            "Cela arrive quand l'accès a déjà été autorisé auparavant. Révoquez-le sur\n"
            "https://myaccount.google.com/permissions puis relancez ce script."
        )
    return token


def main() -> int:
    cfg = load_config()
    port = free_port(int(os.environ.get("OAUTH_PORT", DEFAULT_PORT)))
    redirect_uri = f"http://localhost:{port}/"

    # PKCE : le code d'autorisation ne peut être échangé que par ce processus.
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).decode().rstrip("=")

    Handler.expected_state = secrets.token_urlsafe(24)
    Handler.result = {}

    auth_url = AUTH_ENDPOINT + "?" + urllib.parse.urlencode({
        "client_id": cfg["client_id"],
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE,
        # offline + consent : sans cela Google ne délivre pas de refresh token.
        "access_type": "offline",
        "prompt": "consent",
        "state": Handler.expected_state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })

    server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    server.timeout = 1

    print("\nOuverture de l'écran de consentement Google…")
    print("Si le navigateur ne s'ouvre pas, collez cette adresse :\n")
    print(f"  {auth_url}\n")
    print(f"En attente de l'autorisation (délai {TIMEOUT_SECONDS // 60} min)…")

    threading.Thread(target=lambda: webbrowser.open(auth_url), daemon=True).start()

    waited = 0
    while not Handler.result and waited < TIMEOUT_SECONDS:
        server.handle_request()
        waited += 1
    server.server_close()

    if not Handler.result:
        die("Délai dépassé : aucune autorisation reçue.")
    if "error" in Handler.result:
        die(f"Autorisation non accordée ({Handler.result['error']}).")

    token = exchange_code(cfg, Handler.result["code"], redirect_uri, verifier)
    save_refresh_token(cfg, token)

    print(f"\n✓ Refresh token enregistré dans {CONFIG_PATH}")
    print("  (il n'est volontairement pas affiché ici)")

    missing = [
        k for k in ("developer_token", "login_customer_id")
        if not str(cfg.get(k) or "") or str(cfg.get(k)).startswith(("VOTRE_", "xxxx"))
    ]
    if missing:
        print(f"\nIl reste à renseigner dans config.json : {', '.join(missing)}")
    else:
        print("\nTout est en place. Lancez :\n  python scripts/fetch_ads_data.py")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrompu.", file=sys.stderr)
        raise SystemExit(130)
