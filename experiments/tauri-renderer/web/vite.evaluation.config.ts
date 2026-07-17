import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "evaluation",
  plugins: [react()],
  build: {
    outDir: "../../frontend-evaluation",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: new URL("./evaluation/index.html", import.meta.url).pathname,
        probe: new URL("./evaluation/probe.html", import.meta.url).pathname,
      },
    },
  },
});
