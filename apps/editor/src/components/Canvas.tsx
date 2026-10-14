import { useEffect, useRef, useState } from "react";
import { Stage, Layer, Group, Rect, Ellipse, Text, Path, Image as KImage, Transformer } from "react-konva";
import KonvaLib from "konva";
import type Konva from "konva";
import { DEFAULT_BACKGROUND, type DesignDocument, type ImageData, type DesignNode, type NodeType, absolutePosition, makeNode, resizeProps } from "@nyota/core";
import { type View, dispatch, getState, select, setCanvasSize, setEditingText, setTool, setView, useEditor } from "../store";

interface Draft { type: NodeType; x0: number; y0: number; x1: number; y1: number }

export const ACCENT = "#0D99FF";

export function Canvas() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const editingTextId = useEditor((s) => s.editingTextId);

  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const size = useEditor((s) => s.canvasSize);
  const view = useEditor((s) => s.view);
  const [hover, setHover] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);

  // Taille du canevas = taille du conteneur
  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setCanvasSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Espace maintenu = main (déplacement du canevas)
  useEffect(() => {
    const down = (e: KeyboardEvent) => e.code === "Space" && !isTyping(e) && (e.preventDefault(), setSpaceDown(true));
    const up = (e: KeyboardEvent) => e.code === "Space" && setSpaceDown(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => (window.removeEventListener("keydown", down), window.removeEventListener("keyup", up));
  }, []);

  // Le Transformer suit la sélection
  useEffect(() => {
    const stage = stageRef.current;
    const tr = trRef.current;
    if (!stage || !tr) return;
    const nodes = selection
      .filter((id) => doc.nodes[id] && !doc.nodes[id]!.locked)
      .map((id) => stage.findOne("#" + cssId(id)))
      .filter((n): n is Konva.Node => !!n);
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [selection, doc]);

  const panning = tool === "hand" || spaceDown;
  const drawing = tool !== "select" && tool !== "hand";

  /** Coordonnées du pointeur dans l'espace du document. */
  const pointer = () => {
    const p = stageRef.current!.getPointerPosition()!;
    return { x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale };
  };

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current!;
    if (e.evt.ctrlKey || e.evt.metaKey) {
      const p = stage.getPointerPosition()!;
      const factor = Math.exp(-e.evt.deltaY * 0.01);
      const scale = clamp(view.scale * factor, 0.05, 32);
      const wx = (p.x - view.x) / view.scale;
      const wy = (p.y - view.y) / view.scale;
      setView({ scale, x: p.x - wx * scale, y: p.y - wy * scale });
    } else {
      setView((v) => ({ ...v, x: v.x - e.evt.deltaX, y: v.y - e.evt.deltaY }));
    }
  };

  const onMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (panning || e.evt.button !== 0) return;
    if (drawing) {
      const p = pointer();
      setDraft({ type: tool as NodeType, x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      return;
    }
    // Clic dans le vide = désélection
    if (e.target === e.target.getStage()) select([]);
  };

  const onMouseMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    // Survol : contour bleu sur l'élément sous le pointeur, comme dans Figma
    let t: Konva.Node | null = e.target;
    while (t && !t.id().startsWith("n_")) t = t.getParent();
    const hid = t ? fromCssId(t.id()) : null;
    if (hid !== hover) setHover(hid);
    if (!draft) return;
    const p = pointer();
    setDraft({ ...draft, x1: p.x, y1: p.y });
  };

  const onMouseUp = () => {
    if (!draft) return;
    const d = draft;
    setDraft(null);
    let x = Math.min(d.x0, d.x1);
    let y = Math.min(d.y0, d.y1);
    let width = Math.abs(d.x1 - d.x0);
    let height = Math.abs(d.y1 - d.y0);
    const clicked = width < 3 && height < 3;
    if (clicked) {
      // Simple clic : taille par défaut
      const defaults: Record<string, [number, number]> = { frame: [375, 812], text: [160, 24] };
      const def = defaults[d.type] ?? [100, 100];
      width = def[0]!;
      height = def[1]!;
    }
    const parent = frameAt(doc, d.x0, d.y0);
    if (parent) {
      const abs = absolutePosition(doc, parent.id);
      x -= abs.x;
      y -= abs.y;
    }
    const node = makeNode(d.type, { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
    node.parentId = parent?.id ?? null;
    dispatch([{ kind: "create", node }], "Créer " + node.name);
    select([node.id]);
    setTool("select");
    if (d.type === "text") setEditingText(node.id);
  };

  const onNodeClick = (id: string, e: Konva.KonvaEventObject<MouseEvent>) => {
    if (drawing || panning) return;
    e.cancelBubble = true;
    const sel = getState().selection;
    if (e.evt.shiftKey) select(sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]);
    else if (!sel.includes(id)) select([id]);
  };

  const onDragEnd = (node: DesignNode, e: Konva.KonvaEventObject<DragEvent>) => {
    e.cancelBubble = true;
    const g = e.target;
    dispatch([{ kind: "update", id: node.id, props: { x: Math.round(g.x()), y: Math.round(g.y()) } }], "Déplacer");
  };

  const onTransformEnd = () => {
    const tr = trRef.current!;
    const ops = tr.nodes().map((g) => {
      const id = fromCssId(g.id());
      const n = getState().doc.nodes[id]!;
      const width = Math.max(1, Math.round(n.width * g.scaleX()));
      const height = Math.max(1, Math.round(n.height * g.scaleY()));
      g.scale({ x: 1, y: 1 });
      return {
        kind: "update" as const,
        id,
        props: { ...resizeProps(n, width, height), x: Math.round(g.x()), y: Math.round(g.y()), rotation: Math.round(g.rotation() * 10) / 10 },
      };
    });
    dispatch(ops, "Redimensionner");
  };

  const renderNode = (id: string): React.ReactNode => {
    const n = doc.nodes[id];
    if (!n || !n.visible) return null;
    const common = { opacity: n.opacity };
    const stroke = n.stroke ? { stroke: n.stroke.color, strokeWidth: n.stroke.width } : {};
    let shape: React.ReactNode = null;
    if (n.type === "frame" || n.type === "rect") {
      shape = <Rect width={n.width} height={n.height} fill={n.fill ?? undefined} cornerRadius={n.radius} {...stroke} />;
    } else if (n.type === "ellipse") {
      shape = (
        <Ellipse x={n.width / 2} y={n.height / 2} radiusX={n.width / 2} radiusY={n.height / 2} fill={n.fill ?? undefined} {...stroke} />
      );
    } else if (n.type === "path" && n.path) {
      const t = new KonvaLib.Transform(n.path.matrix).decompose();
      shape = (
        <Path
          data={n.path.d}
          fill={n.fill ?? undefined}
          fillRule={n.path.fillRule}
          stroke={n.stroke?.color}
          strokeWidth={n.stroke?.width}
          strokeScaleEnabled={false}
          x={t.x}
          y={t.y}
          rotation={t.rotation}
          scaleX={t.scaleX}
          scaleY={t.scaleY}
          skewX={t.skewX}
          skewY={t.skewY}
        />
      );
      // Zone cliquable = boîte englobante, pour sélectionner facilement les petits vecteurs
      shape = <>{shape}<Rect width={n.width} height={n.height} fill="transparent" /></>;
    } else if (n.type === "image" && n.image) {
      shape = <NodeImage src={n.image.src} crop={n.image.crop} width={n.width} height={n.height} radius={n.radius} />;
    } else if (n.type === "text" && n.text) {
      shape = (
        <Text
          width={n.width}
          text={n.text.content}
          fontFamily={n.text.fontFamily}
          fontSize={n.text.fontSize}
          fontStyle={String(n.text.fontWeight)}
          lineHeight={n.text.lineHeight}
          align={n.text.align}
          fill={n.text.color}
          visible={editingTextId !== n.id}
        />
      );
    }
    const clip = n.type === "frame" && n.clip ? { clipFunc: roundedClip(n.width, n.height, n.radius) } : {};
    return (
      <Group
        key={n.id}
        id={cssId(n.id)}
        x={n.x}
        y={n.y}
        rotation={n.rotation}
        {...common}
        draggable={!n.locked && !drawing && !panning}
        onMouseDown={(e) => onNodeClick(n.id, e)}
        onDblClick={(e) => {
          e.cancelBubble = true;
          if (n.type === "text") setEditingText(n.id);
        }}
        onDragStart={(e) => {
          e.cancelBubble = true;
          if (!getState().selection.includes(n.id)) select([n.id]);
        }}
        onDragEnd={(e) => onDragEnd(n, e)}
      >
        {shape}
        {n.children.length > 0 && <Group {...clip}>{n.children.map(renderNode)}</Group>}
      </Group>
    );
  };

  const draftRect = draft && {
    x: Math.min(draft.x0, draft.x1),
    y: Math.min(draft.y0, draft.y1),
    width: Math.abs(draft.x1 - draft.x0),
    height: Math.abs(draft.y1 - draft.y0),
  };

  return (
    <div
      ref={wrapRef}
      className="canvas"
      style={{ cursor: panning ? "grab" : drawing ? "crosshair" : "default", background: doc.background ?? DEFAULT_BACKGROUND }}
    >
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        x={view.x}
        y={view.y}
        scaleX={view.scale}
        scaleY={view.scale}
        draggable={panning}
        onDragEnd={(e) => e.target === stageRef.current && setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }))}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      >
        <Layer>
          {/* Titres des frames de premier niveau */}
          {doc.roots.map((id) => {
            const n = doc.nodes[id]!;
            if (n.type !== "frame" || !n.visible) return null;
            return (
              <Text
                key={"t" + id}
                x={n.x}
                y={n.y - 18 / view.scale}
                text={n.name}
                fontSize={12 / view.scale}
                fontFamily="Inter"
                fill={selection.includes(id) ? ACCENT : "#8C8C8C"}
                listening={false}
              />
            );
          })}
          {doc.roots.map(renderNode)}
          {hover && !selection.includes(hover) && !draft && doc.nodes[hover] && (() => {
            const n = doc.nodes[hover]!;
            const abs = absolutePosition(doc, hover);
            return (
              <Rect
                x={abs.x}
                y={abs.y}
                width={n.width}
                height={n.height}
                rotation={n.rotation}
                stroke={ACCENT}
                strokeWidth={1.5 / view.scale}
                cornerRadius={n.type === "ellipse" ? undefined : n.radius}
                listening={false}
              />
            );
          })()}
          {draftRect && (
            <Rect {...draftRect} stroke={ACCENT} strokeWidth={1 / view.scale} dash={[4 / view.scale, 4 / view.scale]} listening={false} />
          )}
          <Transformer
            ref={trRef}
            rotateEnabled
            keepRatio={false}
            borderStroke={ACCENT}
            anchorStroke={ACCENT}
            anchorSize={7}
            anchorFill="#FFFFFF"
            anchorCornerRadius={1}
            ignoreStroke
            onTransformEnd={onTransformEnd}
          />
        </Layer>
      </Stage>
      <TextEditor view={view} />
    </div>
  );
}

