export const DEFAULT_DATABASE_TAB_LIMIT = 50;
export const MIN_DATABASE_TAB_LIMIT = 1;
export const MAX_DATABASE_TAB_LIMIT = 200;

const TAB_LIMIT_SETTING = "tabLimit";
const LEGACY_RESULT_SHEET_SETTING = "maxResultSheets";

function settingKey(engine: string, name: string): string {
  return `taomni.db.${engine}.${name}`;
}

export function clampDatabaseTabLimit(value: number): number {
  if (!Number.isFinite(value)) return MIN_DATABASE_TAB_LIMIT;
  return Math.min(
    MAX_DATABASE_TAB_LIMIT,
    Math.max(MIN_DATABASE_TAB_LIMIT, Math.round(value)),
  );
}

function parseStoredLimit(rawValue: string | null): number | null {
  if (rawValue === null || rawValue.trim() === "") return null;
  const value = Number(rawValue);
  return Number.isFinite(value) ? clampDatabaseTabLimit(value) : null;
}

/**
 * Load the shared Query/Result tab limit for one database engine.
 *
 * `maxResultSheets` was the original setting name. Migrate it lazily so users
 * keep their existing limit while new code and UI can use the broader name.
 */
export function readDatabaseTabLimit(engine: string): number {
  try {
    const currentKey = settingKey(engine, TAB_LIMIT_SETTING);
    const current = parseStoredLimit(localStorage.getItem(currentKey));
    if (current !== null) return current;

    const legacyKey = settingKey(engine, LEGACY_RESULT_SHEET_SETTING);
    const legacy = parseStoredLimit(localStorage.getItem(legacyKey));
    if (legacy === null) return DEFAULT_DATABASE_TAB_LIMIT;

    // Preserve the old one-time default correction: an unmigrated value of 1
    // represented the former accidental default, not an explicit user choice.
    const legacyMigrationKey = `${legacyKey}.defaultsFixed.v1`;
    const legacyWasCorrected = localStorage.getItem(legacyMigrationKey) === "1";
    localStorage.setItem(legacyMigrationKey, "1");
    const migrated = !legacyWasCorrected && legacy === MIN_DATABASE_TAB_LIMIT
      ? DEFAULT_DATABASE_TAB_LIMIT
      : legacy;
    localStorage.setItem(currentKey, String(migrated));
    return migrated;
  } catch {
    return DEFAULT_DATABASE_TAB_LIMIT;
  }
}

export function writeDatabaseTabLimit(engine: string, value: number): void {
  try {
    localStorage.setItem(
      settingKey(engine, TAB_LIMIT_SETTING),
      String(clampDatabaseTabLimit(value)),
    );
  } catch {
    /* ignore unavailable/quota-limited storage */
  }
}
