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

// Accès pour le banc de fidélité du canevas (tests/fidelity/run.mjs --canvas), en développement seulement
if (import.meta.env.DEV) Object.assign(window, { __nyota: { dispatch, getState, importSvgText, select, setView } });
