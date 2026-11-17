/**
 * Asset lifecycle, QR tags and short-lived staff action tokens (#750).
 *
 * Every function re-checks role, jurisdiction and state before writing.
 * QR tags are lookup keys only; possession never grants a staff action.
 */

import { getCurrentActor } from './accessControl';
import {
  assertAssetCapability,
  assertAssetJurisdiction,
  getScopedJurisdictions,
} from './assetAccessControl';
import {
  ASSET_API_LIMITS,
  ASSET_AUDIT_ACTIONS,
  ASSET_CONDITIONS,
  ASSET_ERROR_CODES,
  ASSET_REGISTRY_SCHEMA_VERSION,
  ASSET_STATUS,
  ASSET_STORAGE_KEYS,
  QR_TOKEN_STATES,
  QR_TOKEN_STATE_LABELS,
} from './assetRegistryConstants';
import {
  appendAssetAuditEvent,
  assetPublicCode,
  categoryFor,
  checkAssetIdempotency,
  currentAssetIdentity,
  ensureAssetRegistryData,
  getAssetQrPath,
  getScopedJurisdictions as getScopedFromCore,
  locationFor,
  normalizeAssetIdempotencyKey,
  publicAssetView,
  readAssetCollection,
  requireAssetJurisdictionDefinition,
  requireAssetRecord,
  saveAssetIdempotency,
  staffAssetView,
} from './assetRegistryCore';
import {
  changeSummary,
  cloneJson,
  createAssetError,
  decodeTokenPayload,
  encodeTokenPayload,
  generateOpaqueToken,
  getAssetStorage,
  hashToken,
  isOpaqueToken,
  newAssetId,
  normalizeSearch,
  optionalIsoDate,
  optionalString,
  requireEnum,
  requireIsoDate,
  requireNumberRange,
  requireString,
  runAssetTransaction,
  sanitizePlain,
  sanitizePublicNarrative,
  signActionPayload,
  tokenPrefix,
} from './assetRegistryValidation';

void getScopedFromCore;

const ACTION_CAPABILITY = Object.freeze({
  inspect: 'inspection.complete',
  complete_inspection: 'inspection.complete',
  triage_report: 'report.triage',
  create_work_order: 'order.manage',
  verify_work_order: 'order.verify',
  retire_asset: 'asset.retire',
});

const ACTION_VALUES = Object.freeze(Object.keys(ACTION_CAPABILITY));

