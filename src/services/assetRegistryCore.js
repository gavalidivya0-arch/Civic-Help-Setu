/**
 * Shared read-side service for the QR-Based Public Asset Maintenance and
 * Repair History Registry (#750).
 *
 * This module is the trusted boundary for public/staff projections, storage
 * helpers, audit-chain writes, idempotency and the read-only queries used by
 * the workspace. Mutations live in assetRegistryService.js and import these
 * helpers; React components never write storage directly.
 */

import { ASSET_JURISDICTIONS } from '../data/publicAssetData';
import { getCurrentActor } from './accessControl';
import {
  actorIdentity,
  assertAssetCapability,
  canAsset,
  canUseAssetStaffWorkspace,
  getScopedJurisdictions,
  isAssetStaff,
  listAssetCapabilities,
  requireActorIdentity,
  resolveAssetRole,
} from './assetAccessControl';
import {
  ASSET_API_LIMITS,
  ASSET_CAPABILITIES,
  ASSET_COLLECTION_KEYS,
  ASSET_CONDITIONS,
  ASSET_CONDITION_LABELS,
  ASSET_ERROR_CODES,
  ASSET_ERROR_MESSAGES,
  ASSET_REGISTRY_SCHEMA_VERSION,
  ASSET_ROLES,
  ASSET_ROLE_LABELS,
  ASSET_STATUS,
  ASSET_STATUS_LABELS,
  ASSET_STORAGE_KEYS,
  FAULT_CATEGORIES,
  FAULT_CATEGORY_LABELS,
  FAULT_REPORT_STATES,
  FAULT_REPORT_STATE_LABELS,
  INSPECTION_STATES,
  INSPECTION_STATE_LABELS,
  INSPECTION_TYPES,
  INSPECTION_TYPE_LABELS,
  QR_TOKEN_STATES,
  QR_TOKEN_STATE_LABELS,
  REPORT_SEVERITIES,
  REPORT_SEVERITY_LABELS,
  TRIAGE_DECISIONS,
  TRIAGE_DECISION_LABELS,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_PRIORITY_LABELS,
  WORK_ORDER_STATES,
  WORK_ORDER_STATE_LABELS,
  WORK_ORDER_TYPES,
  WORK_ORDER_TYPE_LABELS,
  allowedNextStates,
  canTransition,
} from './assetRegistryConstants';
import {
  buildAssetRegistryIndexes,
  ensureAssetRegistryData,
  getAssetMigrationStatus,
  migrateAssetRegistry,
  rollbackAssetRegistry,
} from './assetRegistryMigrations';
import {
  AssetServiceError,
  cloneJson,
  createAssetError,
  getAssetStorage,
  hashString,
  hashToken,
  isOpaqueToken,
  newAssetId,
  normalizeSearch,
  nowIso,
  paginate,
  safeReadJson,
  sanitizePlain,
  sanitizePublicNarrative,
  stableStringify,
} from './assetRegistryValidation';

export {
  ASSET_API_LIMITS,
  ASSET_CAPABILITIES,
  ASSET_COLLECTION_KEYS,
  ASSET_CONDITIONS,
  ASSET_CONDITION_LABELS,
  ASSET_ERROR_CODES,
  ASSET_ERROR_MESSAGES,
  ASSET_REGISTRY_SCHEMA_VERSION,
  ASSET_ROLES,
  ASSET_ROLE_LABELS,
  ASSET_STATUS,
  ASSET_STATUS_LABELS,
  ASSET_STORAGE_KEYS,
  FAULT_CATEGORIES,
  FAULT_CATEGORY_LABELS,
  FAULT_REPORT_STATES,
  FAULT_REPORT_STATE_LABELS,
  INSPECTION_STATES,
  INSPECTION_STATE_LABELS,
  INSPECTION_TYPES,
  INSPECTION_TYPE_LABELS,
  QR_TOKEN_STATES,
  QR_TOKEN_STATE_LABELS,
  REPORT_SEVERITIES,
  REPORT_SEVERITY_LABELS,
  TRIAGE_DECISIONS,
  TRIAGE_DECISION_LABELS,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_PRIORITY_LABELS,
  WORK_ORDER_STATES,
  WORK_ORDER_STATE_LABELS,
  WORK_ORDER_TYPES,
  WORK_ORDER_TYPE_LABELS,
  AssetServiceError,
  allowedNextStates,
  canTransition,
  buildAssetRegistryIndexes,
  ensureAssetRegistryData,
  getAssetMigrationStatus,
  migrateAssetRegistry,
  rollbackAssetRegistry,
  resolveAssetRole,
  getScopedJurisdictions,
  canAsset,
  isAssetStaff,
  listAssetCapabilities,
  canUseAssetStaffWorkspace,
  requireActorIdentity,
};

export const readAssetCollection = (storage, key) => {
  const value = safeReadJson(storage, key, []);
  return Array.isArray(value) ? value : [];
};

export const findAssetById = (items, id) => items.find((item) => item.id === id) || null;
export const findAssetByPublicId = (items, publicId) => items.find((item) => item.publicId === publicId) || null;

export const currentAssetIdentity = () => {
  const identity = actorIdentity(getCurrentActor());
  if (!identity) throw createAssetError(ASSET_ERROR_CODES.UNAUTHENTICATED);
  return identity;
};

export const scopeAssetRecords = (records, scopedJurisdictions) => {
  if (scopedJurisdictions === null) return records;
  const allowed = new Set(scopedJurisdictions);
  return records.filter((record) => allowed.has(record.jurisdictionId));
};