/** Zone de saisie posée par-dessus le canevas pour éditer un texte. */
function TextEditor({ view }: { view: View }) {
  const id = useEditor((s) => s.editingTextId);
  const doc = useEditor((s) => s.doc);
  const ref = useRef<HTMLTextAreaElement>(null);
  const node = id ? doc.nodes[id] : undefined;

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [id]);

  if (!node?.text) return null;
  const abs = absolutePosition(doc, node.id);
  const t = node.text;
  const commit = (value: string) => {
    if (value !== t.content) dispatch([{ kind: "update", id: node.id, props: { text: { content: value } } }], "Texte");
    setEditingText(null);
  };
  return (
    <textarea
      ref={ref}
      className="text-editor"
      defaultValue={t.content}
      style={{
        left: view.x + abs.x * view.scale,
        top: view.y + abs.y * view.scale,
        width: node.width * view.scale,
        height: node.height * view.scale,
        fontFamily: t.fontFamily,
        fontSize: t.fontSize * view.scale,
        fontWeight: t.fontWeight,
        lineHeight: t.lineHeight,
        textAlign: t.align,
        color: t.color,
      }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) commit(e.currentTarget.value);
      }}
    />
  );
}

/** La frame la plus profonde (et la plus haute dans l'empilement) sous un point. */
function frameAt(doc: DesignDocument, x: number, y: number): DesignNode | null {
  const search = (ids: string[], ox: number, oy: number): DesignNode | null => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const n = doc.nodes[ids[i]!]!;
      if (n.type !== "frame" || !n.visible) continue;
      const nx = ox + n.x;
      const ny = oy + n.y;
      if (x >= nx && x <= nx + n.width && y >= ny && y <= ny + n.height) {
        return search(n.children, nx, ny) ?? n;
      }
    }
    return null;
  };
  return search(doc.roots, 0, 0);
}

