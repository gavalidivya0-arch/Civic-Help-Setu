/**
 * Inspection scheduling and verification for the public asset registry (#750).
 *
 * A completed inspection can only become public after a reviewer verifies it.
 * Verification is the only path that changes the asset's public condition and
 * inspection due date, so an unverified field note cannot silently rewrite the
 * register.
 */

import { getCurrentActor } from './accessControl';
import { assertAssetCapability, assertAssetJurisdiction, getScopedJurisdictions } from './assetAccessControl';
import {
  ASSET_API_LIMITS,
  ASSET_AUDIT_ACTIONS,
  ASSET_CONDITIONS,
  ASSET_CONDITION_LABELS,
  ASSET_ERROR_CODES,
  ASSET_REGISTRY_SCHEMA_VERSION,
  ASSET_STATUS,
  ASSET_STORAGE_KEYS,
  INSPECTION_STATES,
  INSPECTION_STATE_LABELS,
  INSPECTION_TYPES,
  allowedNextStates,
  canTransition,
} from './assetRegistryConstants';
import {
  appendAssetAuditEvent,
  assetSequenceId,
  checkAssetIdempotency,
  currentAssetIdentity,
  ensureAssetRegistryData,
  findAssetById,
  inspectionPublicCode,
  normalizeAssetIdempotencyKey,
  readAssetCollection,
  requireAssetRecord,
  requireInspectionRecord,
  saveAssetIdempotency,
  scopeAssetRecords,
  staffInspectionView,
} from './assetRegistryCore';
import {
  createAssetError,
  getAssetStorage,
  newAssetId,
  normalizeSearch,
  optionalString,
  paginate,
  requireEnum,
  requireIsoDate,
  requireString,
  runAssetTransaction,
  sanitizePlain,
  validateEvidenceAttachments,
} from './assetRegistryValidation';

void assetSequenceId;
void ASSET_CONDITION_LABELS;
void INSPECTION_STATE_LABELS;
void allowedNextStates;

const storeInspectionEvidence = (draft, { inspection, attachments, actor, jurisdictionId }) => {
  const validated = validateEvidenceAttachments(attachments, { max: ASSET_API_LIMITS.maxEvidencePerOrder });
  if (validated.length === 0) return [];
  const collection = Array.isArray(draft.get(ASSET_STORAGE_KEYS.evidence)) ? draft.get(ASSET_STORAGE_KEYS.evidence) : [];
  const stored = validated.map((attachment) => ({
    ...attachment,
    entityType: 'AssetInspection',
    entityId: inspection.id,
    assetId: inspection.assetId,
    jurisdictionId,
    uploadedBy: actor.id,
    accessScope: 'staff_only',
  }));
  draft.set(ASSET_STORAGE_KEYS.evidence, collection.concat(stored));
  return stored.map((item) => item.id);
};

const assertInspectionTransition = (from, to) => {
  if (!canTransition('inspection', from, to)) {
    throw createAssetError(ASSET_ERROR_CODES.INVALID_TRANSITION, `Cannot move inspection from ${from} to ${to}.`, {
      details: { from, to, allowed: allowedNextStates('inspection', from) },
    });
  }
};