const getActionSecret = (storage) => {
  const meta = readAssetCollection(storage, ASSET_STORAGE_KEYS.meta);
  void meta;
  const metaValue = (() => {
    try {
      const raw = storage?.getItem(ASSET_STORAGE_KEYS.meta);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })();
  if (!metaValue?.staffActionSecret) {
    throw createAssetError(ASSET_ERROR_CODES.STORAGE_ERROR, 'The staff action signing key is missing. Reload the registry.');
  }
  return metaValue.staffActionSecret;
};

const qrTokenStaffView = (token) => ({
  id: token.id,
  tokenPrefix: token.tokenPrefix,
  state: token.state,
  stateLabel: QR_TOKEN_STATE_LABELS[token.state] || token.state,
  issuedBy: token.issuedBy,
  issuedAt: token.issuedAt,
  expiresAt: token.expiresAt,
  revokedBy: token.revokedBy,
  revokedAt: token.revokedAt,
  revokeReason: token.revokeReason,
});

const findAssetDuplicate = (assets, candidate) => {
  const name = normalizeSearch(candidate.name);
  return (
    assets.find(
      (asset) =>
        asset.id !== candidate.id &&
        asset.jurisdictionId === candidate.jurisdictionId &&
        asset.categoryId === candidate.categoryId &&
        asset.locationId === candidate.locationId &&
        normalizeSearch(asset.name) === name &&
        asset.status !== ASSET_STATUS.ARCHIVED
    ) || null
  );
};

export const createAsset = (
  input = {},
  { storage = getAssetStorage(), idempotencyKey = null, nowMs = Date.now() } = {}
) => {
  const role = assertAssetCapability('asset.create');
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  const key = normalizeAssetIdempotencyKey(idempotencyKey);
  const replayed = checkAssetIdempotency(storage, actor, key, 'create_asset', input);
  if (replayed) return replayed;

  const result = runAssetTransaction(
    storage,
    [
      ASSET_STORAGE_KEYS.assets,
      ASSET_STORAGE_KEYS.categories,
      ASSET_STORAGE_KEYS.locations,
      ASSET_STORAGE_KEYS.qrTokens,
      ASSET_STORAGE_KEYS.audit,
      ASSET_STORAGE_KEYS.idempotency,
    ],
    (draft, context) => {
      const now = context.now;
      const jurisdictionId = sanitizePlain(input.jurisdictionId || actor.jurisdictions[0] || '', {
        max: 40,
        multiline: false,
      });
      if (!jurisdictionId) {
        throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, 'A jurisdiction is required.', {
          fieldErrors: { jurisdictionId: 'Choose a municipal jurisdiction.' },
        });
      }
      assertAssetJurisdiction(getCurrentActor(), jurisdictionId);
      requireAssetJurisdictionDefinition(jurisdictionId);

      const categoryId = requireString(input.categoryId, 'categoryId', { min: 2, max: 80 });
      const category = (draft.get(ASSET_STORAGE_KEYS.categories) || []).find((item) => item.id === categoryId);
      if (!category) {
        throw createAssetError(ASSET_ERROR_CODES.REFERENCE_NOT_FOUND, `Unknown asset category: ${categoryId}.`, {
          fieldErrors: { categoryId: 'Choose a category from the municipal catalogue.' },
        });
      }
      const locationId = requireString(input.locationId, 'locationId', { min: 2, max: 80 });
      const location = (draft.get(ASSET_STORAGE_KEYS.locations) || []).find((item) => item.id === locationId);
      if (!location) {
        throw createAssetError(ASSET_ERROR_CODES.REFERENCE_NOT_FOUND, `Unknown asset location: ${locationId}.`, {
          fieldErrors: { locationId: 'Choose an existing municipal location.' },
        });
      }
      if (location.jurisdictionId !== jurisdictionId) {
        throw createAssetError(ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN, 'Location belongs to another jurisdiction.', {
          fieldErrors: { locationId: 'Choose a location in the selected jurisdiction.' },
        });
      }

      const name = requireString(input.name, 'name', { min: 4, max: ASSET_API_LIMITS.maxNameLength });
      const publicDescription = sanitizePublicNarrative(
        optionalString(input.publicDescription, 'publicDescription', { max: ASSET_API_LIMITS.maxDescriptionLength, multiline: true }),
        { max: ASSET_API_LIMITS.maxDescriptionLength, multiline: true }
      );
      const internalNotes = optionalString(input.internalNotes, 'internalNotes', {
        max: ASSET_API_LIMITS.maxNotesLength,
        multiline: true,
      });
      const condition = requireEnum(input.condition || ASSET_CONDITIONS.UNKNOWN, ASSET_CONDITIONS, 'condition');
      const installedOn = optionalIsoDate(input.installedOn, 'installedOn', { notFuture: true, nowMs });
      const interval = requireNumberRange(
        input.inspectionIntervalDays ?? category.inspectionIntervalDays ?? ASSET_API_LIMITS.defaultInspectionIntervalDays,
        'inspectionIntervalDays',
        ASSET_API_LIMITS.minInspectionIntervalDays,
        ASSET_API_LIMITS.maxInspectionIntervalDays
      );
      const isPubliclyListed = input.isPubliclyListed !== false;
      const assets = draft.get(ASSET_STORAGE_KEYS.assets) || [];
      const candidate = {
        id: newAssetId('asset'),
        publicId: assetPublicCode(assets, jurisdictionId),
        jurisdictionId,
        categoryId,
        locationId,
        name,
        publicDescription,
        internalNotes,
        condition,
        status: ASSET_STATUS.ACTIVE,
        installedOn,
        lastInspectionAt: null,
        inspectionDueAt: new Date(nowMs + interval * 24 * 60 * 60 * 1000).toISOString(),
        inspectionIntervalDays: interval,
        isPubliclyListed,
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
        schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
      };

      const duplicate = findAssetDuplicate(assets, candidate);
      if (duplicate && !input.duplicateOverrideReason) {
        throw createAssetError(ASSET_ERROR_CODES.CONFLICT, `Possible duplicate of ${duplicate.publicId}.`, {
          details: { duplicatePublicId: duplicate.publicId, duplicateAssetId: duplicate.id },
          userMessage: `A similar asset already exists at this location (${duplicate.publicId}). Add an override reason only if this is a different asset.`,
          fieldErrors: { name: 'A similar asset already exists at this location.' },
        });
      }
      if (duplicate && input.duplicateOverrideReason) {
        const overrideReason = requireString(input.duplicateOverrideReason, 'duplicateOverrideReason', { min: 10, max: 500 });
        appendAssetAuditEvent(draft, {
          action: ASSET_AUDIT_ACTIONS.OVERRIDE_RECORDED,
          entityType: 'Asset',
          entityId: candidate.id,
          actor,
          jurisdictionId,
          reason: overrideReason,
          details: { duplicatePublicId: duplicate.publicId },
          createdAt: now,
        });
      }

      assets.push(candidate);
      draft.set(ASSET_STORAGE_KEYS.assets, assets);

      const rawQrToken = generateOpaqueToken(ASSET_API_LIMITS.qrTokenBytes);
      const qrToken = {
        id: newAssetId('qrt'),
        assetId: candidate.id,
        jurisdictionId,
        tokenHash: hashToken(rawQrToken),
        tokenPrefix: tokenPrefix(rawQrToken),
        state: QR_TOKEN_STATES.ACTIVE,
        issuedBy: actor.id,
        issuedAt: now,
        expiresAt: input.qrExpiresAt ? requireIsoDate(input.qrExpiresAt, 'qrExpiresAt', { notPast: true, nowMs }) : null,
        revokedBy: null,
        revokedAt: null,
        revokeReason: '',
        createdAt: now,
        schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
      };
      const tokens = draft.get(ASSET_STORAGE_KEYS.qrTokens) || [];
      tokens.push(qrToken);
      draft.set(ASSET_STORAGE_KEYS.qrTokens, tokens);

      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.ASSET_CREATED,
        entityType: 'Asset',
        entityId: candidate.id,
        actor,
        jurisdictionId,
        reason: input.reason || 'Public asset registered',
        details: { publicId: candidate.publicId, categoryId, locationId, qrTokenId: qrToken.id },
        createdAt: now,
      });
      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.QR_ISSUED,
        entityType: 'QrToken',
        entityId: qrToken.id,
        actor,
        jurisdictionId,
        reason: 'First public tag issued',
        details: { assetPublicId: candidate.publicId, tokenPrefix: qrToken.tokenPrefix },
        createdAt: now,
      });

      const response = {
        asset: staffAssetView(candidate, storage, nowMs),
        publicAsset: publicAssetView(candidate, category, location),
        qrToken: rawQrToken,
        qrPath: getAssetQrPath(rawQrToken),
        qrTokenRecord: qrTokenStaffView(qrToken),
        replayed: false,
      };
      // The raw tag is a bearer lookup key and is shown only in this response.
      // The retry record keeps the asset identity, never the raw tag or its URL.
      saveAssetIdempotency(draft, actor, key, 'create_asset', input, {
        ...response,
        qrToken: undefined,
        qrPath: undefined,
        qrTokenIssuedOnce: true,
      });
      return response;
    }
  );

  return { ...result, role };
};

