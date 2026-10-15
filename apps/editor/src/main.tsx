import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthScreen } from "./components/Auth";
import { Projects } from "./components/Projects";
import { LOCAL_FILE, applyRoute, dispatch, getState, importSvgText, loadUser, routeFromPath, select, setView, useEditor } from "./store";
import "./styles.css";

function Root() {
  const fileId = useEditor((s) => s.fileId);
  const user = useEditor((s) => s.user);
  if (fileId === LOCAL_FILE) return <App key={fileId} />; // brouillon local : sans compte
  if (user === undefined) return <div className="auth" />;
  if (user === null) return <AuthScreen />;
  return fileId ? <App key={fileId} /> : <Projects />;
}

window.addEventListener("popstate", applyRoute);
// Le brouillon local s'ouvre sans compte ; le reste attend de savoir qui est connecté
if (routeFromPath() === LOCAL_FILE) applyRoute();
else void loadUser().then(() => getState().user && applyRoute());
createRoot(document.getElementById("root")!).render(<Root />);

// Accès pour les tests automatiques (banc de fidélité, test de bout en bout) : en développement,
// ou en production si localStorage « swiftma-test » vaut « 1 »
const testing = (() => {
  try {
    return localStorage.getItem("swiftma-test") === "1";
  } catch {
    return false;
  }
})();
if (import.meta.env.DEV || testing) Object.assign(window, { __swiftma: { dispatch, getState, importSvgText, select, setView } });
