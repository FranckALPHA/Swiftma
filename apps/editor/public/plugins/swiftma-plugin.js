// SDK des plugins Swiftma (API v1). À inclure dans la page du plugin :
//   <script src="https://VOTRE-INSTANCE/plugins/swiftma-plugin.js"></script>
// puis :
//   const info = await swiftma.call("getInfo");
//   await swiftma.call("insertSvg", { svg, name: "Icône" });
//   swiftma.on("selection", (ids) => …);
// Contrat complet : docs/plugins.md du dépôt Swiftma.
(function () {
  "use strict";
  var VERSION = 1;
  var seq = 0;
  var pending = {};
  var handlers = {};

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.swiftma !== VERSION) return;
    if (m.id != null && pending[m.id]) {
      var p = pending[m.id];
      delete pending[m.id];
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
    } else if (m.event && handlers[m.event]) {
      handlers[m.event].forEach(function (fn) { fn(m.ids !== undefined ? m.ids : m); });
    }
  });

  window.swiftma = {
    version: VERSION,
    /** Appelle une méthode de l'éditeur ; renvoie une promesse du résultat. */
    call: function (method, params) {
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        pending[id] = { resolve: resolve, reject: reject };
        window.parent.postMessage({ swiftma: VERSION, id: id, method: method, params: params || {} }, "*");
        setTimeout(function () {
          if (pending[id]) {
            delete pending[id];
            reject(new Error("Swiftma ne répond pas (le plugin est-il ouvert dans Swiftma ?)"));
          }
        }, 30000);
      });
    },
    /** Écoute un événement de l'éditeur (« selection »). */
    on: function (event, fn) {
      (handlers[event] = handlers[event] || []).push(fn);
    },
  };
})();