export const updateAsset = (
  assetId,
  updates = {},
  { storage = getAssetStorage(), idempotencyKey = null, nowMs = Date.now(), reason = 'Asset record corrected' } = {}
) => {
  const role = assertAssetCapability('asset.update');
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const key = normalizeAssetIdempotencyKey(idempotencyKey);
  const replayed = checkAssetIdempotency(storage, actor, key, 'update_asset', { assetId, updates, reason });
  if (replayed) return replayed;

  const result = runAssetTransaction(
    storage,
    [
      ASSET_STORAGE_KEYS.assets,
      ASSET_STORAGE_KEYS.categories,
      ASSET_STORAGE_KEYS.locations,
      ASSET_STORAGE_KEYS.audit,
      ASSET_STORAGE_KEYS.idempotency,
    ],
    (draft, context) => {
      const now = context.now;
      const asset = requireAssetRecord(draft, assetId, scoped);
      assertAssetJurisdiction(getCurrentActor(), asset.jurisdictionId);
      if (updates.status !== undefined || updates.condition !== undefined) {
        throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, 'Lifecycle status and condition are changed through inspections or the retirement workflow.', {
          fieldErrors: {
            ...(updates.status !== undefined ? { status: 'Use the lifecycle action instead of editing status.' } : {}),
            ...(updates.condition !== undefined ? { condition: 'Record condition through a verified inspection.' } : {}),
          },
        });
      }
      const before = cloneJson(asset);
      const categoryId = updates.categoryId !== undefined ? requireString(updates.categoryId, 'categoryId', { min: 2, max: 80 }) : asset.categoryId;
      const category = (draft.get(ASSET_STORAGE_KEYS.categories) || []).find((item) => item.id === categoryId);
      if (!category) {
        throw createAssetError(ASSET_ERROR_CODES.REFERENCE_NOT_FOUND, `Unknown asset category: ${categoryId}.`, {
          fieldErrors: { categoryId: 'Choose a category from the municipal catalogue.' },
        });
      }
      const locationId = updates.locationId !== undefined ? requireString(updates.locationId, 'locationId', { min: 2, max: 80 }) : asset.locationId;
      const location = (draft.get(ASSET_STORAGE_KEYS.locations) || []).find((item) => item.id === locationId);
      if (!location) {
        throw createAssetError(ASSET_ERROR_CODES.REFERENCE_NOT_FOUND, `Unknown asset location: ${locationId}.`, {
          fieldErrors: { locationId: 'Choose an existing municipal location.' },
        });
      }
      if (location.jurisdictionId !== asset.jurisdictionId) {
        throw createAssetError(ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN, 'Location belongs to another jurisdiction.');
      }
      const name = updates.name !== undefined ? requireString(updates.name, 'name', { min: 4, max: ASSET_API_LIMITS.maxNameLength }) : asset.name;
      const publicDescription =
        updates.publicDescription !== undefined
          ? sanitizePublicNarrative(updates.publicDescription, { max: ASSET_API_LIMITS.maxDescriptionLength, multiline: true })
          : asset.publicDescription;
      const internalNotes =
        updates.internalNotes !== undefined
          ? optionalString(updates.internalNotes, 'internalNotes', { max: ASSET_API_LIMITS.maxNotesLength, multiline: true })
          : asset.internalNotes;
      const installedOn =
        updates.installedOn !== undefined ? optionalIsoDate(updates.installedOn, 'installedOn', { notFuture: true, nowMs }) : asset.installedOn;
      const inspectionIntervalDays =
        updates.inspectionIntervalDays !== undefined
          ? requireNumberRange(
              updates.inspectionIntervalDays,
              'inspectionIntervalDays',
              ASSET_API_LIMITS.minInspectionIntervalDays,
              ASSET_API_LIMITS.maxInspectionIntervalDays
            )
          : asset.inspectionIntervalDays;
      const isPubliclyListed = updates.isPubliclyListed !== undefined ? Boolean(updates.isPubliclyListed) : asset.isPubliclyListed;

      const candidate = {
        ...asset,
        categoryId,
        locationId,
        name,
        publicDescription,
        internalNotes,
        installedOn,
        inspectionIntervalDays,
        isPubliclyListed,
        inspectionDueAt:
          inspectionIntervalDays !== asset.inspectionIntervalDays
            ? new Date(nowMs + inspectionIntervalDays * 24 * 60 * 60 * 1000).toISOString()
            : asset.inspectionDueAt,
        updatedAt: now,
        schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
      };

      const duplicate = findAssetDuplicate((draft.get(ASSET_STORAGE_KEYS.assets) || []).filter((item) => item.id !== asset.id), candidate);
      if (duplicate && !updates.duplicateOverrideReason) {
        throw createAssetError(ASSET_ERROR_CODES.CONFLICT, `Possible duplicate of ${duplicate.publicId}.`, {
          details: { duplicatePublicId: duplicate.publicId, duplicateAssetId: duplicate.id },
          userMessage: `Another asset with the same name already exists at this location (${duplicate.publicId}).`,
          fieldErrors: { name: 'Another asset with this name exists at this location.' },
        });
      }

      draft.set(
        ASSET_STORAGE_KEYS.assets,
        (draft.get(ASSET_STORAGE_KEYS.assets) || []).map((item) => (item.id === asset.id ? candidate : item))
      );
      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.ASSET_UPDATED,
        entityType: 'Asset',
        entityId: asset.id,
        actor,
        jurisdictionId: asset.jurisdictionId,
        reason,
        changes: changeSummary(before, candidate, [
          'categoryId',
          'locationId',
          'name',
          'publicDescription',
          'internalNotes',
          'installedOn',
          'inspectionIntervalDays',
          'isPubliclyListed',
          'inspectionDueAt',
        ]),
        details: updates.duplicateOverrideReason
          ? { duplicateOverride: true, duplicateOfPublicId: duplicate?.publicId || null, overrideReason: requireString(
              updates.duplicateOverrideReason,
              'duplicateOverrideReason',
              { min: 10, max: ASSET_API_LIMITS.maxReasonLength }
            ) }
          : null,
        createdAt: now,
      });

      const response = {
        asset: staffAssetView(candidate, storage, nowMs),
        publicAsset: publicAssetView(candidate, category, location),
        replayed: false,
      };
      saveAssetIdempotency(draft, actor, key, 'update_asset', { assetId, updates, reason }, response);
      return response;
    }
  );
  return { ...result, role };
};

