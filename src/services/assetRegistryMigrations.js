/**
 * Bootstrap, schema migration, rollback and index definitions for the public
 * asset registry.
 *
 * The app has no SQL database; each normalised collection is a JSON array in
 * localStorage. This module supplies the operational guarantees a server
 * migration would: version stamp, pre-migration snapshot, all-or-nothing
 * apply, explicit rollback and a documented query-index manifest.
 */

import {
  ASSET_CATEGORY_SEED,
  ASSET_DEMO_ASSETS,
  ASSET_DEMO_EVIDENCE,
  ASSET_DEMO_FAULT_REPORTS,
  ASSET_DEMO_INSPECTIONS,
  ASSET_DEMO_QR_TOKENS,
  ASSET_DEMO_REPAIR_EVENTS,
  ASSET_DEMO_TRIAGE,
  ASSET_DEMO_WORK_ORDERS,
  ASSET_JURISDICTIONS,
  ASSET_LOCATION_SEED,
} from '../data/publicAssetData';
import {
  ASSET_COLLECTION_KEYS,
  ASSET_ERROR_CODES,
  ASSET_REGISTRY_SCHEMA_VERSION,
  ASSET_STORAGE_KEYS,
} from './assetRegistryConstants';
import {
  createAssetError,
  generateOpaqueToken,
  hashToken,
  newAssetId,
  nowIso,
  removeStorageKey,
  runAssetTransaction,
  safeReadJson,
  safeWriteJson,
  sanitizePlain,
  tokenPrefix,
} from './assetRegistryValidation';
import { assertAssetCapability } from './assetAccessControl';

export const ASSET_REGISTRY_INDEX_MANIFEST = Object.freeze([
  {
    name: 'byJurisdiction',
    fields: ['jurisdictionId'],
    purpose: 'Scope every staff read and write to the signed-in jurisdiction.',
  },
  {
    name: 'byStatusCategory',
    fields: ['status', 'categoryId'],
    purpose: 'Registry filter chips and condition summaries.',
  },
  {
    name: 'byCreatedAt',
    fields: ['createdAt'],
    purpose: 'Stable newest-first pagination and retention scans.',
  },
  {
    name: 'bySearchText',
    fields: ['publicId', 'name', 'ward', 'locality', 'category label'],
    purpose: 'Bounded public/staff search without reading private notes.',
  },
  {
    name: 'byQrTokenHash',
    fields: ['tokenHash'],
    purpose: 'Constant-time lookup of a scanned tag; never a token listing.',
  },
  {
    name: 'byFaultReportState',
    fields: ['state', 'jurisdictionId', 'createdAt'],
    purpose: 'Citizen report triage queue and public reference lookup.',
  },
  {
    name: 'byWorkOrderState',
    fields: ['state', 'assignee', 'dueAt'],
    purpose: 'Maintenance board columns and overdue work.',
  },
  {
    name: 'byInspectionDue',
    fields: ['inspectionDueAt'],
    purpose: 'Overdue and upcoming preventive inspections.',
  },
  {
    name: 'byPublicReference',
    fields: ['publicReference', 'publicId'],
    purpose: 'Exact public reference lookup without exposing internal ids.',
  },
]);

const BACKUP_KEYS = Object.freeze([
  ASSET_STORAGE_KEYS.meta,
  ...ASSET_COLLECTION_KEYS,
  ASSET_STORAGE_KEYS.idempotency,
  ASSET_STORAGE_KEYS.rateLimit,
  ASSET_STORAGE_KEYS.actionNonces,
  ASSET_STORAGE_KEYS.legacyAssets,
  ASSET_STORAGE_KEYS.legacyReports,
]);

const readCollection = (storage, key) => {
  const value = safeReadJson(storage, key, []);
  return Array.isArray(value) ? value : [];
};

