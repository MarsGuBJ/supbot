import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several tests spawn real processes (git, PowerShell, node) which
    // intermittently take >5s on Windows under load.
    testTimeout: 15_000,
  },
});