export const transitionAssetStatus = (
  assetId,
  input = {},
  { storage = getAssetStorage(), idempotencyKey = null, nowMs = Date.now() } = {}
) => {
  const role = assertAssetCapability('asset.retire');
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const key = normalizeAssetIdempotencyKey(idempotencyKey);
  const replayed = checkAssetIdempotency(storage, actor, key, 'transition_asset', { assetId, input });
  if (replayed) return replayed;

  const result = runAssetTransaction(
    storage,
    [ASSET_STORAGE_KEYS.assets, ASSET_STORAGE_KEYS.audit, ASSET_STORAGE_KEYS.idempotency],
    (draft, context) => {
      const now = context.now;
      const asset = requireAssetRecord(draft, assetId, scoped);
      assertAssetJurisdiction(getCurrentActor(), asset.jurisdictionId);
      const to = requireEnum(input.to, ASSET_STATUS, 'to');
      if (!Object.values(ASSET_STATUS).includes(to)) {
        throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, 'Choose a valid asset status.');
      }
      if (to === asset.status) {
        throw createAssetError(ASSET_ERROR_CODES.INVALID_TRANSITION, `Asset is already ${to}.`);
      }
      if (!allowedAssetTransition(asset.status, to)) {
        throw createAssetError(ASSET_ERROR_CODES.INVALID_TRANSITION, `Cannot move asset from ${asset.status} to ${to}.`, {
          details: { from: asset.status, to, allowed: allowedAssetNext(asset.status) },
        });
      }
      const reason = requireString(input.reason, 'reason', {
        min: [ASSET_STATUS.RETIRED, ASSET_STATUS.ARCHIVED].includes(to) ? 10 : 5,
        max: ASSET_API_LIMITS.maxReasonLength,
      });
      if (to === ASSET_STATUS.ACTIVE && asset.condition === ASSET_CONDITIONS.OUT_OF_SERVICE) {
        throw createAssetError(ASSET_ERROR_CODES.CONFLICT, 'An out-of-service asset cannot be reactivated without a verified repair.', {
          userMessage: 'Record a verified repair and update the condition before returning this asset to service.',
        });
      }
      const candidate = {
        ...asset,
        status: to,
        updatedAt: now,
        ...(to === ASSET_STATUS.RETIRED ? { retiredAt: now, retiredBy: actor.id } : {}),
        ...(to === ASSET_STATUS.ACTIVE ? { reactivatedAt: now, reactivatedBy: actor.id } : {}),
      };
      draft.set(
        ASSET_STORAGE_KEYS.assets,
        (draft.get(ASSET_STORAGE_KEYS.assets) || []).map((item) => (item.id === asset.id ? candidate : item))
      );
      appendAssetAuditEvent(draft, {
        action: to === ASSET_STATUS.RETIRED ? ASSET_AUDIT_ACTIONS.ASSET_RETIRED : ASSET_AUDIT_ACTIONS.ASSET_STATUS_CHANGED,
        entityType: 'Asset',
        entityId: asset.id,
        actor,
        jurisdictionId: asset.jurisdictionId,
        reason,
        changes: { status: { before: asset.status, after: to } },
        details: { assetPublicId: asset.publicId },
        createdAt: now,
      });
      const response = {
        asset: staffAssetView(candidate, storage, nowMs),
        publicAsset: publicAssetView(candidate, categoryFor(storage, candidate.categoryId), locationFor(storage, candidate.locationId)),
        replayed: false,
      };
      saveAssetIdempotency(draft, actor, key, 'transition_asset', { assetId, input }, response);
      return response;
    }
  );
  void role;
  return result;
};

