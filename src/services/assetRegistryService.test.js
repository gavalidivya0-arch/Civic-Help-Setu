import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setCurrentActor } from './accessControl';
import {
  ASSET_CONDITIONS,
  ASSET_ERROR_CODES,
  ASSET_STATUS,
  ASSET_STORAGE_KEYS,
  FAULT_REPORT_STATES,
  INSPECTION_STATES,
  QR_TOKEN_STATES,
  TRIAGE_DECISIONS,
  WORK_ORDER_STATES,
} from './assetRegistryConstants';
import {
  applyAssetRetentionPolicy,
  clearAssetCitizenData,
  completeInspection,
  completeWorkOrder,
  createAsset,
  createWorkOrder,
  ensureAssetRegistryData,
  getAssetAuditTrail,
  getFaultReportStatus,
  getPublicAssetByQrToken,
  getPublicAssets,
  getStaffAsset,
  issueQrToken,
  issueStaffActionToken,
  consumeStaffActionToken,
  listAssetInspections,
  listFaultReports,
  listQrTokens,
  listStaffAssets,
  listTriageSuggestions,
  listWorkOrders,
  reviewFaultReport,
  reviewTriageSuggestion,
  scheduleInspection,
  startInspection,
  submitFaultReport,
  transitionAssetStatus,
  transitionWorkOrder,
  triageFaultReport,
  updateAsset,
  verifyAssetAuditChain,
  verifyInspection,
  verifyWorkOrder,
} from './assetRegistryService';

const createMemoryStorage = () => {
  const map = new Map();
  return {
    failOnKey: null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem(key, value) {
      if (this.failOnKey === key) throw new Error(`Simulated write failure for ${key}`);
      map.set(key, String(value));
    },
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    dump: () => map,
  };
};

const read = (storage, key) => {
  const raw = storage.getItem(key);
  return raw ? JSON.parse(raw) : null;
};

const admin = { id: 'admin_1', username: 'Registry Administrator', role: 'admin', raw: { publicMetadata: {} } };
const operator = {
  id: 'operator_1',
  username: 'Maintenance operator',
  role: 'admin',
  raw: { publicMetadata: { assetRole: 'operator', jurisdictionId: 'blr' } },
};
const reviewer = {
  id: 'reviewer_1',
  username: 'Maintenance reviewer',
  role: 'admin',
  raw: { publicMetadata: { assetRole: 'reviewer', jurisdictionId: 'blr' } },
};
const delhiOperator = {
  id: 'operator_del',
  username: 'Delhi operator',
  role: 'admin',
  raw: { publicMetadata: { assetRole: 'operator', jurisdictionId: 'del' } },
};
const delhiReviewer = {
  id: 'reviewer_del',
  username: 'Delhi reviewer',
  role: 'admin',
  raw: { publicMetadata: { assetRole: 'reviewer', jurisdictionId: 'del' } },
};
const citizen = { id: 'citizen_1', username: 'Resident', role: 'citizen' };

const SAFE_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const evidence = () => [{ mimeType: 'image/png', sizeBytes: 128, url: SAFE_IMAGE, caption: 'Completion photo' }];
const BENCH_TAG = 'demo-tag-bench-indiranagar-9f4c2a7e8b1d6c05';
const SHELTER_TAG = 'demo-tag-shelter-koramangala-3a7d1e5b9c2f8a41';

const expectCode = (fn, code) => {
  try {
    fn();
    throw new Error(`Expected ${code} but the call succeeded.`);
  } catch (error) {
    expect(error.code).toBe(code);
  }
};

let storage;

beforeEach(() => {
  storage = createMemoryStorage();
  ensureAssetRegistryData({ storage, nowMs: Date.parse('2026-11-16T08:00:00.000Z') });
  setCurrentActor(null);
});

afterEach(() => setCurrentActor(null));

