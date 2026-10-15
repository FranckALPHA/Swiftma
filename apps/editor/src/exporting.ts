import { zipSync, strToU8 } from "fflate";
import { type DesignDocument, exportReact } from "@swiftma/core";

export const slugify = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "swiftma-export";

/** Un composant React par élément, empaquetés dans un .zip prêt à lancer (npm install && npm run dev). */
export function downloadReactZip(doc: DesignDocument, id: string) {
  const node = doc.nodes[id];
  if (!node) return;
  const files = exportReact(doc, id);
  const folder = slugify(node.name);
  const zip = zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        `${folder}/${path}`,
        typeof content === "string" ? strToU8(content) : Uint8Array.from(atob(content.base64), (c) => c.charCodeAt(0)),
      ]),
    ),
  );
  const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${folder}-react.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