export const scheduleInspection = (
  input = {},
  { storage = getAssetStorage(), idempotencyKey = null, nowMs = Date.now() } = {}
) => {
  const role = assertAssetCapability('inspection.schedule');
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const key = normalizeAssetIdempotencyKey(idempotencyKey);
  const replayed = checkAssetIdempotency(storage, actor, key, 'schedule_inspection', input);
  if (replayed) return replayed;

  const result = runAssetTransaction(
    storage,
    [ASSET_STORAGE_KEYS.inspections, ASSET_STORAGE_KEYS.assets, ASSET_STORAGE_KEYS.audit, ASSET_STORAGE_KEYS.idempotency],
    (draft, context) => {
      const now = context.now;
      const assetId = requireString(input.assetId, 'assetId', { min: 2, max: 80 });
      const asset = requireAssetRecord(draft, assetId, scoped);
      assertAssetJurisdiction(getCurrentActor(), asset.jurisdictionId);
      if ([ASSET_STATUS.RETIRED, ASSET_STATUS.ARCHIVED].includes(asset.status)) {
        throw createAssetError(ASSET_ERROR_CODES.CONFLICT, 'A retired asset cannot receive a new inspection.');
      }
      const type = requireEnum(input.type || INSPECTION_TYPES.ROUTINE, INSPECTION_TYPES, 'type');
      const scheduledFor = requireIsoDate(input.scheduledFor || now, 'scheduledFor', { nowMs });
      const internalNotes = optionalString(input.internalNotes, 'internalNotes', {
        max: ASSET_API_LIMITS.maxNotesLength,
        multiline: true,
      });
      const inspections = draft.get(ASSET_STORAGE_KEYS.inspections) || [];
      const inspection = {
        id: newAssetId('insp'),
        publicId: inspectionPublicCode(inspections, asset.jurisdictionId),
        assetId: asset.id,
        jurisdictionId: asset.jurisdictionId,
        type,
        state: INSPECTION_STATES.SCHEDULED,
        scheduledFor,
        startedAt: null,
        completedAt: null,
        completedBy: null,
        conditionAfter: null,
        findings: '',
        internalNotes,
        evidenceIds: [],
        verifiedBy: null,
        verifiedAt: null,
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
        schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
      };
      inspections.push(inspection);
      draft.set(ASSET_STORAGE_KEYS.inspections, inspections);
      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.INSPECTION_SCHEDULED,
        entityType: 'AssetInspection',
        entityId: inspection.id,
        actor,
        jurisdictionId: asset.jurisdictionId,
        reason: input.reason || 'Inspection scheduled',
        details: { assetPublicId: asset.publicId, type, scheduledFor },
        createdAt: now,
      });
      const response = { inspection: staffInspectionView(inspection), replayed: false };
      saveAssetIdempotency(draft, actor, key, 'schedule_inspection', input, response);
      return response;
    }
  );
  return { ...result, role };
};