describe('asset registry bootstrap and public read model', () => {
  it('seeds a demonstration register with reference data and hashed QR tags', () => {
    expect(read(storage, ASSET_STORAGE_KEYS.assets).length).toBeGreaterThan(0);
    expect(read(storage, ASSET_STORAGE_KEYS.categories).length).toBeGreaterThan(0);
    const tokens = read(storage, ASSET_STORAGE_KEYS.qrTokens);
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(token).not.toHaveProperty('rawToken');
      expect(token.tokenHash).toMatch(/^[a-f0-9]{32}$/);
    }
  });

  it('returns only approved public fields with no internal ids or private notes', () => {
    const result = getPublicAssets({ pageSize: 50 }, storage);
    expect(result.total).toBeGreaterThan(0);
    for (const asset of result.items) {
      expect(asset.publicId).toMatch(/^(BLR|DEL)-AST-\d{4}$/);
      expect(asset).not.toHaveProperty('id');
      expect(asset).not.toHaveProperty('internalNotes');
      expect(asset).not.toHaveProperty('createdBy');
      expect(asset).not.toHaveProperty('jurisdictionId');
      expect(asset.location.precision).toBe('approximately 1 km grid');
      expect(asset.maintenanceHistory).toBeUndefined();
    }
    expect(result.summary.verifiedRepairs).toBe(result.items.reduce((total, asset) => total + asset.repairCount, 0));
  });

  it('scopes public summary outcomes to the filtered asset set', () => {
    const all = getPublicAssets({ pageSize: 50 }, storage);
    expect(all.summary.openFaults).toBeGreaterThan(0);
    const playground = getPublicAssets({ categoryId: 'cat_playground', pageSize: 50 }, storage);
    expect(playground.items.every((asset) => asset.category.code === 'playground_equipment')).toBe(true);
    expect(playground.summary.openFaults).toBe(0);
    expect(playground.summary.verifiedRepairs).toBe(
      playground.items.reduce((total, asset) => total + asset.repairCount, 0)
    );
  });

  it('hides archived assets from the public register', () => {
    const all = getPublicAssets({ pageSize: 50 }, storage).total;
    setCurrentActor(reviewer);
    transitionAssetStatus(
      'asset_bench_indiranagar_1',
      { to: ASSET_STATUS.RETIRED, reason: 'Removed during footpath rebuild' },
      { storage }
    );
    transitionAssetStatus(
      'asset_bench_indiranagar_1',
      { to: ASSET_STATUS.ARCHIVED, reason: 'Record archived after removal' },
      { storage }
    );
    setCurrentActor(null);
    expect(getPublicAssets({ pageSize: 50 }, storage).total).toBe(all - 1);
  });

  it('paginates with bounded page sizes', () => {
    const page = getPublicAssets({ page: 1, pageSize: 2 }, storage);
    expect(page.items).toHaveLength(2);
    expect(page.pageSize).toBe(2);
    expect(page.totalPages).toBeGreaterThanOrEqual(1);
  });
});

describe('QR lookup tokens', () => {
  it('resolves the demo tag to a public asset and approved history', () => {
    const result = getPublicAssetByQrToken(BENCH_TAG, {}, storage);
    expect(result.publicId).toBe('BLR-AST-0001');
    expect(result.fueld).toBeUndefined();
    expect(Array.isArray(result.maintenanceHistory)).toBe(true);
  });

  it('resolves verified repair history for the playground tag only', () => {
    const result = getPublicAssetByQrToken('demo-tag-play-koramangala-6b2e8d4a1c9f7e30', {}, storage);
    expect(result.publicId).toBe('BLR-AST-0003');
    expect(result.maintenanceHistory).toHaveLength(1);
    expect(result.maintenanceHistory[0]).not.toHaveProperty('id');
    expect(result.maintenanceHistory[0]).not.toHaveProperty('recordedBy');
    expect(result.maintenanceHistory[0].publicSummary).toContain('slide panel');
  });

  it('rejects unknown, malformed and revoked tags', () => {
    expectCode(
      () => getPublicAssetByQrToken('not-a-real-token-but-long-enough-x', {}, storage),
      ASSET_ERROR_CODES.QR_INVALID
    );
    expectCode(() => getPublicAssetByQrToken('short', {}, storage), ASSET_ERROR_CODES.QR_INVALID);
    const tokens = read(storage, ASSET_STORAGE_KEYS.qrTokens);
    const target = tokens.find((item) => item.assetId === 'asset_bench_indiranagar_1');
    target.state = QR_TOKEN_STATES.REVOKED;
    storage.setItem(ASSET_STORAGE_KEYS.qrTokens, JSON.stringify(tokens));
    expectCode(() => getPublicAssetByQrToken(BENCH_TAG, {}, storage), ASSET_ERROR_CODES.QR_INVALID);
  });
});

