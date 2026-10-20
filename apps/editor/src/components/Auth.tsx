import { useEffect, useState } from "react";
import { api } from "../api";
import { setUser } from "../store";
import { SOURCE_URL } from "../source";
import { IconLogo } from "./icons";

/** Écran de connexion / création de compte. Le premier compte créé devient administrateur. */
export function AuthScreen() {
  const [config, setConfig] = useState<{ signup: boolean; hasUsers: boolean } | null>(null);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  useEffect(() => {
    api
      .authConfig()
      .then((c) => {
        setConfig(c);
        if (!c.hasUsers) setMode("register");
      })
      .catch(() => setError("Hub injoignable. Lance-le avec « npm run dev » ou « docker compose up »."));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setUser(mode === "login" ? await api.login(email, password) : await api.register(email, name, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const first = config && !config.hasUsers;
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="projects-brand"><IconLogo size={26} /> Swiftma</div>
        <h1>{first ? "Bienvenue" : mode === "login" ? "Connexion" : "Créer un compte"}</h1>
        {first && <p className="hint">Premier démarrage : crée le compte administrateur de cette instance. Il récupère les projets existants.</p>}
        {mode === "register" && (
          <label>
            Nom affiché
            <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" placeholder="Amina Nkoulou" />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label>
          Mot de passe
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === "register" ? 8 : undefined}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button className="btn primary-btn" disabled={busy || !config} type="submit">
          {mode === "login" ? "Se connecter" : "Créer le compte"}
        </button>
        {config?.hasUsers && (config.signup || mode === "register") && (
          <button type="button" className="link" onClick={() => (setMode(mode === "login" ? "register" : "login"), setError(null))}>
            {mode === "login" ? "Pas encore de compte ? En créer un" : "J'ai déjà un compte"}
          </button>
        )}
        {config?.hasUsers && !config.signup && mode === "login" && <p className="hint">Les inscriptions sont fermées : demande un compte à l'administrateur.</p>}
        {config?.hasUsers && mode === "login" && (
          <button type="button" className="link" onClick={() => setForgot(!forgot)}>Mot de passe oublié ?</button>
        )}
        {forgot && mode === "login" && (
          <p className="hint">
            Demande un lien de réinitialisation à l'administrateur de l'instance (menu du compte → Comptes de l'instance).
            Administrateur sans accès : sur le serveur, lance <code>swiftma-hub reset-password ton@email</code>.
          </p>
        )}
        <a className="link" href="/local">Essayer sans compte (brouillon local, rien n'est sauvegardé)</a>
        <a className="link" href={SOURCE_URL} target="_blank" rel="noreferrer">Logiciel libre (AGPL-3.0) · code source</a>
      </form>
    </div>
  );
}

/** Page d'un lien de réinitialisation (/reset#<secret>) : choisir un nouveau mot de passe, puis connecté. */
export function ResetScreen() {
  const token = location.hash.slice(1);
  const [account, setAccount] = useState<{ email: string; name: string } | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("Lien incomplet : ouvre le lien reçu en entier.");
      return;
    }
    api.resetInfo(token).then(setAccount).catch((e) => setError(e.message));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError("Les deux mots de passe ne correspondent pas");
    setBusy(true);
    setError(null);
    try {
      const user = await api.resetPassword(token, password);
      history.replaceState(null, "", "/"); // le secret quitte la barre d'adresse et l'historique
      setUser(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="projects-brand"><IconLogo size={26} /> Swiftma</div>
        <h1>Nouveau mot de passe</h1>
        {account && <p className="hint">Compte : {account.name} ({account.email}). Toutes ses sessions ouvertes seront fermées.</p>}
        <label>
          Nouveau mot de passe
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" disabled={!account} />
        </label>
        <label>
          Confirmer
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" disabled={!account} />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button className="btn primary-btn" disabled={busy || !account} type="submit">Enregistrer et se connecter</button>
        <a className="link" href="/">Retour à la connexion</a>
      </form>
    </div>
  );
}
