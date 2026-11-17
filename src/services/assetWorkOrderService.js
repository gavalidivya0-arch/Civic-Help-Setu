/**
 * Work orders, repair completion, append-only repair events and retention
 * (#750).
 *
 * Completion requires closure notes and at least one validated image. A
 * reviewer verifies the work; only then does the linked citizen report become
 * resolved. Repair events are created once and are never edited.
 */

import { getCurrentActor } from './accessControl';
import { assertAssetCapability, assertAssetJurisdiction, getScopedJurisdictions } from './assetAccessControl';
import {
  ASSET_API_LIMITS,
  ASSET_AUDIT_ACTIONS,
  ASSET_CONDITIONS,
  ASSET_ERROR_CODES,
  ASSET_REGISTRY_SCHEMA_VERSION,
  ASSET_STATUS,
  ASSET_STORAGE_KEYS,
  FAULT_REPORT_STATES,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_STATES,
  WORK_ORDER_TYPES,
  allowedNextStates,
  canTransition,
} from './assetRegistryConstants';
import {
  appendAssetAuditEvent,
  checkAssetIdempotency,
  currentAssetIdentity,
  ensureAssetRegistryData,
  findAssetById,
  normalizeAssetIdempotencyKey,
  readAssetCollection,
  repairPublicCode,
  requireAssetRecord,
  requireReportRecord,
  requireWorkOrderRecord,
  saveAssetIdempotency,
  scopeAssetRecords,
  staffWorkOrderView,
  workOrderPublicCode,
} from './assetRegistryCore';
import {
  changeSummary,
  cloneJson,
  createAssetError,
  getAssetStorage,
  hashToken,
  newAssetId,
  normalizeSearch,
  nowIso,
  optionalIsoDate,
  optionalString,
  paginate,
  requireEnum,
  requireNumberRange,
  requireString,
  runAssetTransaction,
  sanitizePlain,
  sanitizePublicNarrative,
  validateEvidenceAttachments,
} from './assetRegistryValidation';

void allowedNextStates;

const storeWorkOrderEvidence = (draft, { order, attachments, actor, jurisdictionId }) => {
  const validated = validateEvidenceAttachments(attachments, { max: ASSET_API_LIMITS.maxEvidencePerOrder });
  if (validated.length === 0) return [];
  const collection = Array.isArray(draft.get(ASSET_STORAGE_KEYS.evidence)) ? draft.get(ASSET_STORAGE_KEYS.evidence) : [];
  const stored = validated.map((attachment) => ({
    ...attachment,
    entityType: 'WorkOrder',
    entityId: order.id,
    assetId: order.assetId,
    jurisdictionId,
    uploadedBy: actor.id,
    accessScope: 'staff_and_approved_public',
  }));
  draft.set(ASSET_STORAGE_KEYS.evidence, collection.concat(stored));
  return stored.map((item) => item.id);
};