describe('permissions and jurisdiction scoping', () => {
  it('refuses staff reads for anonymous and citizen callers', () => {
    expectCode(() => listStaffAssets({}, storage), ASSET_ERROR_CODES.UNAUTHENTICATED);
    setCurrentActor(citizen);
    expectCode(() => listStaffAssets({}, storage), ASSET_ERROR_CODES.PERMISSION_DENIED);
  });

  it('scopes reads and writes to the actor jurisdiction', () => {
    setCurrentActor(delhiOperator);
    const scoped = listStaffAssets({ pageSize: 50 }, storage);
    expect(scoped.items.length).toBeGreaterThan(0);
    for (const item of scoped.items) {
      expect(item.jurisdictionId).toBe('del');
    }
    expectCode(() => getStaffAsset('asset_bench_indiranagar_1', storage), ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN);
    setCurrentActor(delhiReviewer);
    expectCode(
      () =>
        transitionAssetStatus(
          'asset_bench_indiranagar_1',
          { to: ASSET_STATUS.RETIRED, reason: 'Not my asset to retire' },
          { storage }
        ),
      ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN
    );
  });

  it('paginates and scopes staff inspection and work-order lists', () => {
    setCurrentActor(operator);
    const inspections = listAssetInspections({ pageSize: 1 }, storage);
    expect(inspections.items).toHaveLength(1);
    expect(inspections.pageSize).toBe(1);
    expect(inspections.total).toBeGreaterThan(0);
    const orders = listWorkOrders({ pageSize: 1 }, storage);
    expect(orders.items).toHaveLength(1);
    expect(orders.pageSize).toBe(1);
    expect(orders.total).toBeGreaterThan(0);

    setCurrentActor(delhiOperator);
    const delhiInspections = listAssetInspections({ pageSize: 50 }, storage);
    expect(delhiInspections.items.every((item) => item.jurisdictionId === 'del')).toBe(true);
    const delhiOrders = listWorkOrders({ pageSize: 50 }, storage);
    expect(delhiOrders.items.every((item) => item.jurisdictionId === 'del')).toBe(true);
  });

  it('separates operator and reviewer capabilities', () => {
    setCurrentActor(operator);
    expectCode(
      () => transitionAssetStatus('asset_bench_indiranagar_1', { to: ASSET_STATUS.RETIRED, reason: 'Operator cannot retire assets' }, { storage }),
      ASSET_ERROR_CODES.PERMISSION_DENIED
    );
    expectCode(
      () => verifyInspection('insp_bench_1', {}, { storage }),
      ASSET_ERROR_CODES.PERMISSION_DENIED
    );
  });
});

