// Design → code : un arbre de nœuds devient du HTML + CSS positionné.

import type { NodeTree } from "./model.js";
import { absolutePlacementCss, cssEffects, cssFontStack, cssGradient, cssMask, cssStroke, sizeBoundsCss, stretchesWithParent } from "./paint.js";

export function exportHtml(root: NodeTree): { html: string; css: string } {
  const rules: string[] = [];
  const cls = (n: NodeTree) => "n-" + slug(n.name) + "-" + n.id.slice(-4);

  const render = (n: NodeTree, parent: NodeTree | null, depth: number): string => {
    if (!n.visible) return "";
    const c = cls(n);
    const isRoot = !parent;
    const flow = !!parent?.layout && !n.absolute;
    const sz = (axis: "h" | "v") => {
      const v = (axis === "h" ? n.sizingH : n.sizingV) ?? "fixed";
      const parentHug = !!parent?.layout && ((axis === "h" ? parent.sizingH : parent.sizingV) ?? "fixed") === "hug";
      if (v === "fill" && ((flow && !parentHug) || (isRoot && axis === "h"))) return "fill";
      return v === "hug" && n.layout ? "hug" : "fixed";
    };
    const dim = (axis: "h" | "v", size: number) => {
      const v = sz(axis);
      const prop = axis === "h" ? "width" : "height";
      return v === "fixed" ? [`${prop}: ${px(size)}`] : v === "hug" ? [`${prop}: fit-content`] : isRoot ? [`${prop}: 100%`] : [];
    };
    const free = !isRoot && !flow;
    const s: string[] = [
      ...(free ? absolutePlacementCss(n, parent!.width, parent!.height).filter((d) => !d.startsWith("transform")) : ["position: relative"]),
      ...(free && stretchesWithParent(n, "h") ? [] : dim("h", n.width)),
      ...(free && stretchesWithParent(n, "v") ? [] : dim("v", n.height)),
      ...sizeBoundsCss(n),
      "box-sizing: border-box",
    ];
    if (flow) {
      const row = parent!.layout!.direction === "row";
      if (sz(row ? "h" : "v") === "fill") s.push("flex: 1 1 0", row ? "min-width: 0" : "min-height: 0");
      else s.push("flex-shrink: 0");
      if (sz(row ? "v" : "h") === "fill") s.push("align-self: stretch");
      if (!row && sz("h") !== "fill") s.push("max-width: 100%");
    }
    if (n.layout) {
      const L = n.layout;
      const al = { start: "flex-start", center: "center", end: "flex-end", "space-between": "space-between" };
      const wrap = L.direction === "row" && L.wrap;
      s.push(
        "display: flex",
        `flex-direction: ${L.direction}`,
        ...(wrap ? ["flex-wrap: wrap", "align-content: flex-start"] : []),
        `gap: ${wrap ? `${px(L.wrapGap ?? L.gap)} ` : ""}${px(L.gap)}`,
        `padding: ${L.padding.map(px).join(" ")}`,
        `justify-content: ${al[L.justify]}`,
        `align-items: ${al[L.align]}`,
      );
    }
    if (n.gradient && n.type !== "path") {
      s.push(`background: ${cssGradient(n.gradient, n.width, n.height)}`);
      if (n.type === "text") s.push("-webkit-background-clip: text", "background-clip: text", "color: transparent");
    } else if (n.fill && n.type !== "text" && n.type !== "path") s.push(`background: ${n.fill}`);
    const fx = cssEffects(n);
    const strokeShadow = n.stroke && n.type !== "path" && n.type !== "text" ? cssStroke(n.stroke) : null;
    const boxShadow = [strokeShadow, fx.boxShadow].filter(Boolean).join(", ");
    if (boxShadow) s.push(`box-shadow: ${boxShadow}`);
    if (fx.filter) s.push(`filter: ${fx.filter}`);
    if (fx.backdropFilter) s.push(`backdrop-filter: ${fx.backdropFilter}`, `-webkit-backdrop-filter: ${fx.backdropFilter}`);
    if (n.type === "ellipse") s.push("border-radius: 50%");
    else if (n.radius) s.push(`border-radius: ${px(n.radius)}`);
    if (n.opacity !== 1) s.push(`opacity: ${n.opacity}`);
    if (n.rotation) s.push(`transform: rotate(${n.rotation}deg)`, "transform-origin: top left");
    if (n.clip && n.children.length) s.push("overflow: hidden");
    if (n.clip && n.clipPath) {
      const mask = cssMask(n.clipPath, n.width, n.height);
      s.push(`-webkit-mask: ${mask}`, `mask: ${mask}`);
    }
    if (n.text) {
      s.push(
        `font-family: ${cssFontStack(n.text)}`,
        `font-size: ${px(n.text.fontSize)}`,
        `font-weight: ${n.text.fontWeight}`,
        ...(n.text.italic ? ["font-style: italic"] : []),
      ...(n.text.letterSpacing ? [`letter-spacing: ${n.text.letterSpacing}px`] : []),
      ...(n.text.decoration ? [`text-decoration: ${n.text.decoration}`] : []),
      ...(n.stroke && n.stroke.width > 0 ? [`-webkit-text-stroke: ${n.stroke.width}px ${n.stroke.color}`] : []),
        `line-height: ${n.text.lineHeight}`,
        ...(n.gradient ? [] : [`color: ${n.text.color}`]),
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
      return `${pad}<svg class="${c}" viewBox="0 0 ${n.width || 1} ${n.height || 1}" style="overflow: visible; display: block"><path d="${n.path.d}" transform="matrix(${m})" fill="${n.fill ?? "none"}"${n.path.fillRule === "evenodd" ? ' fill-rule="evenodd"' : ""}${n.stroke ? ` stroke="${n.stroke.color}" stroke-width="${n.stroke.width}" vector-effect="non-scaling-stroke"${n.stroke.cap ? ` stroke-linecap="${n.stroke.cap}"` : ""}${n.stroke.join ? ` stroke-linejoin="${n.stroke.join}"` : ""}${n.stroke.dash?.length ? ` stroke-dasharray="${n.stroke.dash.join(" ")}"` : ""}` : ""} /></svg>`;
    }
    const inner = n.children.map((ch) => render(ch, n, depth + 1)).filter(Boolean).join("\n");
    return inner ? `${pad}<div class="${c}">\n${inner}\n${pad}</div>` : `${pad}<div class="${c}"></div>`;
  };

  const html = render(root, null, 0);
  return { html, css: rules.join("\n\n") };
}

const px = (v: number) => `${Math.round(v * 100) / 100}px`;
const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "node";
const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