export const getAssetJurisdiction = (jurisdictionId) =>
  ASSET_JURISDICTIONS.find((jurisdiction) => jurisdiction.id === jurisdictionId) || null;

export const requireAssetJurisdictionDefinition = (jurisdictionId) => {
  const jurisdiction = getAssetJurisdiction(jurisdictionId);
  if (!jurisdiction) {
    throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, `Unknown jurisdiction: ${jurisdictionId}.`, {
      fieldErrors: { jurisdictionId: 'Choose a supported municipal jurisdiction.' },
    });
  }
  return jurisdiction;
};

export const normalizeAssetIdempotencyKey = (key) => {
  if (key === undefined || key === null || key === '') return null;
  const text = String(key).trim();
  if (text.length < 6 || text.length > 160) {
    throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, 'Idempotency key must be between 6 and 160 characters.');
  }
  return text;
};

export const assetPayloadHash = (payload) => hashToken(stableStringify(payload));
const idempotencySlot = (actor, key) => (key ? `${actor.id}:${key}` : null);

export const checkAssetIdempotency = (storage, actor, key, scope, payload) => {
  if (!key) return null;
  const store = safeReadJson(storage, ASSET_STORAGE_KEYS.idempotency, {});
  const existing = store?.[idempotencySlot(actor, key)];
  if (!existing) return null;
  if (existing.payloadHash !== assetPayloadHash({ scope, payload })) {
    throw createAssetError(ASSET_ERROR_CODES.IDEMPOTENCY_CONFLICT);
  }
  return { ...cloneJson(existing.result), replayed: true };
};

export const saveAssetIdempotency = (draft, actor, key, scope, payload, result) => {
  if (!key) return;
  const slot = idempotencySlot(actor, key);
  const current = draft.get(ASSET_STORAGE_KEYS.idempotency);
  const store = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  store[slot] = {
    payloadHash: assetPayloadHash({ scope, payload }),
    scope,
    result: cloneJson(result),
    createdAt: nowIso(),
  };
  draft.set(ASSET_STORAGE_KEYS.idempotency, store);
};

export const appendAssetAuditEvent = (draft, event) => {
  const events = Array.isArray(draft.get(ASSET_STORAGE_KEYS.audit)) ? draft.get(ASSET_STORAGE_KEYS.audit) : [];
  const previousHash = events.length > 0 ? events[events.length - 1].hash : 'GENESIS';
  const base = {
    id: newAssetId('audit'),
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    actorId: event.actor?.id || 'system',
    actorLabel: event.actor?.label || 'System',
    actorRole: event.actor?.role || ASSET_ROLES.CITIZEN,
    jurisdictionId: event.jurisdictionId || null,
    reason: sanitizePlain(event.reason || '', { max: ASSET_API_LIMITS.maxReasonLength, multiline: false }),
    changes: event.changes || null,
    details: event.details || null,
    createdAt: event.createdAt || nowIso(),
    previousHash,
  };
  const record = { ...base, hash: hashToken(stableStringify(base)) };
  events.push(record);
  draft.set(ASSET_STORAGE_KEYS.audit, events);
  return record;
};

export const verifyAssetAuditChain = (events = []) => {
  let previousHash = 'GENESIS';
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const { hash, ...base } = event || {};
    if (!event || event.previousHash !== previousHash || hashToken(stableStringify(base)) !== hash) {
      return { valid: false, brokenAt: index, checked: index + 1, total: events.length };
    }
    previousHash = hash;
  }
  return { valid: true, brokenAt: null, checked: events.length, total: events.length };
};

export const assetSequenceId = (items, prefix, width = 4) => {
  let next = items.length + 1;
  const existing = new Set(items.map((item) => item.publicId));
  let candidate = `${prefix}-${String(next).padStart(width, '0')}`;
  while (existing.has(candidate)) {
    next += 1;
    candidate = `${prefix}-${String(next).padStart(width, '0')}`;
  }
  return candidate;
};

export const assetPublicCode = (assets, jurisdictionId) =>
  assetSequenceId(
    assets.filter((asset) => asset.jurisdictionId === jurisdictionId),
    `${jurisdictionId.toUpperCase()}-AST`
  );

export const inspectionPublicCode = (inspections, jurisdictionId) =>
  assetSequenceId(
    inspections.filter((inspection) => inspection.jurisdictionId === jurisdictionId),
    `${jurisdictionId.toUpperCase()}-INS`
  );

export const workOrderPublicCode = (orders, jurisdictionId) =>
  assetSequenceId(
    orders.filter((order) => order.jurisdictionId === jurisdictionId),
    `${jurisdictionId.toUpperCase()}-AWO`
  );

export const repairPublicCode = (repairs, jurisdictionId) =>
  assetSequenceId(
    repairs.filter((repair) => repair.jurisdictionId === jurisdictionId),
    `${jurisdictionId.toUpperCase()}-REP`
  );

const referenceSuffix = (existing, prefix) => {
  let candidate = `${prefix}-${hashString(`${Date.now()}|${existing.length}|${Math.random()}`).slice(0, 4).toUpperCase()}${hashString(`${Math.random()}|${existing.length}`)
    .slice(0, 2)
    .toUpperCase()}`;
  while (existing.includes(candidate)) {
    candidate = `${prefix}-${hashString(`${candidate}|${Math.random()}`).slice(0, 6).toUpperCase()}`;
  }
  return candidate;
};

