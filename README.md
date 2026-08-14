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
  fetch_ads_data.py      récupère les vraies performances depuis l'API Google Ads
  fetch_search_terms.py  récupère les termes de recherche (section sémantique)
  enrich_terms.py        score sémantique + intention via l'API Claude
  get_refresh_token.py   obtient le refresh token OAuth (une seule fois)
  gen_demo_data.py       génère un jeu de démonstration au même schéma
  config.example.json    modèle de configuration à copier
```

## Onglet Live

La journée en cours heure par heure, face au même jour de la semaine
précédente à heure égale.

```bash
python scripts/fetch_live.py --accounts 3384610932,9875320091
```

`.github/workflows/refresh-live.yml` le relance toutes les 15 minutes entre 6h
et 23h (heure de Paris) et commite le résultat.

⚠️ **« Live » plafonne à 15-30 minutes de fraîcheur.** GitHub Pages sert un
fichier statique : chaque mise à jour demande un commit et un redéploiement. Le
cron GitHub Actions a une granularité minimale de 5 minutes et se déclenche
souvent avec 5 à 15 minutes de retard, auxquelles s'ajoute le déploiement de
Pages. L'interface affiche l'heure d'arrêt des données et la passe en rouge
au-delà de 45 minutes. Pour du temps réel, il faut un hébergement dynamique.

### Le délai de consolidation des conversions

Google rattache les conversions à l'heure du **clic** et les remonte avec
retard. Relevé sur le compte principal à 11h :

| heure | 0h | 1h | 2h | 3h | 4h | 5h … 10h | 11h |
|---|---|---|---|---|---|---|---|
| aujourd'hui | 4,0 | 3,2 | 1,0 | 5,0 | 3,0 | **0,0** | 0,0 |
| la veille | 7,0 | 2,0 | 1,3 | 2,0 | 2,0 | 0,3 … 2,0 | 6,7 |

La veille et J-7 ont des conversions sur les 24 heures : le trou de sept heures
est du retard, pas une absence. Une alerte « aucune conversion depuis 1 heure »
sonnerait donc en permanence.

Deux conséquences :

- Le tableau de bord utilise **`all_conversions`**, dont le retard est bien
  moindre (données jusqu'à 10h contre 4h pour la colonne `conversions`).
- **L'alerte n'évalue que la dernière heure consolidée.** La frontière n'est pas
  codée en dur : elle se déduit du rapport entre le volume du jour et celui de
  la même heure J-7. Un repère vertical la matérialise sur le graphique.

Le coût, lui, remonte quasiment en temps réel — la comparaison de dépense est
fiable dès l'heure en cours.

## Section sémantique (optionnelle)

Trois analyses des termes de recherche, dans un jeu de données distinct
(`data/terms.json`) chargé à la demande pour ne pas alourdir le rapport
principal : dérive sémantique par requête, clustering d'intention, et
n-grammes émergents/déclinants.

```bash
python scripts/fetch_search_terms.py --days 90 --max-pairs 8000
pip install anthropic
python scripts/enrich_terms.py --dry-run   # estime le coût API
python scripts/enrich_terms.py
```

**Le n-gramme fonctionne sans l'étape d'enrichissement** — c'est du calcul pur.
Les deux autres graphiques restent vides tant que `enrich_terms.py` n'a pas
tourné, car ils reposent sur un scoring par modèle de langage.

Deux choix de volumétrie, mesurés et non devinés :

- **`clics > 0`** au niveau de la requête API. Sur le compte le plus dépensier,
  cela fait passer 33 542 lignes à 7 482 sur 7 jours **pour un coût total
  identique** — un terme sans clic ne dépense rien. Sans ce filtre, 90 jours ×
  21 comptes représentent environ 14 millions de lignes.
- **Plafond de paires.** Le coût est très concentré : les 100 premières paires
  portent 55 % de la dépense d'un compte. À l'échelle du MCC la traîne est plus
  longue — 8 000 paires couvrent 66 % de la dépense. La couverture réellement
  atteinte est calculée à chaque exécution et affichée dans le dashboard.

⚠️ **`data/terms.json` est gitignoré par défaut.** Il contient les requêtes
réellement tapées par des internautes — une catégorie de données distincte des
noms de campagnes, et dont la redistribution est encadrée par les conditions
d'utilisation de Google Ads. Pour le publier délibérément :
`git add -f data/terms.json`.

---

## Section AI Max

```bash
python scripts/fetch_aimax.py --days 90 --max-terms 4000
python scripts/probe_aimax.py     # que l'API expose-t-elle sur AI Max ?
```

Ce que capte AI Max, ce que ça convertit, et à quel ROAS — face aux autres types
de correspondance. Chargée sans bouton : l'agrégat pèse une fraction de
`data.json`. La section **se masque d'elle-même** si le fichier n'existe pas.

### D'où viennent les données

AI Max est récent et son modèle de données ne se devine pas. `probe_aimax.py`
interroge `GoogleAdsFieldService`, qui décrit l'API elle-même, plutôt que de
supposer un nom de champ. Trois points d'accroche en sont ressortis :

| Champ | Ce qu'il donne |
|---|---|
| `campaign.ai_max_setting.enable_ai_max` | activé ou non, par campagne |
| `segments.search_term_match_type = AI_MAX` | requêtes appariées par AI Max |
| `segments.search_term_match_source` | `AI_MAX_BROAD_MATCH` (élargissement d'un mot-clé) ou `AI_MAX_KEYWORDLESS` (trafic sans aucun mot-clé) |

Les deux segments partitionnent les mêmes lignes — leurs totaux de coût
coïncident au centime, vérifié avant de les croiser. Contrairement à l'action de
conversion, les croiser ne duplique donc aucune dépense.

Deux détections plutôt qu'une : le réglage lu est l'état **actuel**, si bien
qu'une campagne activée puis désactivée pendant la fenêtre n'y figure plus. Le
trafic effectivement apparié en `AI_MAX` la rattrape.

### Le périmètre

Ce sont les **comptes où AI Max est activé**, pas le MCC entier. Comparer AI Max
aux autres correspondances n'a de sens qu'à l'intérieur de ces comptes : ailleurs
sa part serait diluée dans un total sans rapport, et d'autres devises entreraient
dans l'agrégat. Le bandeau de la section le dit et nomme les comptes retenus.

La fenêtre est fixe (90 jours) et **ne suit pas le filtre de période**, comme les
sections sémantique et types de correspondance qui reposent sur le même genre
d'agrégat pré-calculé. Le filtre de comptes, lui, s'applique partout.

### Lectures à ne pas fausser

Les totaux annoncés viennent des **cellules agrégées, exhaustives**, jamais de la
liste de requêtes plafonnée : autrement le ROAS d'une carte contredirait celui du
bandeau, tous deux justes mais calculés sur des ensembles différents. La liste
détaillée annonce la part du coût qu'elle couvre ; le pied de tableau totalise ce
que la table montre, pas le périmètre.

Sur le ROAS, les écarts se jouent autour de 1 : le graphique porte un repère au
seuil de rentabilité. Les barres partent toujours de zéro — tronquer l'échelle
pour « voir mieux » fausserait les longueurs.

Le dernier mois de la montée en charge est presque toujours **partiel** (la
fenêtre s'arrête à la veille de l'extraction) et le sous-titre le signale. Une
part reste lisible sur un mois incomplet ; un ROAS beaucoup moins, les
conversions y remontant encore.

`NEAR_EXACT` et `NEAR_PHRASE` sont traduits en « variante proche » et non en
« exact » / « expression » : ce sont des variantes que Google apparie sans que
l'annonceur les ait écrites, les confondre avec les ciblages déclarés serait un
contresens.

⚠️ **`data/aimax.json` est gitignoré par défaut**, pour la même raison que
`terms.json` : les requêtes captées sont des recherches réellement tapées. Pour
le publier délibérément : `git add -f data/aimax.json`.

---

## Onglet Tracking / Consent Mode

`#vue=tracking`, alimenté par `data/tracking.json`
(`python scripts/fetch_tracking.py`) et, facultativement, par
`data/changelog.json` (`python scripts/fetch_changelog.py`). Chargé à l'ouverture
de l'onglet.

