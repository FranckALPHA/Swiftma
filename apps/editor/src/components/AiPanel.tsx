import { useEffect, useRef, useState } from "react";
import type { AiEvent } from "@swiftma/core";
import { type AiImage, askAi, attachImage, setAiImage, useEditor } from "../store";

/** Taille de frame probable : une capture mobile @2x/@3x devient un écran de 390 px de large. */
function guessFrame(img: AiImage): { w: number; h: number } {
  const { originalWidth: w, originalHeight: h } = img;
  if (h > w && w > 500) return { w: 390, h: Math.round((h * 390) / w) };
  if (w > 1920) return { w: 1440, h: Math.round((h * 1440) / w) };
  return { w, h };
}

export function AiPanel() {
  const image = useEditor((s) => s.aiImage);
  const busy = useEditor((s) => s.aiBusy);
  const log = useEditor((s) => s.aiLog);
  const selection = useEditor((s) => s.selection);
  const [prompt, setPrompt] = useState("");
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Effets en bloc : un effet ne doit rien renvoyer d'autre qu'une fonction de nettoyage. Certaines extensions
  // du navigateur remplacent scrollTo et renvoient une valeur : React plantait en quittant l'onglet IA.
  useEffect(() => {
    setFrame(image ? guessFrame(image) : null);
  }, [image]);
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  const run = () => {
    if (busy || (!image && !prompt.trim())) return;
    void askAi({
      prompt: prompt.trim(),
      image: image && frame && {
        data: image.dataUrl.split(",")[1],
        mediaType: "image/png",
        width: image.width,
        height: image.height,
        frameWidth: frame.w,
        frameHeight: frame.h,
      },
    });
    setPrompt("");
  };

  return (
    <div className="ai-panel">
      <div className="side-section-title">Designer avec l'IA</div>

      <div
        className={"dropzone" + (image ? " has-image" : "")}
        onClick={() => !image && fileRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f?.type.startsWith("image/")) void attachImage(f);
        }}
      >
        {image ? (
          <>
            <img src={image.dataUrl} alt="Capture" />
            <button className="remove" onClick={(e) => (e.stopPropagation(), setAiImage(null))}>×</button>
          </>
        ) : (
          <span>Colle une capture (Ctrl+V), dépose une image ou clique ici</span>
        )}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && attachImage(e.target.files[0])} />
      </div>

      {image && frame && (
        <div className="frame-size">
          Frame
          <input value={frame.w} onChange={(e) => setFrame({ w: Number(e.target.value) || 1, h: Math.round((Number(e.target.value) || 1) * image.originalHeight / image.originalWidth) })} />
          ×
          <input value={frame.h} onChange={(e) => setFrame({ ...frame, h: Number(e.target.value) || 1 })} />
          px
        </div>
      )}

      <textarea
        className="prompt"
        placeholder={
          image
            ? "Précisions (optionnel) : « garde les couleurs exactes », « version sombre »…"
            : selection.length
              ? "Que faire avec la sélection ? « aligne les cartes », « passe en thème sombre »…"
              : "Décris un écran : « page de paiement Mobile Money, style moderne »"
        }
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && run()}
      />
      <button className="btn primary-btn ai-run" disabled={busy || (!image && !prompt.trim())} onClick={run}>
        {busy ? "L'IA dessine…" : image ? "Designer cette capture" : "Générer"}
      </button>

      <div className="ai-log" ref={logRef}>
        {groupThinking(log).map((e, i) => (
          <div key={i} className={"ai-event " + e.kind}>
            {e.kind === "start" && <>▶ {e.prompt || "Capture d'écran"}</>}
            {e.kind === "thinking" && <i>{e.text}</i>}
            {e.kind === "tool" && <>⚙ {e.name} — {e.summary}</>}
            {e.kind === "done" && <>✓ {e.text}</>}
            {e.kind === "error" && <>✕ {e.message}</>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Regroupe les fragments de réflexion consécutifs en un seul paragraphe. */
function groupThinking(log: AiEvent[]): AiEvent[] {
  const out: AiEvent[] = [];
  for (const e of log) {
    const last = out[out.length - 1];
    if (e.kind === "thinking" && last?.kind === "thinking") out[out.length - 1] = { ...last, text: last.text + e.text };
    else out.push(e);
  }
  return out;
}
