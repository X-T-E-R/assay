export const CURRENT_VERSION = "0.2.0";
export const LAYOUT_VERSION = 2;

export const MANAGED_DIR = ".framework";
export const VERSION_FILE = `${MANAGED_DIR}/VERSION`;
export const MANIFEST_FILE = `${MANAGED_DIR}/manifest.json`;
export const EVENTS_DIR = `${MANAGED_DIR}/events`;
export const BACKUPS_DIR = `${MANAGED_DIR}/backups`;

export const PRIMARY_DIRS = [
  "references/intake",
  "references/frozen",
  "analyses/references",
  "analyses/gaps",
  "analyses/patterns",
  "analyses/templates",
  "systems",
  "iterations/templates",
  "knowledge/guides",
  "knowledge/decisions",
  "knowledge/patterns",
  "knowledge/troubleshooting",
  "data",
  "releases",
  `${MANAGED_DIR}/events`,
  `${MANAGED_DIR}/backups`,
  `${MANAGED_DIR}/migrations`,
] as const;

export const PROTECTED_PREFIXES = [
  "references/frozen/",
  "analyses/references/",
  "analyses/gaps/",
  "analyses/patterns/",
  "iterations/",
  "knowledge/",
  "data/",
] as const;