describe('asset lifecycle', () => {
  it('creates an asset, issues a QR tag and publishes it', () => {
    setCurrentActor(operator);
    const result = createAsset(
      {
        jurisdictionId: 'blr',
        categoryId: 'cat_bench',
        locationId: 'loc_blr_jayanagar',
        name: 'Jayanagar ward office test bench',
        publicDescription: 'A new concrete bench installed for the test.',
        internalNotes: 'Private note: warranty until 2029.',
        installedOn: '2026-10-01',
        condition: ASSET_CONDITIONS.GOOD,
      },
      { storage, idempotencyKey: 'create-asset-test-1' }
    );
    expect(result.asset.publicId).toMatch(/^BLR-AST-\d{4}$/);
    expect(result.qrToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    setCurrentActor(null);
    const publicAsset = getPublicAssetByQrToken(result.qrToken, {}, storage);
    expect(publicAsset.publicId).toBe(result.asset.publicId);
    expect(publicAsset).not.toHaveProperty('internalNotes');
    expect(JSON.stringify(publicAsset)).not.toContain('warranty until 2029');
  });

  it('replays an idempotent create and rejects reuse with a different payload', () => {
    setCurrentActor(operator);
    const payload = {
      jurisdictionId: 'blr',
      categoryId: 'cat_bench',
      locationId: 'loc_blr_jayanagar',
      name: 'Idempotent bench ' + Date.now(),
      publicDescription: 'A bench used to test retries.',
    };
    const first = createAsset(payload, { storage, idempotencyKey: 'idem-create-1' });
    const second = createAsset(payload, { storage, idempotencyKey: 'idem-create-1' });
    expect(second.replayed).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    expect(second.qrToken).toBeUndefined();
    expect(second.qrPath).toBeUndefined();
    expectCode(
      () => createAsset({ ...payload, name: 'Different name after retry' }, { storage, idempotencyKey: 'idem-create-1' }),
      ASSET_ERROR_CODES.IDEMPOTENCY_CONFLICT
    );
  });

  it('never persists the raw QR tag or its URL in the retry record', () => {
    setCurrentActor(operator);
    const created = createAsset(
      {
        jurisdictionId: 'blr',
        categoryId: 'cat_bench',
        locationId: 'loc_blr_jayanagar',
        name: 'Raw tag hygiene bench ' + Date.now(),
        publicDescription: 'A bench used to verify that retry records hold no raw tag.',
      },
      { storage, idempotencyKey: 'idem-create-raw-tag' }
    );
    const idempotency = storage.getItem(ASSET_STORAGE_KEYS.idempotency);
    expect(idempotency).toBeTruthy();
    expect(idempotency).not.toContain(created.qrToken);
    expect(idempotency).not.toContain(encodeURIComponent(created.qrToken));
  });

  it('blocks duplicate asset names at the same location unless an override reason is recorded', () => {
    setCurrentActor(operator);
    expectCode(
      () =>
        createAsset(
          {
            jurisdictionId: 'blr',
            categoryId: 'cat_bench',
            locationId: 'loc_blr_indiranagar',
            name: 'Indiranagar 100 Feet Road bus-stop bench',
            publicDescription: 'A duplicate of the seeded bench.',
          },
          { storage, idempotencyKey: 'duplicate-asset-1' }
        ),
      ASSET_ERROR_CODES.CONFLICT
    );
    const created = createAsset(
      {
        jurisdictionId: 'blr',
        categoryId: 'cat_bench',
        locationId: 'loc_blr_indiranagar',
        name: 'Indiranagar 100 Feet Road bus-stop bench',
        publicDescription: 'A second bench at the same bus stop.',
        duplicateOverrideReason: 'Verified as a separate bench at the same stop.',
      },
      { storage, idempotencyKey: 'duplicate-asset-2' }
    );
    expect(created.asset.publicId).toBeTruthy();
  });

  it('enforces status transitions and refuses direct status edits', () => {
    setCurrentActor(operator);
    expectCode(
      () => updateAsset('asset_bench_indiranagar_1', { status: ASSET_STATUS.RETIRED }, { storage }),
      ASSET_ERROR_CODES.VALIDATION_ERROR
    );
    setCurrentActor(reviewer);
    expectCode(
      () => transitionAssetStatus('asset_bench_indiranagar_1', { to: ASSET_STATUS.ARCHIVED, reason: 'Invalid direct archive' }, { storage }),
      ASSET_ERROR_CODES.INVALID_TRANSITION
    );
    transitionAssetStatus(
      'asset_bench_indiranagar_1',
      { to: ASSET_STATUS.RETIRED, reason: 'Removed during footpath rebuild' },
      { storage }
    );
    const retired = getStaffAsset('asset_bench_indiranagar_1', storage);
    expect(retired.asset.status).toBe(ASSET_STATUS.RETIRED);
  });

  it('will not reactivate an out-of-service asset without a verified repair', () => {
    setCurrentActor(reviewer);
    expectCode(
      () =>
        transitionAssetStatus(
          'asset_play_koramangala_1',
          { to: ASSET_STATUS.ACTIVE, reason: 'Trying to reopen a suspended asset' },
          { storage }
        ),
      ASSET_ERROR_CODES.CONFLICT
    );
  });

  it('rotates QR tags without hitting the active-tag limit', () => {
    setCurrentActor(admin);
    const first = issueQrToken('asset_bench_indiranagar_1', { revokeExisting: false, reason: 'Add a second tag' }, { storage });
    expect(first.token).toBeTruthy();
    const rotated = issueQrToken(
      'asset_bench_indiranagar_1',
      { revokeExisting: true, reason: 'Rotate after staff change' },
      { storage }
    );
    expect(rotated.token).toBeTruthy();
    setCurrentActor(null);
    expectCode(() => getPublicAssetByQrToken(BENCH_TAG, {}, storage), ASSET_ERROR_CODES.QR_INVALID);
    expect(getPublicAssetByQrToken(rotated.token, {}, storage).publicId).toBe('BLR-AST-0001');
  });

  it('lists QR tags without exposing hashes or raw tokens', () => {
    setCurrentActor(operator);
    const tokens = listQrTokens('asset_bench_indiranagar_1', { storage });
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(token).not.toHaveProperty('tokenHash');
      expect(token.tokenPrefix).toMatch(/^[A-Za-z0-9_-]{6}$/);
    }
  });
});

