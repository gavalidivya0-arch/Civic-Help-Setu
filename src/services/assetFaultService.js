/**
 * Citizen fault reports and explainable triage (#750).
 *
 * QR tokens are lookup keys only. Submitting a report never grants staff
 * access, and the automated suggestion can only be accepted, edited or
 * rejected by an authorised person.
 */

import { getCurrentActor } from './accessControl';
import { actorIdentity, assertAssetCapability, assertAssetJurisdiction, getScopedJurisdictions } from './assetAccessControl';
import {
  ASSET_API_LIMITS,
  ASSET_AUDIT_ACTIONS,
  ASSET_ERROR_CODES,
  ASSET_REGISTRY_SCHEMA_VERSION,
  ASSET_STATUS,
  ASSET_STORAGE_KEYS,
  FAULT_CATEGORIES,
  FAULT_REPORT_STATES,
  REPORT_SEVERITIES,
  TRIAGE_DECISIONS,
  WORK_ORDER_PRIORITIES,
  allowedNextStates,
  canTransition,
} from './assetRegistryConstants';
import {
  appendAssetAuditEvent,
  checkAssetIdempotency,
  currentAssetIdentity,
  ensureAssetRegistryData,
  faultReportReference,
  findAssetByPublicId,
  findAssetById,
  normalizeAssetIdempotencyKey,
  publicReportView,
  readAssetCollection,
  requireReportRecord,
  saveAssetIdempotency,
  scopeAssetRecords,
  staffReportView,
} from './assetRegistryCore';
import {
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
  requireString,
  runAssetTransaction,
  sanitizePlain,
  sanitizePublicNarrative,
  validateEvidenceAttachments,
} from './assetRegistryValidation';
import { analyzeFaultTriage } from './assetTriageService';

void allowedNextStates;
void canTransition;

const enforceReportRateLimit = (draft, reporterKeyHash, nowMs) => {
  const current = draft.get(ASSET_STORAGE_KEYS.rateLimit);
  const store = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const history = Array.isArray(store[reporterKeyHash]) ? store[reporterKeyHash] : [];
  const active = history.filter(
    (timestamp) => Number.isFinite(timestamp) && timestamp <= nowMs && nowMs - timestamp < ASSET_API_LIMITS.reportRateWindowMs
  );
  if (active.length >= ASSET_API_LIMITS.reportRateLimit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((Math.min(...active) + ASSET_API_LIMITS.reportRateWindowMs - nowMs) / 1000)
    );
    throw createAssetError(ASSET_ERROR_CODES.RATE_LIMITED, 'Citizen report rate limit reached.', {
      details: { retryAfterSeconds },
      userMessage: `Too many reports from this device. Try again in ${retryAfterSeconds} seconds.`,
    });
  }
  active.push(nowMs);
  store[reporterKeyHash] = active;
  draft.set(ASSET_STORAGE_KEYS.rateLimit, store);
};

const storeReportEvidence = (draft, { reportId, assetId, jurisdictionId, attachments, actor, reporterLabel }) => {
  const validated = validateEvidenceAttachments(attachments, { max: ASSET_API_LIMITS.maxAttachmentsPerReport });
  if (validated.length === 0) return [];
  const collection = Array.isArray(draft.get(ASSET_STORAGE_KEYS.evidence)) ? draft.get(ASSET_STORAGE_KEYS.evidence) : [];
  const stored = validated.map((attachment) => ({
    ...attachment,
    entityType: 'FaultReport',
    entityId: reportId,
    assetId,
    jurisdictionId,
    uploadedBy: actor.id,
    reporterLabel,
    accessScope: 'staff_only',
  }));
  draft.set(ASSET_STORAGE_KEYS.evidence, collection.concat(stored));
  return stored.map((item) => item.id);
};

