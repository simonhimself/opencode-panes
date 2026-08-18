import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { reactRuntimeSource } from "./build/react-runtime-source.ts";

export default defineConfig({
  plugins: [reactRuntimeSource(), react()],
  test: {
    environment: "jsdom",
    include: ["test/client/**/*.test.{ts,tsx}"],
  },
});
