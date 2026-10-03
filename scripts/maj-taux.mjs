// Mise à jour automatique des taux affichés dans l'onglet Investissement.
//
// Lit les pages officielles de service-public.gouv.fr (Livret A, LDDS, LEP et
// plafonds de revenus du LEP, PEL, PEA, prélèvements sociaux, flat tax,
// assurance vie, PER, barème de l'impôt), la garantie des dépôts (FGDR), la
// série Insee de l'inflation et le taux moyen des comptes à terme (Banque de
// France, publié par la BCE). Vérifie que chaque valeur est plausible, puis
// réécrit taux.json si quelque chose a changé. Une rubrique introuvable ou
// incohérente garde ses anciennes valeurs : l'application continue avec les
// derniers chiffres connus, et le robot se termine en erreur, ce qui prévient
// le propriétaire du dépôt par courriel.
//
// Le rendement moyen des fonds en euros n'est publié que par l'ACPR, une fois
// par an, sur un site fermé aux robots : il se saisit dans le formulaire
// « Run workflow » (variables FONDS_EUROS et FONDS_EUROS_ANNEE), et le robot
// ouvre un rappel quand le chiffre de l'année écoulée devrait être paru.
//
// Usage : node scripts/maj-taux.mjs [--dry-run] [--date=AAAA-MM-JJ]
// Node 18 ou plus (fetch intégré), aucune dépendance.

import { readFile, writeFile } from "node:fs/promises";

const FICHIER = new URL("../taux.json", import.meta.url);
const SOURCES = {
  livretA: "https://www.service-public.gouv.fr/particuliers/vosdroits/F2365",
  ldds: "https://www.service-public.gouv.fr/particuliers/vosdroits/F2368",
  lep: "https://www.service-public.gouv.fr/particuliers/vosdroits/F2367",
  // IPC base 2025, glissement annuel, ensemble des ménages, France entière.
  inflation: "https://bdm.insee.fr/series/sdmx/data/SERIES_BDM/011814632?lastNObservations=1",
  pel: "https://www.service-public.gouv.fr/particuliers/vosdroits/F16140",
  pea: "https://www.service-public.gouv.fr/particuliers/vosdroits/F2385",
  garanties: "https://www.garantiedesdepots.fr/fr",
  // Taux moyen des nouveaux dépôts à terme des ménages en France, jusqu'à
  // 1 an (statistiques MIR de la Banque de France, diffusées par la BCE).
  compteTerme: "https://data-api.ecb.europa.eu/service/data/MIR/M.FR.B.L22.F.R.A.2250.EUR.N?lastNObservations=1&format=csvdata",
  prelevements: "https://www.service-public.gouv.fr/particuliers/vosdroits/F2329",
  plusValues: "https://www.service-public.gouv.fr/particuliers/vosdroits/F21618",
  assuranceVie: "https://www.service-public.gouv.fr/particuliers/vosdroits/F22414",
  per: "https://www.service-public.gouv.fr/particuliers/vosdroits/F34982",
  bareme: "https://www.service-public.gouv.fr/particuliers/vosdroits/F1419"
};
const MOIS = { janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12 };