### Périmètre : neuf comptes

L'onglet ne regarde que les comptes réellement suivis — un diagnostic sur un
compte que personne ne surveille produit des alertes que personne ne traitera, et
noie celles qui comptent :

`gdm_spiice-google-fr` · `gdm_jacquie_michel_contact_fr` ·
`2lm_jacquie_et_michel_rencontre` · `gdm_femme-liberee_homme` · `Easyflirt` ·
`JM_SWIPE` · `Onlydate_93781` · `fr_sexy_1` · `fr_love_toprencontreserieuse`

La liste est la constante `TRACKING_SCOPE` dans `assets/app.js`. Deux comptes
« Spiice » existent : `gdm_spiice-google-fr` (Recherche) est dans le périmètre,
`gdm_Spiice_App` et `Spiice_Display` non. Sélectionner un compte hors périmètre
dans la barre du haut affiche un message explicite, pas un onglet vide.

Sur ce périmètre, la part des conversions vues par les enchères tombe à **4,2 %**
(contre 10,6 % sur les 21 comptes actifs) : l'essentiel de ce qui est mesuré ici
n'optimise rien.

### ⚠️ Ce que l'API Google Ads ne sait pas

Sondé sur la v25 avant d'écrire une ligne d'interface, puis vérifié
exhaustivement : **les 181 ressources de la v25 ont été énumérées**, et les 30
champs de `conversion_action` listés un par un.

