import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Chaque cas exporté vit dans cases/<id>/ (une page par cas, servie sans build).
// Pas de surveillance des fichiers ni de rechargement : écrire un nouveau cas ne doit pas recharger les autres pages.
export default defineConfig({ plugins: [react()], server: { port: 4300, strictPort: true, hmr: false, watch: null }, logLevel: "error" });