describe('staff action tokens', () => {
  it('binds a short-lived action token to the actor, asset and role', () => {
    setCurrentActor(operator);
    const issued = issueStaffActionToken({ assetId: 'asset_bench_indiranagar_1', action: 'inspect', reason: 'Site visit' }, { storage });
    const consumed = consumeStaffActionToken(issued.token, { storage });
    expect(consumed.action).toBe('inspect');
    expectCode(() => consumeStaffActionToken(issued.token, { storage }), ASSET_ERROR_CODES.ACTION_TOKEN_REPLAYED);
  });

  it('rejects tampered, expired and wrong-actor tokens', () => {
    setCurrentActor(operator);
    const issued = issueStaffActionToken({ assetId: 'asset_bench_indiranagar_1', action: 'inspect' }, { storage, nowMs: 1_000_000 });
    expectCode(() => consumeStaffActionToken(`${issued.token}x`, { storage }), ASSET_ERROR_CODES.ACTION_TOKEN_INVALID);
    expectCode(() => consumeStaffActionToken(issued.token, { storage, nowMs: 1_000_000 + 60 * 60 * 1000 }), ASSET_ERROR_CODES.ACTION_TOKEN_EXPIRED);
    const fresh = issueStaffActionToken({ assetId: 'asset_bench_indiranagar_1', action: 'inspect' }, { storage });
    setCurrentActor(reviewer);
    expectCode(() => consumeStaffActionToken(fresh.token, { storage }), ASSET_ERROR_CODES.ACTION_TOKEN_SCOPE);
  });
});

describe('inspections', () => {
  it('requires verification before findings become public', () => {
    setCurrentActor(operator);
    const scheduled = scheduleInspection(
      { assetId: 'asset_bench_indiranagar_1', type: 'routine', scheduledFor: '2026-11-20T09:00:00.000Z' },
      { storage }
    );
    startInspection(scheduled.inspection.id, {}, { storage });
    const completed = completeInspection(
      scheduled.inspection.id,
      {
        findings: 'Armrest paint is worn but the structure is sound.',
        conditionAfter: ASSET_CONDITIONS.FAIR,
        evidence: evidence(),
      },
      { storage }
    );
    expect(completed.inspection.state).toBe(INSPECTION_STATES.COMPLETED);
    const beforeVerify = getPublicAssetByQrToken(BENCH_TAG, {}, storage);
    expect(beforeVerify.condition).toBe('fair');
    expect(beforeVerify.inspectionHistory.some((item) => item.publicId === scheduled.inspection.publicId)).toBe(false);

    expectCode(() => verifyInspection(scheduled.inspection.id, {}, { storage }), ASSET_ERROR_CODES.PERMISSION_DENIED);
    setCurrentActor(reviewer);
    const verified = verifyInspection(scheduled.inspection.id, { reason: 'Findings reviewed on site' }, { storage });
    expect(verified.inspection.state).toBe(INSPECTION_STATES.VERIFIED);
    const afterVerify = getPublicAssetByQrToken(BENCH_TAG, {}, storage);
    expect(afterVerify.condition).toBe('fair');
    expect(afterVerify.inspectionHistory.some((item) => item.publicId === scheduled.inspection.publicId)).toBe(true);
  });

  it('rejects unsafe evidence and invalid inspection transitions', () => {
    setCurrentActor(operator);
    const scheduled = scheduleInspection({ assetId: 'asset_bench_indiranagar_1' }, { storage });
    expectCode(
      () =>
        completeInspection(
          scheduled.inspection.id,
          {
            findings: 'This finding is long enough to pass validation.',
            conditionAfter: ASSET_CONDITIONS.GOOD,
            evidence: [{ mimeType: 'image/svg+xml', sizeBytes: 100, url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }],
          },
          { storage }
        ),
      ASSET_ERROR_CODES.UNSAFE_ATTACHMENT
    );
    setCurrentActor(reviewer);
    expectCode(
      () => verifyInspection(scheduled.inspection.id, {}, { storage }),
      ASSET_ERROR_CODES.INVALID_TRANSITION
    );
  });
});