| Demandé | Réponse de l'API |
|---|---|
| Taux de Consent Mode granted / denied | **`%consent%` → 0 champ** |
| Conversions modélisées vs observées | **`%model%led%` → 0 champ** |
| Écran *Diagnostics* d'une action de conversion | **aucune ressource ne l'expose** |

L'écran `MCC > Goals > Conversions > Summary > [action] > Diagnostics` de
l'interface n'a pas d'équivalent API. Les champs les plus proches de
`conversion_action` sont `attribution_model_settings.data_driven_model_status`
(disponibilité du modèle d'attribution, pas la modélisation des conversions),
`origin`, `status`, `type` et `tag_snippets`. Aucun ne porte le statut du
consentement.

Ces données existent dans la CMP (Didomi), dans GTM et dans GA4. Afficher « 98 %
de consentement » à partir de rien serait le pire service à rendre à quelqu'un
qui cherche une cassure de mesure, donc l'onglet ne le fait pas. Il mesure le
tracking par ses **effets**, et le dit dans un bandeau permanent.

Le taux de consentement s'affiche quand vous le fournissez, via la colonne
`consent_rate` du Sheet (voir plus bas). Il vient de là, jamais d'ici.

### Le seul diagnostic que l'API expose vraiment

`offline_conversion_upload_conversion_action_summary` — pour les conversions
**importées** uniquement. Il donne, par action : un statut
(`EXCELLENT` / `GOOD` / `NEEDS_ATTENTION` / `NO_RECENT_UPLOAD`), le nombre
d'événements envoyés et acceptés, la date du dernier envoi, la source (API,
interface, connecteur) et les **motifs de rejet**, traduits en français avec le
code d'origine conservé entre parenthèses.

Piège qui m'a d'abord fait conclure à tort que la ressource était vide : elle ne
répond **que sur le compte propriétaire des conversions**
(`conversion_tracking_setting.google_ads_conversion_customer`). Interrogée sur un
compte enfant d'un suivi mutualisé, elle renvoie zéro ligne **sans erreur**, ce
qui se lit comme « aucun import ». Le script interroge donc les comptes
propriétaires, pas les enfants.