const allowedAssetTransition = (from, to) => {
  const transitions = {
    [ASSET_STATUS.ACTIVE]: [ASSET_STATUS.SUSPENDED, ASSET_STATUS.RETIRED],
    [ASSET_STATUS.SUSPENDED]: [ASSET_STATUS.ACTIVE, ASSET_STATUS.RETIRED],
    [ASSET_STATUS.RETIRED]: [ASSET_STATUS.ARCHIVED],
    [ASSET_STATUS.ARCHIVED]: [ASSET_STATUS.RETIRED],
  };
  return (transitions[from] || []).includes(to);
};
const allowedAssetNext = (from) => {
  const transitions = {
    [ASSET_STATUS.ACTIVE]: [ASSET_STATUS.SUSPENDED, ASSET_STATUS.RETIRED],
    [ASSET_STATUS.SUSPENDED]: [ASSET_STATUS.ACTIVE, ASSET_STATUS.RETIRED],
    [ASSET_STATUS.RETIRED]: [ASSET_STATUS.ARCHIVED],
    [ASSET_STATUS.ARCHIVED]: [ASSET_STATUS.RETIRED],
  };
  return transitions[from] || [];
};

export const issueQrToken = (
  assetId,
  input = {},
  { storage = getAssetStorage(), idempotencyKey = null, nowMs = Date.now() } = {}
) => {
  const role = assertAssetCapability('asset.qr.issue');
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const key = normalizeAssetIdempotencyKey(idempotencyKey);
  const replayed = checkAssetIdempotency(storage, actor, key, 'issue_qr', { assetId, input });
  if (replayed) return replayed;

  const result = runAssetTransaction(
    storage,
    [ASSET_STORAGE_KEYS.assets, ASSET_STORAGE_KEYS.qrTokens, ASSET_STORAGE_KEYS.audit, ASSET_STORAGE_KEYS.idempotency],
    (draft, context) => {
      const now = context.now;
      const asset = requireAssetRecord(draft, assetId, scoped);
      assertAssetJurisdiction(getCurrentActor(), asset.jurisdictionId);
      const tokens = draft.get(ASSET_STORAGE_KEYS.qrTokens) || [];
      const active = tokens.filter((token) => token.assetId === asset.id && token.state === QR_TOKEN_STATES.ACTIVE);
      if (input.revokeExisting) {
        for (const token of active) {
          token.state = QR_TOKEN_STATES.REVOKED;
          token.revokedBy = actor.id;
          token.revokedAt = now;
          token.revokeReason = sanitizePlain(input.reason || 'Rotated by staff', { max: 300 });
        }
        draft.set(ASSET_STORAGE_KEYS.qrTokens, tokens);
      } else if (active.length >= ASSET_API_LIMITS.maxQrTokensPerAsset) {
        throw createAssetError(ASSET_ERROR_CODES.CONFLICT, 'Too many active tags for this asset. Revoke an old tag first.', {
          userMessage: `At most ${ASSET_API_LIMITS.maxQrTokensPerAsset} active tags are allowed per asset.`,
        });
      }
      const rawToken = generateOpaqueToken(ASSET_API_LIMITS.qrTokenBytes);
      const token = {
        id: newAssetId('qrt'),
        assetId: asset.id,
        jurisdictionId: asset.jurisdictionId,
        tokenHash: hashToken(rawToken),
        tokenPrefix: tokenPrefix(rawToken),
        state: QR_TOKEN_STATES.ACTIVE,
        issuedBy: actor.id,
        issuedAt: now,
        expiresAt: input.expiresAt ? requireIsoDate(input.expiresAt, 'expiresAt', { notPast: true, nowMs }) : null,
        revokedBy: null,
        revokedAt: null,
        revokeReason: '',
        createdAt: now,
        schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
      };
      tokens.push(token);
      draft.set(ASSET_STORAGE_KEYS.qrTokens, tokens);
      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.QR_ISSUED,
        entityType: 'QrToken',
        entityId: token.id,
        actor,
        jurisdictionId: asset.jurisdictionId,
        reason: input.reason || 'Public tag issued',
        details: { assetPublicId: asset.publicId, tokenPrefix: token.tokenPrefix, revokedExisting: Boolean(input.revokeExisting) },
        createdAt: now,
      });
      const response = {
        token: rawToken,
        path: getAssetQrPath(rawToken),
        record: qrTokenStaffView(token),
        replayed: false,
      };
      saveAssetIdempotency(draft, actor, key, 'issue_qr', { assetId, input }, {
        recordId: token.id,
        tokenPrefix: token.tokenPrefix,
        issuedAt: token.issuedAt,
      });
      return response;
    }
  );
  return { ...result, role };
};

