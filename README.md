# Reporting Google Ads

Dashboard de performance Google Ads multi-comptes : filtre par compte, période,
appareil, réseau et campagne. Page statique, sans dépendance ni build — elle
s'héberge telle quelle sur GitHub Pages.

```
index.html            la page
assets/styles.css     palette, thème clair/sombre, mise en page
assets/app.js         agrégation en mémoire et rendu SVG
data/data.json        les données (le seul fichier à régénérer)
scripts/
  fetch_ads_data.py     récupère les vraies performances depuis l'API Google Ads
  get_refresh_token.py  obtient le refresh token OAuth (une seule fois)
  gen_demo_data.py      génère un jeu de démonstration au même schéma
  config.example.json   modèle de configuration à copier
```

---

## ⚠️ Avant de publier : ce dépôt est public

Sur un dépôt public, **toute personne connaissant l'URL voit vos données** :
coûts, conversions, noms de campagnes et de comptes. GitHub Pages sur dépôt privé
exige un plan payant (Pro ou Team).

Deux garde-fous sont en place :

- `data/data.json` ne contient que des **chiffres déjà agrégés** — jamais de
  requêtes de recherche, de données clients ni d'identifiants.
- `scripts/config.json` (vos credentials) est **gitignoré**. Ne le forcez jamais
  avec `git add -f`. Un secret poussé sur un dépôt public doit être considéré
  comme compromis, même après suppression : l'historique Git le conserve et les
  robots d'indexation le récupèrent en quelques minutes.

Si ces données ne doivent pas être publiques, arrêtez-vous ici et choisissez un
plan GitHub payant, ou un hébergement protégé par authentification.

---

## 1. Voir le dashboard en local

Le dépôt contient déjà un `data/data.json` de démonstration.

```bash
python -m http.server 8000
```

Puis ouvrez <http://localhost:8000>.

> **Ne l'ouvrez pas en double-cliquant sur `index.html`.** En `file://`, le
> navigateur bloque la lecture de `data/data.json` et la page reste vide.

---

## 2. Brancher vos vraies données

### 2.1 Ce qu'il faut réunir

| Élément | Où l'obtenir |
|---|---|
| **Developer token** | Google Ads → compte MCC → Outils → *Centre d'API*. Un token en accès *Test* ne lit que les comptes de test : demandez l'accès *Basic*. |
| **ID client MCC** | En haut à droite de l'interface Google Ads, 10 chiffres (`123-456-7890`). |
| **Client ID / Client secret** | [Google Cloud Console](https://console.cloud.google.com) → activez *Google Ads API* → *Identifiants* → ID client OAuth de type **Application de bureau**. |
| **Refresh token** | Voir ci-dessous. |

### 2.2 Configurer

```bash
cp scripts/config.example.json scripts/config.json
```

Renseignez les **quatre** champs que vous seul pouvez obtenir :
`developer_token`, `client_id`, `client_secret`, `login_customer_id`.
Le cinquième — `refresh_token` — est rempli automatiquement à l'étape suivante.

Alternative sans fichier : les variables d'environnement
`GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`,
`GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`,
`GOOGLE_ADS_LOGIN_CUSTOMER_ID`.

### 2.3 Obtenir le refresh token

```bash
python scripts/get_refresh_token.py
```

Votre navigateur s'ouvre sur l'écran de consentement Google. Vous autorisez, et le
script écrit le token directement dans `scripts/config.json`.

Le token n'est **jamais affiché** : il ne passe donc pas par votre historique de
terminal. Le script n'a aucune dépendance (le flux OAuth, PKCE compris, est
implémenté sur la stdlib) — inutile d'installer `google-auth-oauthlib`.

C'est la seule étape qui demande une interaction ; tout le reste est automatisable.

> Si l'ID client OAuth est de type **Application Web** et non *Application de
> bureau*, ajoutez-y `http://localhost:8080/` comme URI de redirection autorisée.
> Si le port 8080 est occupé : `OAUTH_PORT=8081 python scripts/get_refresh_token.py`
> (et déclarez ce port côté Google).

Un refresh token est révoqué si le mot de passe du compte change, si l'accès est
retiré, ou après 6 mois d'inutilisation. Relancez alors ce script.

Si Google ne renvoie pas de refresh token, c'est que l'accès avait déjà été
accordé : révoquez-le sur <https://myaccount.google.com/permissions> et relancez.

### 2.4 Récupérer

```bash
python scripts/fetch_ads_data.py                      # 180 derniers jours, tous les comptes
python scripts/fetch_ads_data.py --days 365
python scripts/fetch_ads_data.py --start 2026-01-01 --end 2026-06-30
python scripts/fetch_ads_data.py --accounts 1234567890,9876543210
```

Le script énumère les comptes actifs du MCC, interroge chacun, agrège et écrit
`data/data.json`. Un compte inaccessible n'interrompt pas le rapport : il est
signalé dans `meta.failed_accounts` et un bandeau l'indique sur la page.

**Récupérez toujours le double de la période que vous analyserez** : le dashboard
calcule les évolutions en comparant à la période précédente de même longueur. Sur
180 jours de données, une vue « 90 j » a sa comparaison ; une vue « Tout » ne
l'aura pas.

### 2.5 Comptes en plusieurs devises