export const createWorkOrder = (
  input = {},
  { storage = getAssetStorage(), idempotencyKey = null, nowMs = Date.now() } = {}
) => {
  const role = assertAssetCapability('order.manage');
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const key = normalizeAssetIdempotencyKey(idempotencyKey);
  const replayed = checkAssetIdempotency(storage, actor, key, 'create_work_order', input);
  if (replayed) return replayed;

  const result = runAssetTransaction(
    storage,
    [
      ASSET_STORAGE_KEYS.workOrders,
      ASSET_STORAGE_KEYS.assets,
      ASSET_STORAGE_KEYS.reports,
      ASSET_STORAGE_KEYS.inspections,
      ASSET_STORAGE_KEYS.audit,
      ASSET_STORAGE_KEYS.idempotency,
    ],
    (draft, context) => {
      const now = context.now;
      const assetId = requireString(input.assetId, 'assetId', { min: 2, max: 80 });
      const asset = requireAssetRecord(draft, assetId, scoped);
      assertAssetJurisdiction(getCurrentActor(), asset.jurisdictionId);
      if ([ASSET_STATUS.RETIRED, ASSET_STATUS.ARCHIVED].includes(asset.status)) {
        throw createAssetError(ASSET_ERROR_CODES.CONFLICT, 'A retired asset cannot receive a new work order.');
      }
      const title = requireString(input.title, 'title', { min: 5, max: 120 });
      const description = sanitizePublicNarrative(
        requireString(input.description, 'description', { min: 10, max: ASSET_API_LIMITS.maxDescriptionLength, multiline: true }),
        { max: ASSET_API_LIMITS.maxDescriptionLength, multiline: true }
      );
      const type = requireEnum(input.type || WORK_ORDER_TYPES.REPAIR, WORK_ORDER_TYPES, 'type');
      const priority = requireEnum(input.priority || WORK_ORDER_PRIORITIES.MEDIUM, WORK_ORDER_PRIORITIES, 'priority');
      const dueAt = optionalIsoDate(input.dueAt, 'dueAt', { nowMs });
      const assignedTo = optionalString(input.assignedTo, 'assignedTo', { max: 120 });
      const assignedTeam = optionalString(input.assignedTeam, 'assignedTeam', { max: 120 });
      const internalNotes = optionalString(input.internalNotes, 'internalNotes', {
        max: ASSET_API_LIMITS.maxNotesLength,
        multiline: true,
      });

      let faultReport = null;
      if (input.faultReportId) {
        faultReport = requireReportRecord(draft, input.faultReportId, scoped);
        if (faultReport.assetId !== asset.id) {
          throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, 'The fault report belongs to a different asset.', {
            fieldErrors: { faultReportId: 'Choose a report for the same asset.' },
          });
        }
        if (faultReport.state !== FAULT_REPORT_STATES.TRIAGED) {
          throw createAssetError(ASSET_ERROR_CODES.INVALID_TRANSITION, 'Triage the fault report before creating a work order.', {
            details: { from: faultReport.state, allowed: [FAULT_REPORT_STATES.TRIAGED] },
          });
        }
      }
      let inspection = null;
      if (input.inspectionId) {
        inspection = findAssetById(draft.get(ASSET_STORAGE_KEYS.inspections) || [], input.inspectionId);
        if (!inspection || inspection.assetId !== asset.id) {
          throw createAssetError(ASSET_ERROR_CODES.NOT_FOUND, 'The linked inspection was not found for this asset.', {
            fieldErrors: { inspectionId: 'Choose an inspection for the same asset.' },
          });
        }
        if (scoped !== null && !scoped.includes(inspection.jurisdictionId)) {
          throw createAssetError(ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN);
        }
      }

      const orders = draft.get(ASSET_STORAGE_KEYS.workOrders) || [];
      const order = {
        id: newAssetId('wo'),
        publicReference: workOrderPublicCode(orders, asset.jurisdictionId),
        assetId: asset.id,
        jurisdictionId: asset.jurisdictionId,
        faultReportId: faultReport?.id || null,
        inspectionId: inspection?.id || null,
        type,
        priority,
        state: assignedTo || assignedTeam ? WORK_ORDER_STATES.ASSIGNED : WORK_ORDER_STATES.DRAFT,
        title,
        description,
        assignedTo,
        assignedTeam,
        internalNotes,
        dueAt,
        startedAt: null,
        completedAt: null,
        completedBy: null,
        closureSummary: '',
        evidenceIds: [],
        verifiedBy: null,
        verifiedAt: null,
        cancelledAt: null,
        cancelReason: '',
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
        schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
      };
      orders.push(order);
      draft.set(ASSET_STORAGE_KEYS.workOrders, orders);

      if (faultReport) {
        if (!canTransition('report', faultReport.state, FAULT_REPORT_STATES.CONVERTED)) {
          throw createAssetError(ASSET_ERROR_CODES.INVALID_TRANSITION, 'The report cannot be converted to a work order from its current state.');
        }
        const reportCandidate = {
          ...faultReport,
          state: FAULT_REPORT_STATES.CONVERTED,
          workOrderId: order.id,
          updatedAt: now,
        };
        draft.set(
          ASSET_STORAGE_KEYS.reports,
          (draft.get(ASSET_STORAGE_KEYS.reports) || []).map((item) => (item.id === faultReport.id ? reportCandidate : item))
        );
        appendAssetAuditEvent(draft, {
          action: ASSET_AUDIT_ACTIONS.REPORT_CONVERTED,
          entityType: 'FaultReport',
          entityId: faultReport.id,
          actor,
          jurisdictionId: asset.jurisdictionId,
          reason: 'Work order raised for the citizen report',
          details: { workOrderReference: order.publicReference, assetPublicId: asset.publicId },
          createdAt: now,
        });
      }

      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.WORK_ORDER_CREATED,
        entityType: 'WorkOrder',
        entityId: order.id,
        actor,
        jurisdictionId: asset.jurisdictionId,
        reason: input.reason || 'Work order created',
        details: { publicReference: order.publicReference, assetPublicId: asset.publicId, priority, type },
        createdAt: now,
      });
      const response = { workOrder: staffWorkOrderView(order, storage), replayed: false };
      saveAssetIdempotency(draft, actor, key, 'create_work_order', input, response);
      return response;
    }
  );
  return { ...result, role };
};

