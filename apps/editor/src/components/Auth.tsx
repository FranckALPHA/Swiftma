import { useEffect, useState } from "react";
import { api } from "../api";
import { setUser } from "../store";
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
        <a className="link" href="/local">Essayer sans compte (brouillon local, rien n'est sauvegardé)</a>
      </form>
    </div>
  );
}
