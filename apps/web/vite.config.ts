import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { reactRuntimeSource } from "./build/react-runtime-source.ts";

export default defineConfig({
  plugins: [reactRuntimeSource(), react(), cloudflare()],
});
