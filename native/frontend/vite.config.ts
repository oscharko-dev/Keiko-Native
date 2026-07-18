import { defineConfig } from "vitest/config";

const expectedRevision = process.env.KEIKO_NATIVE_SOURCE_REVISION;
if (!/^[0-9a-f]{40}$/u.test(expectedRevision ?? "")) {
  throw new Error("KEIKO_NATIVE_SOURCE_REVISION must be an exact Git revision");
}

export default defineConfig({
  cacheDir: "dist/.vite-cache",
  build: {
    emptyOutDir: true,
    outDir: "dist",
  },
  define: {
    __KEIKO_EXPECTED_SOURCE_REVISION__: JSON.stringify(expectedRevision),
  },
  test: {
    coverage: {
      all: true,
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 85,
        functions: 85,
        lines: 85,
        statements: 85,
      },
    },
    environment: "node",
  },
});