export const updateWorkOrder = (
  workOrderId,
  updates = {},
  { storage = getAssetStorage(), idempotencyKey = null, nowMs = Date.now(), reason = 'Work order updated' } = {}
) => {
  const role = assertAssetCapability('order.manage');
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const key = normalizeAssetIdempotencyKey(idempotencyKey);
  const replayed = checkAssetIdempotency(storage, actor, key, 'update_work_order', { workOrderId, updates, reason });
  if (replayed) return replayed;

  const result = runAssetTransaction(
    storage,
    [ASSET_STORAGE_KEYS.workOrders, ASSET_STORAGE_KEYS.audit, ASSET_STORAGE_KEYS.idempotency],
    (draft, context) => {
      const now = context.now;
      const order = requireWorkOrderRecord(draft, workOrderId, scoped);
      assertAssetJurisdiction(getCurrentActor(), order.jurisdictionId);
      if (![WORK_ORDER_STATES.DRAFT, WORK_ORDER_STATES.ASSIGNED, WORK_ORDER_STATES.IN_PROGRESS, WORK_ORDER_STATES.BLOCKED].includes(order.state)) {
        throw createAssetError(ASSET_ERROR_CODES.INVALID_TRANSITION, `A ${order.state} work order cannot be edited.`, {
          details: { from: order.state, allowed: [WORK_ORDER_STATES.DRAFT, WORK_ORDER_STATES.ASSIGNED, WORK_ORDER_STATES.IN_PROGRESS, WORK_ORDER_STATES.BLOCKED] },
        });
      }
      if (updates.state !== undefined) {
        throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, 'Use the transition action to change a work-order state.', {
          fieldErrors: { state: 'Use the transition action instead of editing state.' },
        });
      }
      const before = cloneJson(order);
      const candidate = {
        ...order,
        title: updates.title !== undefined ? requireString(updates.title, 'title', { min: 5, max: 120 }) : order.title,
        description:
          updates.description !== undefined
            ? sanitizePublicNarrative(updates.description, { max: ASSET_API_LIMITS.maxDescriptionLength, multiline: true })
            : order.description,
        type: updates.type !== undefined ? requireEnum(updates.type, WORK_ORDER_TYPES, 'type') : order.type,
        priority: updates.priority !== undefined ? requireEnum(updates.priority, WORK_ORDER_PRIORITIES, 'priority') : order.priority,
        assignedTo: updates.assignedTo !== undefined ? optionalString(updates.assignedTo, 'assignedTo', { max: 120 }) : order.assignedTo,
        assignedTeam: updates.assignedTeam !== undefined ? optionalString(updates.assignedTeam, 'assignedTeam', { max: 120 }) : order.assignedTeam,
        internalNotes:
          updates.internalNotes !== undefined
            ? optionalString(updates.internalNotes, 'internalNotes', { max: ASSET_API_LIMITS.maxNotesLength, multiline: true })
            : order.internalNotes,
        dueAt: updates.dueAt !== undefined ? optionalIsoDate(updates.dueAt, 'dueAt', { nowMs }) : order.dueAt,
        updatedAt: now,
      };
      draft.set(
        ASSET_STORAGE_KEYS.workOrders,
        (draft.get(ASSET_STORAGE_KEYS.workOrders) || []).map((item) => (item.id === order.id ? candidate : item))
      );
      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.WORK_ORDER_UPDATED,
        entityType: 'WorkOrder',
        entityId: order.id,
        actor,
        jurisdictionId: order.jurisdictionId,
        reason,
        changes: changeSummary(before, candidate, ['title', 'description', 'type', 'priority', 'assignedTo', 'assignedTeam', 'internalNotes', 'dueAt']),
        createdAt: now,
      });
      const response = { workOrder: staffWorkOrderView(candidate, storage), replayed: false };
      saveAssetIdempotency(draft, actor, key, 'update_work_order', { workOrderId, updates, reason }, response);
      return response;
    }
  );
  return { ...result, role };
};