Sur ce MCC : trois actions importées, toutes `EXCELLENT`, avec des rejets
`EXPIRED_EVENT` sur deux d'entre elles. Et un cas à vérifier — `sales` est
rapportée comme importée avec succès le 12 août alors qu'elle ne produit plus
aucune conversion sur les comptes suivis depuis le 26 mai. Les deux faits peuvent
coexister (envoi accepté mais attribué ailleurs) ; la carte le signale sans
conclure.

### Comparaison des balises d'un même objectif

`conversion_action.category` permet de comparer les balises **à l'intérieur d'un
objectif** : Inscription (`SIGNUP`), Abonnement payant (`SUBSCRIBE_PAID`),
Téléchargement (`DOWNLOAD`)… Le sélecteur ne propose que les objectifs
réellement présents dans la période et les comptes filtrés.

C'est la carte qui distingue une **migration réussie** d'une **perte de mesure** —
deux choses qui se ressemblent parfaitement sur un total. Sur les données
réelles : `GOOGLE TAG - INSCRIPTION SOI - MCC BO` et
`GOOGLE TAG - INSCRIPTION SOI 2026 - MCC BO (MP>sGTM<Ads)` évoluent en parallèle
à des volumes voisins (8,2 k et 9,6 k) — les deux mesurent en même temps. Sur
l'objectif Abonnement, `sales` est à plat depuis le 26 mai pendant que quatre
autres balises montent ; un bandeau nomme la balise éteinte et celles qui
montent, en disant que la coïncidence demande vérification plutôt qu'en tranchant.

Les actions retirées sont incluses volontairement : sans elles, la balise qu'on
cherche justement à remplacer disparaîtrait de la comparaison.

### Le raisonnement

Une cassure de balise fait tomber les conversions **sans toucher aux clics**. Une
vraie baisse de performance déplace les deux. Le rapport conversions / clic
sépare donc les deux cas, et c'est ce que fait la carte principale : elle compare
les 7 derniers jours aux 28 précédents et rend un verdict.

| Verdict | Signature |
|---|---|
| **Cassure de mesure** | plus aucune conversion, les clics continuent |
| **Mesure suspecte** | le taux chute de 30 % ou plus, le trafic tient à ±20 % |
| **Performance** | taux et trafic baissent ensemble |
| **Volume** | le trafic baisse, le taux tient |
| **Trop peu de trafic** | moins de 200 clics sur la référence |

Les seuils sont des constantes nommées en tête du bloc Tracking de
`assets/app.js` (`TRK_RECENT_DAYS`, `TRK_BASE_DAYS`, `TRK_DROP`, `TRK_STABLE`,
`TRK_MIN_CLICKS`) et sont **affichés dans le sous-titre de la carte**. Un seuil
caché transforme un diagnostic en oracle, et personne ne peut discuter un oracle.

### Actions muettes

Le diagnostic par compte reste muet quand une seule balise casse parmi dix. Cette
carte descend donc au grain de l'action de conversion : une action qui a converti
au moins 20 fois sur la période, puis plus rien pendant 3 jours ou plus **alors
que le compte recevait encore des clics**.

Sur les données réelles elle sort `sales` sur `fr_sexy_1` : dernière conversion le
26 mai, **76 jours de silence, 23 365 clics et 35 062 € dépensés depuis**. Et
quatre actions de `es_top5decitas` qui se taisent le même jour — quand toutes les
actions d'un compte s'arrêtent ensemble, c'est le conteneur, pas l'action.

### Marché : la livraison, pas le ciblage

Premier essai écarté : le ciblage géographique des campagnes
(`campaign_criterion`). Il produit des clés inexploitables — une campagne visant
seize pays donne un marché « 16 pays », et deux campagnes visant seize pays
*différents* tombent dans le même seau. Le ciblage dit une intention.

`geographic_view` donne le pays réel de livraison, par jour. Piège évité :
`location_type` vaut `LOCATION_OF_PRESENCE` **ou** `AREA_OF_INTEREST`, et les
additionner compterait deux fois la même dépense — d'où un filtre, pas une somme.

