import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": here("./src"),
      // the real package throws outside a Next.js server build
      "server-only": here("./test/stubs/server-only.ts"),
    },
  },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