export const transitionWorkOrder = (
  workOrderId,
  input = {},
  { storage = getAssetStorage(), idempotencyKey = null } = {}
) => {
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const target = input.to;
  const capability =
    target === WORK_ORDER_STATES.VERIFIED ? 'order.verify' : target === WORK_ORDER_STATES.COMPLETED ? 'order.complete' : 'order.manage';
  const role = assertAssetCapability(capability);
  const key = normalizeAssetIdempotencyKey(idempotencyKey);
  const replayed = checkAssetIdempotency(storage, actor, key, 'transition_work_order', { workOrderId, input });
  if (replayed) return replayed;

  const result = runAssetTransaction(
    storage,
    [
      ASSET_STORAGE_KEYS.workOrders,
      ASSET_STORAGE_KEYS.assets,
      ASSET_STORAGE_KEYS.reports,
      ASSET_STORAGE_KEYS.repairEvents,
      ASSET_STORAGE_KEYS.evidence,
      ASSET_STORAGE_KEYS.audit,
      ASSET_STORAGE_KEYS.idempotency,
    ],
    (draft, context) => {
      const now = context.now;
      const order = requireWorkOrderRecord(draft, workOrderId, scoped);
      assertAssetJurisdiction(getCurrentActor(), order.jurisdictionId);
      const asset = requireAssetRecord(draft, order.assetId, scoped);
      const to = requireEnum(target, WORK_ORDER_STATES, 'to');
      if (to === order.state) {
        throw createAssetError(ASSET_ERROR_CODES.INVALID_TRANSITION, `Work order is already ${to}.`);
      }
      if (!canTransition('workOrder', order.state, to)) {
        throw createAssetError(ASSET_ERROR_CODES.INVALID_TRANSITION, `Cannot move work order from ${order.state} to ${to}.`, {
          details: { from: order.state, to, allowed: allowedNextStates('workOrder', order.state) },
        });
      }

      const updates = { state: to, updatedAt: now };
      let repairEvent = null;
      if (to === WORK_ORDER_STATES.IN_PROGRESS) {
        updates.startedAt = order.startedAt || now;
      }
      if (to === WORK_ORDER_STATES.BLOCKED) {
        updates.blockReason = requireString(input.reason, 'reason', { min: 5, max: ASSET_API_LIMITS.maxReasonLength });
      }
      if (to === WORK_ORDER_STATES.CANCELLED) {
        updates.cancelledAt = now;
        updates.cancelReason = requireString(input.reason, 'reason', { min: 5, max: ASSET_API_LIMITS.maxReasonLength });
      }
      if (to === WORK_ORDER_STATES.COMPLETED) {
        const closureSummary = requireString(input.closureSummary, 'closureSummary', {
          min: 10,
          max: ASSET_API_LIMITS.maxDescriptionLength,
          multiline: true,
        });
        const publicSummary = sanitizePublicNarrative(
          requireString(input.publicSummary, 'publicSummary', { min: 10, max: 600, multiline: true }),
          { max: 600, multiline: true }
        );
        const conditionAfter = requireEnum(input.conditionAfter || asset.condition, ASSET_CONDITIONS, 'conditionAfter');
        const evidenceIds = storeWorkOrderEvidence(draft, {
          order,
          attachments: input.evidence || [],
          actor,
          jurisdictionId: order.jurisdictionId,
        });
        const allEvidence = [...new Set([...(order.evidenceIds || []), ...evidenceIds])];
        if (allEvidence.length === 0) {
          throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, 'Completion requires at least one validated image.', {
            fieldErrors: { evidence: 'Add a JPEG, PNG or WebP photo of the completed repair.' },
          });
        }
        const costInr = input.costInr === undefined ? null : requireNumberRange(input.costInr, 'costInr', 0, 10_000_000);
        const repairs = draft.get(ASSET_STORAGE_KEYS.repairEvents) || [];
        repairEvent = {
          id: newAssetId('repair'),
          publicReference: repairPublicCode(repairs, order.jurisdictionId),
          assetId: order.assetId,
          jurisdictionId: order.jurisdictionId,
          workOrderId: order.id,
          summary: closureSummary,
          publicSummary,
          completedAt: now,
          recordedBy: actor.id,
          verifiedBy: null,
          verifiedAt: null,
          evidenceIds: allEvidence,
          costInr,
          createdAt: now,
          schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
        };
        repairs.push(repairEvent);
        draft.set(ASSET_STORAGE_KEYS.repairEvents, repairs);
        updates.completedAt = now;
        updates.completedBy = actor.id;
        updates.closureSummary = closureSummary;
        updates.publicSummary = publicSummary;
        updates.conditionAfter = conditionAfter;
        updates.evidenceIds = allEvidence;
        updates.repairEventId = repairEvent.id;

        const assetUpdate = {
          ...asset,
          condition: conditionAfter,
          lastRepairAt: now,
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
            reason: 'Completed repair left the asset out of service',
            changes: { status: { before: asset.status, after: ASSET_STATUS.SUSPENDED }, condition: { before: asset.condition, after: conditionAfter } },
            createdAt: now,
          });
        }
        draft.set(
          ASSET_STORAGE_KEYS.assets,
          (draft.get(ASSET_STORAGE_KEYS.assets) || []).map((item) => (item.id === asset.id ? assetUpdate : item))
        );
        appendAssetAuditEvent(draft, {
          action: ASSET_AUDIT_ACTIONS.REPAIR_RECORDED,
          entityType: 'RepairEvent',
          entityId: repairEvent.id,
          actor,
          jurisdictionId: order.jurisdictionId,
          reason: 'Repair completion recorded with evidence',
          details: { publicReference: repairEvent.publicReference, workOrderReference: order.publicReference, evidenceCount: allEvidence.length },
          createdAt: now,
        });
      }

      if (to === WORK_ORDER_STATES.VERIFIED) {
        updates.verifiedBy = actor.id;
        updates.verifiedAt = now;
        updates.verificationNotes = optionalString(input.verificationNotes, 'verificationNotes', {
          max: ASSET_API_LIMITS.maxNotesLength,
          multiline: true,
        });
        // Repair events stay immutable. Verification lives on the work order;
        // the public projection joins the two so history remains append-only.
        const assetUpdate = { ...asset, lastVerifiedRepairAt: now, updatedAt: now };
        if (
          input.reactivateAsset === true &&
          asset.status === ASSET_STATUS.SUSPENDED &&
          [ASSET_CONDITIONS.GOOD, ASSET_CONDITIONS.FAIR].includes(asset.condition)
        ) {
          assetUpdate.status = ASSET_STATUS.ACTIVE;
          assetUpdate.reactivatedAt = now;
          assetUpdate.reactivatedBy = actor.id;
        }
        draft.set(
          ASSET_STORAGE_KEYS.assets,
          (draft.get(ASSET_STORAGE_KEYS.assets) || []).map((item) => (item.id === asset.id ? assetUpdate : item))
        );
        if (order.faultReportId) {
          const reports = draft.get(ASSET_STORAGE_KEYS.reports) || [];
          const report = reports.find((item) => item.id === order.faultReportId);
          if (report && canTransition('report', report.state, FAULT_REPORT_STATES.RESOLVED)) {
            const candidateReport = { ...report, state: FAULT_REPORT_STATES.RESOLVED, resolvedAt: now, updatedAt: now };
            draft.set(
              ASSET_STORAGE_KEYS.reports,
              reports.map((item) => (item.id === report.id ? candidateReport : item))
            );
            appendAssetAuditEvent(draft, {
              action: ASSET_AUDIT_ACTIONS.REPORT_RESOLVED,
              entityType: 'FaultReport',
              entityId: report.id,
              actor,
              jurisdictionId: report.jurisdictionId,
              reason: 'Repair verified; citizen report resolved',
              details: { publicReference: report.publicReference, workOrderReference: order.publicReference },
              createdAt: now,
            });
          }
        }
      }

      const candidate = { ...order, ...updates };
      draft.set(
        ASSET_STORAGE_KEYS.workOrders,
        (draft.get(ASSET_STORAGE_KEYS.workOrders) || []).map((item) => (item.id === order.id ? candidate : item))
      );
      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.WORK_ORDER_TRANSITIONED,
        entityType: 'WorkOrder',
        entityId: order.id,
        actor,
        jurisdictionId: order.jurisdictionId,
        reason: input.reason || `Work order moved to ${to}`,
        changes: { state: { before: order.state, after: to } },
        details: { publicReference: order.publicReference, repairEventId: repairEvent?.id || null },
        createdAt: now,
      });
      const response = {
        workOrder: staffWorkOrderView(candidate, storage),
        repairEvent,
        replayed: false,
      };
      saveAssetIdempotency(draft, actor, key, 'transition_work_order', { workOrderId, input }, response);
      return response;
    }
  );
  return { ...result, role };
};