Le portefeuille livre dans 22 pays. Ceux sous 200 clics sont repliés en une ligne
« Autres marchés », nommés dans le sous-titre.

### Journal des changements

Deux sources, distinguées :

- **Le Sheet** — vos déploiements GTM, changements Didomi, mises à jour de
  conteneur. Superposés en repères verticaux sur la courbe conversions / clics,
  numérotés, avec la liste sous le graphique et le détail dans l'infobulle.
- **Google Ads** — `change_event`, ce qui a bougé dans les comptes. Plafonné à
  **28 jours** par l'API (`DURING LAST_30_DAYS` est refusé, `>= J-29` sans borne
  haute aussi ; seul un `BETWEEN` borné passe). L'onglet l'annonce : une période
  sans repère plus ancienne ne veut pas dire qu'il ne s'est rien passé.

`change_event.user_email` nomme l'auteur de chaque modification. Le champ est lu
pour compter les auteurs distincts, **jamais écrit** dans `tracking.json` : un
journal nominatif publié sur un dépôt public est un problème de RGPD, pas une
fonctionnalité.

### Le Sheet des changements techniques

```bash
python scripts/fetch_changelog.py --sheet <ID_ou_URL>   # depuis Google Sheets
python scripts/fetch_changelog.py --csv fichier.csv     # hors ligne
python scripts/fetch_changelog.py --sample              # jeu d'exemple
```

Le Sheet doit être **lisible sans authentification** (Fichier → Partager →
Publier sur le web, format CSV ; ou partage en lecture pour tous), parce que le
script tourne aussi dans GitHub Actions où il n'y a pas de session Google.

Colonnes reconnues sans tenir compte de la casse, des accents ni de l'ordre :

| Colonne | Obligatoire | Contenu |
|---|---|---|
| `date` | oui | `AAAA-MM-JJ` ou `JJ/MM/AAAA` |
| `titre` | oui | « Déploiement conteneur sGTM v14 » |
| `fin` | non | pour un événement qui dure |
| `type` | non | `GTM`, `DIDOMI`, `CONTAINER`, `ADS`, `SITE` |
| `detail` | non | texte libre |
| `comptes` | non | noms de comptes, séparés par des virgules |
| `marches` | non | `FR`, `ES`, `BE`… |
| `impact` | non | `attendu`, `inattendu`, `neutre` |
| `consent_rate` | non | taux de consentement — `0,82`, `82 %` ou `82` |

Une ligne sans date ou sans titre est ignorée **et signalée** à l'extraction :
mieux vaut un avertissement qu'un repère muet sur une courbe.

⚠️ Tout ce que contient le Sheet finit dans `data/changelog.json`, donc en ligne
sur un dépôt public. N'y mettez pas d'URL de conteneur privée, de jeton GTM ni
d'adresse e-mail : un libellé suffit.

Pour le rafraîchissement automatique, ajoutez le secret `CHANGELOG_SHEET_ID` (et
`CHANGELOG_SHEET_GID` si l'onglet n'est pas le premier). Sans lui, l'étape
s'abstient et l'onglet fonctionne — sans repères.

### Deux pièges de lecture, signalés dans l'interface

- **Périodes partielles.** Une fenêtre de 90 jours commence et finit rarement un
  lundi. Sur une base 100, une première semaine tronquée sert de référence à tout
  le reste, et une dernière semaine d'un seul jour ressemble à un effondrement.
  Les deux sont écartées du graphique et gardées dans le tableau, marquées
  « partiel ».
- **Le mois en cours du profil de retard.** Une conversion à quinze jours de
  retard survenue cette semaine n'est pas encore arrivée : la part « moins d'un
  jour » du mois courant est mécaniquement surévaluée. Ce n'est pas un tagging qui
  s'améliore, c'est une fenêtre qui se ferme trop tôt.