describe('citizen fault reports and triage', () => {
  it('accepts an anonymous QR report and exposes only public status fields', () => {
    const result = submitFaultReport(
      {
        qrToken: BENCH_TAG,
        category: 'wear',
        severity: 'minor',
        description: 'The paint on the armrest has worn away and the timber feels rough.',
      },
      { storage, reporterKey: 'device-key-1', idempotencyKey: 'report-key-1' }
    );
    expect(result.duplicate).toBe(false);
    expect(result.publicReport.publicReference).toMatch(/^AST-REP-[A-Z0-9]{6}$/);
    expect(result.publicReport).not.toHaveProperty('id');
    expect(result.publicReport).not.toHaveProperty('reporterKeyHash');
    const tracked = getFaultReportStatus(result.publicReport.publicReference, storage);
    expect(tracked.publicReference).toBe(result.publicReport.publicReference);
    expect(tracked).not.toHaveProperty('reporterKeyHash');
  });

  it('strips markup and personal identifiers from citizen report text before storing it publicly', () => {
    const result = submitFaultReport(
      {
        qrToken: BENCH_TAG,
        category: 'damage',
        severity: 'minor',
        description:
          '<script>alert(1)</script> The bench slat is loose. Contact me on 9876543210 or resident@example.com for access.',
      },
      { storage, reporterKey: 'injection-device' }
    );
    expect(result.publicReport.description).not.toContain('<script>');
    expect(result.publicReport.description).not.toContain('9876543210');
    expect(result.publicReport.description).not.toContain('resident@example.com');
    expect(result.publicReport.description).toContain('bench slat is loose');
  });

  it('returns the existing report when the same device retries the same content', () => {
    const payload = {
      qrToken: BENCH_TAG,
      category: 'wear',
      severity: 'minor',
      description: 'The armrest paint is peeling badly and the timber is rough.',
    };
    const first = submitFaultReport(payload, { storage, reporterKey: 'device-key-2' });
    const second = submitFaultReport(payload, { storage, reporterKey: 'device-key-2' });
    expect(second.duplicate).toBe(true);
    expect(second.publicReport.publicReference).toBe(first.publicReport.publicReference);
  });

  it('enforces the per-device report rate limit', () => {
    const base = {
      qrToken: BENCH_TAG,
      category: 'wear',
      severity: 'cosmetic',
      description: 'A distinct description that is long enough for validation.',
    };
    for (let index = 0; index < 3; index += 1) {
      submitFaultReport({ ...base, description: `${base.description} Report ${index}.` }, { storage, reporterKey: 'rate-device' });
    }
    expectCode(
      () =>
        submitFaultReport(
          { ...base, description: `${base.description} Report number four.` },
          { storage, reporterKey: 'rate-device' }
        ),
      ASSET_ERROR_CODES.RATE_LIMITED
    );
  });

  it('rejects reports for a revoked tag', () => {
    const tokens = read(storage, ASSET_STORAGE_KEYS.qrTokens);
    tokens.find((item) => item.assetId === 'asset_bench_indiranagar_1').state = QR_TOKEN_STATES.REVOKED;
    storage.setItem(ASSET_STORAGE_KEYS.qrTokens, JSON.stringify(tokens));
    expectCode(
      () =>
        submitFaultReport(
          {
            qrToken: BENCH_TAG,
            category: 'damage',
            severity: 'major',
            description: 'The bench slat is broken and the exposed bolt is sharp.',
          },
          { storage, reporterKey: 'revoked-device' }
        ),
      ASSET_ERROR_CODES.QR_INVALID
    );
  });

  it('records an explainable pending suggestion and supports human accept/edit/reject', () => {
    const submitted = submitFaultReport(
      {
        qrToken: SHELTER_TAG,
        category: 'safety_hazard',
        severity: 'safety_hazard',
        description: 'The roof panel is cracked and a sharp metal edge is exposed above the bench.',
      },
      { storage, reporterKey: 'triage-device' }
    );
    setCurrentActor(citizen);
    expectCode(() => listTriageSuggestions({}, storage), ASSET_ERROR_CODES.PERMISSION_DENIED);
    setCurrentActor(operator);
    const queue = listTriageSuggestions({}, storage);
    expect(queue.items.length).toBeGreaterThan(0);
    const suggestion = queue.items.find((item) => item.report.publicReference === submitted.publicReport.publicReference);
    expect(suggestion.decision).toBe(TRIAGE_DECISIONS.PENDING);
    expect(suggestion.requiresHumanReview).toBe(true);
    expect(suggestion.canApplyAutomatically).toBe(false);
    expect(suggestion.rulesetVersion).toBeTruthy();
    expect(suggestion.rationale).toContain('advisory');
    expect(suggestion.factors.length).toBeGreaterThan(0);

    const edited = reviewTriageSuggestion(
      suggestion.id,
      { decision: TRIAGE_DECISIONS.EDITED, editedPriority: 'urgent', reason: 'Site context raises the priority.' },
      { storage }
    );
    expect(edited.suggestion.decision).toBe(TRIAGE_DECISIONS.EDITED);
    expect(edited.report.priority).toBe('urgent');
    expectCode(
      () => reviewTriageSuggestion(suggestion.id, { decision: TRIAGE_DECISIONS.ACCEPTED }, { storage }),
      ASSET_ERROR_CODES.INVALID_TRANSITION
    );
  });

  it('triages a report and records a rejection or duplicate decision with a reason', () => {
    const submitted = submitFaultReport(
      {
        qrToken: BENCH_TAG,
        category: 'damage',
        severity: 'major',
        description: 'One timber slat is loose and a fixing bolt is sticking out of the seat.',
      },
      { storage, reporterKey: 'conversion-device' }
    );
    setCurrentActor(operator);
    const report = listFaultReports({}, storage).items.find(
      (item) => item.publicReference === submitted.publicReport.publicReference
    );
    triageFaultReport(report.id, { priority: 'high', assignedTeam: 'Ward crew' }, { storage });
    setCurrentActor(reviewer);
    expectCode(
      () => reviewFaultReport(report.id, { decision: FAULT_REPORT_STATES.REJECTED }, { storage }),
      ASSET_ERROR_CODES.VALIDATION_ERROR
    );
    const rejected = reviewFaultReport(
      report.id,
      { decision: FAULT_REPORT_STATES.REJECTED, reason: 'No municipal asset fault could be confirmed.' },
      { storage }
    );
    expect(rejected.report.state).toBe(FAULT_REPORT_STATES.REJECTED);
    const tracked = getFaultReportStatus(submitted.publicReport.publicReference, storage);
    expect(tracked.stateLabel).toContain('Closed without action');
  });
});