export const faultReportReference = (reports) =>
  referenceSuffix(reports.map((report) => report.publicReference), 'AST-REP');

export const inspectionTiming = (dueAt, nowMs = Date.now()) => {
  if (!dueAt) return { status: 'unscheduled', label: 'No inspection scheduled', daysUntilDue: null, isOverdue: false };
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return { status: 'unscheduled', label: 'No inspection scheduled', daysUntilDue: null, isOverdue: false };
  const days = Math.ceil((due - nowMs) / (24 * 60 * 60 * 1000));
  if (days < 0) {
    return { status: 'overdue', label: `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`, daysUntilDue: days, isOverdue: true };
  }
  if (days <= ASSET_API_LIMITS.inspectionReminderDays) {
    return { status: 'due_soon', label: `Due in ${days} day${days === 1 ? '' : 's'}`, daysUntilDue: days, isOverdue: false };
  }
  return { status: 'scheduled', label: `Due ${new Date(due).toLocaleDateString('en-IN')}`, daysUntilDue: days, isOverdue: false };
};

export const categoryFor = (storage, categoryId) =>
  readAssetCollection(storage, ASSET_STORAGE_KEYS.categories).find((category) => category.id === categoryId) || null;

export const locationFor = (storage, locationId) =>
  readAssetCollection(storage, ASSET_STORAGE_KEYS.locations).find((location) => location.id === locationId) || null;

export const requireAssetRecord = (draft, assetId, scopedJurisdictions) => {
  const asset = findAssetById(draft.get(ASSET_STORAGE_KEYS.assets) || [], assetId);
  if (!asset) throw createAssetError(ASSET_ERROR_CODES.NOT_FOUND, 'Asset was not found.');
  if (scopedJurisdictions !== null && !scopedJurisdictions.includes(asset.jurisdictionId)) {
    throw createAssetError(ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN);
  }
  return asset;
};

export const requireInspectionRecord = (draft, inspectionId, scopedJurisdictions) => {
  const inspection = findAssetById(draft.get(ASSET_STORAGE_KEYS.inspections) || [], inspectionId);
  if (!inspection) throw createAssetError(ASSET_ERROR_CODES.NOT_FOUND, 'Inspection was not found.');
  if (scopedJurisdictions !== null && !scopedJurisdictions.includes(inspection.jurisdictionId)) {
    throw createAssetError(ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN);
  }
  return inspection;
};

export const requireReportRecord = (draft, reportId, scopedJurisdictions) => {
  const report = findAssetById(draft.get(ASSET_STORAGE_KEYS.reports) || [], reportId);
  if (!report) throw createAssetError(ASSET_ERROR_CODES.NOT_FOUND, 'Fault report was not found.');
  if (scopedJurisdictions !== null && !scopedJurisdictions.includes(report.jurisdictionId)) {
    throw createAssetError(ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN);
  }
  return report;
};

export const requireWorkOrderRecord = (draft, workOrderId, scopedJurisdictions) => {
  const order = findAssetById(draft.get(ASSET_STORAGE_KEYS.workOrders) || [], workOrderId);
  if (!order) throw createAssetError(ASSET_ERROR_CODES.NOT_FOUND, 'Work order was not found.');
  if (scopedJurisdictions !== null && !scopedJurisdictions.includes(order.jurisdictionId)) {
    throw createAssetError(ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN);
  }
  return order;
};

export const assertAssetTransition = (kind, from, to) => {
  if (!canTransition(kind, from, to)) {
    throw createAssetError(
      ASSET_ERROR_CODES.INVALID_TRANSITION,
      `Cannot move ${kind} from ${from} to ${to}. Allowed: ${allowedNextStates(kind, from).join(', ') || 'none'}.`,
      { details: { from, to, allowed: allowedNextStates(kind, from) } }
    );
  }
};

export const freshness = (storage) => {
  const meta = safeReadJson(storage, ASSET_STORAGE_KEYS.meta, {}) || {};
  const assets = readAssetCollection(storage, ASSET_STORAGE_KEYS.assets);
  const latest = assets.reduce((max, asset) => {
    const time = Date.parse(asset.updatedAt || asset.createdAt || '');
    return Number.isFinite(time) && time > max ? time : max;
  }, 0);
  const lastUpdatedAt = latest ? new Date(latest).toISOString() : meta.seededAt || meta.migratedAt || null;
  const ageDays = lastUpdatedAt ? Math.floor((Date.now() - Date.parse(lastUpdatedAt)) / (24 * 60 * 60 * 1000)) : null;
  return {
    lastUpdatedAt,
    ageDays,
    isStale: ageDays === null ? true : ageDays > ASSET_API_LIMITS.staleAfterDays,
    staleAfterDays: ASSET_API_LIMITS.staleAfterDays,
    source: 'Municipal public asset register (local device store)',
  };
};

export const publicRepairView = (repair, verifiedAtOverride = null) => ({
  publicReference: repair.publicReference,
  publicSummary: repair.publicSummary,
  completedAt: repair.completedAt,
  verifiedAt: repair.verifiedAt || verifiedAtOverride || null,
  evidenceCount: Array.isArray(repair.evidenceIds) ? repair.evidenceIds.length : 0,
});

