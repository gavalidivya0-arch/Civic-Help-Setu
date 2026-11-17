import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ASSET_REGISTRY_INDEX_MANIFEST,
  buildAssetRegistryIndexes,
  ensureAssetRegistryData,
  getAssetMigrationStatus,
  migrateAssetRegistry,
  rollbackAssetRegistry,
} from './assetRegistryMigrations';
import { ASSET_ERROR_CODES, ASSET_STORAGE_KEYS } from './assetRegistryConstants';
import { setCurrentActor } from './accessControl';

const admin = { id: 'migration_admin', username: 'Migration Administrator', role: 'admin', raw: { publicMetadata: {} } };
const citizen = { id: 'migration_citizen', username: 'Resident', role: 'citizen', raw: { publicMetadata: {} } };

const expectCode = (fn, code) => {
  try {
    fn();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error.code).toBe(code);
  }
};

const createMemoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => map,
  };
};

const read = (storage, key) => {
  const raw = storage.getItem(key);
  return raw ? JSON.parse(raw) : null;
};

let storage;

beforeEach(() => {
  storage = createMemoryStorage();
  setCurrentActor(admin);
});

afterEach(() => {
  setCurrentActor(null);
});

describe('asset registry migrations', () => {
  it('bootstraps schema metadata, reference data and the index manifest once', () => {
    const first = ensureAssetRegistryData({ storage, nowMs: Date.parse('2026-11-16T08:00:00.000Z') });
    expect(first.schemaVersion).toBe(1);
    expect(first.initialized).toBe(true);
    expect(first.demoData).toBe(true);
    expect(first.backupAvailable).toBe(false);
    expect(first.indexes.map((index) => index.name)).toEqual(ASSET_REGISTRY_INDEX_MANIFEST.map((index) => index.name));

    const before = storage.getItem(ASSET_STORAGE_KEYS.assets);
    const second = ensureAssetRegistryData({ storage });
    expect(second.schemaVersion).toBe(1);
    expect(storage.getItem(ASSET_STORAGE_KEYS.assets)).toBe(before);
  });

  it('imports a legacy asset collection with a pre-migration snapshot', () => {
    storage.setItem(
      ASSET_STORAGE_KEYS.legacyAssets,
      JSON.stringify([
        {
          id: 'legacy_bench_1',
          name: 'Legacy ward bench',
          category: 'bench',
          jurisdiction: 'blr',
          ward: 'Ward 14 - Indiranagar East',
          description: 'An older bench record.',
        },
      ])
    );
    const result = migrateAssetRegistry({ storage, nowMs: Date.parse('2026-11-16T08:00:00.000Z') });
    expect(result.migrated).toBe(true);
    expect(result.importedLegacyAssets).toBe(1);
    const assets = read(storage, ASSET_STORAGE_KEYS.assets);
    expect(assets).toHaveLength(1);
    expect(assets[0].publicId).toMatch(/^LEG-AST-\d{4}$/);
    expect(assets[0].categoryId).toBe('cat_bench');
    expect(assets[0].schemaVersion).toBe(1);
    expect(read(storage, ASSET_STORAGE_KEYS.migrationBackup).keys).toBeTruthy();
    expect(result.status.backupAvailable).toBe(true);
  });

  it('is a no-op when the schema is current', () => {
    ensureAssetRegistryData({ storage });
    const result = migrateAssetRegistry({ storage });
    expect(result.migrated).toBe(false);
    expect(result.fromVersion).toBe(1);
  });

  it('rolls back to the exact pre-migration snapshot', () => {
    storage.setItem(
      ASSET_STORAGE_KEYS.legacyAssets,
      JSON.stringify([{ id: 'legacy_bench_2', name: 'Another legacy bench', category: 'bench', jurisdiction: 'blr' }])
    );
    migrateAssetRegistry({ storage });
    expect(read(storage, ASSET_STORAGE_KEYS.assets)).toHaveLength(1);
    const rollback = rollbackAssetRegistry({ storage });
    expect(rollback.rolledBack).toBe(true);
    expect(read(storage, ASSET_STORAGE_KEYS.assets)).toBeNull();
    expect(read(storage, ASSET_STORAGE_KEYS.categories)).toBeNull();
    expect(read(storage, ASSET_STORAGE_KEYS.legacyAssets)).toHaveLength(1);
    expect(storage.getItem(ASSET_STORAGE_KEYS.migrationBackup)).toBeNull();
    expect(getAssetMigrationStatus(storage).lastRollbackAt).toBeTruthy();
  });

  it('requires the registry.migrate capability for migration and rollback', () => {
    setCurrentActor(null);
    expectCode(() => migrateAssetRegistry({ storage }), ASSET_ERROR_CODES.UNAUTHENTICATED);
    setCurrentActor(citizen);
    expectCode(() => migrateAssetRegistry({ storage }), ASSET_ERROR_CODES.PERMISSION_DENIED);
    expect(storage.getItem(ASSET_STORAGE_KEYS.migrationBackup)).toBeNull();

    setCurrentActor(admin);
    migrateAssetRegistry({ storage });
    setCurrentActor(citizen);
    expectCode(() => rollbackAssetRegistry({ storage }), ASSET_ERROR_CODES.PERMISSION_DENIED);
    expect(storage.getItem(ASSET_STORAGE_KEYS.migrationBackup)).toBeTruthy();
    setCurrentActor(admin);
    expect(rollbackAssetRegistry({ storage }).rolledBack).toBe(true);
  });

  it('builds query index counts without exposing record content', () => {
    ensureAssetRegistryData({ storage });
    const indexes = buildAssetRegistryIndexes(storage);
    expect(indexes.manifest.length).toBe(ASSET_REGISTRY_INDEX_MANIFEST.length);
    expect(indexes.counts.assets).toBeGreaterThan(0);
    expect(indexes.counts.byJurisdiction.blr).toBeGreaterThan(0);
    expect(JSON.stringify(indexes)).not.toContain('internalNotes');
    expect(JSON.stringify(indexes)).not.toContain('reporterKeyHash');
  });
});
