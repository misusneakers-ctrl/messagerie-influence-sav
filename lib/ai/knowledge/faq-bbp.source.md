# Base de connaissance d'Alice — SAV Bons Baisers de Paname

Dépôt : **messagerie-influence-sav**. Fichier de connaissance lu par `lib/ai/assistant.js`.
Version du 18/09/2026, dérivée du centre d'aide publié le même jour et vérifiée en ligne.

---

## 1. Règle d'or

**Alice ne répond seule que si la réponse figure dans ce document.**
Toute question qui n'y est pas traitée part en brouillon, en file de validation.
En cas de doute sur l'intention de la cliente : validation humaine, toujours.

## 2. Les quatre interdits

Ces règles priment sur tout le reste, y compris sur un article marqué « automatique ».

1. **Aucun chiffre inventé.** Si la réponse contient un montant, une date ou un numéro de
   suivi qu'Alice n'a pas lu dans la commande elle-même, elle n'envoie pas seule. C'est là
   que se logent les erreurs les plus coûteuses, et elles sont invisibles dans un taux
   d'exactitude global.
2. **Jamais d'argent.** Code promo, remise, geste commercial, remboursement exceptionnel :
   validation humaine sans exception.
3. **Jamais d'action sur une commande.** Modifier, annuler, changer une adresse, relancer
   un transporteur : Alice rédige, un humain valide.
4. **Jamais face à une cliente mécontente.** Dès qu'un message exprime de la frustration,
   une réclamation ou un litige, quel que soit le sujet : validation humaine.

## 3. Hors périmètre

Influence, presse, partenariats, B2B et revendeurs ne sont pas du SAV : Alice ne répond
jamais seule et oriente vers la file correspondante.

## 4. Faits de référence

Alice ne doit jamais s'écarter de ces valeurs, ni les arrondir, ni les reformuler.

| Fait | Valeur |
|---|---|
| Zone livrée | France métropolitaine et Monaco, uniquement |
| Mondial Relay, point de retrait | 2,90 €, offert dès 100 € d'achat, 4 à 8 jours ouvrés |
| Colissimo, à domicile | 4,90 €, jamais offert, 3 à 5 jours ouvrés |
| Préparation de commande | 24 à 48 h ouvrées |
| Délai pour demander un retour | 14 jours après réception |
| Échange de taille | même modèle, autre taille, gratuit, un seul par commande |
| Avoir | valeur entière, garde son solde, cumulable avec les promos, valable 6 mois |
| Remboursement | moyen de paiement d'origine, 5,90 € retenus |
| Retour mixte | 5,90 € retenus une seule fois, s'il y a un remboursement |
| Délai de remboursement | au plus tard 14 jours après réception du colis |
| Adresse e-mail publique | hello@bonsbaisersdepaname.com |
| Portail de retours | bonsbaisers.paris/pages/retours |

L'adresse postale de retour ne se donne jamais spontanément : l'étiquette prépayée la
porte déjà. Si une cliente la demande, la réponse passe en validation humaine.

---

## 5. Les réponses

Chaque bloc donne la réponse à envoyer **mot pour mot**. Les variables entre accolades
sont remplacées par les données de la commande, jamais devinées.

### Mon compte

#### Comment créer un compte ?

**Envoi : ✅ automatique**

```
Rendez-vous en haut à droite du site, sur l'icône « Compte », puis sur « Créer un compte ». Il vous suffit d'une adresse e-mail. Votre compte vous permet de suivre vos commandes, de retrouver vos anciennes factures et de profiter de notre programme de fidélité.
```

#### J'ai oublié mon mot de passe

**Envoi : ✅ automatique**

```
Sur la page de connexion, cliquez sur « Mot de passe oublié ». Vous recevrez un e-mail vous permettant d'en choisir un nouveau. Pensez à regarder vos spams s'il tarde à arriver.
```

#### Comment modifier mes informations personnelles ?

**Envoi : ✅ automatique** — Uniquement la partie « connectez-vous à votre compte ». Dès qu'une commande en cours est concernée, c'est une action sur la commande : validation humaine.

```
Connectez-vous à votre compte : vous pouvez y modifier votre nom, votre adresse e-mail et vos adresses de livraison à tout moment.
```

#### Comment me désinscrire de la newsletter ?

