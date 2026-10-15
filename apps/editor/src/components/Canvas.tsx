import { useEffect, useRef, useState } from "react";
import { Stage, Layer, Group, Rect, Ellipse, Text, Path, Image as KImage, Shape as KShape, Transformer } from "react-konva";
import KonvaLib from "konva";
import type Konva from "konva";
import { DEFAULT_BACKGROUND, type NodeProps, inFlow, resizeOps, type DesignDocument, type Gradient, type ImageData, type ClipPath, type Matrix6, type PathData, type Shadow, applyMatrix, cssFontStack, invertMatrix, toRgba, type DesignNode, type NodeType, absolutePosition, makeNode, resizeProps } from "@swiftma/core";
import { fitTextOps } from "../textFit";
import { USER_ID, sendCursor, setThumbnailCapture, type View, dispatch, getState, select, setCanvasSize, setEditingText, setTool, setView, useEditor } from "../store";

// Konva dessine lettre par lettre dès qu'il y a un espacement : le crénage (« Te », « AV »…) est perdu.
// On garde la mise en page de Konva (largeurs avec espacement) mais on dessine chaque ligne d'un bloc
// avec l'espacement natif du canevas, comme le navigateur.
type SceneText = { _sceneFunc(ctx: Konva.Context): void; attrs: { letterSpacing?: number } };
const textProto = KonvaLib.Text.prototype as unknown as SceneText;
const konvaTextScene = textProto._sceneFunc;
textProto._sceneFunc = function (this: SceneText, ctx: Konva.Context) {
  const ls = this.attrs.letterSpacing ?? 0;
  const native = ctx._context as CanvasRenderingContext2D & { letterSpacing?: string };
  if (!ls || !("letterSpacing" in native)) return konvaTextScene.call(this, ctx);
  this.attrs.letterSpacing = 0;
  native.letterSpacing = `${ls}px`;
  try {
    konvaTextScene.call(this, ctx);
  } finally {
    this.attrs.letterSpacing = ls;
    native.letterSpacing = "0px";
  }
};

interface Draft { type: NodeType; x0: number; y0: number; x1: number; y1: number }

export const COMPONENT = "#9747FF";
const ACCENT = "#0D99FF";