const findQrAssetInDraft = (draft, rawToken, nowMs) => {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const token = (draft.get(ASSET_STORAGE_KEYS.qrTokens) || []).find((item) => item.tokenHash === tokenHash);
  if (!token || token.state !== 'active') {
    throw createAssetError(ASSET_ERROR_CODES.QR_INVALID);
  }
  if (token.expiresAt && Date.parse(token.expiresAt) <= nowMs) {
    throw createAssetError(ASSET_ERROR_CODES.QR_INVALID);
  }
  const asset = findAssetById(draft.get(ASSET_STORAGE_KEYS.assets) || [], token.assetId);
  if (!asset || asset.isPubliclyListed === false || asset.status === ASSET_STATUS.ARCHIVED) {
    throw createAssetError(ASSET_ERROR_CODES.QR_INVALID);
  }
  if (![ASSET_STATUS.ACTIVE, ASSET_STATUS.SUSPENDED].includes(asset.status)) {
    throw createAssetError(ASSET_ERROR_CODES.QR_INVALID, 'This asset is retired and cannot receive new reports.');
  }
  return asset;
};

export const submitFaultReport = (
  input = {},
  { storage = getAssetStorage(), idempotencyKey = null, reporterKey = null, nowMs = Date.now() } = {}
) => {
  assertAssetCapability('report.submit', getCurrentActor(), { allowAnonymous: true });
  ensureAssetRegistryData({ storage });
  const signedIn = currentAssetIdentityOrNull();
  const rawReporterKey = sanitizePlain(reporterKey || input.reporterKey || signedIn?.id || 'anonymous_device', {
    max: 120,
    multiline: false,
  });
  const reporterKeyHash = hashToken(rawReporterKey);
  const idemActor = signedIn || { id: `anonymous:${reporterKeyHash.slice(0, 12)}`, label: 'Anonymous resident', role: 'citizen' };
  const key = normalizeAssetIdempotencyKey(idempotencyKey);
  const replayed = checkAssetIdempotency(storage, idemActor, key, 'submit_fault_report', input);
  if (replayed) return replayed;

  const result = runAssetTransaction(
    storage,
    [
      ASSET_STORAGE_KEYS.reports,
      ASSET_STORAGE_KEYS.assets,
      ASSET_STORAGE_KEYS.qrTokens,
      ASSET_STORAGE_KEYS.evidence,
      ASSET_STORAGE_KEYS.triage,
      ASSET_STORAGE_KEYS.rateLimit,
      ASSET_STORAGE_KEYS.audit,
      ASSET_STORAGE_KEYS.idempotency,
    ],
    (draft, context) => {
      const now = context.now;
      const qrToken = sanitizePlain(input.qrToken || '', { max: 160, multiline: false });
      const publicId = sanitizePlain(input.assetPublicId || '', { max: 40, multiline: false });
      let asset = null;
      if (qrToken) {
        asset = findQrAssetInDraft(draft, qrToken, nowMs);
      } else if (publicId) {
        asset = findAssetByPublicId(draft.get(ASSET_STORAGE_KEYS.assets) || [], publicId);
        if (!asset || asset.isPubliclyListed === false || ![ASSET_STATUS.ACTIVE, ASSET_STATUS.SUSPENDED].includes(asset.status)) {
          throw createAssetError(ASSET_ERROR_CODES.NOT_FOUND, 'The selected public asset could not be found.');
        }
      } else {
        throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, 'Scan an asset tag or choose a public asset.', {
          fieldErrors: { asset: 'Scan the QR tag on the asset or choose it from the public register.' },
        });
      }

      const category = requireEnum(input.category, FAULT_CATEGORIES, 'category');
      const severity = requireEnum(input.severity || REPORT_SEVERITIES.MINOR, REPORT_SEVERITIES, 'severity');
      const description = sanitizePublicNarrative(
        requireString(input.description, 'description', {
          min: 20,
          max: ASSET_API_LIMITS.maxDescriptionLength,
          multiline: true,
        }),
        { max: ASSET_API_LIMITS.maxDescriptionLength, multiline: true }
      );
      if (description.length < 20) {
        throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, 'Describe the issue in at least 20 characters.', {
          fieldErrors: { description: 'Describe what you can see in at least 20 characters.' },
        });
      }

      enforceReportRateLimit(draft, reporterKeyHash, nowMs);
      const reports = draft.get(ASSET_STORAGE_KEYS.reports) || [];
      const duplicate = reports.find(
        (report) =>
          report.reporterKeyHash === reporterKeyHash &&
          report.assetId === asset.id &&
          report.category === category &&
          report.description === description &&
          ![FAULT_REPORT_STATES.REJECTED, FAULT_REPORT_STATES.DUPLICATE].includes(report.state) &&
          nowMs - Date.parse(report.createdAt || '') < ASSET_API_LIMITS.duplicateReportCooldownMs
      );
      if (duplicate) {
        const response = {
          duplicate: true,
          publicReport: publicReportView(duplicate),
          message: 'This report is already in the municipal queue. Use the existing reference to follow it.',
        };
        saveAssetIdempotency(draft, idemActor, key, 'submit_fault_report', input, response);
        return response;
      }

      const reportId = newAssetId('report');
      const evidenceIds = storeReportEvidence(draft, {
        reportId,
        assetId: asset.id,
        jurisdictionId: asset.jurisdictionId,
        attachments: input.evidence || input.attachments || [],
        actor: idemActor,
        reporterLabel: signedIn ? signedIn.label : 'Resident (not verified)',
      });
      const report = {
        id: reportId,
        publicReference: faultReportReference(reports),
        assetId: asset.id,
        jurisdictionId: asset.jurisdictionId,
        category,
        severity,
        description,
        state: FAULT_REPORT_STATES.SUBMITTED,
        reporterKeyHash,
        reporterLabel: signedIn ? signedIn.label : 'Resident (not verified)',
        evidenceIds,
        priority: null,
        assignedTeam: '',
        triageNotes: '',
        workOrderId: null,
        resolvedAt: null,
        reviewedBy: null,
        reviewedAt: null,
        reviewReason: '',
        createdAt: now,
        updatedAt: now,
        schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
      };

      const suggestionBase = analyzeFaultTriage({ report, asset });
      const suggestion = {
        id: newAssetId('triage'),
        reportId: report.id,
        assetId: asset.id,
        jurisdictionId: asset.jurisdictionId,
        ...suggestionBase,
        executedAt: now,
        decision: TRIAGE_DECISIONS.PENDING,
        decidedBy: null,
        decidedAt: null,
        decisionReason: '',
        editedPriority: null,
        createdAt: now,
        schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
      };
      report.triageSuggestionId = suggestion.id;
      reports.push(report);
      draft.set(ASSET_STORAGE_KEYS.reports, reports);
      const triage = draft.get(ASSET_STORAGE_KEYS.triage) || [];
      triage.push(suggestion);
      draft.set(ASSET_STORAGE_KEYS.triage, triage);

      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.REPORT_SUBMITTED,
        entityType: 'FaultReport',
        entityId: report.id,
        actor: idemActor,
        jurisdictionId: asset.jurisdictionId,
        reason: 'Citizen fault report submitted',
        details: { publicReference: report.publicReference, category, assetPublicId: asset.publicId },
        createdAt: now,
      });
      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.TRIAGE_SUGGESTED,
        entityType: 'FaultReport',
        entityId: report.id,
        actor: idemActor,
        jurisdictionId: asset.jurisdictionId,
        reason: 'Deterministic triage suggestion recorded',
        details: {
          suggestionId: suggestion.id,
          rulesetVersion: suggestion.rulesetVersion,
          suggestedPriority: suggestion.suggestedPriority,
          confidence: suggestion.confidence,
        },
        createdAt: now,
      });

      const response = {
        duplicate: false,
        publicReport: publicReportView(report),
        message: 'Report received. Keep the public reference to follow its status.',
      };
      saveAssetIdempotency(draft, idemActor, key, 'submit_fault_report', input, response);
      return response;
    }
  );
  return { ...result, role: 'citizen' };
};