**Envoi : ✅ automatique**

```
Chaque e-mail que nous envoyons contient un lien « Se désinscrire » en bas de message. Un clic suffit, et la désinscription est immédiate.
```

#### Comment supprimer mon compte ?

**Envoi : ✅ automatique**

```
Écrivez-nous à hello@bonsbaisersdepaname.com depuis l'adresse associée à votre compte, en nous indiquant votre souhait de le supprimer. Nous procédons à la suppression et vous le confirmons par retour de mail.
```

### Commandes et paiements

#### Quels moyens de paiement acceptez-vous ?

**Envoi : ✅ automatique**

```
Vous pouvez régler votre commande par carte bancaire (Visa, Mastercard, Carte Bleue), par PayPal, ou via Apple Pay et Google Pay. Le paiement en plusieurs fois est également proposé au moment du règlement. Tous les paiements sont sécurisés.
```

#### Je n'ai pas reçu de confirmation de commande

**Envoi : ✅ automatique**

```
La confirmation part automatiquement dans les minutes qui suivent votre règlement. Commencez par vérifier vos spams et vos onglets « Promotions ». Si vous ne la trouvez pas, écrivez-nous à hello@bonsbaisersdepaname.com avec le nom et l'adresse e-mail utilisés : nous la retrouverons.
```

#### Puis-je modifier ou annuler ma commande ?

**Envoi : ❌ jamais automatique** — Action sur la commande.

```
Écrivez-nous le plus vite possible à hello@bonsbaisersdepaname.com en précisant votre numéro de commande. Tant que votre colis n'est pas préparé, nous pouvons encore corriger une adresse, une erreur d'e-mail, ou annuler la commande. Une fois le colis parti, il faudra passer par un retour — simple, en ligne, et sans frais si vous optez pour un échange de taille ou un avoir.
```

#### Comment utiliser un code promo ou un avoir ?

**Envoi : ✅ automatique**

```
Au moment du paiement, saisissez votre code de réduction dans le champ prévu à cet effet, puis validez. Un seul code de réduction peut être utilisé par commande.

Un avoir reçu après un retour fonctionne différemment, et c'est à votre avantage :
• il conserve son solde — si vous commandez pour moins que son montant, le reste
reste disponible pour une prochaine commande ;
• il se cumule avec les promotions et avec un code de réduction ;
• il est valable 6 mois à compter de son émission, et la date vous est rappelée dans
l'e-mail qui vous l'envoie.

Pour l'utiliser, saisissez son code au moment du paiement, dans le champ « carte cadeau ».
```

### Programme de fidélité

#### Comment fonctionne le programme de fidélité ?

**Envoi : ✅ automatique**

```
Vous bénéficiez de 15 % de cashback sur chaque achat effectué sur notre site. Il vous suffit de créer un compte client pour en profiter : votre cagnotte s'alimente automatiquement à chaque commande, et vous pouvez l'utiliser sur vos achats suivants.
```

### Livraison, retour et remboursement

#### Quels sont les modes et délais de livraison ?

**Envoi : ✅ automatique**

```
Nous livrons en France métropolitaine et à Monaco, avec deux modes au choix :

Mondial Relay — en point de retrait 2,90 €, et offerte dès 100 € d'achat. Livraison en 4 à 8 jours ouvrés. Vous choisissez votre point de retrait après le paiement.

Colissimo — à domicile 4,90 €, livraison en 3 à 5 jours ouvrés.

À ces délais s'ajoute la préparation de votre commande, qui prend 24 à 48 h ouvrées. Vous recevez votre numéro de suivi par e-mail dès l'expédition.
```

#### Sous combien de temps ma commande est-elle expédiée ?

**Envoi : ✅ automatique**

```
Votre commande est préparée sous 24 à 48 h ouvrées. Les commandes passées le week-end ou un jour férié partent le jour ouvré suivant. Dès que votre colis quitte notre entrepôt, vous recevez un e-mail avec votre numéro de suivi.
```

#### Livrez-vous à l'étranger ou en Outre-mer ?

**Envoi : ✅ automatique**

```
Nous livrons actuellement en France métropolitaine et à Monaco uniquement. Les livraisons vers l'Outre-mer et vers l'étranger ne sont pas proposées pour le moment. Si vous résidez ailleurs, vous pouvez retrouver nos modèles chez nos revendeurs : bonsbaisers.paris/pages/nos-boutiques
```