describe('work orders and append-only repair events', () => {
  const prepareTriagedReport = () => {
    const submitted = submitFaultReport(
      {
        qrToken: BENCH_TAG,
        category: 'damage',
        severity: 'major',
        description: 'One timber slat is loose and a fixing bolt is sticking out of the seat.',
      },
      { storage, reporterKey: 'order-device' }
    );
    setCurrentActor(operator);
    const queue = listFaultReports({ state: FAULT_REPORT_STATES.SUBMITTED }, storage);
    const report = queue.items.find((item) => item.publicReference === submitted.publicReport.publicReference);
    triageFaultReport(report.id, { priority: 'high', assignedTeam: 'Ward crew' }, { storage });
    return { submitted, report };
  };

  it('creates and completes a work order with validated evidence, then verifies it', () => {
    const { report } = prepareTriagedReport();
    const order = createWorkOrder(
      {
        assetId: 'asset_bench_indiranagar_1',
        faultReportId: report.id,
        title: 'Repair the loose bench slat',
        description: 'Tighten the fixing and replace the protruding bolt with a flush fitting.',
        type: 'repair',
        priority: 'high',
        assignedTeam: 'Ward 14 maintenance crew',
        dueAt: '2026-11-30T17:00:00.000Z',
      },
      { storage }
    );
    expect(order.workOrder.state).toBe(WORK_ORDER_STATES.ASSIGNED);

    expectCode(
      () =>
        completeWorkOrder(
          order.workOrder.id,
          {
            closureSummary: 'Slat tightened and bolt replaced with a flush fitting.',
            publicSummary: 'The loose slat was secured and the protruding bolt was replaced.',
            conditionAfter: ASSET_CONDITIONS.GOOD,
            evidence: [],
          },
          { storage }
        ),
      ASSET_ERROR_CODES.VALIDATION_ERROR
    );

    transitionWorkOrder(order.workOrder.id, { to: WORK_ORDER_STATES.IN_PROGRESS }, { storage });
    const completed = completeWorkOrder(
      order.workOrder.id,
      {
        closureSummary: 'Slat tightened and bolt replaced with a flush fitting.',
        publicSummary: 'The loose slat was secured and the protruding bolt was replaced.',
        conditionAfter: ASSET_CONDITIONS.GOOD,
        evidence: evidence(),
        costInr: 900,
      },
      { storage }
    );
    expect(completed.workOrder.state).toBe(WORK_ORDER_STATES.COMPLETED);
    expect(completed.repairEvent).toBeTruthy();

    setCurrentActor(reviewer);
    const repairBefore = read(storage, ASSET_STORAGE_KEYS.repairEvents).find(
      (item) => item.id === completed.repairEvent.id
    );
    const verified = verifyWorkOrder(order.workOrder.id, { verificationNotes: 'Checked on site.' }, { storage });
    expect(verified.workOrder.state).toBe(WORK_ORDER_STATES.VERIFIED);
    const repairAfter = read(storage, ASSET_STORAGE_KEYS.repairEvents).find(
      (item) => item.id === completed.repairEvent.id
    );
    expect(repairAfter).toEqual(repairBefore);
    expect(repairAfter.verifiedAt).toBeNull();
    const publicAsset = getPublicAssetByQrToken(BENCH_TAG, {}, storage);
    const publicRepair = publicAsset.maintenanceHistory.find(
      (item) => item.publicReference === completed.repairEvent.publicReference
    );
    expect(publicRepair).toBeTruthy();
    expect(publicRepair.verifiedAt).toBe(verified.workOrder.verifiedAt);
    const resolved = getFaultReportStatus(report.publicReference, storage);
    expect(resolved.state).toBe(FAULT_REPORT_STATES.RESOLVED);
  });
});

