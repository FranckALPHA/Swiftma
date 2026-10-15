import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Projects } from "./components/Projects";
import { applyRoute, dispatch, getState, importSvgText, select, setView, useEditor } from "./store";
import "./styles.css";

function Root() {
  const fileId = useEditor((s) => s.fileId);
  return fileId ? <App key={fileId} /> : <Projects />;
}

window.addEventListener("popstate", applyRoute);
applyRoute();
createRoot(document.getElementById("root")!).render(<Root />);

// Accès pour les tests automatiques (banc de fidélité, test de bout en bout) : en développement,
// ou en production si localStorage « nyota-test » vaut « 1 »
const testing = (() => {
  try {
    return localStorage.getItem("nyota-test") === "1";
  } catch {
    return false;
  }
})();
if (import.meta.env.DEV || testing) Object.assign(window, { __nyota: { dispatch, getState, importSvgText, select, setView } });