export const completeWorkOrder = (workOrderId, input = {}, options = {}) =>
  transitionWorkOrder(workOrderId, { ...input, to: WORK_ORDER_STATES.COMPLETED }, options);

export const verifyWorkOrder = (workOrderId, input = {}, options = {}) =>
  transitionWorkOrder(workOrderId, { ...input, to: WORK_ORDER_STATES.VERIFIED }, options);

export const listWorkOrders = (filters = {}, storage = getAssetStorage()) => {
  assertAssetCapability('asset.staff.read');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const search = normalizeSearch(filters.search || '');
  const assets = readAssetCollection(storage, ASSET_STORAGE_KEYS.assets);
  const assetsById = Object.fromEntries(assets.map((asset) => [asset.id, asset]));
  let orders = scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.workOrders), scoped)
    .filter((order) => (filters.state ? order.state === filters.state : true))
    .filter((order) => (filters.type ? order.type === filters.type : true))
    .filter((order) => (filters.priority ? order.priority === filters.priority : true))
    .filter((order) => (filters.assetId ? order.assetId === filters.assetId : true))
    .filter((order) => (filters.jurisdictionId ? order.jurisdictionId === filters.jurisdictionId : true));

  if (search) {
    orders = orders.filter((order) => {
      const asset = assetsById[order.assetId];
      return [order.publicReference, order.title, order.description, order.assignedTeam, asset?.publicId, asset?.name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search);
    });
  }

  const nowMs = Number.isFinite(filters.nowMs) ? filters.nowMs : Date.now();
  orders = orders.sort((a, b) => {
    if (filters.sort === 'due') return Date.parse(a.dueAt || '9999-12-31') - Date.parse(b.dueAt || '9999-12-31');
    return Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0);
  });
  const paged = paginate(orders, { page: filters.page, pageSize: filters.pageSize });
  return {
    ...paged,
    items: paged.items.map((order) => ({
      ...staffWorkOrderView(order, storage),
      asset: assetsById[order.assetId]
        ? { publicId: assetsById[order.assetId].publicId, name: assetsById[order.assetId].name }
        : null,
    })),
    openCount: orders.filter((order) => ![WORK_ORDER_STATES.VERIFIED, WORK_ORDER_STATES.CANCELLED].includes(order.state)).length,
    overdueCount: orders.filter(
      (order) => ![WORK_ORDER_STATES.VERIFIED, WORK_ORDER_STATES.CANCELLED].includes(order.state) && order.dueAt && Date.parse(order.dueAt) < nowMs
    ).length,
    generatedAt: nowIso(nowMs),
  };
};