// Une erreur passagère (serveur surchargé, délai dépassé) est retentée deux
// fois avant d'abandonner la rubrique.
async function lire(url){
  for(let essai = 1; ; essai++){
    try{
      const rep = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Suivi-Budget, mise a jour des taux)" }, signal: AbortSignal.timeout(90000) });
      if(rep.ok) return await rep.text();
      if(rep.status < 500 || essai >= 3) throw new Error(`${url} : HTTP ${rep.status}`);
    }catch(e){
      if(essai >= 3 || /HTTP [1-4]\d\d$/.test(e.message)) throw e;
    }
    await new Promise(r => setTimeout(r, 10000 * essai));
  }
}
// Texte brut d'une page : sans scripts, sans balises, espaces normalisés.
function texte(html){
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&#39;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/&eacute;/g, "é")
    .replace(/[  ]/g, " ").replace(/\s+/g, " ");
}
const nombre = s => Number(String(s).replace(/\s/g, "").replace(",", "."));
function borne(nom, v, min, max){
  if(!Number.isFinite(v) || v < min || v > max) throw new Error(`${nom} invraisemblable : ${v}`);
  return v;
}
function trouver(nom, t, re){
  const m = t.match(re);
  if(!m) throw new Error(`${nom} introuvable : la page a peut-être changé de forme`);
  return m;
}
// « Vérifié le 01 août 2026 » → "2026-08-01"
function dateVerif(nom, t){
  const m = trouver(nom + " (date de vérification)", t, /Vérifié le (\d{1,2})(?:er)? ([a-zéû]+) (\d{4})/i);
  const mois = MOIS[m[2].toLowerCase()];
  if(!mois) throw new Error(`${nom} : mois inconnu « ${m[2]} »`);
  return `${m[3]}-${String(mois).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
}

// Date du jour (AAAA-MM-JJ) ; --date=AAAA-MM-JJ la remplace pour les essais.
function aujourdhui(){
  const opt = process.argv.find(a => a.startsWith("--date="));
  return opt ? opt.slice(7) : new Date().toISOString().slice(0, 10);
}
// Début de la période de taux contenant une date : 1er février ou 1er août.
function debutPeriode(ymd){
  const [a, m] = ymd.split("-").map(Number);
  return m >= 8 ? `${a}-08-01` : m >= 2 ? `${a}-02-01` : `${a - 1}-08-01`;
}
function decaler(ymd, jours){
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + jours);
  return d.toISOString().slice(0, 10);
}

// Chaque rubrique est lue séparément : si une page officielle change de
// forme, seule sa rubrique garde les anciennes valeurs ; les autres sont
// mises à jour, et le robot se termine en erreur pour prévenir.
async function rubrique(nom, erreurs, fn){
  try{ return await fn(); }
  catch(e){ erreurs.push(`${nom} : ${e.message}`); return undefined; }
}
const pct = s => nombre(s);

async function lireLivrets(ancien){
  const tA = texte(await lire(SOURCES.livretA));
  const tauxA = borne("Taux du Livret A", nombre(trouver("Taux du Livret A", tA, /taux d'intérêt annuel du livret A est de ([\d,]+) ?%/i)[1]), 0.1, 10);
  const tD = texte(await lire(SOURCES.ldds));
  const tauxD = borne("Taux du LDDS", nombre(trouver("Taux du LDDS", tD, /taux d'intérêt annuel est de ([\d,]+) ?%/i)[1]), 0.1, 10);
  // Période de validité des taux : les livrets réglementés sont révisés le
  // 1er février et le 1er août. Les taux lus ne valent pour la période en
  // cours que si la page officielle a été revue pour elle (au plus tôt
  // 20 jours avant la révision, quand le nouveau taux est annoncé) ; sinon
  // on garde l'ancienne période, et l'application invite à vérifier.
  const verifA = dateVerif("Livret A", tA);
  const debut = debutPeriode(aujourdhui());
  const periode = verifA >= decaler(debut, -20) ? debut : (ancien.periode || debutPeriode(verifA));
  const plafA = borne("Plafond du Livret A", nombre(trouver("Plafond du Livret A", tA, /montant maximum d'épargne inscrit sur le livret A est de ([\d ]+) €/i)[1]), 5000, 200000);
  const plafD = borne("Plafond du LDDS", nombre(trouver("Plafond du LDDS", tD, /plafond du LDDS est de ([\d ]+) €/i)[1]), 2000, 200000);
  return { periode, livretA: { ...ancien.livretA, taux: tauxA, verifie: verifA, plafond: plafA }, ldds: { ...ancien.ldds, taux: tauxD, verifie: dateVerif("LDDS", tD), plafond: plafD } };
}

async function lireLep(ancien){
  const tL = texte(await lire(SOURCES.lep));
  const tauxL = borne("Taux du LEP", nombre(trouver("Taux du LEP", tL, /taux d'intérêt du LEP est de ([\d,]+) ?%/i)[1]), 0.1, 10);
  // Barème de métropole : « Nombre de parts … Plafond de RFR 1 23 028 € 1,25 26 103 € … Pour chaque demi-part supplémentaire 6 149 € »
  const bloc = trouver("Barème du LEP", tL, /LEP éligibilité (\d{4}) - Revenu fiscal de référence à ne pas dépasser selon la situation familiale - Métropole (.*?)Pour chaque demi-part supplémentaire ([\d ]+) €(?: Pour quart de part ([\d ]+) €)?/i);
  const annee = borne("Année du barème du LEP", Number(bloc[1]), 2024, 2100);
  const parts = [...bloc[2].matchAll(/(\d+(?:[,.]\d+)?) (\d{1,3}(?: \d{3})+) €/g)].map(m => [nombre(m[1]), nombre(m[2])]);
  if(parts.length < 5 || parts[0][0] !== 1) throw new Error("Barème du LEP incomplet");
  borne("Plafond du LEP pour une part", parts[0][1], 15000, 40000);
  for(let i = 1; i < parts.length; i++) if(!(parts[i][0] > parts[i - 1][0] && parts[i][1] > parts[i - 1][1])) throw new Error("Barème du LEP non croissant");
  const demiPart = borne("Supplément par demi-part", nombre(bloc[3]), 2000, 15000);
  const quartPart = bloc[4] ? borne("Supplément par quart de part", nombre(bloc[4]), 1000, 8000) : Math.round(demiPart / 2);
  const plafond = borne("Plafond du LEP", nombre(trouver("Plafond du LEP", tL, /plafond des versements sur le LEP est fixé à ([\d ]+) €/i)[1]), 2000, 100000);
  return { ...ancien.lep, taux: tauxL, verifie: dateVerif("LEP", tL), plafond, rfr: { annee, parts, demiPart, quartPart } };
}

async function lireInflation(){
  const xml = await lire(SOURCES.inflation);
  const obs = trouver("Inflation", xml, /<Obs TIME_PERIOD="(\d{4}-\d{2})" OBS_VALUE="(-?[\d.]+)"/);
  return { taux: borne("Inflation", Number(obs[2]), -5, 25), mois: obs[1] };
}

// PEL : taux fixé chaque 1er janvier pour les plans ouverts dans l'année.
async function lirePel(){
  const t = texte(await lire(SOURCES.pel));
  const m = trouver("Taux du PEL", t, /Il est de : ([\d,]+) ?% pour les PEL ouverts à partir du 1 ?er janvier (\d{4})/i);
  const plafond = trouver("Plafond du PEL", t, /montant maximum que vous pouvez verser sur le PEL est ([\d ]+) €/i);
  const min = trouver("Versement minimum du PEL", t, /verser chaque année sur votre PEL un montant minimum de ([\d ]+) €/i);
  const duree = trouver("Durées du PEL", t, /durée minimale de (\d+) ans \. Après \d+ ans, le PEL peut être prolongé d.année en année jusqu.à atteindre la durée maximale de (\d+) ans/i);
  const fin = trouver("Fin du PEL", t, /Au bout de (\d+) ans d.existence , votre PEL est automatiquement transformé en livret/i);
  const ansMin = borne("Durée minimale du PEL", Number(duree[1]), 1, 10), ansVers = borne("Durée des versements du PEL", Number(duree[2]), ansMin, 30);
  return { taux: borne("Taux du PEL", nombre(m[1]), 0, 10), annee: borne("Année du PEL", Number(m[2]), 2024, 2100), plafond: borne("Plafond du PEL", nombre(plafond[1]), 20000, 200000),
    min: borne("Versement minimum du PEL", nombre(min[1]), 0, 10000), ansMin, ansVers, ansMax: borne("Durée maximale du PEL", Number(fin[1]), ansVers, 50) };
}

// PEA : plafond des versements et durée avant laquelle un retrait clôture le plan.
async function lirePea(){
  const t = texte(await lire(SOURCES.pea));
  const plafond = trouver("Plafond du PEA", t, /plafond des versements sur le PEA bancaire est de ([\d ]+) €/i);
  const ans = trouver("Durée du PEA", t, /tout retrait \(total ou partiel\) avant la fin de la (\d+) ?(?:e|ème|eme) année du PEA entraîne la clôture du plan/i);
  return { plafond: borne("Plafond du PEA", nombre(plafond[1]), 20000, 1000000), ans: borne("Durée du PEA", Number(ans[1]), 1, 15) };
}

// Garantie des dépôts bancaires (FGDR). La garantie des contrats d'assurance
// vie (FGAP) n'est publiée dans aucune page lisible par un robot : elle garde
// sa valeur, vérifiée avec le rappel annuel des fonds en euros.
async function lireGaranties(ancien){
  const t = texte(await lire(SOURCES.garanties));
  const dep = trouver("Garantie des dépôts", t, /Garantie des dépôts Quel montant est garanti ?\? Jusqu.à ([\d ]+) ?€ par client et par établissement bancaire/i);
  return { ...(ancien.garanties || {}), depots: borne("Garantie des dépôts", nombre(dep[1]), 20000, 1000000) };
}

// Compte à terme : taux moyen des nouveaux dépôts des ménages (série mensuelle).
async function lireCompteTerme(){
  const csv = (await lire(SOURCES.compteTerme)).trim().split(/\r?\n/);
  if(csv.length < 2) throw new Error("Taux des comptes à terme introuvable");
  const cols = csv[0].split(","), val = csv[csv.length - 1].split(",");
  const mois = val[cols.indexOf("TIME_PERIOD")], taux = Number(val[cols.indexOf("OBS_VALUE")]);
  if(!/^\d{4}-\d{2}$/.test(mois || "")) throw new Error("Mois du taux des comptes à terme illisible");
  return { taux: borne("Taux des comptes à terme", Math.round(taux * 100) / 100, 0, 10), mois };
}

// Règles fiscales des placements : prélèvements sociaux, flat tax,
// assurance vie, plafond du PER et barème de l'impôt.
async function lireFiscalite(){
  const tPs = texte(await lire(SOURCES.prelevements));
  // Dernière année décrite (« Revenus de 2026 … Cas général … TOTAL 18,6 % … Assurance vie … TOTAL 17,2 % … Plan épargne logement … TOTAL 17,2 % »)
  const blocs = [...tPs.matchAll(/Revenus de (\d{4}) Le taux des prélèvements sociaux dépend des revenus concernés : Cas général (.*?)(?=Revenus de \d{4}|Comment payer)/gi)];
  if(!blocs.length) throw new Error("Taux des prélèvements sociaux introuvables : la page a peut-être changé de forme");
  const bloc = blocs[blocs.length - 1], annee = borne("Année des prélèvements sociaux", Number(bloc[1]), 2024, 2100);
  const total = (nom, re) => borne(nom, pct(trouver(nom, bloc[2], re)[1]), 5, 40);
  const ps = total("Prélèvements sociaux (cas général)", /^.*?TOTAL ([\d,]+) ?%/i);
  const psAv = total("Prélèvements sociaux (assurance vie)", /Assurance vie Tableau.*?TOTAL ([\d,]+) ?%/i);
  const psPel = total("Prélèvements sociaux (PEL)", /Plan épargne logement Tableau.*?TOTAL ([\d,]+) ?%/i);
  const csgDed = borne("CSG déductible", pct(trouver("CSG déductible", tPs, /part déductible est de ([\d,]+) ?%/i)[1]), 0, 15);

  const tPv = texte(await lire(SOURCES.plusValues));
  const pfu = trouver("Flat tax", tPv, /prélèvement forfaitaire unique au taux de ([\d,]+) ?% \( ?([\d,]+) ?% d'impôt sur le revenu et ([\d,]+) ?% de prélèvements sociaux ?\)/i);
  if(Math.abs(pct(pfu[3]) - ps) > 0.01) throw new Error(`Prélèvements sociaux incohérents : ${pfu[3]} et ${ps}`);

  const tAv = texte(await lire(SOURCES.assuranceVie));
  const ab = trouver("Abattement de l'assurance vie", tAv, /([\d ]+) € pour un célibataire ([\d ]+) € pour un couple/i);
  const t8 = trouver("Taux après 8 ans", tAv, /([\d,]+) ?% pour les intérêts correspondant aux primes n'excédant pas ([\d ]+) €/i);
  const avAns = borne("Durée de l'assurance vie", Number(trouver("Durée de l'assurance vie", tAv, /Contrat de plus de (\d+) ans Les intérêts de vos contrats d.assurance-vie sont imposés en/i)[1]), 2, 20);

  const tPer = texte(await lire(SOURCES.per));
  const per = trouver("Plafond du PER", tPer, /égal à ([\d,]+) ?% de vos revenus d.activité[^(]*\(nets de frais professionnels\) de \d{4} \(avec un maximum de ([\d ]+) € ?\), ou à ([\d ]+) € si ce montant est plus élevé/i);

  const tIr = texte(await lire(SOURCES.bareme));
  const b = trouver("Barème de l'impôt", tIr, /Barème progressif applicable aux revenus de (\d{4}) Tranches de revenus Taux d'imposition de la tranche de revenu (.*?Plus de [\d ]+ € \d+ ?%)/i);
  const tranches = [];
  const debut = b[2].match(/^Jusqu'à ([\d ]+) € 0 ?%/i);
  if(!debut) throw new Error("Barème de l'impôt : première tranche introuvable");
  tranches.push([nombre(debut[1]), 0]);
  for(const m of b[2].matchAll(/De [\d ]+ € à ([\d ]+) € (\d+) ?%/g)) tranches.push([nombre(m[1]), Number(m[2])]);
  const fin = b[2].match(/Plus de [\d ]+ € (\d+) ?%/i);
  tranches.push([null, Number(fin[1])]);
  if(tranches.length < 4) throw new Error("Barème de l'impôt incomplet");
  for(let i = 1; i < tranches.length; i++){
    if(!(tranches[i][1] > tranches[i - 1][1]) || (tranches[i][0] !== null && !(tranches[i][0] > tranches[i - 1][0]))) throw new Error("Barème de l'impôt non croissant");
  }
  borne("Première tranche", tranches[0][0], 5000, 30000);
  return {
    annee, ps, psAv, psPel, pfu: borne("Flat tax (impôt)", pct(pfu[2]), 5, 30), csgDed,
    avAbatt: [borne("Abattement (seul)", nombre(ab[1]), 1000, 20000), borne("Abattement (couple)", nombre(ab[2]), 2000, 40000)],
    avTaux8: borne("Taux après 8 ans", pct(t8[1]), 1, 20), avSeuil: borne("Seuil des primes", nombre(t8[2]), 50000, 1000000), avAns,
    perPct: borne("Plafond du PER (%)", pct(per[1]), 1, 30), perMin: borne("Plafond du PER (minimum)", nombre(per[3]), 1000, 20000), perMax: borne("Plafond du PER (maximum)", nombre(per[2]), 10000, 100000),
    bareme: { revenus: borne("Année du barème", Number(b[1]), 2023, 2100), tranches }
  };
}

// Rendement des fonds en euros saisi dans le formulaire « Run workflow ».
function fondsEurosSaisi(ancien){
  const brut = (process.env.FONDS_EUROS || "").trim(), anBrut = (process.env.FONDS_EUROS_ANNEE || "").trim();
  if(!brut) return undefined;
  const taux = borne("Rendement des fonds en euros", nombre(brut.replace("%", "")), 0, 10);
  const anCourant = Number(aujourdhui().slice(0, 4));
  const annee = anBrut ? borne("Année du rendement des fonds en euros", Number(anBrut), 2000, anCourant) : anCourant - 1;
  if(ancien.fondsEuros && annee < ancien.fondsEuros.annee) throw new Error(`Rendement des fonds en euros : l'année ${annee} est plus ancienne que celle déjà connue (${ancien.fondsEuros.annee})`);
  return { taux: Math.round(taux * 100) / 100, annee };
}
// L'ACPR publie le rendement de l'année écoulée vers l'été : à partir du
// 1er septembre, un chiffre plus ancien appelle une saisie.
function rappels(nouveau){
  const jour = aujourdhui(), an = Number(jour.slice(0, 4)), r = [];
  if(jour.slice(5) >= "09-01" && nouveau.fondsEuros && nouveau.fondsEuros.annee < an - 1) r.push({
    titre: `Taux : rendement ${an - 1} des fonds en euros à saisir`,
    corps: [
      `Le rendement moyen des fonds en euros affiché dans l'application est celui de ${nouveau.fondsEuros.annee} (${String(nouveau.fondsEuros.taux).replace(".", ",")} %).`,
      `L'ACPR publie chaque année, vers l'été, le « taux de revalorisation moyen » des contrats d'assurance vie de l'année écoulée (publication « Revalorisation ${an - 1} des contrats d'assurance-vie et de capitalisation » : https://acpr.banque-france.fr/fr/publications-et-statistiques/publications).`,
      "",
      "Pour le mettre à jour, sans toucher au code :",
      "1. ouvrez l'onglet **Actions** du dépôt, puis « Mise à jour des taux » ;",
      `2. cliquez sur **Run workflow**, saisissez le taux (par exemple \`2,63\`) et l'année (\`${an - 1}\`), puis validez.`,
      "",
      "Profitez-en pour vérifier que la garantie des contrats d'assurance vie (FGAP, https://www.fgap.fr) est toujours de " + ((nouveau.garanties && nouveau.garanties.assurance) || 70000).toLocaleString("fr-FR").replace(/\u202f/g, " ") + " € par assuré et par assureur.",
      "",
      "Ce rappel se ferme tout seul une fois le chiffre saisi."
    ].join("\n")
  });
  return r;
}