Enfin, `conversions` et `all_conversions` ne disent pas la même chose : segmenté
par action, le premier ne compte que les actions incluses dans la colonne
« Conversions » — celles que les enchères voient. Sur ce MCC, **11 % seulement**
des conversions suivies alimentent l'optimisation. La santé d'une balise se lit
sur `all_conversions`, ce que l'algorithme optimise sur `conversions` ; les deux
sont collectés, et un KPI le montre.

---

## Section « Répartition du coût par sexe »

Une carte du rapport, sous les classements, alimentée par `data/gender.json`
(`python scripts/fetch_gender.py`, 180 jours par défaut). Elle trace les **8 plus
gros comptes en dépense**, chacun ramené à 100 %, et suit la période et le filtre
de comptes de la barre du haut comme le reste du rapport.

Le graphique s'arrête à 8 lignes ; le sous-titre annonce la part du coût couverte
et la vue **Tableau** liste **tous** les comptes, avec conversions et ROAS. Rien
n'est tronqué en silence.

### D'où vient la donnée

De `gender_view`, au grain critère démographique, agrégée en
(jour × compte × sexe). Vérifié avant d'écrire le script : sur les trois comptes
les plus dépensiers, la somme des coûts de `gender_view` **égale à 100 %** le coût
total des campagnes. Il n'y a donc aucun angle mort de couverture à signaler.
L'autre voie possible, `segments.adjusted_gender`, est refusée par l'API dès qu'on
demande des métriques
(`PROHIBITED_SEGMENT_WITH_METRIC_IN_SELECT_OR_WHERE_CLAUSE`).

Ni campagne ni appareil dans la requête : chaque champ demandé segmente le
résultat, et cette carte n'en affiche aucun. À ce grain le fichier tient dans
**244 Ko** au lieu de 2,1 Mo, ce qui lui permet d'être chargé avec le rapport
sans bouton. Il reste séparé de `data.json` pour que son absence masque la
section au lieu de casser le rapport.

### « Inconnu » n'est pas une troisième catégorie de personnes

C'est l'aveu que Google n'a pas su trancher. Sur ce MCC cela pèse **40 % du
coût** — dix fois « Femmes ». Deux conséquences pour la lecture :

- La catégorie reste **affichée en clair**, jamais rangée dans un « autres » qui
  la ferait passer pour marginale. Une mention sous le titre de la carte le
  rappelle, avec la part recalculée sur la sélection courante — sur un compte
  isolé elle peut tomber à zéro.
- Un CPA « Hommes » ne se compare donc pas à un CPA global : 40 % de la dépense
  est ailleurs. Réduire ce bloc passe par le ciblage démographique des
  campagnes, pas par ce rapport.

L'ordre d'affichage — Hommes, Femmes, Inconnu — et les couleurs sont **figés**,
indépendamment du volume. Une catégorie qui change de place ou de teinte d'un
export à l'autre rendrait deux captures incomparables.

### Base 100

Le basculement `Volume` / `Base 100` ramène chaque compte à 100 % ; la dépense
absolue reste affichée à droite de la barre — sans elle, un compte à 2 k€ et un à
180 k€ auraient exactement la même allure.

Le même basculement existe sur la carte **Répartition du coût par compte**, qui
offre `Appareil · Base 100 · Réseau`. « Réseau » a été conservé, pas remplacé :
la répartition Search / Display / Partenaires répond à une autre question que le
mix d'appareils.

---

## Le bouton « Actualiser » du Live — ce qu'il fait, ce qu'il ne peut pas faire

Il **relit `data/live.json`** sans recharger la page, et la vue se redessine. Un
rafraîchissement automatique tourne aussi toutes les 5 minutes, **uniquement**
quand l'onglet Live est affiché et la fenêtre au premier plan.

Il ne **régénère pas** les données. GitHub Pages sert un fichier statique : rien
ne s'exécute côté serveur. Régénérer suppose d'appeler l'API Google Ads, donc de
détenir un jeton — et un jeton posé dans une page publique est un jeton
compromis, définitivement. Il n'existe pas de version prudente de cette idée.