export const publicInspectionView = (inspection) => ({
  publicId: inspection.publicId,
  type: inspection.type,
  typeLabel: INSPECTION_TYPE_LABELS[inspection.type] || inspection.type,
  completedAt: inspection.completedAt || inspection.verifiedAt || null,
  conditionAfter: inspection.conditionAfter,
  conditionLabel: ASSET_CONDITION_LABELS[inspection.conditionAfter] || inspection.conditionAfter,
  summary: inspection.state === INSPECTION_STATES.VERIFIED
    ? sanitizePublicNarrative(inspection.findings || '', { max: 600, multiline: true })
    : '',
});

const verifiedRepairEntry = (repair, workOrders) => {
  if (repair.verifiedAt) return { repair, verifiedAt: repair.verifiedAt };
  const linkedOrder = workOrders.find((order) => order.id === repair.workOrderId);
  if (linkedOrder?.state === WORK_ORDER_STATES.VERIFIED && linkedOrder.verifiedAt) {
    return { repair, verifiedAt: linkedOrder.verifiedAt };
  }
  return null;
};

export const publicAssetView = (
  asset,
  category,
  location,
  { repairs = [], inspections = [], workOrders = null, storage = null, includeHistory = false } = {}
) => {
  // Repair events are append-only. A repair becomes public when the linked
  // work order is verified; the event itself is never edited after creation.
  const orderRecords = Array.isArray(workOrders)
    ? workOrders
    : storage
      ? readAssetCollection(storage, ASSET_STORAGE_KEYS.workOrders)
      : [];
  const repairItems = repairs
    .filter((repair) => repair.assetId === asset.id)
    .map((repair) => verifiedRepairEntry(repair, orderRecords))
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.repair.completedAt || 0) - Date.parse(a.repair.completedAt || 0))
    .map(({ repair, verifiedAt }) => publicRepairView(repair, verifiedAt));
  const inspectionItems = inspections
    .filter((inspection) => inspection.assetId === asset.id && inspection.state === INSPECTION_STATES.VERIFIED)
    .sort((a, b) => Date.parse(b.verifiedAt || b.completedAt || 0) - Date.parse(a.verifiedAt || a.completedAt || 0))
    .map(publicInspectionView);

  return {
    publicId: asset.publicId,
    name: asset.name,
    category: category
      ? { code: category.code, label: category.label }
      : { code: 'unknown', label: 'Public asset' },
    publicDescription: asset.publicDescription || '',
    condition: asset.condition,
    conditionLabel: ASSET_CONDITION_LABELS[asset.condition] || asset.condition,
    status: asset.status,
    statusLabel: ASSET_STATUS_LABELS[asset.status] || asset.status,
    location: location
      ? {
          ward: location.ward,
          locality: location.locality || '',
          landmark: location.landmark || '',
          grid: location.publicGrid || 'unknown_grid',
          precision: 'approximately 1 km grid',
        }
      : { ward: 'Location not recorded', locality: '', landmark: '', grid: 'unknown_grid', precision: 'not published' },
    installedYear: asset.installedOn ? new Date(asset.installedOn).getUTCFullYear() : null,
    lastInspectedAt: asset.lastInspectionAt || null,
    nextInspectionAt: asset.inspectionDueAt || null,
    inspectionTiming: inspectionTiming(asset.inspectionDueAt),
    lastRepairAt: repairItems[0]?.completedAt || null,
    repairCount: repairItems.length,
    maintenanceHistory: includeHistory ? repairItems : undefined,
    inspectionHistory: includeHistory ? inspectionItems : undefined,
    source: 'Municipal public asset register',
    updatedAt: asset.updatedAt,
    publicFieldsNote:
      'Only approved public fields are shown. Internal notes, precise locations, reporter details and evidence files are not published.',
  };
};

export const staffAssetView = (asset, storage, nowMs = Date.now()) => {
  const category = categoryFor(storage, asset.categoryId);
  const location = locationFor(storage, asset.locationId);
  const inspections = readAssetCollection(storage, ASSET_STORAGE_KEYS.inspections).filter((item) => item.assetId === asset.id);
  const orders = readAssetCollection(storage, ASSET_STORAGE_KEYS.workOrders).filter((item) => item.assetId === asset.id);
  const reports = readAssetCollection(storage, ASSET_STORAGE_KEYS.reports).filter((item) => item.assetId === asset.id);
  const repairs = readAssetCollection(storage, ASSET_STORAGE_KEYS.repairEvents).filter((item) => item.assetId === asset.id);
  const qrTokens = readAssetCollection(storage, ASSET_STORAGE_KEYS.qrTokens).filter((item) => item.assetId === asset.id);
  return {
    ...asset,
    conditionLabel: ASSET_CONDITION_LABELS[asset.condition] || asset.condition,
    statusLabel: ASSET_STATUS_LABELS[asset.status] || asset.status,
    inspectionTiming: inspectionTiming(asset.inspectionDueAt, nowMs),
    category: category ? { id: category.id, code: category.code, label: category.label } : null,
    location: location ? { ...location } : null,
    publicView: publicAssetView(asset, category, location, {
      repairs,
      workOrders: orders,
      storage,
    }),
    counts: {
      inspections: inspections.length,
      openInspections: inspections.filter((item) => ![INSPECTION_STATES.VERIFIED, INSPECTION_STATES.CANCELLED].includes(item.state)).length,
      workOrders: orders.length,
      openWorkOrders: orders.filter((item) => ![WORK_ORDER_STATES.VERIFIED, WORK_ORDER_STATES.CANCELLED].includes(item.state)).length,
      faultReports: reports.length,
      pendingFaultReports: reports.filter((item) => [FAULT_REPORT_STATES.SUBMITTED, FAULT_REPORT_STATES.TRIAGED].includes(item.state)).length,
      repairs: repairs.length,
      activeQrTokens: qrTokens.filter((item) => item.state === QR_TOKEN_STATES.ACTIVE).length,
    },
    qrTokens: qrTokens.map((token) => ({
      id: token.id,
      tokenPrefix: token.tokenPrefix,
      state: token.state,
      stateLabel: QR_TOKEN_STATE_LABELS[token.state] || token.state,
      issuedAt: token.issuedAt,
      expiresAt: token.expiresAt,
      revokedAt: token.revokedAt,
      revokeReason: token.revokeReason,
    })),
  };
};