async function main(){
  const dryRun = process.argv.includes("--dry-run");
  const ancien = JSON.parse(await readFile(FICHIER, "utf8"));
  const erreurs = [];
  const livrets = await rubrique("Livret A et LDDS", erreurs, () => lireLivrets(ancien));
  const lep = await rubrique("LEP", erreurs, () => lireLep(ancien));
  const inflation = await rubrique("Inflation", erreurs, lireInflation);
  const pel = await rubrique("PEL", erreurs, lirePel);
  const pea = await rubrique("PEA", erreurs, lirePea);
  const fiscalite = await rubrique("Fiscalité", erreurs, lireFiscalite);
  const garanties = await rubrique("Garantie des dépôts", erreurs, () => lireGaranties(ancien));
  const compteTerme = await rubrique("Comptes à terme", erreurs, lireCompteTerme);
  const fondsEuros = await rubrique("Fonds en euros (saisie)", erreurs, () => fondsEurosSaisi(ancien));

  const nouveau = { ...ancien };
  if(livrets) Object.assign(nouveau, livrets);
  if(lep) nouveau.lep = lep;
  if(inflation) nouveau.inflation = inflation;
  if(pel) nouveau.pel = pel;
  if(pea) nouveau.pea = pea;
  if(fiscalite) nouveau.fiscalite = fiscalite;
  if(garanties) nouveau.garanties = garanties;
  if(compteTerme) nouveau.compteTerme = compteTerme;
  if(fondsEuros) nouveau.fondsEuros = fondsEuros;

  console.log(JSON.stringify({ periode: nouveau.periode, livretA: nouveau.livretA, ldds: nouveau.ldds, lep: nouveau.lep && { taux: nouveau.lep.taux, plafond: nouveau.lep.plafond }, inflation: nouveau.inflation, pel: nouveau.pel, pea: nouveau.pea, garanties: nouveau.garanties, compteTerme: nouveau.compteTerme, fondsEuros: nouveau.fondsEuros, fiscalite: nouveau.fiscalite }));
  // On ne réécrit le fichier (donc on ne publie) que si une valeur a changé.
  const avant = JSON.stringify(ancien), apres = JSON.stringify(nouveau);
  if(avant === apres) console.log("Aucun changement.");
  else {
    nouveau.maj = aujourdhui();
    if(dryRun) console.log("Changement détecté (essai : rien n'est écrit).");
    else {
      // Une ligne par tranche de barème, pour des différences lisibles.
      const json = JSON.stringify(nouveau, null, 2).replace(/\[\s+([\d.]+|null),\s+(\d+)\s+\]/g, "[$1, $2]");
      await writeFile(FICHIER, json + "\n");
      console.log("taux.json mis à jour.");
    }
  }
  // Rappels à ouvrir sur GitHub (étape suivante du workflow) : une ligne
  // JSON par rappel dans le fichier indiqué par RAPPELS. Le fichier est
  // toujours écrit, même vide : son absence signifie que le robot n'est pas
  // allé jusque-là, et les rappels ouverts restent alors en place.
  const aFaire = rappels(nouveau);
  if(aFaire.length) console.log("Rappel : " + aFaire.map(r => r.titre).join(" ; "));
  if(process.env.RAPPELS && !dryRun) await writeFile(process.env.RAPPELS, aFaire.map(r => JSON.stringify(r) + "\n").join(""));
  if(erreurs.length){
    console.error("Rubriques non mises à jour :\n- " + erreurs.join("\n- "));
    process.exit(1);
  }
}

main().catch(e => { console.error("Échec : " + e.message); process.exit(1); });