const currentAssetIdentityOrNull = () => actorIdentity(getCurrentActor());

export const listFaultReports = (filters = {}, storage = getAssetStorage()) => {
  assertAssetCapability('asset.staff.read');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const search = normalizeSearch(filters.search || '');
  const assets = readAssetCollection(storage, ASSET_STORAGE_KEYS.assets);
  const assetsById = Object.fromEntries(assets.map((asset) => [asset.id, asset]));
  const triage = readAssetCollection(storage, ASSET_STORAGE_KEYS.triage);
  let reports = scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.reports), scoped)
    .filter((report) => (filters.state ? report.state === filters.state : true))
    .filter((report) => (filters.category ? report.category === filters.category : true))
    .filter((report) => (filters.assetId ? report.assetId === filters.assetId : true))
    .filter((report) => (filters.jurisdictionId ? report.jurisdictionId === filters.jurisdictionId : true));

  if (search) {
    reports = reports.filter((report) => {
      const asset = assetsById[report.assetId];
      return [report.publicReference, report.description, report.category, asset?.publicId, asset?.name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search);
    });
  }
  reports = reports.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const paged = paginate(reports, { page: filters.page, pageSize: filters.pageSize });
  return {
    ...paged,
    items: paged.items.map((report) => ({
      ...staffReportView(report),
      asset: assetsById[report.assetId]
        ? { publicId: assetsById[report.assetId].publicId, name: assetsById[report.assetId].name }
        : null,
      triageSuggestion: (() => {
        const items = triage.filter((item) => item.reportId === report.id);
        return items.length ? items.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))[0] : null;
      })(),
    })),
    pendingCount: reports.filter((report) => [FAULT_REPORT_STATES.SUBMITTED, FAULT_REPORT_STATES.TRIAGED].includes(report.state)).length,
    generatedAt: nowIso(),
  };
};