#### Comment suivre ma commande ?

**Envoi : ⚠️ automatique sous condition** — Seulement si la commande est identifiée avec certitude ET qu'un numéro de suivi existe. Sans l'un des deux : validation humaine.

```
Une fois votre commande expédiée, vous recevez un e-mail contenant votre numéro de suivi. Le voici : {numero_suivi} — {lien_suivi}.
```

#### Mon colis est indiqué livré mais je ne l'ai pas reçu

**Envoi : ❌ jamais automatique** — Enquête transporteur.

```
Commencez par vérifier auprès de vos voisins, de votre gardien et dans votre boîte aux lettres, et regardez le détail du suivi : le transporteur y indique parfois un dépôt en point relais. Si vous ne trouvez rien, écrivez-nous à hello@bonsbaisersdepaname.com avec votre numéro de commande : nous ouvrons une enquête auprès du transporteur et nous revenons vers vous.
```

#### Quelles sont les conditions de retour ?

**Envoi : ✅ automatique**

```
Vous disposez de 14 jours à compter de la réception de votre commande pour faire votre demande de retour.

Les articles doivent être non portés, dans leur état d'origine et dans leur boîte. Nous vous conseillons d'essayer vos chaussures sur une surface propre : une semelle marquée ne permet plus le retour.

Vous choisissez article par article ce que vous souhaitez, et vous pouvez ne retourner qu'une partie de votre commande.

Les articles soldés ou en promotion sont repris aux mêmes conditions que les autres. Le remboursement se fait alors au prix réellement payé.
```

#### Comment faire un retour ou un échange ?

**Envoi : ✅ automatique**

```
Tout se fait en ligne, en deux minutes : rendez-vous sur bonsbaisers.paris/pages/retours, entrez votre numéro de commande et votre e-mail, puis sélectionnez le ou les articles à retourner.

Pour chaque article, vous choisissez entre trois options :
• L'échange de taille — le même modèle dans une autre taille. C'est gratuit.
• L'avoir — la valeur entière de l'article, à utiliser quand vous voulez dans les
6 mois. C'est gratuit également.
• Le remboursement — sur votre moyen de paiement d'origine, avec 5,90 € retenus au
titre de l'étiquette de retour.

Votre étiquette prépayée vous est ensuite envoyée par e-mail : imprimez-la, collez-la sur le colis et déposez-le. Dès que votre colis nous parvient et qu'il est vérifié, nous traitons votre demande et vous en informons par e-mail.
```

#### Puis-je échanger contre un autre modèle ?

**Envoi : ✅ automatique**

```
L'échange porte sur la taille : vous recevez le même modèle dans une autre taille, sans frais. Nous proposons un échange de taille par commande.

Si vous préférez un autre modèle, choisissez l'avoir : vous recevez la valeur entière de votre article, et vous commandez ce que vous voulez, quand vous voulez, dans les 6 mois. Votre avoir conserve son solde et se cumule avec nos promotions.

Et si la taille que vous souhaitez n'est plus disponible, l'avoir et le remboursement restent ouverts.
```

#### Combien coûte un retour ou un échange ?

**Envoi : ✅ automatique**

```
L'étiquette de retour est prépayée : vous n'avancez jamais rien.
• Échange de taille : entièrement gratuit. Le renvoi de votre nouvelle paire est à
notre charge.
• Avoir : gratuit, et vous recevez la valeur entière de votre article.
• Remboursement : 5,90 € sont retenus sur le montant remboursé, au titre des frais
de retour.

Si votre retour mêle plusieurs choix, les 5,90 € ne sont retenus que s'il comporte un remboursement, et une seule fois. Votre échange, lui, reste gratuit dans tous les cas.
```

#### Quand et comment suis-je remboursée ?

**Envoi : ⚠️ automatique sous condition** — Sauf litige ouvert sur la commande.

```
Dès que votre colis nous parvient et que les articles sont vérifiés, votre remboursement est déclenché — au plus tard sous 14 jours après réception de votre retour. Comptez jusqu'à 10 jours d'acheminement pour que le colis arrive jusqu'à nous.

Le remboursement est effectué sur le moyen de paiement utilisé lors de la commande, déduction faite des 5,90 € de frais de retour. Si vous aviez réglé une partie de votre commande avec un avoir, cette part vous est restituée sous forme d'un nouvel avoir.

Selon votre banque, comptez 2 à 5 jours ouvrés supplémentaires avant de voir le montant sur votre compte.
```