export const publicReportView = (report) => ({
  publicReference: report.publicReference,
  category: report.category,
  categoryLabel: FAULT_CATEGORY_LABELS[report.category] || report.category,
  severity: report.severity,
  severityLabel: REPORT_SEVERITY_LABELS[report.severity] || report.severity,
  description: report.description,
  state: report.state,
  stateLabel: FAULT_REPORT_STATE_LABELS[report.state] || report.state,
  priority: report.priority || null,
  priorityLabel: report.priority ? WORK_ORDER_PRIORITY_LABELS[report.priority] || report.priority : null,
  createdAt: report.createdAt,
  updatedAt: report.updatedAt,
  resolvedAt: report.resolvedAt || null,
  resolutionMessage:
    report.state === FAULT_REPORT_STATES.REJECTED
      ? 'A municipal reviewer assessed this report but did not record a maintenance action.'
      : report.state === FAULT_REPORT_STATES.DUPLICATE
        ? 'This report was linked to an existing report for the same asset.'
        : report.state === FAULT_REPORT_STATES.RESOLVED
          ? 'A repair was recorded and verified for this asset.'
          : report.state === FAULT_REPORT_STATES.CONVERTED
            ? 'A work order has been raised for this asset.'
            : 'The municipal team has received this report.',
  source: 'Citizen report — not a verified municipal observation',
});

export const staffReportView = (report) => {
  const { reporterKeyHash, ...safe } = report;
  void reporterKeyHash;
  return {
    ...safe,
    stateLabel: FAULT_REPORT_STATE_LABELS[report.state] || report.state,
    categoryLabel: FAULT_CATEGORY_LABELS[report.category] || report.category,
    severityLabel: REPORT_SEVERITY_LABELS[report.severity] || report.severity,
    priorityLabel: report.priority ? WORK_ORDER_PRIORITY_LABELS[report.priority] || report.priority : null,
    publicView: publicReportView(report),
  };
};

export const staffInspectionView = (inspection) => ({
  ...inspection,
  stateLabel: INSPECTION_STATE_LABELS[inspection.state] || inspection.state,
  typeLabel: INSPECTION_TYPE_LABELS[inspection.type] || inspection.type,
  conditionLabel: inspection.conditionAfter ? ASSET_CONDITION_LABELS[inspection.conditionAfter] || inspection.conditionAfter : null,
});

export const staffWorkOrderView = (order, storage) => {
  const evidence = readAssetCollection(storage, ASSET_STORAGE_KEYS.evidence).filter((item) => (order.evidenceIds || []).includes(item.id));
  return {
    ...order,
    stateLabel: WORK_ORDER_STATE_LABELS[order.state] || order.state,
    typeLabel: WORK_ORDER_TYPE_LABELS[order.type] || order.type,
    priorityLabel: WORK_ORDER_PRIORITY_LABELS[order.priority] || order.priority,
    evidence: evidence.map((item) => ({
      id: item.id,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      url: item.url,
      caption: item.caption,
      exifStripped: Boolean(item.exifStripped),
      accessScope: item.accessScope,
    })),
  };
};

export const resolvePublicQrAsset = (storage, rawToken, { forReport = false } = {}) => {
  if (!isOpaqueToken(rawToken)) {
    throw createAssetError(ASSET_ERROR_CODES.QR_INVALID);
  }
  const tokenHash = hashToken(rawToken);
  const token = readAssetCollection(storage, ASSET_STORAGE_KEYS.qrTokens).find((item) => item.tokenHash === tokenHash);
  if (!token || token.state !== QR_TOKEN_STATES.ACTIVE) {
    throw createAssetError(ASSET_ERROR_CODES.QR_INVALID);
  }
  if (token.expiresAt && Date.parse(token.expiresAt) < Date.now()) {
    throw createAssetError(ASSET_ERROR_CODES.QR_INVALID);
  }
  const asset = findAssetById(readAssetCollection(storage, ASSET_STORAGE_KEYS.assets), token.assetId);
  if (!asset || asset.isPubliclyListed === false || asset.status === ASSET_STATUS.ARCHIVED) {
    throw createAssetError(ASSET_ERROR_CODES.QR_INVALID);
  }
  if (forReport && ![ASSET_STATUS.ACTIVE, ASSET_STATUS.SUSPENDED].includes(asset.status)) {
    throw createAssetError(ASSET_ERROR_CODES.QR_INVALID, 'This asset is no longer accepting fault reports.', {
      userMessage: 'This asset is retired, so new fault reports are not accepted. Contact the municipal office if you need help.',
    });
  }
  return { asset, token };
};

const buildPublicAsset = (storage, asset, { includeHistory = false } = {}) => {
  const category = categoryFor(storage, asset.categoryId);
  const location = locationFor(storage, asset.locationId);
  return publicAssetView(asset, category, location, {
    repairs: readAssetCollection(storage, ASSET_STORAGE_KEYS.repairEvents),
    inspections: readAssetCollection(storage, ASSET_STORAGE_KEYS.inspections),
    workOrders: readAssetCollection(storage, ASSET_STORAGE_KEYS.workOrders),
    storage,
    includeHistory,
  });
};