export const triageFaultReport = (
  reportId,
  input = {},
  { storage = getAssetStorage(), idempotencyKey = null, nowMs = Date.now() } = {}
) => {
  const role = assertAssetCapability('report.triage');
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const key = normalizeAssetIdempotencyKey(idempotencyKey);
  const replayed = checkAssetIdempotency(storage, actor, key, 'triage_report', { reportId, input });
  if (replayed) return replayed;

  const result = runAssetTransaction(
    storage,
    [ASSET_STORAGE_KEYS.reports, ASSET_STORAGE_KEYS.audit, ASSET_STORAGE_KEYS.idempotency],
    (draft, context) => {
      const now = context.now;
      const report = requireReportRecord(draft, reportId, scoped);
      assertAssetJurisdiction(getCurrentActor(), report.jurisdictionId);
      if (report.state !== FAULT_REPORT_STATES.SUBMITTED) {
        throw createAssetError(ASSET_ERROR_CODES.INVALID_TRANSITION, `Only a submitted report can be triaged; this one is ${report.state}.`, {
          details: { from: report.state, allowed: [FAULT_REPORT_STATES.SUBMITTED] },
        });
      }
      const priority = requireEnum(input.priority, WORK_ORDER_PRIORITIES, 'priority');
      const assignedTeam = optionalString(input.assignedTeam, 'assignedTeam', { max: 120 });
      const triageNotes = optionalString(input.triageNotes, 'triageNotes', {
        max: ASSET_API_LIMITS.maxNotesLength,
        multiline: true,
      });
      const dueAt = optionalIsoDate(input.dueAt, 'dueAt', { nowMs });
      const candidate = {
        ...report,
        state: FAULT_REPORT_STATES.TRIAGED,
        priority,
        assignedTeam,
        triageNotes,
        triageDueAt: dueAt,
        triagedBy: actor.id,
        triagedAt: now,
        updatedAt: now,
      };
      draft.set(
        ASSET_STORAGE_KEYS.reports,
        (draft.get(ASSET_STORAGE_KEYS.reports) || []).map((item) => (item.id === report.id ? candidate : item))
      );
      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.REPORT_TRIAGED,
        entityType: 'FaultReport',
        entityId: report.id,
        actor,
        jurisdictionId: report.jurisdictionId,
        reason: input.reason || 'Citizen report triaged',
        changes: { state: { before: report.state, after: candidate.state }, priority: { before: report.priority, after: priority } },
        details: { publicReference: report.publicReference, assignedTeam },
        createdAt: now,
      });
      const response = { report: staffReportView(candidate), replayed: false };
      saveAssetIdempotency(draft, actor, key, 'triage_report', { reportId, input }, response);
      return response;
    }
  );
  return { ...result, role };
};