export const transitionInspection = (
  inspectionId,
  input = {},
  { storage = getAssetStorage(), idempotencyKey = null, nowMs = Date.now() } = {}
) => {
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const key = normalizeAssetIdempotencyKey(idempotencyKey);

  const inspectionPreview = readAssetCollection(storage, ASSET_STORAGE_KEYS.inspections).find((item) => item.id === inspectionId);
  if (!inspectionPreview) throw createAssetError(ASSET_ERROR_CODES.NOT_FOUND, 'Inspection was not found.');
  const target = input.to;
  const capability =
    target === INSPECTION_STATES.VERIFIED ? 'inspection.verify' : 'inspection.complete';
  const role = assertAssetCapability(capability);
  const replayed = checkAssetIdempotency(storage, actor, key, 'transition_inspection', { inspectionId, input });
  if (replayed) return replayed;

  const result = runAssetTransaction(
    storage,
    [
      ASSET_STORAGE_KEYS.inspections,
      ASSET_STORAGE_KEYS.assets,
      ASSET_STORAGE_KEYS.evidence,
      ASSET_STORAGE_KEYS.audit,
      ASSET_STORAGE_KEYS.idempotency,
    ],
    (draft, context) => {
      const now = context.now;
      const inspection = requireInspectionRecord(draft, inspectionId, scoped);
      assertAssetJurisdiction(getCurrentActor(), inspection.jurisdictionId);
      const asset = requireAssetRecord(draft, inspection.assetId, scoped);
      const to = requireEnum(target, INSPECTION_STATES, 'to');
      if (to === inspection.state) {
        throw createAssetError(ASSET_ERROR_CODES.INVALID_TRANSITION, `Inspection is already ${to}.`);
      }
      assertInspectionTransition(inspection.state, to);
      const before = { ...inspection };
      const updates = { state: to, updatedAt: now };

      if (to === INSPECTION_STATES.IN_PROGRESS) {
        updates.startedAt = inspection.startedAt || now;
      }
      if (to === INSPECTION_STATES.COMPLETED) {
        updates.findings = requireString(input.findings, 'findings', { min: 10, max: ASSET_API_LIMITS.maxDescriptionLength, multiline: true });
        updates.conditionAfter = requireEnum(input.conditionAfter, ASSET_CONDITIONS, 'conditionAfter');
        updates.completedAt = now;
        updates.completedBy = actor.id;
        updates.evidenceIds = storeInspectionEvidence(draft, {
          inspection,
          attachments: input.evidence || [],
          actor,
          jurisdictionId: inspection.jurisdictionId,
        });
      }
      if (to === INSPECTION_STATES.VERIFIED) {
        if (inspection.state !== INSPECTION_STATES.COMPLETED) {
          throw createAssetError(ASSET_ERROR_CODES.INVALID_TRANSITION, 'Only a completed inspection can be verified.');
        }
        updates.verifiedBy = actor.id;
        updates.verifiedAt = now;
        updates.verificationNotes = optionalString(input.verificationNotes, 'verificationNotes', { max: 500, multiline: true });
        const conditionAfter = inspection.conditionAfter || ASSET_CONDITIONS.UNKNOWN;
        const interval =
          asset.inspectionIntervalDays ||
          ASSET_API_LIMITS.defaultInspectionIntervalDays;
        const assetUpdate = {
          ...asset,
          condition: conditionAfter,
          lastInspectionAt: inspection.completedAt || now,
          inspectionDueAt: new Date(nowMs + interval * 24 * 60 * 60 * 1000).toISOString(),
          updatedAt: now,
        };
        if (conditionAfter === ASSET_CONDITIONS.OUT_OF_SERVICE && asset.status === ASSET_STATUS.ACTIVE) {
          assetUpdate.status = ASSET_STATUS.SUSPENDED;
          assetUpdate.suspendedAt = now;
          assetUpdate.suspendedBy = actor.id;
          appendAssetAuditEvent(draft, {
            action: ASSET_AUDIT_ACTIONS.ASSET_STATUS_CHANGED,
            entityType: 'Asset',
            entityId: asset.id,
            actor,
            jurisdictionId: asset.jurisdictionId,
            reason: 'Verified inspection found an unsafe condition',
            changes: { status: { before: asset.status, after: ASSET_STATUS.SUSPENDED }, condition: { before: asset.condition, after: conditionAfter } },
            createdAt: now,
          });
        }
        if (
          input.reactivateAsset === true &&
          asset.status === ASSET_STATUS.SUSPENDED &&
          [ASSET_CONDITIONS.GOOD, ASSET_CONDITIONS.FAIR].includes(conditionAfter)
        ) {
          assetUpdate.status = ASSET_STATUS.ACTIVE;
          assetUpdate.reactivatedAt = now;
          assetUpdate.reactivatedBy = actor.id;
        }
        draft.set(
          ASSET_STORAGE_KEYS.assets,
          (draft.get(ASSET_STORAGE_KEYS.assets) || []).map((item) => (item.id === asset.id ? assetUpdate : item))
        );
        appendAssetAuditEvent(draft, {
          action: ASSET_AUDIT_ACTIONS.INSPECTION_VERIFIED,
          entityType: 'AssetInspection',
          entityId: inspection.id,
          actor,
          jurisdictionId: inspection.jurisdictionId,
          reason: input.reason || 'Inspection verified',
          details: { assetPublicId: asset.publicId, conditionAfter, reactivated: assetUpdate.status === ASSET_STATUS.ACTIVE },
          createdAt: now,
        });
      }
      if ([INSPECTION_STATES.MISSED, INSPECTION_STATES.CANCELLED].includes(to)) {
        updates.reason = requireString(input.reason, 'reason', { min: 5, max: ASSET_API_LIMITS.maxReasonLength });
      }

      const candidate = { ...inspection, ...updates };
      draft.set(
        ASSET_STORAGE_KEYS.inspections,
        (draft.get(ASSET_STORAGE_KEYS.inspections) || []).map((item) => (item.id === inspection.id ? candidate : item))
      );
      if (to !== INSPECTION_STATES.VERIFIED) {
        appendAssetAuditEvent(draft, {
          action:
            to === INSPECTION_STATES.COMPLETED
              ? ASSET_AUDIT_ACTIONS.INSPECTION_COMPLETED
              : ASSET_AUDIT_ACTIONS.INSPECTION_TRANSITIONED,
          entityType: 'AssetInspection',
          entityId: inspection.id,
          actor,
          jurisdictionId: inspection.jurisdictionId,
          reason: input.reason || `Inspection moved to ${to}`,
          changes: { state: { before: before.state, after: to } },
          createdAt: now,
        });
      }
      const response = { inspection: staffInspectionView(candidate), replayed: false };
      saveAssetIdempotency(draft, actor, key, 'transition_inspection', { inspectionId, input }, response);
      return response;
    }
  );
  return { ...result, role };
};