export const getPlanningJurisdictions = () =>
  ASSET_JURISDICTIONS.map((jurisdiction) => ({
    id: jurisdiction.id,
    name: jurisdiction.name,
    state: jurisdiction.state,
    wards: [...jurisdiction.wards],
  }));

export const listAssetCategories = (storage = getAssetStorage()) => {
  ensureAssetRegistryData({ storage });
  return readAssetCollection(storage, ASSET_STORAGE_KEYS.categories).map((category) => ({ ...category }));
};

export const listAssetLocations = (filters = {}, storage = getAssetStorage()) => {
  assertAssetCapability('asset.staff.read');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const ward = normalizeSearch(filters.ward || '');
  return scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.locations), scoped)
    .filter((location) => (filters.jurisdictionId ? location.jurisdictionId === filters.jurisdictionId : true))
    .filter((location) => (ward ? normalizeSearch(location.ward).includes(ward) : true))
    .map((location) => ({ ...location }));
};

export const getPublicAssets = (filters = {}, storage = getAssetStorage()) => {
  assertAssetCapability('asset.public.read', null, { allowAnonymous: true });
  ensureAssetRegistryData({ storage });
  const categories = readAssetCollection(storage, ASSET_STORAGE_KEYS.categories);
  const locations = readAssetCollection(storage, ASSET_STORAGE_KEYS.locations);
  const categoryById = Object.fromEntries(categories.map((category) => [category.id, category]));
  const locationById = Object.fromEntries(locations.map((location) => [location.id, location]));
  const search = normalizeSearch(filters.search || '');
  const scoped = isAssetStaff() ? getScopedJurisdictions() : null;

  const assets = scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.assets), scoped)
    .filter((asset) => asset.isPubliclyListed !== false)
    .filter((asset) => asset.status !== ASSET_STATUS.ARCHIVED)
    .filter((asset) => (filters.jurisdictionId ? asset.jurisdictionId === filters.jurisdictionId : true))
    .filter((asset) => (filters.categoryId ? asset.categoryId === filters.categoryId : true))
    .filter((asset) => (filters.status ? asset.status === filters.status : true))
    .filter((asset) => (filters.condition ? asset.condition === filters.condition : true))
    .filter((asset) => {
      if (!filters.ward) return true;
      return locationById[asset.locationId]?.ward === filters.ward;
    });

  const searched = search
    ? assets.filter((asset) => {
        const category = categoryById[asset.categoryId];
        const location = locationById[asset.locationId];
        return [asset.publicId, asset.name, asset.publicDescription, category?.label, location?.ward, location?.locality, location?.landmark]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(search);
      })
    : assets;

  const publicAssets = searched
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
    .map((asset) => buildPublicAsset(storage, asset));
  const paged = paginate(publicAssets, { page: filters.page, pageSize: filters.pageSize });
  const visibleAssetIds = new Set(searched.map((asset) => asset.id));
  const verifiedRepairs = publicAssets.reduce((total, asset) => total + (asset.repairCount || 0), 0);

  const byCategory = {};
  const byCondition = {};
  const byStatus = {};
  for (const asset of searched) {
    byCategory[asset.categoryId] = (byCategory[asset.categoryId] || 0) + 1;
    byCondition[asset.condition] = (byCondition[asset.condition] || 0) + 1;
    byStatus[asset.status] = (byStatus[asset.status] || 0) + 1;
  }

  return {
    ...paged,
    items: paged.items,
    summary: {
      totalAssets: searched.length,
      byCategory: Object.entries(byCategory).map(([id, count]) => ({
        categoryId: id,
        label: categoryById[id]?.label || id,
        count,
      })),
      byCondition: Object.entries(byCondition).map(([condition, count]) => ({
        condition,
        label: ASSET_CONDITION_LABELS[condition] || condition,
        count,
      })),
      byStatus: Object.entries(byStatus).map(([status, count]) => ({
        status,
        label: ASSET_STATUS_LABELS[status] || status,
        count,
      })),
      openFaults: readAssetCollection(storage, ASSET_STORAGE_KEYS.reports).filter(
        (report) =>
          visibleAssetIds.has(report.assetId) &&
          [FAULT_REPORT_STATES.SUBMITTED, FAULT_REPORT_STATES.TRIAGED, FAULT_REPORT_STATES.CONVERTED].includes(report.state)
      ).length,
      verifiedRepairs,
    },
    freshness: freshness(storage),
    generatedAt: nowIso(),
    source: 'Municipal public asset register — demonstration dataset',
  };
};

export const getPublicAssetByQrToken = (rawToken, filters = {}, storage = getAssetStorage()) => {
  assertAssetCapability('asset.public.read', null, { allowAnonymous: true });
  ensureAssetRegistryData({ storage });
  const { asset } = resolvePublicQrAsset(storage, rawToken, { forReport: false });
  const publicAsset = buildPublicAsset(storage, asset, { includeHistory: filters.includeHistory !== false });
  return {
    ...publicAsset,
    tag: { status: 'active', resolvedAt: nowIso() },
    canReportFault: [ASSET_STATUS.ACTIVE, ASSET_STATUS.SUSPENDED].includes(asset.status),
  };
};