La régénération appartient aux workflows, qui détiennent les secrets. Deux
boutons **Régénérer ↗** y conduisent en un clic : celui du Live ouvre
`refresh-live.yml`, celui de l'en-tête des indicateurs clés ouvre
`refresh-data.yml`. Il reste à cliquer **Run workflow** sur GitHub, puis à
revenir actualiser.

Leur URL est **déduite de celle de la page** et non codée en dur : un fork ou un
renommage du dépôt les suivrait, là où une constante aurait pointé dans le vide
sans rien signaler. En local, l'origine ne dit rien du dépôt et les deux boutons
se masquent — mieux vaut pas de bouton qu'un bouton qui mène ailleurs.

| Moyen | Délai |
|---|---|
| Cron du workflow, toutes les 15 min de 6 h à 23 h (Paris) | 15 à 30 min, redéploiement Pages compris |
| **Bouton Régénérer ↗ → Run workflow** | ~2 min pour le Live, 3 à 4 pour le rapport |
| `python scripts/fetch_live.py` en local, puis commit + push | ~1 min |

Les boutons sont visibles par tout visiteur de la page publique, mais ne mènent
qu'à GitHub : lancer un workflow demande un accès en écriture au dépôt. Si vous
préférez les masquer aux visiteurs, dites-le — un drapeau dans l'URL suffit.

**Prérequis, et il n'est pas rempli aujourd'hui :** sans les cinq secrets Google
Ads dans les paramètres du dépôt, le workflow s'abstient proprement et
`live.json` ne bouge jamais. Le bouton affiche alors « Données figées depuis N
jours · la régénération automatique ne tourne pas », parce qu'un bouton qui ne
change rien à l'écran passe pour cassé alors que le problème est ailleurs. Voir
la section 3.4 pour poser les secrets.

## Page Cannibalisation sémantique

`cannibalisation.html` est un export **figé**, produit par un autre projet
(`bo-cannibalisation-semantique`, menu **Export HTML autonome**) qui le dépose
sur Google Drive. On le republie ici :

```bash
python scripts/publish_cannibalisation.py chemin/vers/export.html
git add cannibalisation.html && git commit && git push
```

Le script ajoute la navigation vers le reste du dashboard et **refuse un export
vide** — le cas s'est produit une fois, l'injection des données ayant échoué
silencieusement côté Apps Script, et rien ne le signalait.

Un **lien** dans l'en-tête, pas un troisième onglet : les onglets basculent
entre deux vues du même jeu de données, filtrables et rafraîchies ensemble.
Cette page est un document distinct, figé à sa date d'extraction. Leur donner la
même apparence laisserait croire qu'elle suit les filtres.