export const getWorkOrder = (workOrderId, storage = getAssetStorage()) => {
  assertAssetCapability('asset.staff.read');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const order = readAssetCollection(storage, ASSET_STORAGE_KEYS.workOrders).find((item) => item.id === workOrderId);
  if (!order) throw createAssetError(ASSET_ERROR_CODES.NOT_FOUND, 'Work order was not found.');
  if (scoped !== null && !scoped.includes(order.jurisdictionId)) {
    throw createAssetError(ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN);
  }
  return staffWorkOrderView(order, storage);
};

export const listRepairEvents = (filters = {}, storage = getAssetStorage()) => {
  assertAssetCapability('asset.staff.read');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const assetsById = Object.fromEntries(readAssetCollection(storage, ASSET_STORAGE_KEYS.assets).map((asset) => [asset.id, asset]));
  let repairs = scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.repairEvents), scoped)
    .filter((repair) => (filters.assetId ? repair.assetId === filters.assetId : true))
    .filter((repair) => (filters.workOrderId ? repair.workOrderId === filters.workOrderId : true))
    .filter((repair) => (filters.jurisdictionId ? repair.jurisdictionId === filters.jurisdictionId : true))
    .sort((a, b) => Date.parse(b.completedAt || 0) - Date.parse(a.completedAt || 0));
  const paged = paginate(repairs, { page: filters.page, pageSize: filters.pageSize });
  return {
    ...paged,
    items: paged.items.map((repair) => ({
      ...repair,
      asset: assetsById[repair.assetId]
        ? { publicId: assetsById[repair.assetId].publicId, name: assetsById[repair.assetId].name }
        : null,
    })),
    generatedAt: nowIso(),
  };
};

