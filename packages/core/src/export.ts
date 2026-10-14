// Design → code : un arbre de nœuds devient du HTML + CSS positionné.

import type { NodeTree } from "./model.js";

export function exportHtml(root: NodeTree): { html: string; css: string } {
  const rules: string[] = [];
  const cls = (n: NodeTree) => "n-" + slug(n.name) + "-" + n.id.slice(-4);

  const render = (n: NodeTree, isRoot: boolean, depth: number): string => {
    if (!n.visible) return "";
    const c = cls(n);
    const s: string[] = [
      isRoot ? "position: relative" : "position: absolute",
      ...(isRoot ? [] : [`left: ${px(n.x)}`, `top: ${px(n.y)}`]),
      `width: ${px(n.width)}`,
      `height: ${px(n.height)}`,
    ];
    if (n.fill && n.type !== "text" && n.type !== "path") s.push(`background: ${n.fill}`);
    if (n.stroke && n.type !== "path") s.push(`border: ${px(n.stroke.width)} solid ${n.stroke.color}`, "box-sizing: border-box");
    if (n.type === "ellipse") s.push("border-radius: 50%");
    else if (n.radius) s.push(`border-radius: ${px(n.radius)}`);
    if (n.opacity !== 1) s.push(`opacity: ${n.opacity}`);
    if (n.rotation) s.push(`transform: rotate(${n.rotation}deg)`, "transform-origin: top left");
    if (n.clip && n.children.length) s.push("overflow: hidden");
    if (n.text) {
      s.push(
        `font-family: "${n.text.fontFamily}", sans-serif`,
        `font-size: ${px(n.text.fontSize)}`,
        `font-weight: ${n.text.fontWeight}`,
        `line-height: ${n.text.lineHeight}`,
        `color: ${n.text.color}`,
        `text-align: ${n.text.align}`,
        "margin: 0",
      );
    }
    rules.push(`.${c} {\n  ${s.join(";\n  ")};\n}`);
    const pad = "  ".repeat(depth);
    if (n.type === "text") return `${pad}<p class="${c}">${escape(n.text!.content)}</p>`;
    if (n.type === "image" && n.image) {
      const k = n.image.crop;
      if (!k) return `${pad}<img class="${c}" src="${n.image.src}" alt="${escape(n.name)}" style="object-fit: cover">`;
      const w = n.width / k.width, h = n.height / k.height;
      return `${pad}<div class="${c}" style="overflow: hidden"><img src="${n.image.src}" alt="${escape(n.name)}" style="position: absolute; max-width: none; width: ${w}px; height: ${h}px; left: ${-k.x * w}px; top: ${-k.y * h}px"></div>`;
    }
    if (n.type === "path" && n.path) {
      const m = n.path.matrix.join(" ");
      return `${pad}<svg class="${c}" viewBox="0 0 ${n.width || 1} ${n.height || 1}" style="overflow: visible; display: block"><path d="${n.path.d}" transform="matrix(${m})" fill="${n.fill ?? "none"}"${n.path.fillRule === "evenodd" ? ' fill-rule="evenodd"' : ""}${n.stroke ? ` stroke="${n.stroke.color}" stroke-width="${n.stroke.width}"` : ""} /></svg>`;
    }
    const inner = n.children.map((ch) => render(ch, false, depth + 1)).filter(Boolean).join("\n");
    return inner ? `${pad}<div class="${c}">\n${inner}\n${pad}</div>` : `${pad}<div class="${c}"></div>`;
  };

  const html = render(root, true, 0);
  return { html, css: rules.join("\n\n") };
}

const px = (v: number) => `${Math.round(v * 100) / 100}px`;
const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "node";
const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
