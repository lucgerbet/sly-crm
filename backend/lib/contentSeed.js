// La ligne éditoriale du compte Instagram SLY, et la banque de sujets qui
// l'alimente.
//
// Un carousel n'est jamais écrit "à partir de rien" : la routine tire le
// prochain sujet non utilisé de cette banque, ce qui garantit qu'on ne
// republie pas deux fois le même angle et que les six piliers tournent au
// lieu de dériver vers le seul qui vient facilement à l'esprit.
//
// La banque est semée en base au premier démarrage puis vit dans la base :
// modifier ce fichier après coup n'écrase rien, il ne sert qu'à l'amorçage
// et de référence pour la tâche programmée quand elle en génère de nouveaux.

export const PILLARS = [
  { key: 'anatomie',   label: 'Anatomie du costume', color: '#3A2A23' },
  { key: 'regles',     label: 'Les règles',          color: '#5A1F24' },
  { key: 'gentleman',  label: 'Le gentleman moderne', color: '#7A6B58' },
  { key: 'sur-mesure', label: 'Sur-mesure & artisanat', color: '#2F4034' },
  { key: 'occasions',  label: 'Occasions & dress codes', color: '#3C4A5A' },
  { key: 'culture',    label: 'Culture & histoire',  color: '#5A4A2A' },
];

export const pillarLabel = (key) =>
  PILLARS.find((p) => p.key === key)?.label || key;

