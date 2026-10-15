import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connect, dispatch, getState, importSvgText, select, setView } from "./store";
import "./styles.css";

connect();
createRoot(document.getElementById("root")!).render(<App />);

// Accès pour le banc de fidélité du canevas (tests/fidelity/run.mjs --canvas), en développement seulement
if (import.meta.env.DEV) Object.assign(window, { __nyota: { dispatch, getState, importSvgText, select, setView } });