export const getPublicAssetByPublicId = (publicId, filters = {}, storage = getAssetStorage()) => {
  assertAssetCapability('asset.public.read', null, { allowAnonymous: true });
  ensureAssetRegistryData({ storage });
  const asset = findAssetByPublicId(readAssetCollection(storage, ASSET_STORAGE_KEYS.assets), sanitizePlain(publicId || '', { max: 40 }));
  if (!asset || asset.isPubliclyListed === false || asset.status === ASSET_STATUS.ARCHIVED) {
    throw createAssetError(ASSET_ERROR_CODES.NOT_FOUND);
  }
  return {
    ...buildPublicAsset(storage, asset, { includeHistory: filters.includeHistory !== false }),
    canReportFault: [ASSET_STATUS.ACTIVE, ASSET_STATUS.SUSPENDED].includes(asset.status),
  };
};

export const getFaultReportStatus = (publicReference, storage = getAssetStorage()) => {
  assertAssetCapability('asset.public.read', null, { allowAnonymous: true });
  ensureAssetRegistryData({ storage });
  const reference = sanitizePlain(publicReference || '', { max: 40, multiline: false }).toUpperCase();
  const report = readAssetCollection(storage, ASSET_STORAGE_KEYS.reports).find((item) => item.publicReference === reference);
  if (!report) throw createAssetError(ASSET_ERROR_CODES.NOT_FOUND, 'No report matches that reference.');
  return publicReportView(report);
};

export const listStaffAssets = (filters = {}, storage = getAssetStorage()) => {
  assertAssetCapability('asset.staff.read');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const categories = readAssetCollection(storage, ASSET_STORAGE_KEYS.categories);
  const locations = readAssetCollection(storage, ASSET_STORAGE_KEYS.locations);
  const categoryById = Object.fromEntries(categories.map((category) => [category.id, category]));
  const locationById = Object.fromEntries(locations.map((location) => [location.id, location]));
  const search = normalizeSearch(filters.search || '');
  const nowMs = Number.isFinite(filters.nowMs) ? filters.nowMs : Date.now();

  let assets = scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.assets), scoped)
    .filter((asset) => (filters.jurisdictionId ? asset.jurisdictionId === filters.jurisdictionId : true))
    .filter((asset) => (filters.categoryId ? asset.categoryId === filters.categoryId : true))
    .filter((asset) => (filters.status ? asset.status === filters.status : true))
    .filter((asset) => (filters.condition ? asset.condition === filters.condition : true))
    .filter((asset) => {
      if (!filters.ward) return true;
      return locationById[asset.locationId]?.ward === filters.ward;
    });

  if (search) {
    assets = assets.filter((asset) => {
      const category = categoryById[asset.categoryId];
      const location = locationById[asset.locationId];
      return [asset.publicId, asset.name, asset.publicDescription, asset.internalNotes, category?.label, location?.ward, location?.locality, location?.landmark]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search);
    });
  }

  if (filters.inspectionDue && filters.inspectionDue !== 'all') {
    assets = assets.filter((asset) => {
      const timing = inspectionTiming(asset.inspectionDueAt, nowMs);
      if (filters.inspectionDue === 'overdue') return timing.isOverdue;
      if (filters.inspectionDue === 'due_30') return timing.daysUntilDue !== null && timing.daysUntilDue <= 30;
      if (filters.inspectionDue === 'unscheduled') return timing.status === 'unscheduled';
      return true;
    });
  }

  const sorted = [...assets].sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
  const paged = paginate(sorted, { page: filters.page, pageSize: filters.pageSize });
  return {
    ...paged,
    items: paged.items.map((asset) => staffAssetView(asset, storage, nowMs)),
    filters: { ...filters },
    freshness: freshness(storage),
    generatedAt: nowIso(nowMs),
  };
};

export const getStaffAsset = (assetId, storage = getAssetStorage()) => {
  assertAssetCapability('asset.staff.read');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const asset = requireAssetRecord({ get: (key) => readAssetCollection(storage, key) }, assetId, scoped);
  const inspections = readAssetCollection(storage, ASSET_STORAGE_KEYS.inspections).filter((item) => item.assetId === asset.id);
  const reports = readAssetCollection(storage, ASSET_STORAGE_KEYS.reports).filter((item) => item.assetId === asset.id);
  const orders = readAssetCollection(storage, ASSET_STORAGE_KEYS.workOrders).filter((item) => item.assetId === asset.id);
  const repairs = readAssetCollection(storage, ASSET_STORAGE_KEYS.repairEvents).filter((item) => item.assetId === asset.id);
  const evidence = readAssetCollection(storage, ASSET_STORAGE_KEYS.evidence).filter((item) => item.assetId === asset.id);
  return {
    asset: staffAssetView(asset, storage),
    inspections: inspections.map(staffInspectionView),
    faultReports: reports.map(staffReportView),
    workOrders: orders.map((order) => staffWorkOrderView(order, storage)),
    repairEvents: repairs,
    evidence,
    publicHistory: buildPublicAsset(storage, asset, { includeHistory: true }),
  };
};

