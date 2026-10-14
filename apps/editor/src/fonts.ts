// Chargement des polices Google Fonts dans l'éditeur : indispensable pour mesurer les textes importés
// et pour que le canevas les affiche avec la bonne police.

import { type FontVariant, googleFontUrls } from "@nyota/core";

const requested = new Set<string>(); // variantes déjà demandées
const key = (v: FontVariant) => `${v.family}|${v.weight}|${v.italic}`;

function addLink(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.onload = () => resolve(true);
    link.onerror = () => (link.remove(), resolve(false));
    document.head.appendChild(link);
  });
}

/** Charge les variantes manquantes ; renvoie true si de nouvelles polices ont été chargées. */
export async function ensureFonts(variants: FontVariant[]): Promise<boolean> {
  const missing = variants.filter((v) => v.family && !requested.has(key(v)));
  if (!missing.length) return false;
  missing.forEach((v) => requested.add(key(v)));
  await Promise.all(
    googleFontUrls(missing).map(async ({ family, url }) => {
      // Variante inexistante chez Google (400) : on se rabat sur la version régulière de la famille
      if (!(await addLink(url))) await addLink(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}&display=swap`);
    }),
  );
  await Promise.all(
    missing.map((v) => document.fonts.load(`${v.italic ? "italic " : ""}${v.weight} 16px "${v.family}"`).catch(() => [])),
  );
  return true;
}
