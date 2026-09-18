# Pourquoi l'appli était lente — 18/09/2026

La base Neon (`Super APP`) est hébergée à **Londres** (`aws-eu-west-2`).
Les fonctions Vercel tournaient à **Washington** (`iad1`, la région par défaut,
faute de `vercel.json`).

Chaque requête SQL traversait donc l'Atlantique : environ **80 ms d'aller-retour**,
avant même que la base ne travaille. Or une page en enchaîne beaucoup :

| Étape | Aller-retours | Coût à 80 ms |
|---|---|---|
| Résolution de la marque (table `tenants`) | 1 connexion + 1 requête | ~160 ms |
| `withTenant` : BEGIN, set_config, COMMIT | 3 | ~240 ms |
| Les requêtes utiles de l'endpoint | 1 à 8 | 80 à 640 ms |
| Ouverture d'une connexion à froid (TLS + auth) | 4 à 5 | 320 à 400 ms |

Soit **0,8 à 1,5 seconde de pure latence réseau** par appel, pour une base qui
pèse 1,5 Mo et met quelques millisecondes à répondre. Le volume n'y est pour
rien : 170 tickets, 1 180 messages.

## Corrections appliquées

1. **`vercel.json` : `regions: ["lhr1"]`** — les fonctions tournent à Londres,
   à côté de la base. L'aller-retour passe de ~80 ms à ~2 ms. C'est l'essentiel
   du gain.
2. **Marque gardée en mémoire** (`lib/tenant.js`) — la table `tenants` contient
   deux lignes qui ne changent jamais ; elle était relue à chaque requête.
   Cache de 5 minutes, vidé par un simple redéploiement.
3. **`withTenant` en un aller-retour de moins** — `BEGIN` et `set_config` sont
   envoyés ensemble.
4. **Pool ajusté pour le serverless** — `keepAlive` (réutilise la connexion
   TCP), `max: 3` (chaque instance Vercel ouvre sa propre poule ; 5 × N
   instances saturait vite la limite Neon du plan gratuit), délais d'attente
   explicites plutôt qu'une attente infinie.

## À vérifier côté Vercel — par Luc

La variable `DATABASE_URL` doit pointer vers le point d'entrée **poolé** de
Neon : l'hôte contient `-pooler`, par exemple
`ep-xxxx-pooler.eu-west-2.aws.neon.tech`. Sans le pooler, chaque fonction
ouvre une vraie connexion Postgres (poignée de main TLS complète) et le plan
gratuit plafonne vite.

Neon, Vercel → Settings → Environment Variables → `DATABASE_URL`.


# La synchro Instagram ne rendait plus rien — 18/09, 19 h

Les journaux Vercel montraient quatre **504 « Task timed out after 300
seconds »** sur `POST /api/tickets/sync-instagram`, et des 502 sur
`sync-email`. Ce n'était pas de la lenteur : la fonction mourait.

Elle redemandait à Meta les messages des ~170 conversations, puis écrivait en
base conversation par conversation, avec **une requête par message** pour
savoir s'il était déjà connu. Des milliers d'allers-retours, chacun payant la
traversée de l'Atlantique.

Trois parades, cumulées :

1. **On ignore ce qui n'a pas bougé.** La date de dernière activité de chaque
   conversation est retenue (`tickets.ig_conversation_updated_at`). Au passage
   suivant, une conversation inchangée est écartée — sans même appeler Meta.
   Après le premier passage, une actualisation ne touche que le réel nouveau.
2. **Un budget de temps de 45 s.** La route s'arrête d'elle-même et annonce ce
   qu'il reste (`remaining`) ; le front la rappelle. Une longue actualisation
   devient une suite d'actualisations courtes, au lieu d'un 504 qui ne rend
   rien du tout.
3. **Un seul contrôle « déjà importé » par conversation** au lieu d'un par
   message : sur une conversation de trente messages, vingt-neuf allers-retours
   économisés.

Avec le changement de région (Londres), ces trois parades se renforcent : moins
d'allers-retours, et chacun cinquante fois plus court.
