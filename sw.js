/* =========================================================================
   Suivi de Budget — service worker
   =========================================================================
   Deux missions :

   1. HORS LIGNE. L'application tient dans un seul fichier (index.html) : on
      en garde une copie, servie dès que le réseau manque. Le réseau reste
      prioritaire quand il répond, pour toujours ouvrir la dernière version ;
      s'il traîne (réseau faible), la copie est servie sans attendre et la
      version en ligne est récupérée en arrière-plan.

   2. MISES À JOUR AUTOMATIQUES. Aucun numéro de version à tenir à la main :
      l'empreinte (hachage) du fichier fait office de version. La page la
      reçoit dans <meta name="app-version">, et demande régulièrement au
      service worker de comparer avec la version en ligne. Si elles diffèrent,
      la nouvelle version est mise en cache et la page se recharge d'elle-même
      au premier moment sans risque (aucune fiche ouverte, aucune saisie en
      cours) — sans fermer l'application ni vider le cache.

   Ce fichier ne change presque jamais : publier une nouvelle version de
   index.html suffit. S'il est modifié, le navigateur installe le nouveau
   service worker, qui prend aussitôt la main ; la page se recharge alors de
   la même façon.
   ========================================================================= */
"use strict";

var SHELL_CACHE = "suivi-budget-shell-v1";
var RUNTIME_CACHE = "suivi-budget-runtime-v1";
var SCOPE = self.registration.scope;
var SHELL_URL = new URL("./", SCOPE).href;
var NETWORK_TIMEOUT = 3500;

/* Empreinte rapide d'un texte (cyrb53). Pas besoin d'une fonction
   cryptographique : il s'agit seulement de savoir si le fichier a changé. */
function empreinte(str){
  var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for(var i = 0, ch; i < str.length; i++){
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/* La page d'application, et elle seule : la racine du dossier ou index.html. */
function estCoquille(url){
  var u = new URL(url);
  var s = new URL(SCOPE);
  if(u.origin !== s.origin) return false;
  return u.pathname === s.pathname || u.pathname === s.pathname + "index.html";
}

function avecDelai(promesse, ms){
  return new Promise(function(resolve, reject){
    var fini = false;
    var minuteur = setTimeout(function(){ if(!fini){ fini = true; reject(new Error("timeout")); } }, ms);
    promesse.then(function(v){ if(!fini){ fini = true; clearTimeout(minuteur); resolve(v); } },
                  function(e){ if(!fini){ fini = true; clearTimeout(minuteur); reject(e); } });
  });
}

/* Récupère la version en ligne, la range dans le cache avec son empreinte, et
   renvoie { texte, version }. Rejette si le réseau ne répond pas. */
function recupererEnLigne(){
  return fetch(SHELL_URL, { cache: "no-cache", credentials: "same-origin" }).then(function(rep){
    if(!rep.ok) throw new Error("HTTP " + rep.status);
    var type = rep.headers.get("Content-Type") || "";
    if(type.indexOf("text/html") === -1) throw new Error("type inattendu");
    return rep.text();
  }).then(function(texte){
    var version = empreinte(texte);
    return caches.open(SHELL_CACHE).then(function(cache){
      return cache.put(SHELL_URL, new Response(texte, {
        headers: { "Content-Type": "text/html; charset=utf-8", "X-App-Version": version }
      }));
    }).then(function(){ return { texte: texte, version: version }; });
  });
}

function lireCache(){
  return caches.open(SHELL_CACHE).then(function(cache){ return cache.match(SHELL_URL); }).then(function(rep){
    if(!rep) return null;
    return rep.text().then(function(texte){
      return { texte: texte, version: rep.headers.get("X-App-Version") || empreinte(texte) };
    });
  });
}

/* Le document servi porte sa propre empreinte, pour que la page sache quelle
   version elle exécute — y compris quand elle vient du cache, hors ligne. */
function servir(entree){
  var html = entree.texte.replace(
    '<meta name="app-version" content="">',
    '<meta name="app-version" content="' + entree.version + '">'
  );
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function pageHorsLigne(){
  return new Response(
    '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Suivi de Budget</title><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'font-family:system-ui,sans-serif;background:#0A0F0C;color:#ECF1EB;text-align:center;padding:24px">' +
    '<div><div style="font-size:44px">📡</div><h1 style="font-weight:600;font-size:20px">Hors ligne</h1>' +
    '<p style="opacity:.7;max-width:320px;line-height:1.5">Ouvrez l’application une première fois avec du réseau : elle sera ensuite disponible hors ligne.</p>' +
    '<button onclick="location.reload()" style="margin-top:12px;padding:12px 20px;border-radius:14px;border:0;background:#E8C766;font-weight:700">Réessayer</button></div></body></html>',
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

self.addEventListener("install", function(event){
  event.waitUntil(
    recupererEnLigne().catch(function(){ /* hors ligne à l'installation : le cache se remplira plus tard */ })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function(event){
  event.waitUntil(
    caches.keys().then(function(noms){
      return Promise.all(noms.filter(function(n){
        return n.indexOf("suivi-budget-") === 0 && n !== SHELL_CACHE && n !== RUNTIME_CACHE;
      }).map(function(n){ return caches.delete(n); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

/* Réseau d'abord, avec un délai : au-delà, la copie est servie tout de suite
   et le téléchargement se poursuit en arrière-plan pour la prochaine fois. */
function coquille(event){
  var enLigne = recupererEnLigne();
  event.waitUntil(enLigne.catch(function(){}));
  return avecDelai(enLigne, NETWORK_TIMEOUT).then(servir).catch(function(){
    return lireCache().then(function(entree){
      if(entree) return servir(entree);
      /* Rien en cache : on attend le réseau jusqu'au bout. */
      return enLigne.then(servir).catch(pageHorsLigne);
    });
  });
}

/* Bibliothèque de synchronisation (Firebase) : ses adresses sont versionnées,
   donc immuables ; une copie permet à la synchronisation de redémarrer même
   si l'application a été ouverte hors ligne. */
function cacheDabord(request){
  return caches.open(RUNTIME_CACHE).then(function(cache){
    return cache.match(request).then(function(trouve){
      if(trouve) return trouve;
      return fetch(request).then(function(rep){
        if(rep && (rep.ok || rep.type === "opaque")) cache.put(request, rep.clone());
        return rep;
      });
    });
  });
}

self.addEventListener("fetch", function(event){
  var req = event.request;
  if(req.method !== "GET") return;
  var url = req.url;
  if((req.mode === "navigate" || req.destination === "document") && estCoquille(url)){
    event.respondWith(coquille(event));
    return;
  }
  if(url.indexOf("https://www.gstatic.com/firebasejs/") === 0){
    event.respondWith(cacheDabord(req));
    return;
  }
  /* Tout le reste suit son cours normal. */
});

/* La page demande : « une version plus récente a-t-elle été publiée ? » */
self.addEventListener("message", function(event){
  var data = event.data || {};
  var repondre = function(msg){
    if(event.ports && event.ports[0]) event.ports[0].postMessage(msg);
    else if(event.source) event.source.postMessage(msg);
  };
  if(data.type === "check"){
    event.waitUntil(
      lireCache().then(function(avant){
        return recupererEnLigne().then(function(apres){
          repondre({ type: "version", version: apres.version, previous: avant ? avant.version : null, online: true });
        });
      }).catch(function(){
        return lireCache().then(function(entree){
          repondre({ type: "version", version: entree ? entree.version : null, online: false });
        });
      })
    );
  } else if(data.type === "skipWaiting"){
    self.skipWaiting();
  }
});