export const getAssetRegistrySummary = (storage = getAssetStorage()) => {
  assertAssetCapability('asset.staff.read');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const assets = scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.assets), scoped);
  const reports = scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.reports), scoped);
  const orders = scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.workOrders), scoped);
  const inspections = scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.inspections), scoped);
  const triage = scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.triage), scoped);
  const nowMs = Date.now();
  const byStatus = Object.fromEntries(Object.values(ASSET_STATUS).map((status) => [status, 0]));
  const byCondition = Object.fromEntries(Object.values(ASSET_CONDITIONS).map((condition) => [condition, 0]));
  for (const asset of assets) {
    byStatus[asset.status] = (byStatus[asset.status] || 0) + 1;
    byCondition[asset.condition] = (byCondition[asset.condition] || 0) + 1;
  }
  return {
    totalAssets: assets.length,
    byStatus,
    byCondition,
    suspendedAssets: assets.filter((asset) => asset.status === ASSET_STATUS.SUSPENDED).length,
    overdueInspections: assets.filter((asset) => inspectionTiming(asset.inspectionDueAt, nowMs).isOverdue).length,
    upcomingInspections: assets.filter((asset) => {
      const timing = inspectionTiming(asset.inspectionDueAt, nowMs);
      return !timing.isOverdue && timing.daysUntilDue !== null && timing.daysUntilDue <= ASSET_API_LIMITS.inspectionReminderDays;
    }).length,
    openWorkOrders: orders.filter((order) => ![WORK_ORDER_STATES.VERIFIED, WORK_ORDER_STATES.CANCELLED].includes(order.state)).length,
    overdueWorkOrders: orders.filter(
      (order) => ![WORK_ORDER_STATES.VERIFIED, WORK_ORDER_STATES.CANCELLED].includes(order.state) && order.dueAt && Date.parse(order.dueAt) < nowMs
    ).length,
    pendingFaultReports: reports.filter((report) => [FAULT_REPORT_STATES.SUBMITTED, FAULT_REPORT_STATES.TRIAGED].includes(report.state)).length,
    pendingInspectionVerification: inspections.filter((inspection) => inspection.state === INSPECTION_STATES.COMPLETED).length,
    pendingTriageReview: triage.filter((item) => item.decision === TRIAGE_DECISIONS.PENDING).length,
    qrTokens: readAssetCollection(storage, ASSET_STORAGE_KEYS.qrTokens).filter((token) => {
      if (token.jurisdictionId && scoped !== null && !scoped.includes(token.jurisdictionId)) return false;
      return token.state === QR_TOKEN_STATES.ACTIVE;
    }).length,
    freshness: freshness(storage),
    indexes: buildAssetRegistryIndexes(storage).manifest,
    generatedAt: nowIso(nowMs),
  };
};

export const getAssetInspectionReminders = (filters = {}, storage = getAssetStorage()) => {
  assertAssetCapability('asset.staff.read');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const nowMs = Number.isFinite(filters.nowMs) ? filters.nowMs : Date.now();
  const withinDays = Math.max(0, Math.min(365, Number(filters.dueWithinDays ?? ASSET_API_LIMITS.inspectionReminderDays)));
  const reminders = scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.assets), scoped)
    .filter((asset) => ![ASSET_STATUS.RETIRED, ASSET_STATUS.ARCHIVED].includes(asset.status))
    .filter((asset) => (filters.jurisdictionId ? asset.jurisdictionId === filters.jurisdictionId : true))
    .map((asset) => ({
      assetId: asset.id,
      publicId: asset.publicId,
      name: asset.name,
      jurisdictionId: asset.jurisdictionId,
      condition: asset.condition,
      conditionLabel: ASSET_CONDITION_LABELS[asset.condition] || asset.condition,
      inspectionDueAt: asset.inspectionDueAt,
      lastInspectionAt: asset.lastInspectionAt,
      timing: inspectionTiming(asset.inspectionDueAt, nowMs),
    }))
    .filter((item) => item.timing.isOverdue || (item.timing.daysUntilDue !== null && item.timing.daysUntilDue <= withinDays))
    .sort((a, b) => Date.parse(a.inspectionDueAt || '9999-12-31') - Date.parse(b.inspectionDueAt || '9999-12-31'));
  return {
    overdue: reminders.filter((item) => item.timing.isOverdue),
    upcoming: reminders.filter((item) => !item.timing.isOverdue),
    dueWithinDays: withinDays,
    generatedAt: nowIso(nowMs),
  };
};

export const getAssetAuditTrail = (filters = {}, storage = getAssetStorage()) => {
  assertAssetCapability('audit.read');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  let events = scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.audit), scoped)
    .filter((event) => (filters.action ? event.action === filters.action : true))
    .filter((event) => (filters.entityType ? event.entityType === filters.entityType : true))
    .filter((event) => (filters.entityId ? event.entityId === filters.entityId : true))
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const paged = paginate(events, { page: filters.page, pageSize: filters.pageSize });
  const all = readAssetCollection(storage, ASSET_STORAGE_KEYS.audit);
  return {
    ...paged,
    items: paged.items,
    chain: verifyAssetAuditChain(all),
    generatedAt: nowIso(),
  };
};

export const getAssetErrorMessage = (error) =>
  error?.userMessage || ASSET_ERROR_MESSAGES[error?.code] || 'The asset registry could not complete that action. Please retry.';

export const getAssetPublicReport = (publicReference, storage = getAssetStorage()) =>
  getFaultReportStatus(publicReference, storage);

export const getAssetQrPath = (rawToken) => `/public-assets/tag/${encodeURIComponent(rawToken)}`;

export const buildDemoQrPath = (rawToken) => getAssetQrPath(rawToken);

// Keep these aliases available for pages that import a single service module.
export const getPublicAssetHistory = getPublicAssetByQrToken;
export const getAssetFreshness = freshness;
export const getAssetRegistryIndexes = buildAssetRegistryIndexes;
