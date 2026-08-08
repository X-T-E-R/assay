export const CURRENT_VERSION = "0.10.0";

/**
 * Layout version written by this build of Assay. New workspaces always carry
 * this version in their manifest. Older layouts require an external cutover
 * tool and are never loaded or rewritten by this package.
 */
export const LAYOUT_VERSION = 7;

/**
 * Assay-owned workspace state directory (layout v7). Holds the manifest,
 * version, events, backups, systems registry, and (in overlay
 * mode) the work folders.
 */
export const MANAGED_DIR = ".assay";

export const VERSION_FILE = `${MANAGED_DIR}/VERSION`;
export const MANIFEST_FILE = `${MANAGED_DIR}/manifest.json`;
export const EVENTS_DIR = `${MANAGED_DIR}/events`;
export const BACKUPS_DIR = `${MANAGED_DIR}/backups`;
export const SYSTEMS_REGISTRY_FILE = `${MANAGED_DIR}/systems-registry.json`;
export const PLUGINS_STATE_FILE = `${MANAGED_DIR}/plugins.json`;