Elle ne se met donc **pas** à jour avec `data.json` : il faut réexporter puis
republier. La date d'extraction est en tête de page, et un rappel figure en pied.

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
python scripts/fetch_ads_data.py     # rapport      → data/data.json
python scripts/fetch_gender.py       # par sexe     → data/gender.json
python scripts/fetch_tracking.py     # tracking     → data/tracking.json
git add data/data.json data/gender.json data/tracking.json
git commit -m "Mise à jour des données"
git push
```

Le site se redéploie automatiquement.

### 3.4 Rafraîchissement automatique (optionnel)

`.github/workflows/refresh-data.yml` récupère `data.json`, `aimax.json`,
`gender.json`, `tracking.json` et `changelog.json` chaque jour et les commite.
Tous sauf le premier sont en `continue-on-error` : leur section se signale
absente plutôt que de priver le rapport principal de sa mise à jour.

Deux secrets facultatifs s'ajoutent pour la timeline des changements :
`CHANGELOG_SHEET_ID` et `CHANGELOG_SHEET_GID`. Pour l'activer, ajoutez vos credentials dans **Settings → Secrets and
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

Trois onglets en haut à droite — **Rapport**, **Live** et **Tracking** —
partagent cette rangée. Le filtre de comptes s'applique aux trois ; la période
cadre le rapport et le Tracking, mais pas le Live qui porte sur la seule journée
en cours ; appareil, réseau et nom de campagne ne concernent que le rapport.

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

### Efficacité des campagnes

Coût en abscisse, **ROAS** en ordonnée, un point par campagne, et un repère au
seuil de rentabilité.

L'abscisse est **logarithmique** : les budgets vont ici de quelques euros à
plusieurs dizaines de milliers, et en linéaire la centaine de campagnes qu'on
cherche à comparer s'entassait contre l'axe pendant que trois gros points
occupaient tout l'espace. Le log ne cache rien et ne tronque aucune échelle, il
redistribue seulement la place.

Les campagnes dont le compte ne remonte aucune valeur de conversion sont
écartées, comme dans la marge : leur ROAS vaudrait zéro, ce qui se lirait comme
« aucun retour » au lieu de « non mesuré ». Le sous-titre chiffre l'exclusion.

### La marge par campagne

**Marge = valeur de conversion − coût**, sur la période filtrée. Le **taux de
marge** rapporte cette marge à la valeur produite (marge ÷ valeur de conversion),
pas au coût.

La mesure suppose que le compte remonte une valeur de conversion. Les campagnes
dont le compte n'en remonte **aucune** sur la période sont écartées du calcul :
leur marge vaudrait mécaniquement l'opposé de leur coût, ce qui serait une perte
inventée plutôt que constatée. Un bandeau indique combien de campagnes et quel
coût sont ainsi hors mesure, et dans quels comptes — un angle mort chiffré vaut
mieux qu'un total faussement rassurant.

Le partage se fait **au compte, pas à la campagne** : dans un compte qui suit la
valeur, une campagne à zéro valeur est une vraie perte et doit rester.

Le graphique montre les 7 meilleures et les 7 plus déficitaires — les deux
versants, jamais un seul. En mode taux, il écarte en plus les campagnes pesant
moins de 1 % du coût du périmètre : 40 EUR de valeur face à 900 EUR de coût
donnent −2 000 %, un chiffre exact et sans portée qui écraserait toutes les
autres barres.

Le bouton **Tableau** donne la liste complète, triable par colonne et avec ligne
de totaux. Elle garde les campagnes écartées du graphique : la colonne Coût y
rend le bruit visible plutôt que de le masquer.

---

## Notes techniques

`data/data.json` est **colonnaire** : les dates, campagnes, appareils et réseaux
sont des tables d'index, et `facts` un tableau de tuples

```
[date, campagne, appareil, réseau, impressions, clics, coût, conversions, valeur]
```

Mesuré sur un MCC de 86 comptes : 180 jours × 165 campagnes tiennent en ~1,5 Mo,
soit 47 000 lignes — chargées d'un coup et filtrées en mémoire, sans requête
réseau. Au-delà de ~3 Mo, réduisez la fenêtre avec `--days` ou scindez par MCC.

Les 7 teintes vont aux comptes qui pèsent le plus, classés sur le coût de
**l'ensemble du jeu de données** — une propriété fixe du fichier, jamais de la
sélection courante. Filtrer ne repeint donc aucune série, mais les couleurs
restent alignées sur ce qui compte. Un classement alphabétique donnerait les
teintes aux premiers comptes de la liste, souvent dormants. Le reste est replié
sur « Autres » plutôt que de recycler des teintes indistinguables.

### Version de l'API

L'API est appelée en `v25` (constante `API_VERSION` en tête de
`scripts/fetch_ads_data.py`). Google **bloque** les versions dépréciées — `v20`
et `v21` le sont depuis août 2026 — avec l'erreur `UNSUPPORTED_VERSION`, souvent
de façon intermittente pendant le déploiement du blocage. Le script s'arrête
alors immédiatement en le disant, au lieu de parcourir tous les comptes.

Pour trouver les versions acceptées, faites varier le numéro sur une requête
triviale : une version retirée répond `UNSUPPORTED_VERSION`, une version
inexistante répond `404`.
