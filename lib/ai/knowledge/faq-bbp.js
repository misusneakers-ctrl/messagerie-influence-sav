// lib/ai/knowledge/faq-bbp.js
// FICHIER GÉNÉRÉ — ne pas éditer à la main.
// Source : lib/ai/knowledge/faq-bbp.source.md
// Générateur : scripts/build-knowledge.js
// Le contenu est en JSON échappé (jamais un gabarit de chaîne) : le
// document contient des accents graves et des accolades, qui casseraient
// un template literal.

module.exports = {
  "nom": "faq-bbp",
  "titre": "Base de connaissance d'Alice — SAV Bons Baisers de Paname",
  "version": "18/09/2026",
  "source": "lib/ai/knowledge/faq-bbp.source.md",
  "regle_or": "Alice ne répond seule que si la réponse figure dans ce document. Toute question qui n'y est pas traitée part en brouillon, en file de validation. En cas de doute sur l'intention de la cliente : validation humaine, toujours.",
  "interdits_intro": "Ces règles priment sur tout le reste, y compris sur un article marqué « automatique ».",
  "interdits": [
    "Aucun chiffre inventé. Si la réponse contient un montant, une date ou un numéro de suivi qu'Alice n'a pas lu dans la commande elle-même, elle n'envoie pas seule. C'est là que se logent les erreurs les plus coûteuses, et elles sont invisibles dans un taux d'exactitude global.",
    "Jamais d'argent. Code promo, remise, geste commercial, remboursement exceptionnel : validation humaine sans exception.",
    "Jamais d'action sur une commande. Modifier, annuler, changer une adresse, relancer un transporteur : Alice rédige, un humain valide.",
    "Jamais face à une cliente mécontente. Dès qu'un message exprime de la frustration, une réclamation ou un litige, quel que soit le sujet : validation humaine."
  ],
  "hors_perimetre": "Influence, presse, partenariats, B2B et revendeurs ne sont pas du SAV : Alice ne répond jamais seule et oriente vers la file correspondante.",
  "faits_consigne": "Alice ne doit jamais s'écarter de ces valeurs, ni les arrondir, ni les reformuler.",
  "faits": [
    {
      "fait": "Zone livrée",
      "valeur": "France métropolitaine et Monaco, uniquement"
    },
    {
      "fait": "Mondial Relay, point de retrait",
      "valeur": "2,90 €, offert dès 100 € d'achat, 4 à 8 jours ouvrés"
    },
    {
      "fait": "Colissimo, à domicile",
      "valeur": "4,90 €, jamais offert, 3 à 5 jours ouvrés"
    },
    {
      "fait": "Préparation de commande",
      "valeur": "24 à 48 h ouvrées"
    },
    {
      "fait": "Délai pour demander un retour",
      "valeur": "14 jours après réception"
    },
    {
      "fait": "Échange de taille",
      "valeur": "même modèle, autre taille, gratuit, un seul par commande"
    },
    {
      "fait": "Avoir",
      "valeur": "valeur entière, garde son solde, cumulable avec les promos, valable 6 mois"
    },
    {
      "fait": "Remboursement",
      "valeur": "moyen de paiement d'origine, 5,90 € retenus"
    },
    {
      "fait": "Retour mixte",
      "valeur": "5,90 € retenus une seule fois, s'il y a un remboursement"
    },
    {
      "fait": "Délai de remboursement",
      "valeur": "au plus tard 14 jours après réception du colis"
    },
    {
      "fait": "Adresse e-mail publique",
      "valeur": "hello@bonsbaisersdepaname.com"
    },
    {
      "fait": "Portail de retours",
      "valeur": "bonsbaisers.paris/pages/retours"
    }
  ],
  "faits_note": "L'adresse postale de retour ne se donne jamais spontanément : l'étiquette prépayée la porte déjà. Si une cliente la demande, la réponse passe en validation humaine.",
  "reponses_intro": "Chaque bloc donne la réponse à envoyer mot pour mot. Les variables entre accolades sont remplacées par les données de la commande, jamais devinées.",
  "entrees": [
    {
      "rubrique": "Mon compte",
      "question": "Comment créer un compte ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Rendez-vous en haut à droite du site, sur l'icône « Compte », puis sur « Créer un compte ». Il vous suffit d'une adresse e-mail. Votre compte vous permet de suivre vos commandes, de retrouver vos anciennes factures et de profiter de notre programme de fidélité.",
      "variables": []
    },
    {
      "rubrique": "Mon compte",
      "question": "J'ai oublié mon mot de passe",
      "envoi": "auto",
      "note": null,
      "reponse": "Sur la page de connexion, cliquez sur « Mot de passe oublié ». Vous recevrez un e-mail vous permettant d'en choisir un nouveau. Pensez à regarder vos spams s'il tarde à arriver.",
      "variables": []
    },
    {
      "rubrique": "Mon compte",
      "question": "Comment modifier mes informations personnelles ?",
      "envoi": "auto",
      "note": "Uniquement la partie « connectez-vous à votre compte ». Dès qu'une commande en cours est concernée, c'est une action sur la commande : validation humaine.",
      "reponse": "Connectez-vous à votre compte : vous pouvez y modifier votre nom, votre adresse e-mail et vos adresses de livraison à tout moment.",
      "variables": []
    },
    {
      "rubrique": "Mon compte",
      "question": "Comment me désinscrire de la newsletter ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Chaque e-mail que nous envoyons contient un lien « Se désinscrire » en bas de message. Un clic suffit, et la désinscription est immédiate.",
      "variables": []
    },
    {
      "rubrique": "Mon compte",
      "question": "Comment supprimer mon compte ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Écrivez-nous à hello@bonsbaisersdepaname.com depuis l'adresse associée à votre compte, en nous indiquant votre souhait de le supprimer. Nous procédons à la suppression et vous le confirmons par retour de mail.",
      "variables": []
    },
    {
      "rubrique": "Commandes et paiements",
      "question": "Quels moyens de paiement acceptez-vous ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Vous pouvez régler votre commande par carte bancaire (Visa, Mastercard, Carte Bleue), par PayPal, ou via Apple Pay et Google Pay. Le paiement en plusieurs fois est également proposé au moment du règlement. Tous les paiements sont sécurisés.",
      "variables": []
    },
    {
      "rubrique": "Commandes et paiements",
      "question": "Je n'ai pas reçu de confirmation de commande",
      "envoi": "auto",
      "note": null,
      "reponse": "La confirmation part automatiquement dans les minutes qui suivent votre règlement. Commencez par vérifier vos spams et vos onglets « Promotions ». Si vous ne la trouvez pas, écrivez-nous à hello@bonsbaisersdepaname.com avec le nom et l'adresse e-mail utilisés : nous la retrouverons.",
      "variables": []
    },
    {
      "rubrique": "Commandes et paiements",
      "question": "Puis-je modifier ou annuler ma commande ?",
      "envoi": "jamais",
      "note": "Action sur la commande.",
      "reponse": "Écrivez-nous le plus vite possible à hello@bonsbaisersdepaname.com en précisant votre numéro de commande. Tant que votre colis n'est pas préparé, nous pouvons encore corriger une adresse, une erreur d'e-mail, ou annuler la commande. Une fois le colis parti, il faudra passer par un retour — simple, en ligne, et sans frais si vous optez pour un échange de taille ou un avoir.",
      "variables": []
    },
    {
      "rubrique": "Commandes et paiements",
      "question": "Comment utiliser un code promo ou un avoir ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Au moment du paiement, saisissez votre code de réduction dans le champ prévu à cet effet, puis validez. Un seul code de réduction peut être utilisé par commande.\n\nUn avoir reçu après un retour fonctionne différemment, et c'est à votre avantage :\n• il conserve son solde — si vous commandez pour moins que son montant, le reste\nreste disponible pour une prochaine commande ;\n• il se cumule avec les promotions et avec un code de réduction ;\n• il est valable 6 mois à compter de son émission, et la date vous est rappelée dans\nl'e-mail qui vous l'envoie.\n\nPour l'utiliser, saisissez son code au moment du paiement, dans le champ « carte cadeau ».",
      "variables": []
    },
    {
      "rubrique": "Programme de fidélité",
      "question": "Comment fonctionne le programme de fidélité ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Vous bénéficiez de 15 % de cashback sur chaque achat effectué sur notre site. Il vous suffit de créer un compte client pour en profiter : votre cagnotte s'alimente automatiquement à chaque commande, et vous pouvez l'utiliser sur vos achats suivants.",
      "variables": []
    },
    {
      "rubrique": "Livraison, retour et remboursement",
      "question": "Quels sont les modes et délais de livraison ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Nous livrons en France métropolitaine et à Monaco, avec deux modes au choix :\n\nMondial Relay — en point de retrait 2,90 €, et offerte dès 100 € d'achat. Livraison en 4 à 8 jours ouvrés. Vous choisissez votre point de retrait après le paiement.\n\nColissimo — à domicile 4,90 €, livraison en 3 à 5 jours ouvrés.\n\nÀ ces délais s'ajoute la préparation de votre commande, qui prend 24 à 48 h ouvrées. Vous recevez votre numéro de suivi par e-mail dès l'expédition.",
      "variables": []
    },
    {
      "rubrique": "Livraison, retour et remboursement",
      "question": "Sous combien de temps ma commande est-elle expédiée ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Votre commande est préparée sous 24 à 48 h ouvrées. Les commandes passées le week-end ou un jour férié partent le jour ouvré suivant. Dès que votre colis quitte notre entrepôt, vous recevez un e-mail avec votre numéro de suivi.",
      "variables": []
    },
    {
      "rubrique": "Livraison, retour et remboursement",
      "question": "Livrez-vous à l'étranger ou en Outre-mer ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Nous livrons actuellement en France métropolitaine et à Monaco uniquement. Les livraisons vers l'Outre-mer et vers l'étranger ne sont pas proposées pour le moment. Si vous résidez ailleurs, vous pouvez retrouver nos modèles chez nos revendeurs : bonsbaisers.paris/pages/nos-boutiques",
      "variables": []
    },
    {
      "rubrique": "Livraison, retour et remboursement",
      "question": "Comment suivre ma commande ?",
      "envoi": "conditionnel",
      "note": "Seulement si la commande est identifiée avec certitude ET qu'un numéro de suivi existe. Sans l'un des deux : validation humaine.",
      "reponse": "Une fois votre commande expédiée, vous recevez un e-mail contenant votre numéro de suivi. Le voici : {numero_suivi} — {lien_suivi}.",
      "variables": [
        "{numero_suivi}",
        "{lien_suivi}"
      ]
    },
    {
      "rubrique": "Livraison, retour et remboursement",
      "question": "Mon colis est indiqué livré mais je ne l'ai pas reçu",
      "envoi": "jamais",
      "note": "Enquête transporteur.",
      "reponse": "Commencez par vérifier auprès de vos voisins, de votre gardien et dans votre boîte aux lettres, et regardez le détail du suivi : le transporteur y indique parfois un dépôt en point relais. Si vous ne trouvez rien, écrivez-nous à hello@bonsbaisersdepaname.com avec votre numéro de commande : nous ouvrons une enquête auprès du transporteur et nous revenons vers vous.",
      "variables": []
    },
    {
      "rubrique": "Livraison, retour et remboursement",
      "question": "Quelles sont les conditions de retour ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Vous disposez de 14 jours à compter de la réception de votre commande pour faire votre demande de retour.\n\nLes articles doivent être non portés, dans leur état d'origine et dans leur boîte. Nous vous conseillons d'essayer vos chaussures sur une surface propre : une semelle marquée ne permet plus le retour.\n\nVous choisissez article par article ce que vous souhaitez, et vous pouvez ne retourner qu'une partie de votre commande.\n\nLes articles soldés ou en promotion sont repris aux mêmes conditions que les autres. Le remboursement se fait alors au prix réellement payé.",
      "variables": []
    },
    {
      "rubrique": "Livraison, retour et remboursement",
      "question": "Comment faire un retour ou un échange ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Tout se fait en ligne, en deux minutes : rendez-vous sur bonsbaisers.paris/pages/retours, entrez votre numéro de commande et votre e-mail, puis sélectionnez le ou les articles à retourner.\n\nPour chaque article, vous choisissez entre trois options :\n• L'échange de taille — le même modèle dans une autre taille. C'est gratuit.\n• L'avoir — la valeur entière de l'article, à utiliser quand vous voulez dans les\n6 mois. C'est gratuit également.\n• Le remboursement — sur votre moyen de paiement d'origine, avec 5,90 € retenus au\ntitre de l'étiquette de retour.\n\nVotre étiquette prépayée vous est ensuite envoyée par e-mail : imprimez-la, collez-la sur le colis et déposez-le. Dès que votre colis nous parvient et qu'il est vérifié, nous traitons votre demande et vous en informons par e-mail.",
      "variables": []
    },
    {
      "rubrique": "Livraison, retour et remboursement",
      "question": "Puis-je échanger contre un autre modèle ?",
      "envoi": "auto",
      "note": null,
      "reponse": "L'échange porte sur la taille : vous recevez le même modèle dans une autre taille, sans frais. Nous proposons un échange de taille par commande.\n\nSi vous préférez un autre modèle, choisissez l'avoir : vous recevez la valeur entière de votre article, et vous commandez ce que vous voulez, quand vous voulez, dans les 6 mois. Votre avoir conserve son solde et se cumule avec nos promotions.\n\nEt si la taille que vous souhaitez n'est plus disponible, l'avoir et le remboursement restent ouverts.",
      "variables": []
    },
    {
      "rubrique": "Livraison, retour et remboursement",
      "question": "Combien coûte un retour ou un échange ?",
      "envoi": "auto",
      "note": null,
      "reponse": "L'étiquette de retour est prépayée : vous n'avancez jamais rien.\n• Échange de taille : entièrement gratuit. Le renvoi de votre nouvelle paire est à\nnotre charge.\n• Avoir : gratuit, et vous recevez la valeur entière de votre article.\n• Remboursement : 5,90 € sont retenus sur le montant remboursé, au titre des frais\nde retour.\n\nSi votre retour mêle plusieurs choix, les 5,90 € ne sont retenus que s'il comporte un remboursement, et une seule fois. Votre échange, lui, reste gratuit dans tous les cas.",
      "variables": []
    },
    {
      "rubrique": "Livraison, retour et remboursement",
      "question": "Quand et comment suis-je remboursée ?",
      "envoi": "conditionnel",
      "note": "Sauf litige ouvert sur la commande.",
      "reponse": "Dès que votre colis nous parvient et que les articles sont vérifiés, votre remboursement est déclenché — au plus tard sous 14 jours après réception de votre retour. Comptez jusqu'à 10 jours d'acheminement pour que le colis arrive jusqu'à nous.\n\nLe remboursement est effectué sur le moyen de paiement utilisé lors de la commande, déduction faite des 5,90 € de frais de retour. Si vous aviez réglé une partie de votre commande avec un avoir, cette part vous est restituée sous forme d'un nouvel avoir.\n\nSelon votre banque, comptez 2 à 5 jours ouvrés supplémentaires avant de voir le montant sur votre compte.",
      "variables": []
    },
    {
      "rubrique": "Livraison, retour et remboursement",
      "question": "Où en est mon remboursement ?",
      "envoi": "conditionnel",
      "note": "Seulement si le retour est tracé et sans litige.",
      "reponse": "Vous recevez un e-mail à chaque étape : à la création de votre demande, puis à la réception de votre colis dans notre showroom. Si votre colis est bien parti mais que vous n'avez rien reçu depuis plus de 10 jours, écrivez-nous à hello@bonsbaisersdepaname.com avec votre numéro de commande et votre numéro de suivi de retour.",
      "variables": []
    },
    {
      "rubrique": "Livraison, retour et remboursement",
      "question": "Mon article est défectueux ou abîmé",
      "envoi": "jamais",
      "note": "Photos à examiner, geste commercial possible.",
      "reponse": "Nous en sommes navrés. Écrivez-nous à hello@bonsbaisersdepaname.com avec votre numéro de commande et deux ou trois photos du défaut, en lumière naturelle si possible. Nous revenons vers vous rapidement avec une solution : échange, remboursement ou réparation selon les cas.",
      "variables": []
    },
    {
      "rubrique": "Produits",
      "question": "Comment choisir ma pointure ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Nos chaussures taillent normalement. Nous ne proposons pas de demi-pointures : si vous hésitez entre deux tailles, nous vous conseillons de prendre celle du dessus. Notre guide des tailles complet est ici : bonsbaisers.paris/pages/guide-des-tailles-sneakers-sandales",
      "variables": []
    },
    {
      "rubrique": "Produits",
      "question": "Quelles pointures proposez-vous ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Nos modèles existent du 36 au 41, et certains sont désormais disponibles du 35 au 42. Les pointures proposées sont indiquées sur chaque fiche produit.",
      "variables": []
    },
    {
      "rubrique": "Produits",
      "question": "Où sont fabriqués vos produits ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Tous nos modèles sont dessinés à Paris, dans notre studio. Nos sneakers et nos sandales sont fabriquées en Asie, et nos souliers au Portugal et en Asie.",
      "variables": []
    },
    {
      "rubrique": "Produits",
      "question": "Le modèle que je veux n'est plus disponible",
      "envoi": "auto",
      "note": null,
      "reponse": "Nos réassorts ont lieu régulièrement, et certaines pointures reviennent en stock au gré des retours : n'hésitez pas à repasser sur le site. Vous pouvez aussi vous inscrire à notre newsletter pour être prévenue des réassorts et des nouveautés.",
      "variables": []
    },
    {
      "rubrique": "Produits",
      "question": "Comment entretenir mes chaussures ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Chaque matière a ses gestes. Nous avons réuni nos conseils d'entretien, cuir par cuir, sur cette page : bonsbaisers.paris/pages/guide-d-entretien",
      "variables": []
    },
    {
      "rubrique": "Boutiques",
      "question": "Avez-vous une boutique ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Nous n'avons pas encore de boutique en propre, mais nos modèles sont disponibles chez des revendeurs partout en France. Retrouvez-les ici : bonsbaisers.paris/pages/nos-boutiques",
      "variables": []
    },
    {
      "rubrique": "Boutiques",
      "question": "J'ai acheté un article chez un revendeur, puis-je le retourner ?",
      "envoi": "auto",
      "note": null,
      "reponse": "Les retours et les échanges d'articles achetés chez un revendeur se font directement auprès de la boutique où l'achat a été effectué, selon ses propres conditions. Notre portail de retours ne prend en charge que les commandes passées sur bonsbaisers.paris.",
      "variables": []
    }
  ],
  "montants_autorises": [
    "100",
    "2,90",
    "4,90",
    "5,90"
  ]
};