export const applyAssetRetentionPolicy = ({ storage = getAssetStorage(), nowMs = Date.now(), dryRun = false } = {}) => {
  const role = assertAssetCapability('retention.manage');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const cutoff = nowMs - ASSET_API_LIMITS.closedReportRetentionDays * 24 * 60 * 60 * 1000;
  const reports = readAssetCollection(storage, ASSET_STORAGE_KEYS.reports);
  const candidates = reports.filter((report) => {
    if (scoped !== null && !scoped.includes(report.jurisdictionId)) return false;
    if (![FAULT_REPORT_STATES.RESOLVED, FAULT_REPORT_STATES.REJECTED, FAULT_REPORT_STATES.DUPLICATE].includes(report.state)) return false;
    if (report.archivedAt) return false;
    const closedAt = Date.parse(report.resolvedAt || report.reviewedAt || report.updatedAt || report.createdAt || '');
    return Number.isFinite(closedAt) && closedAt < cutoff;
  });
  if (dryRun) {
    return {
      dryRun: true,
      candidates: candidates.length,
      reportIds: candidates.map((report) => report.id),
      retainedWorkOrders: readAssetCollection(storage, ASSET_STORAGE_KEYS.workOrders).length,
      retainedRepairEvents: readAssetCollection(storage, ASSET_STORAGE_KEYS.repairEvents).length,
      cutoff: new Date(cutoff).toISOString(),
      role,
    };
  }

  const result = runAssetTransaction(
    storage,
    [ASSET_STORAGE_KEYS.reports, ASSET_STORAGE_KEYS.evidence, ASSET_STORAGE_KEYS.audit],
    (draft, context) => {
      const now = context.now;
      const currentReports = draft.get(ASSET_STORAGE_KEYS.reports) || [];
      const archivedIds = new Set(candidates.map((report) => report.id));
      const nextReports = currentReports.map((report) =>
        archivedIds.has(report.id)
          ? {
              ...report,
              description: '[Archived after the retention period]',
              reporterKeyHash: null,
              reporterLabel: 'Archived',
              evidenceIds: [],
              archivedAt: now,
              updatedAt: now,
            }
          : report
      );
      draft.set(ASSET_STORAGE_KEYS.reports, nextReports);
      const evidence = draft.get(ASSET_STORAGE_KEYS.evidence) || [];
      const removedEvidence = evidence.filter(
        (item) => item.entityType === 'FaultReport' && archivedIds.has(item.entityId)
      ).length;
      draft.set(
        ASSET_STORAGE_KEYS.evidence,
        evidence.filter((item) => !(item.entityType === 'FaultReport' && archivedIds.has(item.entityId)))
      );
      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.RETENTION_APPLIED,
        entityType: 'AssetRegistry',
        entityId: 'retention',
        actor: { id: 'retention', label: 'Retention policy', role },
        jurisdictionId: null,
        reason: 'Closed citizen reports archived after the retention period',
        details: { reportsArchived: archivedIds.size, evidenceRemoved: removedEvidence, cutoff: new Date(cutoff).toISOString() },
        createdAt: now,
      });
      return { archivedReports: archivedIds.size, evidenceRemoved: removedEvidence, archivedAt: now };
    }
  );
  return { ...result, dryRun: false, cutoff: new Date(cutoff).toISOString(), role };
};