export function Canvas() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const editingTextId = useEditor((s) => s.editingTextId);
  const version = useEditor((s) => s.version);
  const fontsVersion = useEditor((s) => s.fontsVersion);

  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const others = useEditor((s) => s.presence.users).filter((u) => u.id !== USER_ID);
  const readOnly = useEditor((s) => s.role === "viewer");

  // Vignette du fichier pour l'écran Projets : rendu des frames de premier niveau, 480 px de large au plus
  useEffect(() => {
    setThumbnailCapture(() => {
      const stage = stageRef.current;
      const { doc: d, view: v } = getState();
      if (!stage || !d.roots.length) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const id of d.roots) {
        const n = d.nodes[id]!;
        if (!n.visible) continue;
        x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
        x1 = Math.max(x1, n.x + n.width); y1 = Math.max(y1, n.y + n.height);
      }
      if (!Number.isFinite(x0) || x1 <= x0 || y1 <= y0) return null;
      const ratio = Math.min(480 / ((x1 - x0) * v.scale), 360 / ((y1 - y0) * v.scale), 4);
      // Sans les poignées de sélection ni les curseurs et sélections des autres
      const hidden = [stage.findOne("Transformer"), ...stage.find(".presence")].filter((x): x is Konva.Node => !!x && x.visible());
      hidden.forEach((x) => x.visible(false));
      try {
        return stage.toDataURL({ x: x0 * v.scale + v.x, y: y0 * v.scale + v.y, width: (x1 - x0) * v.scale, height: (y1 - y0) * v.scale, pixelRatio: ratio });
      } catch {
        return null; // image d'une autre origine : le navigateur interdit la capture
      } finally {
        hidden.forEach((x) => x.visible(true));
      }
    });
    return () => setThumbnailCapture(null);
  }, []);
  const trRef = useRef<Konva.Transformer>(null);
  const size = useEditor((s) => s.canvasSize);
  const view = useEditor((s) => s.view);
  const [hover, setHover] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);

  // Taille du canevas = taille du conteneur
  // Polices chargées : les textes qui s'ajustent à leur contenu sont re-mesurés
  useEffect(() => {
    if (!fontsVersion) return;
    const ops = fitTextOps(getState().doc);
    if (ops.length) dispatch(ops, "Ajuster les textes");
  }, [fontsVersion]);

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
  }, [selection, doc, fontsVersion]); // la couche est recréée quand les polices arrivent

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
    const w = pointer();
    sendCursor(w.x, w.y); // les autres voient notre curseur
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
    // Un texte posé d'un clic s'ajuste à son contenu (comme dans Figma) ; tracé en boîte, il garde sa largeur
    const node = makeNode(d.type, {
      x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height),
      ...(d.type === "text" ? (clicked ? { sizingH: "hug" as const, sizingV: "hug" as const } : { sizingV: "hug" as const }) : {}),
    });
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
    const { doc } = getState();
    const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
    if (parent?.layout && inFlow(doc, node)) {
      // Dans un auto-layout, glisser un élément change sa place dans l'ordre, pas ses coordonnées
      const row = parent.layout.direction === "row";
      const center = row ? g.x() + node.width / 2 : g.y() + node.height / 2;
      const others = parent.children.filter((id) => id !== node.id);
      let index = others.length;
      for (let i = 0; i < others.length; i++) {
        const o = doc.nodes[others[i]!]!;
        if (!inFlow(doc, o)) continue;
        if (center < (row ? o.x + o.width / 2 : o.y + o.height / 2)) {
          index = i;
          break;
        }
      }
      if (parent.children.indexOf(node.id) !== index) dispatch([{ kind: "move", id: node.id, parentId: parent.id, index }], "Réordonner");
      const after = getState().doc.nodes[node.id]!;
      g.position({ x: after.x, y: after.y }); // le moteur de mise en page a le dernier mot
      return;
    }
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
      // Redimensionner à la main fixe la taille sur l'axe touché (comme dans Figma)
      const sizing: NodeProps = {};
      if (width !== Math.round(n.width) && n.sizingH && n.sizingH !== "fixed") sizing.sizingH = "fixed";
      if (height !== Math.round(n.height) && n.sizingV && n.sizingV !== "fixed") sizing.sizingV = "fixed";
      // Les enfants en position libre suivent leurs contraintes
      return resizeOps(getState().doc, id, width, height, { ...sizing, x: Math.round(g.x()), y: Math.round(g.y()), rotation: Math.round(g.rotation() * 10) / 10 });
    });
    dispatch(ops.flat(), "Redimensionner");
    // Les éléments placés par un auto-layout reviennent à la position calculée
    for (const g of tr.nodes()) {
      const after = getState().doc.nodes[fromCssId(g.id())];
      if (after) g.position({ x: after.x, y: after.y });
    }
  };

  const renderNode = (id: string): React.ReactNode => {
    const n = doc.nodes[id];
    if (!n || !n.visible) return null;
    const common = { opacity: n.opacity };
    const stroke = n.stroke
      ? {
          stroke: n.stroke.color,
          strokeWidth: n.stroke.width,
          lineCap: n.stroke.cap ?? "butt",
          lineJoin: n.stroke.join ?? "miter",
          ...(n.stroke.dash?.length ? { dash: n.stroke.dash } : {}),
          ...(n.stroke.miterLimit ? { miterLimit: n.stroke.miterLimit } : {}),
        }
      : {};
    let shape: React.ElementType | null = null;
    let shapeProps: Record<string, unknown> = {};
    let local: Matrix6 = [1, 0, 0, 1, 0, 0]; // pixels du nœud → repère de la forme Konva
    let extra: React.ReactNode = null;
    if (n.type === "frame" || n.type === "rect") {
      shape = Rect;
      shapeProps = { width: n.width, height: n.height, fill: n.fill ?? undefined, cornerRadius: n.radius, ...stroke };
    } else if (n.type === "ellipse") {
      shape = Ellipse;
      shapeProps = { x: n.width / 2, y: n.height / 2, radiusX: n.width / 2, radiusY: n.height / 2, fill: n.fill ?? undefined, ...stroke };
      local = [1, 0, 0, 1, -n.width / 2, -n.height / 2];
    } else if (n.type === "path" && n.path) {
      const t = new KonvaLib.Transform(n.path.matrix).decompose();
      const inv = invertMatrix(n.path.matrix);
      shape = Path;
      shapeProps = {
        data: n.path.d, fill: n.fill ?? undefined, fillRule: n.path.fillRule, ...stroke,
        strokeScaleEnabled: false, x: t.x, y: t.y, rotation: t.rotation, scaleX: t.scaleX, scaleY: t.scaleY, skewX: t.skewX, skewY: t.skewY,
      };
      local = inv;
      // Zone cliquable = boîte englobante, pour sélectionner facilement les petits vecteurs
      extra = <Rect width={n.width} height={n.height} fill="transparent" />;
    } else if (n.type === "image" && n.image) {
      shape = NodeImage;
      shapeProps = { src: n.image.src, crop: n.image.crop, width: n.width, height: n.height, radius: n.radius };
    } else if (n.type === "text" && n.text) {
      shape = Text;
      shapeProps = {
        width: n.sizingH === "hug" ? undefined : n.width, text: n.text.content, fontFamily: cssFontStack(n.text), fontSize: n.text.fontSize,
        fontStyle: `${n.text.italic ? "italic " : ""}${n.text.fontWeight}`, lineHeight: n.text.lineHeight, align: n.text.align, fill: n.text.color,
        letterSpacing: n.text.letterSpacing ?? 0, textDecoration: n.text.decoration ?? "",
        // Soulignement à ~0,1 em sous la ligne de base, comme les polices courantes dans le navigateur
        underlineOffset: Math.round(n.text.fontSize * 0.1),
        ...(n.stroke ? { stroke: n.stroke.color, strokeWidth: n.stroke.width, fillAfterStrokeEnabled: false } : {}),
        visible: editingTextId !== n.id,
      };
    }
    if (shape && n.gradient) Object.assign(shapeProps, gradientProps(n.gradient, n.width, n.height, local));
    const Shape_ = shape;
    const drops = (n.shadows ?? []).filter((sh) => sh.type === "drop");
    const inners = (n.shadows ?? []).filter((sh) => sh.type === "inner");
    const boxy = n.type === "frame" || n.type === "rect" || n.type === "ellipse" || n.type === "image";
    const filled = !!(n.fill || n.gradient);
    const content: React.ReactNode = Shape_ && (
      <>
        {/* Flou d'arrière-plan : on floute ce qui est déjà dessiné sous la forme */}
        {!!n.backgroundBlur && (
          <BackdropBlur width={n.width} height={n.height} radius={n.type === "ellipse" ? -1 : n.type === "frame" || n.type === "rect" || n.type === "image" ? n.radius : 0} blur={n.backgroundBlur} />
        )}
        {/* Frame sans fond : son ombre suit le contour de son contenu */}
        {n.type === "frame" && !filled && drops.length > 0 && n.children.length > 0 && <ContentShadow shadows={drops} version={version} />}
        {/* Ombres portées : une copie de la forme, dessinée dessous, qui ne montre que son ombre */}
        {(filled || n.type === "text" || n.type === "image") && drops.map((sh, i) => (
          <Shape_ key={"d" + i} {...shapeProps} {...shadowProps(sh)} listening={false} />
        ))}
        <Shape_ {...shapeProps} />
        {boxy && inners.map((sh, i) => (
          <InnerShadow key={"i" + i} width={n.width} height={n.height} radius={n.type === "ellipse" ? -1 : n.radius} shadow={sh} />
        ))}
        {extra}
      </>
    );
    const clip =
      n.type === "frame" && n.clip
        ? { clipFunc: n.clipPath ? pathClip(n.clipPath) : roundedClip(n.width, n.height, n.radius) }
        : {};
    return (
      <Group
        key={n.id}
        id={cssId(n.id)}
        ref={(g) => applyLayerBlur(g, n.layerBlur ?? 0)}
        x={n.x}
        y={n.y}
        rotation={n.rotation}
        {...common}
        draggable={!n.locked && !drawing && !panning && !readOnly}
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
        {content}
        {n.children.length > 0 && (
          <Group name="kids" {...clip} ref={n.clip && n.clipPath?.fade ? (g) => cacheForFade(g) : undefined}>
            {n.children.map(renderNode)}
            {n.clip && n.clipPath?.fade && <FadeMask clip={n.clipPath} width={n.width} height={n.height} />}
          </Group>
        )}
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
        onMouseLeave={() => sendCursor(null, null)}
      >
        <Layer key={fontsVersion /* polices chargées : on recrée les textes pour qu'ils se re-mesurent */}>
          {/* Titres des frames de premier niveau */}
          {/* (et des variantes d'un ensemble de composants) ; violet pour les composants et instances, comme dans Figma */}
          {[...doc.roots, ...doc.roots.flatMap((r) => (doc.nodes[r]!.isComponentSet ? doc.nodes[r]!.children : []))].map((id) => {
            const n = doc.nodes[id]!;
            if (n.type !== "frame" || !n.visible) return null;
            const abs = absolutePosition(doc, id);
            const purple = n.isComponent || n.isComponentSet || n.instanceOf;
            const label = (n.isComponent || n.isComponentSet ? "❖ " : n.instanceOf ? "◇ " : "") + (n.variant ? Object.entries(n.variant).map(([k, v]) => `${k}=${v}`).join(", ") : n.name);
            return (
              <Text
                key={"t" + id}
                x={abs.x}
                y={abs.y - 18 / view.scale}
                text={label}
                fontSize={12 / view.scale}
                fontFamily="Inter"
                fill={purple ? COMPONENT : selection.includes(id) ? ACCENT : "#8C8C8C"}
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
                name="presence"
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
          {/* Les autres personnes : leur sélection et leur curseur, à leur couleur */}
          {others.flatMap((u) =>
            u.selection.filter((id) => doc.nodes[id]).map((id) => {
              const n = doc.nodes[id]!;
              const abs = absolutePosition(doc, id);
              return <Rect key={u.id + id} name="presence" x={abs.x} y={abs.y} width={n.width} height={n.height} rotation={n.rotation} stroke={u.color} strokeWidth={1.5 / view.scale} listening={false} />;
            }),
          )}
          {others.filter((u) => u.cursor).map((u) => (
            <Group key={"c" + u.id} name="presence" x={u.cursor!.x} y={u.cursor!.y} scaleX={1 / view.scale} scaleY={1 / view.scale} listening={false}>
              <Path data="M0 0 L0 16 L4.5 12 L8 19 L10.5 18 L7 11 L13 11 Z" fill={u.color} stroke="#FFFFFF" strokeWidth={1} />
              <Rect x={12} y={18} width={u.name.length * 6.6 + 12} height={20} cornerRadius={4} fill={u.color} />
              <Text x={18} y={22} text={u.name} fontSize={11} fontFamily="Inter" fill="#FFFFFF" />
            </Group>
          ))}
          {draftRect && (
            <Rect {...draftRect} stroke={ACCENT} strokeWidth={1 / view.scale} dash={[4 / view.scale, 4 / view.scale]} listening={false} />
          )}
          <Transformer
            ref={trRef}
            visible={!readOnly}
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
        fontStyle: t.italic ? "italic" : "normal",
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

/** Masque de forme libre : le tracé d'origine, ramené dans le repère de la frame par sa matrice. */
const clipCache = new Map<string, Path2D>();
function pathClip(p: ClipPath) {
  const all: PathData[] = [p, ...(p.parts ?? [])];
  const key = all.map((q) => q.d + "|" + q.matrix.join(",")).join("§");
  let path = clipCache.get(key);
  if (!path) {
    path = new Path2D();
    for (const q of all) path.addPath(new Path2D(q.d), new DOMMatrix(q.matrix));
    if (clipCache.size > 500) clipCache.clear();
    clipCache.set(key, path);
  }
  // Union de formes : avec plusieurs formes, « nonzero » (une règle « evenodd » croiserait les formes entre elles)
  const rule: CanvasFillRule = all.length > 1 ? "nonzero" : p.fillRule;
  return (): [Path2D, CanvasFillRule] => [path!, rule];
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
function NodeImage({ src, crop, width, height, radius, ...rest }: { src: string; crop?: ImageData["crop"]; width: number; height: number; radius: number } & Record<string, unknown>) {
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
  if (!img) return <Rect width={width} height={height} fill="#E3E3E3" cornerRadius={radius} {...rest} />;
  if (crop) {
    const W = img.naturalWidth, H = img.naturalHeight;
    return (
      <KImage image={img} width={width} height={height} cornerRadius={radius} {...rest}
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
      {...rest}
    />
  );
}

/** Dégradé (fractions de la boîte) → propriétés Konva, dans le repère local de la forme. */
function gradientProps(g: Gradient, w: number, h: number, local: Matrix6) {
  if (g.type === "radial") {
    // Dégradé radial : rendu exact (ellipse tournée comprise) dans une image, posée en motif sur la forme
    const PR = 2;
    const img = radialImage(g, w, h, PR);
    const t = new KonvaLib.Transform(local).scale(1 / PR, 1 / PR).decompose();
    return {
      fillPriority: "pattern",
      fillPatternImage: img,
      fillPatternRepeat: "no-repeat",
      fillPatternX: t.x,
      fillPatternY: t.y,
      fillPatternRotation: t.rotation,
      fillPatternScaleX: t.scaleX,
      fillPatternScaleY: t.scaleY,
    };
  }
  const stops = g.stops.flatMap((s) => [s.offset, toRgba(s.color)]);
  const [sx, sy] = applyMatrix(local, g.start[0] * w, g.start[1] * h);
  const [ex, ey] = applyMatrix(local, g.end[0] * w, g.end[1] * h);
  return {
    fillPriority: "linear-gradient",
    fillLinearGradientStartPoint: { x: sx, y: sy },
    fillLinearGradientEndPoint: { x: ex, y: ey },
    fillLinearGradientColorStops: stops,
  };
}

const radialCache = new Map<string, HTMLCanvasElement>();
function radialImage(g: Gradient, w: number, h: number, pr: number): HTMLCanvasElement {
  const key = JSON.stringify([g, Math.round(w), Math.round(h), pr]);
  const hit = radialCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w * pr));
  c.height = Math.max(1, Math.ceil(h * pr));
  const ctx = c.getContext("2d")!;
  const [rx, ry] = g.radius ?? [0.5, 0.5];
  ctx.scale(pr, pr);
  ctx.translate(g.start[0] * w, g.start[1] * h);
  ctx.rotate(((g.angle ?? 0) * Math.PI) / 180);
  ctx.scale(Math.max(rx * w, 0.01), Math.max(ry * h, 0.01));
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const st of g.stops) grad.addColorStop(Math.max(0, Math.min(1, st.offset)), toRgba(st.color));
  ctx.fillStyle = grad;
  ctx.fillRect(-1e4, -1e4, 2e4, 2e4); // au-delà du dernier arrêt, la dernière couleur continue (comme en SVG/CSS)
  if (radialCache.size > 200) radialCache.clear();
  radialCache.set(key, c);
  return c;
}

/** Flou de calque : l'élément (et son contenu) est mis en cache puis flouté par Konva. */
function applyLayerBlur(g: Konva.Group | null, blur: number) {
  if (!g) return;
  requestAnimationFrame(() => {
    if (!g.getStage()) return;
    if (!blur) {
      if (g.isCached()) g.clearCache();
      return;
    }
    const pr = Math.max(1, (g.getStage()?.scaleX() ?? 1) * window.devicePixelRatio);
    g.clearCache();
    g.cache({ pixelRatio: pr, offset: Math.ceil(blur * 2) });
    g.filters([KonvaLib.Filters.Blur]);
    g.blurRadius(Math.round(blur * pr)); // rayon de pile ≈ 2σ ; CSS blur(valeur/2) ⇒ σ = valeur/2
    g.getLayer()?.batchDraw();
  });
}

/**
 * Flou d'arrière-plan (verre dépoli) : au moment de dessiner l'élément, le canevas contient déjà tout ce qui est
 * dessous. On copie cette zone, on la floute, et on la redessine rognée à la forme de l'élément.
 */
const backdropTmp = document.createElement("canvas");
function BackdropBlur({ width: w, height: h, radius, blur }: { width: number; height: number; radius: number; blur: number }) {
  return (
    <KShape
      listening={false}
      sceneFunc={(kctx) => {
        const c = (kctx as unknown as { _context: CanvasRenderingContext2D })._context;
        const m = c.getTransform();
        const scale = Math.hypot(m.a, m.b);
        const pad = Math.ceil(blur * scale * 1.5) + 2;
        const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
        const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x))) - pad);
        const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))) - pad);
        const x1 = Math.min(c.canvas.width, Math.ceil(Math.max(...pts.map((p) => p.x))) + pad);
        const y1 = Math.min(c.canvas.height, Math.ceil(Math.max(...pts.map((p) => p.y))) + pad);
        if (x1 <= x0 || y1 <= y0) return;
        backdropTmp.width = x1 - x0;
        backdropTmp.height = y1 - y0;
        backdropTmp.getContext("2d")!.drawImage(c.canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
        c.save();
        c.beginPath();
        if (radius < 0) c.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        else roundRectPath(c, 0, 0, w, h, radius);
        c.clip();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.filter = `blur(${(blur / 2) * scale}px)`;
        c.drawImage(backdropTmp, x0, y0);
        c.restore();
      }}
    />
  );
}

function roundRectPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  c.moveTo(x + k, y);
  c.arcTo(x + w, y, x + w, y + h, k);
  c.arcTo(x + w, y + h, x, y + h, k);
  c.arcTo(x, y + h, x, y, k);
  c.arcTo(x, y, x + w, y, k);
  c.closePath();
}

/**
 * Ombre d'une frame sans fond : on prend une image de son contenu, on la place très loin
 * et on ne garde que son ombre, décalée pour retomber sous le contenu (même principe que l'ombre interne).
 */
function ContentShadow({ shadows, version }: { shadows: Shadow[]; version: number }) {
  const ref = useRef<Konva.Group>(null);
  const [snap, setSnap] = useState<{ img: HTMLCanvasElement; x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const me = ref.current;
      const parent = me?.getParent();
      const kids = parent?.findOne(".kids");
      if (!me || !parent || !kids) return;
      const rect = kids.getClientRect({ relativeTo: parent as Konva.Container });
      if (!rect.width || !rect.height) return;
      const img = kids.toCanvas({ pixelRatio: 2 });
      setSnap({ img, x: rect.x, y: rect.y, w: rect.width, h: rect.height });
    });
    return () => cancelAnimationFrame(id);
  }, [version, shadows]);
  // Dessin manuel (et non un nœud image) : sinon l'image placée au loin agrandirait le cadre de sélection.
  return (
    <Group ref={ref} listening={false}>
      {snap && (
        <KShape
          sceneFunc={(kctx) => {
            const c = (kctx as unknown as { _context: CanvasRenderingContext2D })._context;
            const m = c.getTransform();
            const scale = Math.hypot(m.a, m.b);
            const OFF = 100000;
            for (const s of shadows) {
              c.save();
              c.shadowColor = toRgba(s.color);
              c.shadowBlur = s.blur * scale;
              c.shadowOffsetX = (s.x + OFF) * scale;
              c.shadowOffsetY = s.y * scale;
              c.drawImage(snap.img, snap.x - OFF, snap.y, snap.w, snap.h);
              c.restore();
            }
          }}
        />
      )}
    </Group>
  );
}

