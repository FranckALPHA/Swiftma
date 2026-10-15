import { useEffect, useRef, useState } from "react";
import type { FileMeta, Project } from "@nyota/core";
import { api } from "../api";
import { openFile, setPendingImport, setUserName, userName } from "../store";
import { IconFile, IconImport, IconLogo, IconPlus } from "./icons";

/** Écran d'accueil : projets et fichiers, comme le navigateur de fichiers de Figma. */
export function Projects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(userName());
  const svgRef = useRef<HTMLInputElement>(null);

  const loadProjects = async (select?: string) => {
    try {
      const list = await api.projects();
      setProjects(list);
      const keep = select ?? current;
      setCurrent(keep && list.some((p) => p.id === keep) ? keep : (list[0]?.id ?? null));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const loadFiles = async () => {
    if (!current) return setFiles([]);
    setFiles(await api.files(current).catch(() => []));
  };
  useEffect(() => void loadProjects(), []);
  useEffect(() => void loadFiles(), [current]);

  const project = projects?.find((p) => p.id === current) ?? null;
  const act = (fn: () => Promise<unknown>) => () => void fn().then(() => (loadProjects(), loadFiles())).catch((e) => setError(e.message));

  const newProject = async () => {
    const name = prompt("Nom du projet", "Nouveau projet");
    if (!name) return;
    const p = await api.createProject(name);
    await loadProjects(p.id);
  };
  const newFile = async () => {
    if (!current) return;
    const f = await api.createFile(current, "Sans titre");
    openFile(f.id);
  };
  const importSvg = async (file: File) => {
    if (!current) return;
    const base = file.name.replace(/\.svg$/i, "");
    const f = await api.createFile(current, base);
    setPendingImport(await file.text(), base);
    openFile(f.id);
  };

  return (
    <div className="projects">
      <aside className="projects-side">
        <div className="projects-brand"><IconLogo size={22} /> Nyota</div>
        <div className="projects-label">
          Projets
          <button className="icon-btn" title="Nouveau projet" onClick={() => void newProject()}><IconPlus size={14} /></button>
        </div>
        {projects?.map((p) => (
          <button key={p.id} className={"project-item" + (p.id === current ? " on" : "")} onClick={() => setCurrent(p.id)}>
            <span className="flex1">{p.name}</span>
            <span className="meta">{p.fileCount}</span>
          </button>
        ))}
        <div className="flex1" />
        <label className="projects-user" title="Nom affiché aux autres personnes dans un fichier">
          <span className="avatar" style={{ background: "#0D99FF" }}>{name.slice(0, 1).toUpperCase()}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && setUserName(name.trim())} />
        </label>
      </aside>

      <main className="projects-main">
        {error && <div className="projects-error">Hub injoignable : {error}. Lance-le avec <code>npm run dev</code>.</div>}
        {project && (
          <>
            <header className="projects-head">
              <input
                className="project-title"
                defaultValue={project.name}
                key={project.id + project.name}
                onBlur={(e) => e.target.value.trim() && e.target.value !== project.name && act(() => api.renameProject(project.id, e.target.value.trim()))()}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
              <div className="flex1" />
              <button className="btn ghost-btn" onClick={() => svgRef.current?.click()}><IconImport size={14} /> Importer un SVG</button>
              <button className="btn primary-btn" onClick={() => void newFile()}><IconPlus size={14} /> Nouveau fichier</button>
              <button
                className="btn ghost-btn danger"
                title="Supprimer le projet et ses fichiers"
                onClick={() => confirm(`Supprimer « ${project.name} » et ses ${project.fileCount} fichier(s) ?`) && act(() => api.deleteProject(project.id))()}
              >
                Supprimer
              </button>
              <input ref={svgRef} type="file" accept=".svg,image/svg+xml" hidden onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void importSvg(f);
              }} />
            </header>
            <div className="file-grid">
              {files?.map((f) => (
                <div key={f.id} className="file-card" onClick={() => openFile(f.id)} title="Ouvrir">
                  <div className="file-thumb" style={f.hasThumbnail ? { backgroundImage: `url(${api.thumbnailUrl(f.id, f.updatedAt)})` } : undefined}>
                    {!f.hasThumbnail && <IconFile size={28} />}
                  </div>
                  <div className="file-info">
                    <div className="flex1">
                      <div className="file-name">{f.name}</div>
                      <div className="meta">Modifié {since(f.updatedAt)}</div>
                    </div>
                    <FileMenu
                      onRename={() => {
                        const name = prompt("Nom du fichier", f.name);
                        if (name && name !== f.name) act(() => api.renameFile(f.id, name))();
                      }}
                      onDuplicate={act(() => api.duplicateFile(f.id))}
                      onDelete={() => confirm(`Supprimer « ${f.name} » ?`) && act(() => api.deleteFile(f.id))()}
                    />
                  </div>
                </div>
              ))}
              {files && !files.length && <p className="hint">Aucun fichier dans ce projet. Crée-en un, ou importe un SVG exporté de Figma.</p>}
            </div>
          </>
        )}
        {projects && !projects.length && (
          <div className="projects-empty">
            <p>Aucun projet.</p>
            <button className="btn primary-btn" onClick={() => void newProject()}><IconPlus size={14} /> Créer un projet</button>
          </div>
        )}
      </main>
    </div>
  );
}

function FileMenu({ onRename, onDuplicate, onDelete }: { onRename: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="file-menu" onClick={(e) => e.stopPropagation()}>
      <button className="icon-btn" title="Actions" onClick={() => setOpen(!open)}>⋯</button>
      {open && (
        <div className="menu" onMouseLeave={() => setOpen(false)}>
          <button onClick={() => (setOpen(false), onRename())}>Renommer</button>
          <button onClick={() => (setOpen(false), onDuplicate())}>Dupliquer</button>
          <button onClick={() => (setOpen(false), onDelete())}>Supprimer</button>
        </div>
      )}
    </div>
  );
}

const since = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
};
