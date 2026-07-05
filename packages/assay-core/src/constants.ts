export const CURRENT_VERSION = "0.2.0";

/**
 * Layout version written by this build of Assay. New workspaces always carry
 * this version in their manifest; legacy manifests with a lower version are
 * upgraded by `assay migrate-layout`.
 */
export const LAYOUT_VERSION = 4;

/**
 * Assay-owned workspace state directory (layout v4+). Holds the manifest,
 * version, events, backups, systems registry, ADR index, and (in overlay
 * mode) the work folders.
 */
export const MANAGED_DIR = ".assay";

/**
 * Legacy v3 managed directory. Accepted only for migration and discovery
 * fallback so existing `.framework/` workspaces can still be read until they
 * are migrated to `.assay/`. New workspaces must never write this name.
 */
export const LEGACY_MANAGED_DIR = ".framework";

export const VERSION_FILE = `${MANAGED_DIR}/VERSION`;
export const MANIFEST_FILE = `${MANAGED_DIR}/manifest.json`;
export const EVENTS_DIR = `${MANAGED_DIR}/events`;
export const BACKUPS_DIR = `${MANAGED_DIR}/backups`;
export const SYSTEMS_REGISTRY_FILE = `${MANAGED_DIR}/systems-registry.json`;
export const ADRS_FILE = `${MANAGED_DIR}/adrs.json`;

// Legacy v3 mirror constants, used by migration and discovery fallback only.
export const LEGACY_VERSION_FILE = `${LEGACY_MANAGED_DIR}/VERSION`;
export const LEGACY_MANIFEST_FILE = `${LEGACY_MANAGED_DIR}/manifest.json`;
export const LEGACY_EVENTS_DIR = `${LEGACY_MANAGED_DIR}/events`;
export const LEGACY_BACKUPS_DIR = `${LEGACY_MANAGED_DIR}/backups`;
export const LEGACY_SYSTEMS_REGISTRY_FILE = `${LEGACY_MANAGED_DIR}/systems-registry.json`;
export const LEGACY_ADRS_FILE = `${LEGACY_MANAGED_DIR}/adrs.json`;