// 60 sujets = 20 semaines à raison de 3 publications par semaine. La routine
// prévient (et complète toute seule) quand il en reste moins de douze.
export const SEED_TOPICS = [
  // — Anatomie du costume ————————————————————————————————————————
  ['anatomie', 'Le cran du revers', 'Cran aigu, cran droit, col châle : ce que chacun raconte et quand le porter.'],
  ['anatomie', "L'épaule d'une veste", 'Napolitaine, structurée, roulée — l\'épaule décide de toute la silhouette.'],
  ['anatomie', "L'entoilage", 'Thermocollé, semi-entoilé, full canvas : la doublure invisible qui décide de la durée de vie.'],
  ['anatomie', 'La longueur de veste', 'Le repère simple pour savoir si une veste est trop courte ou trop longue.'],
  ['anatomie', 'Les quartiers ouverts ou fermés', 'Le détail de coupe qui affine la taille — ou qui l\'alourdit.'],
  ['anatomie', 'Deux boutons, trois boutons, croisé', 'Ce que chaque boutonnage fait à la morphologie.'],
  ['anatomie', 'Les boutons de manche qui s\'ouvrent', 'Surgeon\'s cuff : héritage de tailleur ou signal de vanité ?'],
  ['anatomie', 'Pantalon à pinces ou sans pinces', 'Le vrai critère n\'est pas la mode, c\'est la cuisse.'],
  ['anatomie', 'Le break du pantalon', 'Full, half, no break : combien de tissu doit tomber sur la chaussure.'],
  ['anatomie', 'La pochette', 'Trois pliages suffisent pour toute une vie.'],
  ['anatomie', 'Le col de veste qui décolle', 'Ce n\'est pas un pli à repasser, c\'est un défaut de patronage.'],
  ['anatomie', 'Doublé, demi-doublé, non doublé', 'Une question de saison et de climat, pas de prix.'],

  // — Les règles ——————————————————————————————————————————————
  ['regles', 'Le dernier bouton ne se ferme jamais', 'D\'où vient la règle, et la seule exception qui existe.'],
  ['regles', 'Ceinture ou bretelles, jamais les deux', 'Pourquoi, et ce que ça change à la coupe du pantalon.'],
  ['regles', 'Un centimètre et demi de chemise', 'Combien de manchette doit dépasser de la manche, et pourquoi.'],
  ['regles', 'Les chaussettes', 'Elles prolongent le pantalon, pas la chaussure — la seule règle qui compte.'],
  ['regles', 'Ceinture et chaussures', 'Le cuir se répond, la boucle se discute.'],
  ['regles', 'La longueur de cravate', 'La pointe touche la boucle de ceinture : le repère qui ne trompe jamais.'],
  ['regles', "Le costume noir n'est pas un costume de ville", 'Ce qu\'il faut porter à la place, et quand le noir est juste.'],
  ['regles', 'Trop grand n\'est pas confortable', 'Les quatre points de contrôle en cabine d\'essayage.'],
  ['regles', 'Le nœud suit le col', 'Simple, double, Windsor : c\'est l\'écartement du col qui décide.'],
  ['regles', 'Poignets mousquetaires', 'Quand la chemise appelle des boutons de manchette — et quand elle ne les appelle pas.'],
  ['regles', 'Mélanger les motifs', 'La règle des trois échelles, expliquée simplement.'],
  ['regles', 'Un pantalon trop long', 'Pourquoi un ourlet coûte moins cher que l\'allure qu\'il fait perdre.'],

  // — Le gentleman moderne ——————————————————————————————————————
  ['gentleman', "Être bien habillé, c'est être approprié", 'La règle qui remplace toutes les autres.'],
  ['gentleman', 'Un gentleman ne cherche pas à impressionner', 'Il met à l\'aise — la différence se voit en trente secondes.'],
  ['gentleman', 'La poignée de main et le regard', 'Deux secondes qui décident du reste de la conversation.'],
  ['gentleman', "La ponctualité est une forme d'élégance", 'Ce que le retard dit vraiment de nous.'],
  ['gentleman', 'Savoir recevoir', 'Trois gestes simples qui changent une soirée.'],
  ['gentleman', 'La discrétion', 'Porter du beau sans porter la marque.'],
  ['gentleman', 'Entrer dans une pièce', 'Posture, rythme, première phrase.'],
  ['gentleman', "L'art du compliment", 'Précis, sincère, court — pourquoi les trois comptent.'],
  ['gentleman', 'Le mot de remerciement', 'Un usage démodé qui marque plus qu\'un message.'],
  ['gentleman', 'Le téléphone à table', 'La seule règle à tenir, et comment la tenir sans être rigide.'],
  ['gentleman', 'Tenir parole', 'Le vrai luxe est de ne pas avoir à se justifier.'],
  ['gentleman', "S'habiller pour soi ou pour les autres", 'La question que tout le monde se pose mal.'],

  // — Sur-mesure & artisanat ————————————————————————————————————
  ['sur-mesure', 'Sur-mesure, demi-mesure, retouché', 'Ce que chaque mot recouvre vraiment — et ce qu\'on vous vend.'],
  ['sur-mesure', 'Même taille, costume différent', 'Pourquoi deux hommes du même gabarit n\'ont pas le même patron.'],
  ['sur-mesure', "Super 110's, 130's, 150's", 'Le chiffre mesure la finesse du fil, pas la qualité du tissu.'],
  ['sur-mesure', 'Laine, lin, coton, mohair', 'Quelle matière pour quelle saison, et pourquoi.'],
  ['sur-mesure', 'Ce qu\'on mesure vraiment', 'Une prise de mesures ne se résume pas à un tour de poitrine.'],
  ['sur-mesure', "L'épaule tombante", 'La quasi-totalité des hommes en ont une plus basse que l\'autre.'],
  ['sur-mesure', 'Le premier essayage', 'Ce qu\'on regarde, et dans quel ordre.'],
  ['sur-mesure', 'Combien de temps dure un costume bien fait', 'Et ce qui le tue avant l\'heure.'],
  ['sur-mesure', 'Entretenir son costume', 'Brosse, cintre, repos, vapeur : le bon rythme.'],
  ['sur-mesure', 'Faire retoucher plutôt que racheter', 'Ce qui se retouche, ce qui ne se retouche pas.'],
  ['sur-mesure', "Le prix d'un costume", 'Où va vraiment l\'argent : tissu, main-d\'œuvre, marge, boutique.'],
  ['sur-mesure', 'Un costume ne se lave pas', 'Comment le nettoyer sans l\'abîmer.'],

  // — Occasions & dress codes ————————————————————————————————————
  ['occasions', 'Invité à un mariage', 'La tenue qui ne vole la vedette à personne.'],
  ['occasions', "Entretien d'embauche", 'Le costume ne doit pas parler plus fort que vous.'],
  ['occasions', 'Black tie', 'Ce que ça veut dire exactement, et les erreurs courantes.'],
  ['occasions', 'Cocktail, tenue de ville, business casual', 'Décoder ce qui est écrit sur le carton.'],
  ['occasions', "Le costume d'été", 'Matière, doublure, couleur : tenir la chaleur sans se déguiser.'],
  ['occasions', 'Son premier costume', 'Lequel acheter en premier quand on n\'en a aucun.'],
  ['occasions', 'Un enterrement', 'La sobriété comme forme de respect.'],

  // — Culture & histoire ————————————————————————————————————————
  ['culture', "D'où vient le costume", 'De l\'uniforme militaire au bureau, en trois siècles.'],
  ['culture', 'Savile Row', 'Pourquoi une rue de Londres a défini l\'élégance masculine.'],
  ['culture', 'Style napolitain contre style anglais', 'Deux écoles, deux philosophies de l\'épaule.'],
  ['culture', 'Le smoking', 'Inventé pour fumer, devenu la tenue la plus codifiée qui soit.'],
  ['culture', 'Les boutons des hommes à droite', 'Une histoire d\'armes, de chevaux et de valets.'],
];