export const listQrTokens = (assetId, { storage = getAssetStorage() } = {}) => {
  assertAssetCapability('asset.staff.read');
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const asset = requireAssetRecord({ get: (key) => readAssetCollection(storage, key) }, assetId, scoped);
  return readAssetCollection(storage, ASSET_STORAGE_KEYS.qrTokens)
    .filter((token) => token.assetId === asset.id)
    .sort((a, b) => Date.parse(b.issuedAt || 0) - Date.parse(a.issuedAt || 0))
    .map(qrTokenStaffView);
};

export const revokeQrToken = (
  identifier,
  input = {},
  { storage = getAssetStorage(), nowMs = Date.now() } = {}
) => {
  const role = assertAssetCapability('asset.qr.revoke');
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const reason = requireString(input.reason, 'reason', { min: 10, max: ASSET_API_LIMITS.maxReasonLength });
  void nowMs;

  const result = runAssetTransaction(
    storage,
    [ASSET_STORAGE_KEYS.qrTokens, ASSET_STORAGE_KEYS.audit],
    (draft, context) => {
      const now = context.now;
      const tokens = draft.get(ASSET_STORAGE_KEYS.qrTokens) || [];
      const targetHash = isOpaqueToken(identifier) ? hashToken(identifier) : null;
      const token = tokens.find((item) => item.id === identifier || (targetHash && item.tokenHash === targetHash));
      if (!token) throw createAssetError(ASSET_ERROR_CODES.NOT_FOUND, 'QR tag was not found.');
      if (scoped !== null && !scoped.includes(token.jurisdictionId)) {
        throw createAssetError(ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN);
      }
      if (token.state !== QR_TOKEN_STATES.ACTIVE) {
        throw createAssetError(ASSET_ERROR_CODES.INVALID_TRANSITION, `QR tag is already ${token.state}.`);
      }
      token.state = QR_TOKEN_STATES.REVOKED;
      token.revokedBy = actor.id;
      token.revokedAt = now;
      token.revokeReason = reason;
      draft.set(ASSET_STORAGE_KEYS.qrTokens, tokens);
      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.QR_REVOKED,
        entityType: 'QrToken',
        entityId: token.id,
        actor,
        jurisdictionId: token.jurisdictionId,
        reason,
        details: { tokenPrefix: token.tokenPrefix, assetId: token.assetId },
        createdAt: now,
      });
      return qrTokenStaffView(token);
    }
  );
  return { ...result, role };
};

