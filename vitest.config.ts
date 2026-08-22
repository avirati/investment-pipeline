import { defineConfig } from "vitest/config";

// The suite is offline by contract: no network, no API key, committed fixtures.
// See docs/TESTING.md.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    retry: 0,
  },
});