function roundedClip(w: number, h: number, r: number) {
  return (ctx: Konva.Context) => {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(rr, 0);
    ctx.arcTo(w, 0, w, h, rr);
    ctx.arcTo(w, h, 0, h, rr);
    ctx.arcTo(0, h, 0, 0, rr);
    ctx.arcTo(0, 0, w, 0, rr);
    ctx.closePath();
  };
}

// Les ids Konva servent de sélecteurs ("#id") : on préfixe pour éviter qu'ils commencent par un chiffre.
const cssId = (id: string) => "n_" + id;
const fromCssId = (id: string) => id.slice(2);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const isTyping = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
};

/** Images : chargées une fois puis mises en cache (une même source peut servir plusieurs nœuds). */
const imageCache = new Map<string, HTMLImageElement>();
function NodeImage({ src, crop, width, height, radius }: { src: string; crop?: ImageData["crop"]; width: number; height: number; radius: number }) {
  const [img, setImg] = useState<HTMLImageElement | null>(() => {
    const cached = imageCache.get(src);
    return cached?.complete ? cached : null;
  });
  useEffect(() => {
    let el = imageCache.get(src);
    if (!el) {
      el = new window.Image();
      el.src = src;
      imageCache.set(src, el);
    }
    if (el.complete) setImg(el);
    else el.addEventListener("load", () => setImg(el!), { once: true });
  }, [src]);
  if (!img) return <Rect width={width} height={height} fill="#E3E3E3" cornerRadius={radius} />;
  if (crop) {
    const W = img.naturalWidth, H = img.naturalHeight;
    return (
      <KImage image={img} width={width} height={height} cornerRadius={radius}
        crop={{ x: crop.x * W, y: crop.y * H, width: crop.width * W, height: crop.height * H }} />
    );
  }
  // Remplissage « cover », comme object-fit: cover dans l'export
  const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
  const cw = width / scale;
  const ch = height / scale;
  return (
    <KImage
      image={img}
      width={width}
      height={height}
      cornerRadius={radius}
      crop={{ x: (img.naturalWidth - cw) / 2, y: (img.naturalHeight - ch) / 2, width: cw, height: ch }}
    />
  );
}
