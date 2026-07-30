import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A vendored checkout of another project under upstream/ is not ours to run: it
    // carries its own suites that expect its own built dist/, so `npm test` reported 23
    // failed FILES (0 failed assertions) purely because vitest's default include globs
    // the whole tree. Our gate must judge our code only.
    exclude: [...configDefaults.exclude, "upstream/**"],
    // The setup and client suites drive real process probes: setup.ts's
    // commandPath/commandCheck shell out via spawnSync for each candidate
    // binary (up to a dozen spawns per report), and those spawns carry their
    // own 5000ms timeout. Vitest's default testTimeout is also 5000ms, so a
    // single slow probe consumed the entire test budget and the test failed —
    // observed passing at 4.2s and failing at 6.3s on the same commit under
    // parallel load. The probe timeout is the real upper bound on these tests;
    // the test budget has to sit above it, not on top of it.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