function shadowProps(s: Shadow) {
  return { shadowColor: toRgba(s.color), shadowBlur: s.blur, shadowOffsetX: s.x, shadowOffsetY: s.y, shadowOpacity: 1, shadowForStrokeEnabled: false };
}

/**
 * Ombre interne (Konva n'en a pas) : on rogne à la forme, puis on dessine un anneau autour d'elle, très loin,
 * dont seule l'ombre décalée retombe à l'intérieur. radius = -1 pour une ellipse.
 */
function InnerShadow({ width: w, height: h, radius, shadow: s }: { width: number; height: number; radius: number; shadow: Shadow }) {
  return (
    <KShape
      listening={false}
      sceneFunc={(kctx, shape) => {
        const c = (kctx as unknown as { _context: CanvasRenderingContext2D })._context;
        const t = shape.getAbsoluteTransform().getMatrix();
        const scale = Math.hypot(t[0]!, t[1]!) * kctx.getCanvas().getPixelRatio();
        const OFF = 100000;
        const outline = (ox: number, inset: number) => {
          const x = ox + inset, y = inset, ww = Math.max(0, w - 2 * inset), hh = Math.max(0, h - 2 * inset);
          if (radius < 0) c.ellipse(x + ww / 2, y + hh / 2, ww / 2, hh / 2, 0, 0, Math.PI * 2);
          else {
            const k = Math.max(0, Math.min(radius - inset, ww / 2, hh / 2));
            c.moveTo(x + k, y);
            c.arcTo(x + ww, y, x + ww, y + hh, k);
            c.arcTo(x + ww, y + hh, x, y + hh, k);
            c.arcTo(x, y + hh, x, y, k);
            c.arcTo(x, y, x + ww, y, k);
            c.closePath();
          }
        };
        c.save();
        c.beginPath();
        outline(0, 0);
        c.clip();
        const pad = s.blur * 2 + Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.spread) + 10;
        c.beginPath();
        c.rect(-OFF - pad, -pad, w + 2 * pad, h + 2 * pad);
        outline(-OFF, s.spread);
        c.shadowColor = toRgba(s.color);
        c.shadowBlur = s.blur * scale;
        c.shadowOffsetX = (s.x + OFF) * scale;
        c.shadowOffsetY = s.y * scale;
        c.fillStyle = "#000";
        c.fill("evenodd");
        c.restore();
      }}
    />
  );
}

