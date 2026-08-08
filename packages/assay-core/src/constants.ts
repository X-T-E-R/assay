export const CURRENT_VERSION = "0.13.0";
export const SYSTEMS_REGISTRY_SCHEMA = 3;

/**
 * Layout version written by this build of Assay. New workspaces always carry
 * this version in their manifest. Older layouts require an external cutover
 * tool and are never loaded or rewritten by this package.
 */
export const LAYOUT_VERSION = 8;

/**
 * Assay-owned workspace state directory (layout v8). Holds the manifest,
 * managed receipt, events, backups, systems registry, and (in overlay
 * mode) the work folders.
 */
export const MANAGED_DIR = ".assay";

export const MANIFEST_FILE = `${MANAGED_DIR}/manifest.json`;
export const MANAGED_FILES_FILE = `${MANAGED_DIR}/managed-files.json`;
export const EVENTS_DIR = `${MANAGED_DIR}/events`;
export const BACKUPS_DIR = `${MANAGED_DIR}/backups`;
export const SYSTEMS_REGISTRY_FILE = `${MANAGED_DIR}/systems-registry.json`;