export const issueStaffActionToken = (
  input = {},
  { storage = getAssetStorage(), nowMs = Date.now() } = {}
) => {
  const role = assertAssetCapability('asset.action.issue');
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  const scoped = getScopedJurisdictions();
  const assetId = requireString(input.assetId, 'assetId', { min: 2, max: 80 });
  const asset = requireAssetRecord({ get: (key) => readAssetCollection(storage, key) }, assetId, scoped);
  assertAssetJurisdiction(getCurrentActor(), asset.jurisdictionId);
  const action = requireString(input.action, 'action', { min: 3, max: 40 });
  if (!ACTION_VALUES.includes(action)) {
    throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, `Action must be one of: ${ACTION_VALUES.join(', ')}.`, {
      fieldErrors: { action: 'Choose a supported staff action.' },
    });
  }
  const ttlMs = Math.max(60_000, Math.min(30 * 60 * 1000, Number(input.ttlMs) || ASSET_API_LIMITS.actionTokenTtlMs));
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  const payload = {
    v: 1,
    assetId: asset.id,
    action,
    actorId: actor.id,
    actorRole: actor.role,
    jurisdictionId: asset.jurisdictionId,
    issuedAt: new Date(nowMs).toISOString(),
    exp: expiresAt,
    nonce: generateOpaqueToken(18),
  };
  const secret = getActionSecret(storage);
  const token = `${encodeTokenPayload(payload)}.${signActionPayload(payload, secret)}`;
  const result = runAssetTransaction(
    storage,
    [ASSET_STORAGE_KEYS.audit],
    (draft, context) => {
      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.ACTION_TOKEN_ISSUED,
        entityType: 'Asset',
        entityId: asset.id,
        actor,
        jurisdictionId: asset.jurisdictionId,
        reason: input.reason || 'Short-lived staff action issued',
        details: { action, expiresAt, tokenId: payload.nonce.slice(0, 6) },
        createdAt: context.now,
      });
      return { token, expiresAt, action, assetId: asset.id, assetPublicId: asset.publicId };
    }
  );
  return { ...result, role };
};