export const reviewFaultReport = (
  reportId,
  input = {},
  { storage = getAssetStorage(), idempotencyKey = null } = {}
) => {
  const role = assertAssetCapability('report.review');
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const key = normalizeAssetIdempotencyKey(idempotencyKey);
  const replayed = checkAssetIdempotency(storage, actor, key, 'review_report', { reportId, input });
  if (replayed) return replayed;

  const result = runAssetTransaction(
    storage,
    [ASSET_STORAGE_KEYS.reports, ASSET_STORAGE_KEYS.audit, ASSET_STORAGE_KEYS.idempotency],
    (draft, context) => {
      const now = context.now;
      const report = requireReportRecord(draft, reportId, scoped);
      assertAssetJurisdiction(getCurrentActor(), report.jurisdictionId);
      const decision = requireEnum(input.decision, { REJECTED: FAULT_REPORT_STATES.REJECTED, DUPLICATE: FAULT_REPORT_STATES.DUPLICATE }, 'decision');
      const reason = requireString(input.reason, 'reason', { min: 5, max: ASSET_API_LIMITS.maxReasonLength });
      if (!canTransition('report', report.state, decision)) {
        throw createAssetError(ASSET_ERROR_CODES.INVALID_TRANSITION, `Cannot move report from ${report.state} to ${decision}.`, {
          details: { from: report.state, to: decision, allowed: allowedNextStates('report', report.state) },
        });
      }
      let duplicateOf = null;
      if (decision === FAULT_REPORT_STATES.DUPLICATE && input.duplicateOfReference) {
        duplicateOf = (draft.get(ASSET_STORAGE_KEYS.reports) || []).find(
          (item) => item.publicReference === sanitizePlain(input.duplicateOfReference, { max: 40 }).toUpperCase() && item.assetId === report.assetId && item.id !== report.id
        );
        if (!duplicateOf) {
          throw createAssetError(ASSET_ERROR_CODES.NOT_FOUND, 'The linked duplicate report was not found for this asset.', {
            fieldErrors: { duplicateOfReference: 'Choose an existing report for the same asset.' },
          });
        }
      }
      const candidate = {
        ...report,
        state: decision,
        reviewedBy: actor.id,
        reviewedAt: now,
        reviewReason: reason,
        duplicateOfReference: duplicateOf?.publicReference || null,
        updatedAt: now,
      };
      draft.set(
        ASSET_STORAGE_KEYS.reports,
        (draft.get(ASSET_STORAGE_KEYS.reports) || []).map((item) => (item.id === report.id ? candidate : item))
      );
      appendAssetAuditEvent(draft, {
        action: decision === FAULT_REPORT_STATES.DUPLICATE ? ASSET_AUDIT_ACTIONS.REPORT_DUPLICATE : ASSET_AUDIT_ACTIONS.REPORT_REJECTED,
        entityType: 'FaultReport',
        entityId: report.id,
        actor,
        jurisdictionId: report.jurisdictionId,
        reason,
        details: { publicReference: report.publicReference, duplicateOfReference: candidate.duplicateOfReference },
        createdAt: now,
      });
      const response = { report: staffReportView(candidate), replayed: false };
      saveAssetIdempotency(draft, actor, key, 'review_report', { reportId, input }, response);
      return response;
    }
  );
  return { ...result, role };
};

export const listTriageSuggestions = (filters = {}, storage = getAssetStorage()) => {
  assertAssetCapability('asset.staff.read');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const reports = readAssetCollection(storage, ASSET_STORAGE_KEYS.reports);
  const reportsById = Object.fromEntries(reports.map((report) => [report.id, report]));
  const assets = readAssetCollection(storage, ASSET_STORAGE_KEYS.assets);
  const assetsById = Object.fromEntries(assets.map((asset) => [asset.id, asset]));
  let suggestions = scopeAssetRecords(readAssetCollection(storage, ASSET_STORAGE_KEYS.triage), scoped)
    .filter((suggestion) => (filters.decision ? suggestion.decision === filters.decision : true))
    .filter((suggestion) => (filters.reportId ? suggestion.reportId === filters.reportId : true))
    .filter((suggestion) => (filters.assetId ? suggestion.assetId === filters.assetId : true))
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const paged = paginate(suggestions, { page: filters.page, pageSize: filters.pageSize });
  return {
    ...paged,
    items: paged.items.map((suggestion) => {
      const report = reportsById[suggestion.reportId];
      const asset = assetsById[suggestion.assetId];
      return {
        ...suggestion,
        report: report ? staffReportView(report) : null,
        asset: asset ? { publicId: asset.publicId, name: asset.name } : null,
      };
    }),
    pendingCount: suggestions.filter((suggestion) => suggestion.decision === TRIAGE_DECISIONS.PENDING).length,
    generatedAt: nowIso(),
  };
};