/** Masque en fondu : le contenu de la frame est mis en cache (une image), pour que le fondu ne touche qu'elle. */
function cacheForFade(g: Konva.Group | null) {
  if (!g) return;
  requestAnimationFrame(() => {
    if (!g.getStage()) return;
    const pr = Math.max(1, (g.getStage()?.scaleX() ?? 1) * window.devicePixelRatio);
    g.clearCache();
    g.cache({ pixelRatio: pr });
    g.getLayer()?.batchDraw();
  });
}

/**
 * Applique le fondu : on dessine la forme du masque remplie par le dégradé d'opacité, en mode « destination-in »
 * (ne garde que ce qui est sous le masque, avec son opacité). Uniquement dans le cache, sinon on effacerait le calque.
 */
function FadeMask({ clip, width: w, height: h }: { clip: ClipPath; width: number; height: number }) {
  return (
    <KShape
      listening={false}
      sceneFunc={(kctx, shape) => {
        const c = (kctx as unknown as { _context: CanvasRenderingContext2D })._context;
        const layerCanvas = (shape.getLayer()?.getCanvas() as unknown as { _canvas: HTMLCanvasElement } | undefined)?._canvas;
        if (!layerCanvas || c.canvas === layerCanvas) return;
        const g = clip.fade!;
        const PR = 2;
        const mask = document.createElement("canvas");
        mask.width = Math.max(1, Math.ceil(w * PR));
        mask.height = Math.max(1, Math.ceil(h * PR));
        const m = mask.getContext("2d")!;
        m.scale(PR, PR);
        if (g.type === "radial") m.drawImage(radialImage(g, w, h, PR), 0, 0, w, h);
        else {
          const lg = m.createLinearGradient(g.start[0] * w, g.start[1] * h, g.end[0] * w, g.end[1] * h);
          for (const st of g.stops) lg.addColorStop(Math.max(0, Math.min(1, st.offset)), toRgba(st.color));
          m.fillStyle = lg;
          m.fillRect(0, 0, w, h);
        }
        const path = new Path2D();
        path.addPath(new Path2D(clip.d), new DOMMatrix(clip.matrix));
        m.globalCompositeOperation = "destination-in";
        m.fillStyle = "#000";
        m.fill(path, clip.fillRule);
        c.save();
        c.globalCompositeOperation = "destination-in";
        c.drawImage(mask, 0, 0, w, h);
        c.restore();
      }}
    />
  );
}
