import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "release",
  plugins: [react()],
  build: { outDir: "../../frontend", emptyOutDir: true },
});