const countBy = (items, field) =>
  items.reduce((acc, item) => {
    const key = item?.[field] || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

const normalizeCategory = (category) => ({
  ...category,
  schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
});

const normalizeLocation = (location) => ({
  ...location,
  schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
});

const normalizeSeedAsset = (asset, now) => ({
  ...asset,
  schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
  createdBy: asset.createdBy || 'demo_admin',
  createdAt: asset.createdAt || now,
  updatedAt: asset.updatedAt || now,
});

const normalizeSeedInspection = (inspection, now) => ({
  ...inspection,
  schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
  createdAt: inspection.createdAt || now,
  updatedAt: inspection.updatedAt || now,
});

const normalizeSeedReport = (report, now) => ({
  ...report,
  schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
  createdAt: report.createdAt || now,
  updatedAt: report.updatedAt || now,
});

const normalizeSeedOrder = (order, now) => ({
  ...order,
  schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
  createdAt: order.createdAt || now,
  updatedAt: order.updatedAt || now,
});

const seedQrTokens = () => {
  const assetsById = Object.fromEntries(ASSET_DEMO_ASSETS.map((asset) => [asset.id, asset]));
  return ASSET_DEMO_QR_TOKENS.map((entry) => ({
    id: newAssetId('qrt'),
    assetId: entry.assetId,
    jurisdictionId: assetsById[entry.assetId]?.jurisdictionId || 'blr',
    tokenHash: hashToken(entry.rawToken),
    tokenPrefix: tokenPrefix(entry.rawToken),
    state: 'active',
    issuedBy: 'demo_admin',
    issuedAt: '2026-09-01T08:00:00.000Z',
    expiresAt: null,
    revokedBy: null,
    revokedAt: null,
    revokeReason: '',
    createdAt: '2026-09-01T08:00:00.000Z',
    schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
  }));
};

const appendMigrationAudit = (draft, { action, actorId, now, details }) => {
  const events = Array.isArray(draft.get(ASSET_STORAGE_KEYS.audit)) ? draft.get(ASSET_STORAGE_KEYS.audit) : [];
  const previous = events.length ? events[events.length - 1].hash : 'GENESIS';
  const base = {
    id: newAssetId('audit'),
    action,
    entityType: 'AssetRegistry',
    entityId: 'registry',
    actorId,
    actorLabel: 'Registry administrator',
    actorRole: 'admin',
    jurisdictionId: null,
    reason: action === 'migration.rollback' ? 'Schema rollback' : 'Schema migration',
    changes: null,
    details: details || null,
    createdAt: now,
    previousHash: previous,
  };
  events.push({ ...base, hash: hashToken(JSON.stringify(base)) });
  draft.set(ASSET_STORAGE_KEYS.audit, events);
};

export const getAssetMigrationStatus = (storage) => {
  const meta = safeReadJson(storage, ASSET_STORAGE_KEYS.meta, {}) || {};
  const counts = Object.fromEntries(
    ASSET_COLLECTION_KEYS.map((key) => [key, readCollection(storage, key).length])
  );
  return {
    schemaVersion: meta.schemaVersion || 0,
    latestSchemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
    initialized: Boolean(meta.initialized),
    seededAt: meta.seededAt || null,
    migratedAt: meta.migratedAt || null,
    lastRollbackAt: meta.lastRollbackAt || null,
    demoData: Boolean(meta.demoData),
    counts,
    backupAvailable: Boolean(readCollection(storage, ASSET_STORAGE_KEYS.migrationBackup).length || safeReadJson(storage, ASSET_STORAGE_KEYS.migrationBackup, null)),
    indexes: ASSET_REGISTRY_INDEX_MANIFEST.map((entry) => ({ ...entry })),
  };
};

/**
 * Bootstraps reference data and a clearly labelled demonstration register on
 * first use. Existing collections are never overwritten.
 */
export const ensureAssetRegistryData = ({ storage, nowMs = Date.now(), seedDemo = true } = {}) => {
  const meta = safeReadJson(storage, ASSET_STORAGE_KEYS.meta, {}) || {};
  if (meta.initialized && meta.schemaVersion === ASSET_REGISTRY_SCHEMA_VERSION) {
    return getAssetMigrationStatus(storage);
  }

  const now = nowIso(nowMs);
  const existingAssets = readCollection(storage, ASSET_STORAGE_KEYS.assets);
  const shouldSeedDemo = seedDemo && existingAssets.length === 0;

  runAssetTransaction(
    storage,
    [
      ASSET_STORAGE_KEYS.meta,
      ASSET_STORAGE_KEYS.categories,
      ASSET_STORAGE_KEYS.locations,
      ASSET_STORAGE_KEYS.assets,
      ASSET_STORAGE_KEYS.inspections,
      ASSET_STORAGE_KEYS.reports,
      ASSET_STORAGE_KEYS.workOrders,
      ASSET_STORAGE_KEYS.repairEvents,
      ASSET_STORAGE_KEYS.evidence,
      ASSET_STORAGE_KEYS.qrTokens,
      ASSET_STORAGE_KEYS.triage,
      ASSET_STORAGE_KEYS.audit,
      ASSET_STORAGE_KEYS.actionNonces,
    ],
    (draft) => {
      const setIfEmpty = (key, value) => {
        const current = draft.get(key);
        if (!Array.isArray(current) || current.length === 0) draft.set(key, value);
      };

      setIfEmpty(ASSET_STORAGE_KEYS.categories, ASSET_CATEGORY_SEED.map(normalizeCategory));
      setIfEmpty(ASSET_STORAGE_KEYS.locations, ASSET_LOCATION_SEED.map(normalizeLocation));
      if (shouldSeedDemo) {
        setIfEmpty(ASSET_STORAGE_KEYS.assets, ASSET_DEMO_ASSETS.map((asset) => normalizeSeedAsset(asset, now)));
        setIfEmpty(ASSET_STORAGE_KEYS.inspections, ASSET_DEMO_INSPECTIONS.map((inspection) => normalizeSeedInspection(inspection, now)));
        setIfEmpty(ASSET_STORAGE_KEYS.reports, ASSET_DEMO_FAULT_REPORTS.map((report) => normalizeSeedReport(report, now)));
        setIfEmpty(ASSET_STORAGE_KEYS.workOrders, ASSET_DEMO_WORK_ORDERS.map((order) => normalizeSeedOrder(order, now)));
        setIfEmpty(ASSET_STORAGE_KEYS.repairEvents, ASSET_DEMO_REPAIR_EVENTS.map((event) => ({ ...event, schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION })));
        setIfEmpty(ASSET_STORAGE_KEYS.evidence, ASSET_DEMO_EVIDENCE.map((item) => ({ ...item, schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION })));
        setIfEmpty(ASSET_STORAGE_KEYS.qrTokens, seedQrTokens());
        setIfEmpty(ASSET_STORAGE_KEYS.triage, ASSET_DEMO_TRIAGE.map((item) => ({ ...item })));
      }
      if (!Array.isArray(draft.get(ASSET_STORAGE_KEYS.audit))) draft.set(ASSET_STORAGE_KEYS.audit, []);
      if (!draft.get(ASSET_STORAGE_KEYS.actionNonces) || Array.isArray(draft.get(ASSET_STORAGE_KEYS.actionNonces))) {
        draft.set(ASSET_STORAGE_KEYS.actionNonces, {});
      }

      const currentMeta = draft.get(ASSET_STORAGE_KEYS.meta);
      const baseMeta = currentMeta && typeof currentMeta === 'object' && !Array.isArray(currentMeta) ? currentMeta : {};
      draft.set(ASSET_STORAGE_KEYS.meta, {
        ...baseMeta,
        initialized: true,
        schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
        seededAt: baseMeta.seededAt || now,
        demoData: Boolean(baseMeta.demoData || shouldSeedDemo),
        staffActionSecret: baseMeta.staffActionSecret || generateOpaqueToken(32),
        indexManifest: ASSET_REGISTRY_INDEX_MANIFEST.map((entry) => entry.name),
      });
    }
  );

  return getAssetMigrationStatus(storage);
};

const categoryIdForLegacy = (row) => {
  const key = sanitizePlain(row.category || row.categoryCode || '', { max: 60 }).toLowerCase();
  const match = ASSET_CATEGORY_SEED.find(
    (category) => category.code === key || category.label.toLowerCase() === key || category.id === key
  );
  return match?.id || 'cat_street_furniture';
};

const normalizeLegacyAsset = (row, index, now) => {
  const locationId = row.locationId || `loc_legacy_${index + 1}`;
  const jurisdictionId = sanitizePlain(row.jurisdictionId || row.jurisdiction || 'blr', { max: 40 }) || 'blr';
  return {
    id: row.id || newAssetId('asset_legacy'),
    publicId: row.publicId || `LEG-AST-${String(index + 1).padStart(4, '0')}`,
    jurisdictionId,
    categoryId: row.categoryId || categoryIdForLegacy(row),
    locationId,
    name: sanitizePlain(row.name || row.assetName || `Legacy public asset ${index + 1}`, { max: 120 }),
    publicDescription: sanitizePlain(row.publicDescription || row.description || '', { max: 1000, multiline: true }),
    internalNotes: sanitizePlain(row.internalNotes || row.notes || '', { max: 1200, multiline: true }),
    condition: row.condition || 'unknown',
    status: row.status || 'active',
    installedOn: row.installedOn || null,
    lastInspectionAt: row.lastInspectionAt || null,
    inspectionDueAt: row.inspectionDueAt || null,
    isPubliclyListed: row.isPubliclyListed !== false,
    createdBy: row.createdBy || 'migration',
    createdAt: row.createdAt || now,
    updatedAt: row.updatedAt || now,
    schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
  };
};

/**
 * Applies the current schema. If a representative legacy collection exists,
 * it is normalised and copied into the registry in one transaction. A full
 * snapshot is written before any collection changes.
 */
export const migrateAssetRegistry = ({ storage, nowMs = Date.now() } = {}) => {
  assertAssetCapability('registry.migrate');
  const now = nowIso(nowMs);
  const meta = safeReadJson(storage, ASSET_STORAGE_KEYS.meta, {}) || {};
  if (meta.initialized && meta.schemaVersion === ASSET_REGISTRY_SCHEMA_VERSION) {
    return { migrated: false, fromVersion: meta.schemaVersion, toVersion: ASSET_REGISTRY_SCHEMA_VERSION, status: getAssetMigrationStatus(storage) };
  }

  const legacyAssets = readCollection(storage, ASSET_STORAGE_KEYS.legacyAssets);
  const backup = {
    createdAt: now,
    fromVersion: meta.schemaVersion || 0,
    schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
    keys: Object.fromEntries(BACKUP_KEYS.map((key) => [key, storage?.getItem(key) ?? null])),
  };
  if (!safeWriteJson(storage, ASSET_STORAGE_KEYS.migrationBackup, backup)) {
    throw createAssetError(ASSET_ERROR_CODES.MIGRATION_ERROR, 'Could not write the pre-migration snapshot.');
  }

  try {
    runAssetTransaction(
      storage,
      [
        ASSET_STORAGE_KEYS.meta,
        ASSET_STORAGE_KEYS.categories,
        ASSET_STORAGE_KEYS.locations,
        ASSET_STORAGE_KEYS.assets,
        ASSET_STORAGE_KEYS.inspections,
        ASSET_STORAGE_KEYS.reports,
        ASSET_STORAGE_KEYS.workOrders,
        ASSET_STORAGE_KEYS.repairEvents,
        ASSET_STORAGE_KEYS.evidence,
        ASSET_STORAGE_KEYS.qrTokens,
        ASSET_STORAGE_KEYS.triage,
        ASSET_STORAGE_KEYS.audit,
        ASSET_STORAGE_KEYS.actionNonces,
      ],
      (draft) => {
        const categories = draft.get(ASSET_STORAGE_KEYS.categories);
        const locations = draft.get(ASSET_STORAGE_KEYS.locations);
        const existingAssets = draft.get(ASSET_STORAGE_KEYS.assets);
        if (!Array.isArray(categories) || categories.length === 0) {
          draft.set(ASSET_STORAGE_KEYS.categories, ASSET_CATEGORY_SEED.map(normalizeCategory));
        }
        if (!Array.isArray(locations) || locations.length === 0) {
          draft.set(ASSET_STORAGE_KEYS.locations, ASSET_LOCATION_SEED.map(normalizeLocation));
        }
        const nextLocations = Array.isArray(locations) ? [...locations] : [];
        const nextAssets = Array.isArray(existingAssets) ? [...existingAssets] : [];
        const existingIds = new Set(nextAssets.map((asset) => asset.id));
        const existingPublicIds = new Set(nextAssets.map((asset) => asset.publicId));

        legacyAssets.forEach((row, index) => {
          const normalized = normalizeLegacyAsset(row, index, now);
          if (existingIds.has(normalized.id)) return;
          if (existingPublicIds.has(normalized.publicId)) {
            normalized.publicId = `LEG-AST-${String(nextAssets.length + 1).padStart(4, '0')}-${index + 1}`;
          }
          const jurisdiction = ASSET_JURISDICTIONS.find((item) => item.id === normalized.jurisdictionId);
          if (!nextLocations.some((location) => location.id === normalized.locationId)) {
            nextLocations.push({
              id: normalized.locationId,
              jurisdictionId: normalized.jurisdictionId,
              ward: sanitizePlain(row.ward || jurisdiction?.wards?.[0] || 'Ward not recorded', { max: 120 }),
              locality: sanitizePlain(row.locality || '', { max: 180 }),
              landmark: sanitizePlain(row.landmark || 'Location recorded during migration', { max: 240 }),
              publicGrid: sanitizePlain(row.publicGrid || 'unknown_grid', { max: 40 }),
              accessNotes: '',
              schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
              createdAt: now,
              updatedAt: now,
            });
          }
          nextAssets.push(normalized);
          existingIds.add(normalized.id);
          existingPublicIds.add(normalized.publicId);
        });

        draft.set(ASSET_STORAGE_KEYS.locations, nextLocations);
        draft.set(ASSET_STORAGE_KEYS.assets, nextAssets);
        if (!Array.isArray(draft.get(ASSET_STORAGE_KEYS.inspections))) draft.set(ASSET_STORAGE_KEYS.inspections, []);
        if (!Array.isArray(draft.get(ASSET_STORAGE_KEYS.reports))) draft.set(ASSET_STORAGE_KEYS.reports, []);
        if (!Array.isArray(draft.get(ASSET_STORAGE_KEYS.workOrders))) draft.set(ASSET_STORAGE_KEYS.workOrders, []);
        if (!Array.isArray(draft.get(ASSET_STORAGE_KEYS.repairEvents))) draft.set(ASSET_STORAGE_KEYS.repairEvents, []);
        if (!Array.isArray(draft.get(ASSET_STORAGE_KEYS.evidence))) draft.set(ASSET_STORAGE_KEYS.evidence, []);
        if (!Array.isArray(draft.get(ASSET_STORAGE_KEYS.qrTokens))) draft.set(ASSET_STORAGE_KEYS.qrTokens, []);
        if (!Array.isArray(draft.get(ASSET_STORAGE_KEYS.triage))) draft.set(ASSET_STORAGE_KEYS.triage, []);
        if (!Array.isArray(draft.get(ASSET_STORAGE_KEYS.audit))) draft.set(ASSET_STORAGE_KEYS.audit, []);
        if (!draft.get(ASSET_STORAGE_KEYS.actionNonces) || Array.isArray(draft.get(ASSET_STORAGE_KEYS.actionNonces))) {
          draft.set(ASSET_STORAGE_KEYS.actionNonces, {});
        }

        const currentMeta = draft.get(ASSET_STORAGE_KEYS.meta);
        const baseMeta = currentMeta && typeof currentMeta === 'object' && !Array.isArray(currentMeta) ? currentMeta : {};
        draft.set(ASSET_STORAGE_KEYS.meta, {
          ...baseMeta,
          initialized: true,
          schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
          seededAt: baseMeta.seededAt || now,
          migratedAt: now,
          demoData: Boolean(baseMeta.demoData),
          staffActionSecret: baseMeta.staffActionSecret || generateOpaqueToken(32),
        });
        appendMigrationAudit(draft, {
          action: 'migration.run',
          actorId: 'migration',
          now,
          details: { fromVersion: backup.fromVersion, toVersion: ASSET_REGISTRY_SCHEMA_VERSION, legacyAssets: legacyAssets.length },
        });
      }
    );
  } catch (error) {
    throw createAssetError(ASSET_ERROR_CODES.MIGRATION_ERROR, `Migration failed: ${error?.message || error}`, {
      details: { fromVersion: backup.fromVersion },
    });
  }

  return {
    migrated: true,
    fromVersion: backup.fromVersion,
    toVersion: ASSET_REGISTRY_SCHEMA_VERSION,
    importedLegacyAssets: legacyAssets.length,
    status: getAssetMigrationStatus(storage),
  };
};

/** Restores the exact pre-migration snapshot. */
export const rollbackAssetRegistry = ({ storage, nowMs = Date.now() } = {}) => {
  assertAssetCapability('registry.migrate');
  const backup = safeReadJson(storage, ASSET_STORAGE_KEYS.migrationBackup, null);
  if (!backup || !backup.keys) {
    throw createAssetError(ASSET_ERROR_CODES.MIGRATION_ERROR, 'No migration snapshot is available to roll back.');
  }
  try {
    for (const key of BACKUP_KEYS) {
      const raw = backup.keys[key];
      if (raw === null || raw === undefined) removeStorageKey(storage, key);
      else storage.setItem(key, raw);
    }
    const meta = safeReadJson(storage, ASSET_STORAGE_KEYS.meta, {}) || {};
    safeWriteJson(storage, ASSET_STORAGE_KEYS.meta, {
      ...meta,
      lastRollbackAt: nowIso(nowMs),
      schemaVersion: backup.fromVersion || meta.schemaVersion,
    });
    removeStorageKey(storage, ASSET_STORAGE_KEYS.migrationBackup);
  } catch (error) {
    throw createAssetError(ASSET_ERROR_CODES.MIGRATION_ERROR, `Rollback failed: ${error?.message || error}`);
  }
  return { rolledBack: true, restoredFrom: backup.createdAt, restoredVersion: backup.fromVersion || 0, status: getAssetMigrationStatus(storage) };
};

/** Query-index manifest plus live collection counts. */
export const buildAssetRegistryIndexes = (storage) => {
  const assets = readCollection(storage, ASSET_STORAGE_KEYS.assets);
  const reports = readCollection(storage, ASSET_STORAGE_KEYS.reports);
  const orders = readCollection(storage, ASSET_STORAGE_KEYS.workOrders);
  const qrTokens = readCollection(storage, ASSET_STORAGE_KEYS.qrTokens);
  return {
    manifest: ASSET_REGISTRY_INDEX_MANIFEST.map((entry) => ({ ...entry })),
    counts: {
      assets: assets.length,
      byJurisdiction: countBy(assets, 'jurisdictionId'),
      byStatus: countBy(assets, 'status'),
      byCategory: countBy(assets, 'categoryId'),
      faultReports: reports.length,
      byReportState: countBy(reports, 'state'),
      workOrders: orders.length,
      byOrderState: countBy(orders, 'state'),
      qrTokens: qrTokens.length,
      byQrState: countBy(qrTokens, 'state'),
    },
    builtAt: nowIso(),
  };
};
