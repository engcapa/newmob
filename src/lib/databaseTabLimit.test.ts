import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DATABASE_TAB_LIMIT,
  MAX_DATABASE_TAB_LIMIT,
  readDatabaseTabLimit,
  writeDatabaseTabLimit,
} from "./databaseTabLimit";

const engine = "PostgreSQL";
const currentKey = `taomni.db.${engine}.tabLimit`;
const legacyKey = `taomni.db.${engine}.maxResultSheets`;

afterEach(() => {
  localStorage.clear();
});

describe("database tab limit preferences", () => {
  it("defaults to 50 and clamps persisted values", () => {
    expect(readDatabaseTabLimit(engine)).toBe(DEFAULT_DATABASE_TAB_LIMIT);

    writeDatabaseTabLimit(engine, MAX_DATABASE_TAB_LIMIT + 50);

    expect(localStorage.getItem(currentKey)).toBe(String(MAX_DATABASE_TAB_LIMIT));
    expect(readDatabaseTabLimit(engine)).toBe(MAX_DATABASE_TAB_LIMIT);
  });

  it("migrates the legacy result sheet limit to the shared tab limit", () => {
    localStorage.setItem(legacyKey, "12");

    expect(readDatabaseTabLimit(engine)).toBe(12);
    expect(localStorage.getItem(currentKey)).toBe("12");
  });

  it("preserves the legacy one-time correction for the former accidental minimum", () => {
    localStorage.setItem(legacyKey, "1");

    expect(readDatabaseTabLimit(engine)).toBe(DEFAULT_DATABASE_TAB_LIMIT);
    expect(localStorage.getItem(currentKey)).toBe(String(DEFAULT_DATABASE_TAB_LIMIT));
  });
});