/**
 * Privacy Centre hook: clears the citizen-submitted report content for one
 * device key while retaining the municipal work-order and repair history.
 */
export const clearAssetCitizenData = ({ reporterKey, storage = getAssetStorage(), nowMs = Date.now() } = {}) => {
  ensureAssetRegistryData({ storage });
  const keyHash = hashToken(sanitizePlain(reporterKey || '', { max: 120, multiline: false }));
  const reports = readAssetCollection(storage, ASSET_STORAGE_KEYS.reports);
  const matches = reports.filter((report) => report.reporterKeyHash === keyHash);
  if (matches.length === 0) return { clearedReports: 0, removedEvidence: 0 };
  const result = runAssetTransaction(
    storage,
    [ASSET_STORAGE_KEYS.reports, ASSET_STORAGE_KEYS.evidence, ASSET_STORAGE_KEYS.audit],
    (draft, context) => {
      const ids = new Set(matches.map((report) => report.id));
      const now = context.now;
      const nextReports = (draft.get(ASSET_STORAGE_KEYS.reports) || []).map((report) =>
        ids.has(report.id)
          ? {
              ...report,
              description: '[Cleared at citizen request]',
              reporterKeyHash: null,
              reporterLabel: 'Cleared at citizen request',
              evidenceIds: [],
              clearedAt: now,
              updatedAt: now,
            }
          : report
      );
      draft.set(ASSET_STORAGE_KEYS.reports, nextReports);
      const evidence = draft.get(ASSET_STORAGE_KEYS.evidence) || [];
      const removedEvidence = evidence.filter((item) => item.entityType === 'FaultReport' && ids.has(item.entityId)).length;
      draft.set(
        ASSET_STORAGE_KEYS.evidence,
        evidence.filter((item) => !(item.entityType === 'FaultReport' && ids.has(item.entityId)))
      );
      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.RETENTION_APPLIED,
        entityType: 'AssetRegistry',
        entityId: 'citizen-clear',
        actor: { id: 'privacy-centre', label: 'Privacy Centre', role: 'citizen' },
        jurisdictionId: null,
        reason: 'Citizen requested deletion of report content',
        details: { clearedReports: ids.size, removedEvidence, requestedAt: nowIso(nowMs) },
        createdAt: now,
      });
      return { clearedReports: ids.size, removedEvidence };
    }
  );
  return result;
};

void sanitizePlain;
void hashToken;
void ASSET_API_LIMITS;