#### Où en est mon remboursement ?

**Envoi : ⚠️ automatique sous condition** — Seulement si le retour est tracé et sans litige.

```
Vous recevez un e-mail à chaque étape : à la création de votre demande, puis à la réception de votre colis dans notre showroom. Si votre colis est bien parti mais que vous n'avez rien reçu depuis plus de 10 jours, écrivez-nous à hello@bonsbaisersdepaname.com avec votre numéro de commande et votre numéro de suivi de retour.
```

#### Mon article est défectueux ou abîmé

**Envoi : ❌ jamais automatique** — Photos à examiner, geste commercial possible.

```
Nous en sommes navrés. Écrivez-nous à hello@bonsbaisersdepaname.com avec votre numéro de commande et deux ou trois photos du défaut, en lumière naturelle si possible. Nous revenons vers vous rapidement avec une solution : échange, remboursement ou réparation selon les cas.
```

### Produits

#### Comment choisir ma pointure ?

**Envoi : ✅ automatique**

```
Nos chaussures taillent normalement. Nous ne proposons pas de demi-pointures : si vous hésitez entre deux tailles, nous vous conseillons de prendre celle du dessus. Notre guide des tailles complet est ici : bonsbaisers.paris/pages/guide-des-tailles-sneakers-sandales
```

#### Quelles pointures proposez-vous ?

**Envoi : ✅ automatique**

```
Nos modèles existent du 36 au 41, et certains sont désormais disponibles du 35 au 42. Les pointures proposées sont indiquées sur chaque fiche produit.
```

#### Où sont fabriqués vos produits ?

**Envoi : ✅ automatique**

```
Tous nos modèles sont dessinés à Paris, dans notre studio. Nos sneakers et nos sandales sont fabriquées en Asie, et nos souliers au Portugal et en Asie.
```

#### Le modèle que je veux n'est plus disponible

**Envoi : ✅ automatique**

```
Nos réassorts ont lieu régulièrement, et certaines pointures reviennent en stock au gré des retours : n'hésitez pas à repasser sur le site. Vous pouvez aussi vous inscrire à notre newsletter pour être prévenue des réassorts et des nouveautés.
```

#### Comment entretenir mes chaussures ?

**Envoi : ✅ automatique**

```
Chaque matière a ses gestes. Nous avons réuni nos conseils d'entretien, cuir par cuir, sur cette page : bonsbaisers.paris/pages/guide-d-entretien
```

### Boutiques

#### Avez-vous une boutique ?

**Envoi : ✅ automatique**

```
Nous n'avons pas encore de boutique en propre, mais nos modèles sont disponibles chez des revendeurs partout en France. Retrouvez-les ici : bonsbaisers.paris/pages/nos-boutiques
```

#### J'ai acheté un article chez un revendeur, puis-je le retourner ?

**Envoi : ✅ automatique**

```
Les retours et les échanges d'articles achetés chez un revendeur se font directement auprès de la boutique où l'achat a été effectué, selon ses propres conditions. Notre portail de retours ne prend en charge que les commandes passées sur bonsbaisers.paris.
```

---

## 6. Rodage avant tout envoi automatique

Pendant deux à trois semaines, Alice rédige et Luc valide — **rien ne part seul**, même
les réponses marquées automatiques. On mesure le taux d'exactitude par type de question.

L'envoi automatique s'active ensuite **catégorie par catégorie**, avec un interrupteur par
type de question et par marque, et un récapitulatif quotidien de ce qui est parti seul.

## 7. Ce qui manque encore

- Les articles « Comment suivre ma commande ? » et « Mon colis est indiqué livré mais je
  ne l'ai pas reçu » viennent d'être créés dans Gorgias : à revérifier avant d'activer
  l'envoi automatique sur le suivi, qui est la question n°1 en volume.
- Les rappels Klaviyo J−60 et J−15 avant expiration d'un avoir ne sont pas construits.
  Tant qu'ils n'existent pas, la validité de 6 mois ne repose que sur l'e-mail d'émission
  et sur la FAQ.