export const reviewTriageSuggestion = (
  suggestionId,
  input = {},
  { storage = getAssetStorage(), idempotencyKey = null } = {}
) => {
  const role = assertAssetCapability('triage.review');
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const key = normalizeAssetIdempotencyKey(idempotencyKey);
  const replayed = checkAssetIdempotency(storage, actor, key, 'review_triage', { suggestionId, input });
  if (replayed) return replayed;

  const result = runAssetTransaction(
    storage,
    [
      ASSET_STORAGE_KEYS.triage,
      ASSET_STORAGE_KEYS.reports,
      ASSET_STORAGE_KEYS.audit,
      ASSET_STORAGE_KEYS.idempotency,
    ],
    (draft, context) => {
      const now = context.now;
      const triage = draft.get(ASSET_STORAGE_KEYS.triage) || [];
      const suggestion = triage.find((item) => item.id === suggestionId);
      if (!suggestion) throw createAssetError(ASSET_ERROR_CODES.NOT_FOUND, 'Triage suggestion was not found.');
      if (scoped !== null && !scoped.includes(suggestion.jurisdictionId)) {
        throw createAssetError(ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN);
      }
      assertAssetJurisdiction(getCurrentActor(), suggestion.jurisdictionId);
      if (suggestion.decision !== TRIAGE_DECISIONS.PENDING) {
        throw createAssetError(ASSET_ERROR_CODES.INVALID_TRANSITION, `This suggestion was already ${suggestion.decision}.`, {
          details: { from: suggestion.decision, allowed: [TRIAGE_DECISIONS.PENDING] },
        });
      }
      const decision = requireEnum(input.decision, TRIAGE_DECISIONS, 'decision');
      if (decision === TRIAGE_DECISIONS.PENDING) {
        throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, 'Choose accepted, edited or rejected.');
      }
      const editedPriority =
        decision === TRIAGE_DECISIONS.EDITED ? requireEnum(input.editedPriority, WORK_ORDER_PRIORITIES, 'editedPriority') : null;
      const reason = optionalString(input.reason, 'reason', { max: ASSET_API_LIMITS.maxReasonLength, multiline: false });
      if (decision === TRIAGE_DECISIONS.REJECTED && reason.length < 5) {
        throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, 'Give a short reason for rejecting the suggestion.', {
          fieldErrors: { reason: 'Explain why the suggestion was rejected.' },
        });
      }
      const report = requireReportRecord(draft, suggestion.reportId, scoped);
      const chosenPriority =
        decision === TRIAGE_DECISIONS.ACCEPTED
          ? suggestion.suggestedPriority
          : decision === TRIAGE_DECISIONS.EDITED
            ? editedPriority
            : report.priority;
      const suggestionCandidate = {
        ...suggestion,
        decision,
        decidedBy: actor.id,
        decidedAt: now,
        decisionReason: reason,
        editedPriority,
        appliedPriority: chosenPriority,
      };
      draft.set(
        ASSET_STORAGE_KEYS.triage,
        triage.map((item) => (item.id === suggestion.id ? suggestionCandidate : item))
      );
      const reportCandidate = {
        ...report,
        priority: chosenPriority || report.priority,
        triageSuggestionDecision: decision,
        updatedAt: now,
      };
      draft.set(
        ASSET_STORAGE_KEYS.reports,
        (draft.get(ASSET_STORAGE_KEYS.reports) || []).map((item) => (item.id === report.id ? reportCandidate : item))
      );
      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.TRIAGE_REVIEWED,
        entityType: 'TriageSuggestion',
        entityId: suggestion.id,
        actor,
        jurisdictionId: suggestion.jurisdictionId,
        reason: reason || `Suggestion ${decision}`,
        details: {
          reportReference: report.publicReference,
          decision,
          suggestedPriority: suggestion.suggestedPriority,
          appliedPriority: chosenPriority,
          rulesetVersion: suggestion.rulesetVersion,
        },
        createdAt: now,
      });
      const response = {
        suggestion: suggestionCandidate,
        report: staffReportView(reportCandidate),
        replayed: false,
      };
      saveAssetIdempotency(draft, actor, key, 'review_triage', { suggestionId, input }, response);
      return response;
    }
  );
  return { ...result, role };
};

export { getFaultReportStatus } from './assetRegistryCore';
