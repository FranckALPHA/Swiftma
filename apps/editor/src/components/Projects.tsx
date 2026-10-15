import { useEffect, useRef, useState } from "react";
import type { ApiToken, FileMeta, Member, Project, Role, User } from "@swiftma/core";
import { api } from "../api";
import { logout, openFile, setPendingImport, setUser, useEditor } from "../store";
import { IconFile, IconImport, IconLogo, IconPlus } from "./icons";
import { Modal } from "./Modal";

/** Écran d'accueil : projets et fichiers, comme le navigateur de fichiers de Figma. */
export function Projects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const user = useEditor((st) => st.user)!;
  const [modal, setModal] = useState<"share" | "tokens" | "account" | "users" | null>(null);
  const [menu, setMenu] = useState(false);
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
        <div className="projects-brand"><IconLogo size={22} /> Swiftma</div>
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
        <div className="file-menu">
          {menu && (
            <div className="menu up" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => (setMenu(false), setModal("account"))}>Mon compte</button>
              <button onClick={() => (setMenu(false), setModal("tokens"))}>Jetons d'accès (IA / MCP)</button>
              {user.isAdmin && <button onClick={() => (setMenu(false), setModal("users"))}>Comptes de l'instance</button>}
              <button onClick={() => void logout()}>Se déconnecter</button>
            </div>
          )}
          <button className="projects-user" title={user.email} onClick={() => setMenu(!menu)}>
            <span className="avatar" style={{ background: "#0D99FF" }}>{user.name.slice(0, 1).toUpperCase()}</span>
            <span className="flex1">{user.name}</span>
            {user.isAdmin && <span className="meta">admin</span>}
          </button>
        </div>
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
                readOnly={project.role === "viewer"}
                onBlur={(e) => e.target.value.trim() && e.target.value !== project.name && act(() => api.renameProject(project.id, e.target.value.trim()))()}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
              {project.role === "viewer" && <span className="badge readonly-badge">Lecture seule</span>}
              <div className="flex1" />
              <button className="btn ghost-btn" onClick={() => setModal("share")}>Partager</button>
              {project.role !== "viewer" && <button className="btn ghost-btn" onClick={() => svgRef.current?.click()}><IconImport size={14} /> Importer un SVG</button>}
              {project.role !== "viewer" && <button className="btn primary-btn" onClick={() => void newFile()}><IconPlus size={14} /> Nouveau fichier</button>}
              {project.role === "owner" && <button
                className="btn ghost-btn danger"
                title="Supprimer le projet et ses fichiers"
                onClick={() => confirm(`Supprimer « ${project.name} » et ses ${project.fileCount} fichier(s) ?`) && act(() => api.deleteProject(project.id))()}
              >
                Supprimer
              </button>}
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
                    {project.role !== "viewer" && <FileMenu
                      onRename={() => {
                        const name = prompt("Nom du fichier", f.name);
                        if (name && name !== f.name) act(() => api.renameFile(f.id, name))();
                      }}
                      onDuplicate={act(() => api.duplicateFile(f.id))}
                      onDelete={() => confirm(`Supprimer « ${f.name} » ?`) && act(() => api.deleteFile(f.id))()}
                    />}
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
      {modal === "share" && project && <ShareModal project={project} me={user} onClose={() => (setModal(null), void loadProjects())} />}
      {modal === "tokens" && <TokensModal onClose={() => setModal(null)} />}
      {modal === "account" && <AccountModal user={user} onClose={() => setModal(null)} />}
      {modal === "users" && <UsersModal onClose={() => setModal(null)} />}
    </div>
  );
}

const ROLES: Record<Role, string> = { owner: "Propriétaire", editor: "Éditeur", viewer: "Lecteur" };

