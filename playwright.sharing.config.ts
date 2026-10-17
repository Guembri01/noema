import base from "./playwright.config";

/**
 * B19 wrapper: identical to the shared config but with a PRIVATE output dir,
 * so a concurrent suite wiping `test-results/` cannot destroy this
 * run's traces and error contexts mid-run (concurrent-run contention).
 */
export default {
  ...base,
  outputDir: "test-results-b19",
};