export const consumeStaffActionToken = (
  rawToken,
  { storage = getAssetStorage(), nowMs = Date.now() } = {}
) => {
  const role = assertAssetCapability('asset.action.consume');
  const actor = currentAssetIdentity();
  ensureAssetRegistryData({ storage });
  if (typeof rawToken !== 'string' || !rawToken.includes('.')) {
    throw createAssetError(ASSET_ERROR_CODES.ACTION_TOKEN_INVALID);
  }
  const separator = rawToken.lastIndexOf('.');
  const encoded = rawToken.slice(0, separator);
  const signature = rawToken.slice(separator + 1);
  const payload = decodeTokenPayload(encoded);
  if (!payload || payload.v !== 1 || typeof payload !== 'object') {
    throw createAssetError(ASSET_ERROR_CODES.ACTION_TOKEN_INVALID);
  }
  const secret = getActionSecret(storage);
  if (signActionPayload(payload, secret) !== signature) {
    throw createAssetError(ASSET_ERROR_CODES.ACTION_TOKEN_INVALID);
  }
  if (!payload.exp || Date.parse(payload.exp) <= nowMs) {
    throw createAssetError(ASSET_ERROR_CODES.ACTION_TOKEN_EXPIRED);
  }
  if (payload.actorId !== actor.id) {
    throw createAssetError(ASSET_ERROR_CODES.ACTION_TOKEN_SCOPE);
  }
  if (!ACTION_VALUES.includes(payload.action)) {
    throw createAssetError(ASSET_ERROR_CODES.ACTION_TOKEN_INVALID);
  }
  assertAssetCapability(ACTION_CAPABILITY[payload.action]);
  const asset = requireAssetRecord({ get: (key) => readAssetCollection(storage, key) }, payload.assetId, getScopedJurisdictions());
  assertAssetJurisdiction(getCurrentActor(), asset.jurisdictionId);
  if (payload.jurisdictionId !== asset.jurisdictionId) {
    throw createAssetError(ASSET_ERROR_CODES.ACTION_TOKEN_SCOPE);
  }

  const result = runAssetTransaction(
    storage,
    [ASSET_STORAGE_KEYS.actionNonces, ASSET_STORAGE_KEYS.audit],
    (draft, context) => {
      const current = draft.get(ASSET_STORAGE_KEYS.actionNonces);
      const nonces = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
      if (nonces[payload.nonce]) {
        throw createAssetError(ASSET_ERROR_CODES.ACTION_TOKEN_REPLAYED);
      }
      nonces[payload.nonce] = { usedAt: context.now, actorId: actor.id, action: payload.action, assetId: asset.id };
      draft.set(ASSET_STORAGE_KEYS.actionNonces, nonces);
      appendAssetAuditEvent(draft, {
        action: ASSET_AUDIT_ACTIONS.ACTION_TOKEN_CONSUMED,
        entityType: 'Asset',
        entityId: asset.id,
        actor,
        jurisdictionId: asset.jurisdictionId,
        reason: 'Short-lived staff action consumed',
        details: { action: payload.action, tokenId: payload.nonce.slice(0, 6) },
        createdAt: context.now,
      });
      return {
        assetId: asset.id,
        assetPublicId: asset.publicId,
        action: payload.action,
        actorId: actor.id,
        consumedAt: context.now,
        replayed: false,
      };
    }
  );
  return { ...result, role };
};

export const listAssetStaffActionCapabilities = () => ({ ...ACTION_CAPABILITY });