Additionner des CHF et des EUR donne un total faux. Si votre MCC mélange les
devises, le script vous avertit et la page affiche un bandeau. Pour corriger,
renseignez dans `scripts/config.json` :

```json
{
  "report_currency": "CHF",
  "currency_rates": { "EUR": 0.94, "USD": 0.88 }
}
```

Les taux sont fixes, appliqués à toute la période — suffisant pour un reporting,
pas pour de la comptabilité.

---

## 3. Publier sur GitHub Pages

### 3.1 Créer le dépôt et pousser

Créez un dépôt **public** vide sur <https://github.com/new> — sans README, sans
`.gitignore` (ils existent déjà ici). Puis :

```bash
cd ads-reporting
git remote add origin https://github.com/VOTRE-COMPTE/VOTRE-REPO.git
git branch -M main
git push -u origin main
```

### 3.2 Activer Pages

Dans le dépôt : **Settings → Pages**, puis *Source* = **Deploy from a branch**,
*Branch* = `main`, dossier = `/ (root)`. Enregistrez.

Après une à deux minutes, votre URL partageable est :

```
https://VOTRE-COMPTE.github.io/VOTRE-REPO/
```

### 3.3 Mettre à jour les données

```bash
python scripts/fetch_ads_data.py
git add data/data.json
git commit -m "Mise à jour des données"
git push
```

Le site se redéploie automatiquement.

### 3.4 Rafraîchissement automatique (optionnel)

`.github/workflows/refresh-data.yml` récupère les données chaque jour et les
commite. Pour l'activer, ajoutez vos credentials dans **Settings → Secrets and
variables → Actions** :

`GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`,
`GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`,
`GOOGLE_ADS_LOGIN_CUSTOMER_ID`.

Les secrets d'Actions ne sont pas exposés publiquement, même sur un dépôt public,
et ne sont pas transmis aux workflows déclenchés par des forks. Ils restent
toutefois lisibles par quiconque peut pousser sur le dépôt : ne donnez l'accès en
écriture qu'à des personnes de confiance.

---

## 4. Utiliser le dashboard

**Filtres** — une seule rangée en haut, qui cadre tout ce qui est en dessous :
période (7 / 30 / 90 jours, mois en cours, tout, ou personnalisée), comptes,
appareil, réseau, nom de campagne. Tous les graphiques, tuiles et tableaux se
recalculent sur la même sélection.

Dans le menu *Comptes*, un premier clic **isole** le compte cliqué ; les clics
suivants ajoutent ou retirent. Tout désélectionner revient à « tous ».

**Liens partageables** — l'état des filtres est écrit dans l'URL. Copiez la barre
d'adresse et le destinataire ouvre exactement la même vue :

```
…/#r=90&g=week&a=1,3&m=roas
```

**Vue tableau** — chaque graphique a un bouton *Tableau* qui affiche les mêmes
chiffres sous forme lisible et copiable. *Exporter en CSV* produit un fichier
séparé par points-virgules, à décimale virgule et BOM UTF-8, qui s'ouvre
directement dans Excel en locale francophone.

**Thème** — le bouton en haut à droite bascule clair/sombre ; par défaut la page
suit le réglage du système. Le choix est mémorisé dans le navigateur.

**Lecture des graphiques** — survolez pour un réticule qui liste toutes les
séries à la date pointée. Au clavier, `Tab` jusqu'au graphique puis les flèches
parcourent les dates. Cliquer une entrée de légende masque ou réaffiche sa série.

### Ce que les chiffres veulent dire

Les indicateurs dérivés (CTR, CPC, CPA, ROAS, taux de conversion) sont **toujours
recalculés sur les totaux agrégés** de la sélection, jamais moyennés depuis des
valeurs déjà dérivées — une moyenne de ratios ne serait pas le ratio des totaux.

Une courbe s'interrompt là où l'indicateur n'est pas calculable (un CPA sans
conversion n'est pas zéro, il n'existe pas). Dans les classements par CPA ou
ROAS, les campagnes de moins de 5 clics sont écartées : sur si peu de volume le
ratio est du bruit et écraserait l'échelle.

En vue hebdomadaire ou mensuelle, les périodes tronquées par les bornes du filtre
sont signalées sous le titre — sans cela, une semaine d'un seul jour se lirait
comme un effondrement.

---

## Notes techniques

`data/data.json` est **colonnaire** : les dates, campagnes, appareils et réseaux
sont des tables d'index, et `facts` un tableau de tuples

```
[date, campagne, appareil, réseau, impressions, clics, coût, conversions, valeur]
```

Ce format tient 180 jours × 31 campagnes en ~780 Ko, ce qui se charge d'un coup
et se filtre en mémoire sans requête réseau. Au-delà de ~2 Mo (plusieurs
centaines de campagnes sur un an), réduisez la fenêtre avec `--days` ou scindez
par MCC.

Les couleurs suivent l'entité, pas son rang : un compte garde sa teinte quels que
soient les filtres. Au-delà de 7 comptes, la queue est repliée sur « Autres »
plutôt que de recycler des teintes indistinguables.

L'API Google Ads est appelée en `v21`. Si Google sunsette cette version, changez
la constante `API_VERSION` en tête de `scripts/fetch_ads_data.py`.
