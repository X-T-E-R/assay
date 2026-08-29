/** npm product version of the suite CLI. The two halves version themselves. */
export const ASSAY_VERSION = "0.15.0";

/**
 * Assay's native physical envelope. Absorb prefers `.absorb` and wins wherever
 * it is present; a workspace assay creates keeps the name assay has always
 * written, and both halves read it in place.
 */
export const ASSAY_ENVELOPE_DIR = ".assay";