export const completeInspection = (inspectionId, input = {}, options = {}) =>
  transitionInspection(inspectionId, { ...input, to: INSPECTION_STATES.COMPLETED }, options);

export const verifyInspection = (inspectionId, input = {}, options = {}) =>
  transitionInspection(inspectionId, { ...input, to: INSPECTION_STATES.VERIFIED }, options);

export const startInspection = (inspectionId, input = {}, options = {}) =>
  transitionInspection(inspectionId, { ...input, to: INSPECTION_STATES.IN_PROGRESS }, options);

export const listAssetInspections = (filters = {}, storage = getAssetStorage()) => {
  assertAssetCapability('asset.staff.read');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const search = normalizeSearch(filters.search || '');
  const assets = readAssetCollection(storage, ASSET_STORAGE_KEYS.assets);
  const assetsById = Object.fromEntries(assets.map((asset) => [asset.id, asset]));
  let inspections = scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.inspections), scoped)
    .filter((inspection) => (filters.state ? inspection.state === filters.state : true))
    .filter((inspection) => (filters.type ? inspection.type === filters.type : true))
    .filter((inspection) => (filters.assetId ? inspection.assetId === filters.assetId : true))
    .filter((inspection) => (filters.jurisdictionId ? inspection.jurisdictionId === filters.jurisdictionId : true));

  if (search) {
    inspections = inspections.filter((inspection) => {
      const asset = assetsById[inspection.assetId];
      return [inspection.publicId, asset?.publicId, asset?.name, inspection.findings, inspection.internalNotes]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search);
    });
  }
  inspections = inspections.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const paged = paginate(inspections, { page: filters.page, pageSize: filters.pageSize });
  return {
    ...paged,
    items: paged.items.map((inspection) => ({
      ...staffInspectionView(inspection),
      asset: assetsById[inspection.assetId]
        ? { publicId: assetsById[inspection.assetId].publicId, name: assetsById[inspection.assetId].name }
        : null,
    })),
    pendingVerification: inspections.filter((inspection) => inspection.state === INSPECTION_STATES.COMPLETED).length,
    generatedAt: new Date().toISOString(),
  };
};

export const getAssetInspection = (inspectionId, storage = getAssetStorage()) => {
  assertAssetCapability('asset.staff.read');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const inspection = readAssetCollection(storage, ASSET_STORAGE_KEYS.inspections).find((item) => item.id === inspectionId);
  if (!inspection) throw createAssetError(ASSET_ERROR_CODES.NOT_FOUND, 'Inspection was not found.');
  if (scoped !== null && !scoped.includes(inspection.jurisdictionId)) {
    throw createAssetError(ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN);
  }
  return staffInspectionView(inspection);
};

void findAssetById;
void sanitizePlain;
