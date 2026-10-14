import base from "./playwright.config";

/**
 * B19 wrapper: identical to the shared config but with a PRIVATE output dir,
 * so a concurrent sibling suite wiping `test-results/` cannot destroy this
 * batch's traces and error contexts mid-run (wave-mode contention).
 */
export default {
  ...base,
  outputDir: "test-results-b19",
};