describe('audit, retention and privacy', () => {
  it('maintains a verifiable hash chain and detects tampering', () => {
    setCurrentActor(admin);
    scheduleInspection({ assetId: 'asset_bench_indiranagar_1' }, { storage });
    const trail = getAssetAuditTrail({ pageSize: 50 }, storage);
    expect(trail.chain.valid).toBe(true);
    const events = read(storage, ASSET_STORAGE_KEYS.audit);
    events[0].details = { tampered: true };
    storage.setItem(ASSET_STORAGE_KEYS.audit, JSON.stringify(events));
    expect(verifyAssetAuditChain(events).valid).toBe(false);
  });

  it('applies retention to old closed reports without touching repair history', () => {
    setCurrentActor(admin);
    const dryRun = applyAssetRetentionPolicy({ storage, nowMs: Date.parse('2029-01-01T00:00:00.000Z'), dryRun: true });
    expect(dryRun.candidates).toBeGreaterThan(0);
    const applied = applyAssetRetentionPolicy({ storage, nowMs: Date.parse('2029-01-01T00:00:00.000Z') });
    expect(applied.archivedReports).toBeGreaterThan(0);
    expect(read(storage, ASSET_STORAGE_KEYS.repairEvents).length).toBeGreaterThan(0);
  });

  it('clears citizen report content for one device while retaining municipal history', () => {
    submitFaultReport(
      {
        qrToken: BENCH_TAG,
        category: 'wear',
        severity: 'minor',
        description: 'The paint is peeling from the bench and the seat feels rough.',
      },
      { storage, reporterKey: 'privacy-device' }
    );
    const cleared = clearAssetCitizenData({ reporterKey: 'privacy-device', storage });
    expect(cleared.clearedReports).toBe(1);
    const reports = read(storage, ASSET_STORAGE_KEYS.reports);
    expect(reports.some((report) => report.reporterKeyHash)).toBe(true);
    expect(read(storage, ASSET_STORAGE_KEYS.repairEvents).length).toBeGreaterThan(0);
  });
});
