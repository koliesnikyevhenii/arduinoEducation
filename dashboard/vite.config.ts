import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server runs on http://localhost:5173 — the origin the API's CORS policy allows.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