/** Partage d'un projet : membres et rôles. Seul un propriétaire les gère. */
function ShareModal({ project, me, onClose }: { project: Project; me: User; onClose: () => void }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [error, setError] = useState<string | null>(null);
  const owner = project.role === "owner";
  const load = () => void api.members(project.id).then(setMembers).catch((e) => setError(e.message));
  useEffect(load, [project.id]);
  const run = (fn: () => Promise<unknown>) => void fn().then(() => (setError(null), load())).catch((e) => setError(e.message));
  return (
    <Modal title={`Partager « ${project.name} »`} onClose={onClose}>
      {owner && (
        <form className="row" onSubmit={(e) => (e.preventDefault(), run(() => api.addMember(project.id, email.trim(), role).then(() => setEmail(""))))}>
          <input className="flex1" type="email" placeholder="Adresse email d'un compte Swiftma" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {Object.entries(ROLES).map(([r, label]) => <option key={r} value={r}>{label}</option>)}
          </select>
          <button className="btn primary-btn">Inviter</button>
        </form>
      )}
      {error && <div className="auth-error">{error}</div>}
      <div>
        {members.map((m) => (
          <div className="member-row" key={m.userId}>
            <span className="avatar" style={{ background: "#9747FF" }}>{m.name.slice(0, 1).toUpperCase()}</span>
            <div className="flex1">
              <div>{m.name}{m.userId === me.id ? " (toi)" : ""}</div>
              <div className="meta">{m.email}</div>
            </div>
            {owner ? (
              <select value={m.role} onChange={(e) => run(() => api.setMemberRole(project.id, m.userId, e.target.value as Role))}>
                {Object.entries(ROLES).map(([r, label]) => <option key={r} value={r}>{label}</option>)}
              </select>
            ) : (
              <span className="meta">{ROLES[m.role]}</span>
            )}
            {(owner || m.userId === me.id) && (
              <button className="btn ghost-btn" style={{ flex: "none" }} onClick={() => confirm(m.userId === me.id ? "Quitter ce projet ?" : `Retirer ${m.name} ?`) && run(() => api.removeMember(project.id, m.userId))}>
                {m.userId === me.id ? "Quitter" : "Retirer"}
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="hint">Lecteur : voit les fichiers. Éditeur : les modifie. Propriétaire : gère aussi les membres et peut supprimer le projet.</p>
    </Modal>
  );
}

/** Jetons d'accès personnels : pour brancher une IA (MCP) ou un script avec tes droits. */
function TokensModal({ onClose }: { onClose: () => void }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState("Claude Code");
  const [created, setCreated] = useState<ApiToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => void api.tokens().then(setTokens).catch((e) => setError(e.message));
  useEffect(load, []);
  const mcp = `${location.origin}/mcp`;
  return (
    <Modal title="Jetons d'accès (IA / MCP)" onClose={onClose}>
      <p>Un jeton donne à une IA ou à un script <b>tes droits</b> sur tes projets. Garde-le secret ; révoque-le s'il fuit.</p>
      <form className="row" onSubmit={(e) => (e.preventDefault(), void api.createToken(name.trim() || "Jeton").then((t) => (setCreated(t), load())).catch((er) => setError(er.message)))}>
        <input className="flex1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du jeton (ex. Claude Code)" />
        <button className="btn primary-btn">Créer un jeton</button>
      </form>
      {created?.token && (
        <>
          <p><b>Copie-le maintenant</b>, il ne sera plus affiché :</p>
          <div className="token-value">{created.token}</div>
          <p>Brancher Claude Code :</p>
          <pre>{`claude mcp add --transport http swiftma ${mcp} \
  --header "Authorization: Bearer ${created.token}"`}</pre>
        </>
      )}
      {error && <div className="auth-error">{error}</div>}
      {tokens.map((t) => (
        <div className="member-row" key={t.id}>
          <div className="flex1">
            <div>{t.name}</div>
            <div className="meta">Créé le {new Date(t.createdAt).toLocaleDateString("fr-FR")} · {t.lastUsedAt ? `utilisé ${since(t.lastUsedAt)}` : "jamais utilisé"}</div>
          </div>
          <button className="btn ghost-btn danger" style={{ flex: "none" }} onClick={() => confirm(`Révoquer « ${t.name} » ?`) && void api.deleteToken(t.id).then(load)}>Révoquer</button>
        </div>
      ))}
    </Modal>
  );
}

function AccountModal({ user, onClose }: { user: User; onClose: () => void }) {
  const [name, setName] = useState(user.name);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [info, setInfo] = useState<string | null>(null);
  const save = (patch: Parameters<typeof api.updateMe>[0], done: string) =>
    void api.updateMe(patch).then((u) => (setUser(u), setInfo(done), setCurrent(""), setPassword(""))).catch((e) => setInfo(e.message));
  return (
    <Modal title="Mon compte" onClose={onClose}>
      <p className="hint">{user.email}{user.isAdmin ? " · administrateur" : ""}</p>
      <form className="row" onSubmit={(e) => (e.preventDefault(), save({ name: name.trim() }, "Nom mis à jour."))}>
        <input className="flex1" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn ghost-btn" style={{ flex: "none" }}>Renommer</button>
      </form>
      <form className="row" onSubmit={(e) => (e.preventDefault(), save({ password, currentPassword: current }, "Mot de passe changé ; tes autres sessions sont fermées."))}>
        <input className="flex1" type="password" placeholder="Mot de passe actuel" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
        <input className="flex1" type="password" placeholder="Nouveau (8 caractères min.)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
        <button className="btn ghost-btn" style={{ flex: "none" }}>Changer</button>
      </form>
      {info && <p className="hint">{info}</p>}
    </Modal>
  );
}

/** Administrateur : créer des comptes (utile quand les inscriptions sont fermées, ex. une école). */
function UsersModal({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState({ email: "", name: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const load = () => void api.users().then(setUsers).catch((e) => setError(e.message));
  useEffect(load, []);
  return (
    <Modal title="Comptes de l'instance" onClose={onClose}>
      <form className="row" onSubmit={(e) => (e.preventDefault(), void api.createUser(form.email.trim(), form.name.trim(), form.password).then(() => (setForm({ email: "", name: "", password: "" }), setError(null), load())).catch((er) => setError(er.message)))}>
        <input className="flex1" type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        <input className="flex1" placeholder="Nom" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <input className="flex1" type="password" placeholder="Mot de passe provisoire" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} />
        <button className="btn primary-btn" style={{ flex: "none" }}>Créer</button>
      </form>
      {error && <div className="auth-error">{error}</div>}
      {users.map((u) => (
        <div className="member-row" key={u.id}>
          <div className="flex1"><div>{u.name}{u.isAdmin ? " · admin" : ""}</div><div className="meta">{u.email}</div></div>
          <span className="meta">{new Date(u.createdAt).toLocaleDateString("fr-FR")}</span>
        </div>
      ))}
    </Modal>
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
