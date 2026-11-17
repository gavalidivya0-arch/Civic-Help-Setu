import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle,
  MapPin,
  QrCode,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import StandardPageHeader from '../components/common/StandardPageHeader';
import AssetFaultReportForm from '../components/assets/AssetFaultReportForm';
import AssetPublicRegister, { AssetPublicDetail } from '../components/assets/AssetPublicRegister';
import AssetStaffWorkspace from '../components/assets/AssetStaffWorkspace';
import {
  AssetInlineAlert,
  AssetOfflineNotice,
  AssetPermissionDenied,
  AssetRegistryErrorState,
  AssetRegistrySkeleton,
  AssetStaleDataNotice,
  AssetStatusBadge,
} from '../components/assets/AssetStates';
import { useAuth } from '../context/AuthContext';
import { useNetwork } from '../context/NetworkContext';
import { canAsset, isAssetStaff } from '../services/assetAccessControl';
import {
  applyAssetRetentionPolicy,
  completeInspection,
  completeWorkOrder,
  createAsset,
  createWorkOrder,
  getAssetAuditTrail,
  getAssetMigrationStatus,
  getAssetRegistrySummary,
  getAssetStorage,
  getAssetInspectionReminders,
  getFaultReportStatus,
  getPlanningJurisdictions,
  getPublicAssetByPublicId,
  getPublicAssetByQrToken,
  getPublicAssets,
  issueQrToken,
  listAssetCategories,
  listAssetInspections,
  listAssetLocations,
  listFaultReports,
  listStaffAssets,
  listTriageSuggestions,
  listWorkOrders,
  migrateAssetRegistry,
  reviewFaultReport,
  reviewTriageSuggestion,
  revokeQrToken,
  rollbackAssetRegistry,
  scheduleInspection,
  startInspection,
  submitFaultReport,
  transitionAssetStatus,
  transitionWorkOrder,
  triageFaultReport,
  updateAsset,
  verifyInspection,
  verifyWorkOrder,
} from '../services/assetRegistryService';

const PANEL_STYLE = {
  border: '1px solid var(--border-main)',
  borderRadius: '0.9rem',
  padding: '1rem',
  background: 'var(--surface-raised, var(--glass-bg))',
  display: 'grid',
  gap: '0.75rem',
};

const DEFAULT_PUBLIC_FILTERS = {
  jurisdictionId: '',
  ward: '',
  categoryId: '',
  condition: '',
  status: '',
  search: '',
  page: 1,
  pageSize: 10,
};

const LOCAL_REPORTER_KEY = 'civicbridge_asset_reporter_key';

const getReporterKey = () => {
  try {
    const existing = globalThis.localStorage?.getItem(LOCAL_REPORTER_KEY);
    if (existing) return existing;
    const generated =
      globalThis.crypto?.randomUUID?.() || `asset_resident_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    globalThis.localStorage?.setItem(LOCAL_REPORTER_KEY, generated);
    return generated;
  } catch {
    return 'asset_resident_session';
  }
};

const newIdempotencyKey = () => {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // Fall through to the timestamp key.
  }
  return `asset_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

export default function PublicAssetRegistry() {
  const { user } = useAuth();
  const { isOnline } = useNetwork();
  const { token: tagToken = '' } = useParams();
  const navigate = useNavigate();
  const staff = isAssetStaff();

  const [tab, setTab] = useState('public');
  const [staffTab, setStaffTab] = useState('overview');
  const [publicFilters, setPublicFilters] = useState(DEFAULT_PUBLIC_FILTERS);
  const [reloadToken, setReloadToken] = useState(0);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [publicDetail, setPublicDetail] = useState(null);
  const [publicDetailError, setPublicDetailError] = useState(null);
  const [reportAsset, setReportAsset] = useState(null);
  const [reportQrToken, setReportQrToken] = useState('');
  const [reportResult, setReportResult] = useState(null);
  const [trackingCode, setTrackingCode] = useState('');
  const [trackingResult, setTrackingResult] = useState(null);
  const [trackingError, setTrackingError] = useState(null);
  const [issuedQr, setIssuedQr] = useState(null);

  const refresh = () => {
    setError(null);
    setNotice(null);
    setReloadToken((value) => value + 1);
  };

  useEffect(() => {
    setPublicDetail(null);
    setPublicDetailError(null);
  }, [tagToken]);

  const data = useMemo(() => {
    // The revision token and signed-in user force a re-read of the trusted
    // service boundary after a write or an account switch.
    void reloadToken;
    void user?.id;
    let jurisdictions = [];
    let categories = [];
    let publicData = null;
    let publicOptions = [];
    let publicError = null;
    try {
      jurisdictions = getPlanningJurisdictions();
      categories = listAssetCategories();
      publicData = getPublicAssets(publicFilters);
      publicOptions = getPublicAssets({ page: 1, pageSize: 100 }).items;
    } catch (err) {
      publicError = err;
    }

    let staffData = null;
    let staffLoadError = null;
    if (staff) {
      try {
        const storage = getAssetStorage();
        staffData = {
          assets: listStaffAssets({ page: 1, pageSize: 100 }),
          inspections: listAssetInspections({ page: 1, pageSize: 100 }),
          orders: listWorkOrders({ page: 1, pageSize: 100 }),
          reports: listFaultReports({ page: 1, pageSize: 100 }),
          triage: listTriageSuggestions({ page: 1, pageSize: 100 }),
          summary: getAssetRegistrySummary(),
          reminders: getAssetInspectionReminders(),
          audit: canAsset('audit.read') ? getAssetAuditTrail({ pageSize: 60 }) : null,
          migration: canAsset('registry.migrate') ? getAssetMigrationStatus(storage) : null,
          categories,
          locations: listAssetLocations({}, storage),
          jurisdictions,
        };
      } catch (err) {
        staffLoadError = err;
      }
    }

    return { jurisdictions, categories, publicData, publicOptions, publicError, staffData, staffLoadError };
  }, [publicFilters, staff, user?.id, reloadToken]);

  const tagLookup = useMemo(() => {
    void reloadToken;
    void user?.id;
    if (!tagToken) return null;
    try {
      return { asset: getPublicAssetByQrToken(tagToken) };
    } catch (err) {
      return { error: err };
    }
  }, [tagToken, reloadToken, user?.id]);

  const wards = useMemo(() => {
    const selected = data.jurisdictions.find((item) => item.id === publicFilters.jurisdictionId);
    if (selected) return selected.wards;
    return [...new Set(data.jurisdictions.flatMap((item) => item.wards))];
  }, [data.jurisdictions, publicFilters.jurisdictionId]);

  const permissions = {
    canCreate: canAsset('asset.create'),
    canUpdate: canAsset('asset.update'),
    canRetire: canAsset('asset.retire'),
    canIssueQr: canAsset('asset.qr.issue'),
    canRevokeQr: canAsset('asset.qr.revoke'),
    canScheduleInspection: canAsset('inspection.schedule'),
    canCompleteInspection: canAsset('inspection.complete'),
    canVerifyInspection: canAsset('inspection.verify'),
    canTriage: canAsset('report.triage'),
    canReviewReport: canAsset('report.review'),
    canReviewTriage: canAsset('triage.review'),
    canManageOrders: canAsset('order.manage'),
    canCompleteOrder: canAsset('order.complete'),
    canVerifyOrder: canAsset('order.verify'),
    canMigrate: canAsset('registry.migrate'),
    canManageRetention: canAsset('retention.manage'),
  };

  const runService = (fn, successMessage) => {
    setError(null);
    setNotice(null);
    try {
      const result = fn();
      setNotice(typeof successMessage === 'function' ? successMessage(result) : successMessage || null);
      setReloadToken((value) => value + 1);
      return result;
    } catch (err) {
      setError(err);
      setNotice(null);
      return null;
    }
  };

  const selectPublicAsset = (publicId) => {
    try {
      setPublicDetail(getPublicAssetByPublicId(publicId));
      setPublicDetailError(null);
      setTab('public');
    } catch (err) {
      setPublicDetail(null);
      setPublicDetailError(err);
    }
  };

  const openReportFor = (publicId, qrToken = '') => {
    const asset =
      (tagLookup?.asset?.publicId === publicId ? tagLookup.asset : null) ||
      data.publicData?.items?.find((item) => item.publicId === publicId) ||
      (publicDetail?.publicId === publicId ? publicDetail : null) ||
      { publicId, name: 'Public asset' };
    setReportAsset(asset);
    setReportQrToken(qrToken || '');
    setReportResult(null);
    setError(null);
    setTab('report');
  };

  const submitReport = (input) => {
    setError(null);
    setNotice(null);
    try {
      const result = submitFaultReport(input, {
        reporterKey: getReporterKey(),
        idempotencyKey: newIdempotencyKey(),
      });
      setReportResult(result);
      setPublicDetail(null);
      setReloadToken((value) => value + 1);
      return result;
    } catch (err) {
      setReportResult(null);
      setError(err);
      return null;
    }
  };

  const lookupReport = () => {
    setTrackingError(null);
    setTrackingResult(null);
    try {
      setTrackingResult(getFaultReportStatus(trackingCode));
    } catch (err) {
      setTrackingError(err);
    }
  };

  const handleCreateAsset = (input) => {
    const result = runService(
      () => createAsset(input, { idempotencyKey: newIdempotencyKey() }),
      (value) =>
        `Registered ${value?.asset?.publicId || 'asset'} and issued a QR lookup tag. The raw tag is only shown once.`
    );
    if (result?.qrPath) setIssuedQr({ assetPublicId: result.asset?.publicId, path: result.qrPath });
  };

  const handleUpdateAsset = (asset, input) => {
    runService(
      () => updateAsset(asset.id, input, { idempotencyKey: newIdempotencyKey() }),
      `Saved the record for ${asset.publicId}.`
    );
  };

  const handleTransitionAsset = (asset, to, reason) => {
    runService(
      () => transitionAssetStatus(asset.id, { to, reason }, { idempotencyKey: newIdempotencyKey() }),
      (value) => `${asset.publicId} is now ${value?.asset?.statusLabel || to}.`
    );
  };

  const handleScheduleInspection = (input) => {
    runService(
      () => scheduleInspection(input, { idempotencyKey: newIdempotencyKey() }),
      (value) => `Inspection ${value?.inspection?.publicId || ''} scheduled.`
    );
  };

  const handleStartInspection = (inspection) => {
    runService(
      () => startInspection(inspection.id, {}, { idempotencyKey: newIdempotencyKey() }),
      `Inspection ${inspection.publicId} started.`
    );
  };

  const handleCompleteInspection = (inspection, input) => {
    runService(
      () => completeInspection(inspection.id, input, { idempotencyKey: newIdempotencyKey() }),
      `Findings for ${inspection.publicId} recorded. A reviewer must verify them before they are published.`
    );
  };

  const handleVerifyInspection = (inspection, reason) => {
    runService(
      () => verifyInspection(inspection.id, { reason }, { idempotencyKey: newIdempotencyKey() }),
      `Inspection ${inspection.publicId} verified. Approved findings are now public.`
    );
  };

  const handleTriageReport = (report, input) => {
    runService(
      () => triageFaultReport(report.id, input, { idempotencyKey: newIdempotencyKey() }),
      `Report ${report.publicReference} triaged.`
    );
  };

  const handleReviewReport = (report, input) => {
    runService(
      () => reviewFaultReport(report.id, input, { idempotencyKey: newIdempotencyKey() }),
      input.decision === 'duplicate'
        ? `Report ${report.publicReference} linked as a duplicate.`
        : `Review decision recorded for ${report.publicReference}.`
    );
  };

  const handleReviewTriage = (suggestion, input) => {
    runService(
      () => reviewTriageSuggestion(suggestion.id, input, { idempotencyKey: newIdempotencyKey() }),
      'Human triage review recorded. The advisory ruleset never applies itself.'
    );
  };

  const handleCreateWorkOrder = (input) => {
    runService(
      () => createWorkOrder(input, { idempotencyKey: newIdempotencyKey() }),
      (value) => `Work order ${value?.workOrder?.publicReference || ''} created.`
    );
  };

  const handleTransitionOrder = (order, { to, reason }) => {
    runService(
      () => transitionWorkOrder(order.id, { to, reason }, { idempotencyKey: newIdempotencyKey() }),
      `Work order ${order.publicReference} moved to ${to.replaceAll('_', ' ')}.`
    );
  };

  const handleCompleteOrder = (order, input) => {
    runService(
      () => completeWorkOrder(order.id, input, { idempotencyKey: newIdempotencyKey() }),
      `Work order ${order.publicReference} completed. A reviewer must verify the repair before it is published.`
    );
  };

  const handleVerifyOrder = (order, input) => {
    runService(
      () => verifyWorkOrder(order.id, input, { idempotencyKey: newIdempotencyKey() }),
      `Repair ${order.publicReference} verified and added to the public repair history.`
    );
  };

  const handleIssueQr = (asset, input) => {
    const result = runService(
      () => issueQrToken(asset.id, input, { idempotencyKey: newIdempotencyKey() }),
      (value) =>
        value?.token
          ? `New QR lookup tag issued for ${asset.publicId}. Copy the link now; the raw tag cannot be shown again.`
          : 'QR tag processed.'
    );
    if (result?.path) setIssuedQr({ assetPublicId: asset.publicId, path: result.path });
  };

  const handleRevokeQr = (asset, token, reason) => {
    runService(
      () => revokeQrToken(token.id, { reason }),
      `QR tag ${token.tokenPrefix}… for ${asset.publicId} revoked.`
    );
  };

  const handleRetention = () => {
    runService(
      () => applyAssetRetentionPolicy({ dryRun: false }),
      (value) =>
        `Retention applied: ${value?.archivedReports || 0} report(s) archived and ${value?.clearedEvidence || 0} evidence file(s) cleared.`
    );
  };

  const handleMigrate = () => {
    runService(
      () => migrateAssetRegistry(),
      (value) => (value?.migrated ? `Schema migrated from version ${value.fromVersion}.` : 'Schema is already current.')
    );
  };

  const handleRollback = () => {
    runService(() => rollbackAssetRegistry(), 'Registry rolled back to the saved pre-migration snapshot.');
  };

  const pageError = error || data.publicError;
  const activeDetail = tagToken ? tagLookup?.asset || null : publicDetail;
  const activeDetailError = tagToken ? tagLookup?.error || null : publicDetailError;
  const tagView = Boolean(tagToken);

  return (
    <div className="section" style={{ padding: '2rem 1rem' }}>
      <div className="container" style={{ maxWidth: '1200px', margin: '0 auto' }}>
        <StandardPageHeader
          eyebrow="Municipal Public Assets"
          eyebrowIcon={<QrCode size={16} />}
          title="Public Asset Maintenance & Repair History Registry"
          subtitle="Scan a municipal asset tag to see its approved record and verified repair history, report a visible fault, and — for municipal staff — manage inspections, work orders, evidence and the audit trail."
          badgeText="QR tags are lookup keys only"
          badgeType="accent"
          align="left"
          maxWidth="940px"
        />

        <div
          role="note"
          style={{
            ...PANEL_STYLE,
            marginBottom: '1.25rem',
            display: 'flex',
            gap: '0.65rem',
            alignItems: 'flex-start',
            fontSize: '0.86rem',
            color: 'var(--text-secondary)',
          }}
        >
          <ShieldCheck size={18} aria-hidden="true" style={{ color: 'var(--accent-main)', flexShrink: 0, marginTop: 2 }} />
          <p style={{ margin: 0 }}>
            A QR tag only identifies a public asset. It never authorises a repair, inspection or record change: staff actions
            require a signed-in municipal role, jurisdiction scope and a short-lived signed action check. Public pages publish
            only approved fields; internal notes, precise locations, reporter keys and evidence files stay private.
          </p>
        </div>

        {!isOnline && <AssetOfflineNotice />}

        <div role="group" aria-label="Public asset registry sections" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <button
            type="button"
            className={tab === 'public' ? 'btn btn-primary' : 'btn btn-secondary'}
            aria-pressed={tab === 'public'}
            onClick={() => setTab('public')}
          >
            <QrCode size={15} aria-hidden="true" /> Public register
          </button>
          <button
            type="button"
            className={tab === 'report' ? 'btn btn-primary' : 'btn btn-secondary'}
            aria-pressed={tab === 'report'}
            onClick={() => setTab('report')}
          >
            <AlertCircle size={15} aria-hidden="true" /> Report a fault
          </button>
          {staff && (
            <button
              type="button"
              className={tab === 'staff' ? 'btn btn-primary' : 'btn btn-secondary'}
              aria-pressed={tab === 'staff'}
              onClick={() => setTab('staff')}
            >
              <ShieldAlert size={15} aria-hidden="true" /> Staff workspace
            </button>
          )}
        </div>

        {notice && tab !== 'staff' && (
          <div style={{ marginBottom: '1rem' }}>
            <AssetInlineAlert tone="success" title="Saved">
              {notice}
            </AssetInlineAlert>
          </div>
        )}
        {pageError && tab !== 'staff' && (
          <div style={{ marginBottom: '1rem' }}>
            <AssetRegistryErrorState error={pageError} onRetry={refresh} />
          </div>
        )}

        {tab === 'public' && (
          <section aria-labelledby="asset-public-section-heading" style={{ display: 'grid', gap: '1rem' }}>
            <h2
              id="asset-public-section-heading"
              style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}
            >
              Public asset register
            </h2>

            {tagView && activeDetailError && (
              <AssetRegistryErrorState
                error={{
                  ...activeDetailError,
                  userMessage:
                    'This QR tag is invalid, expired or has been revoked. Ask the municipal team for a current tag, or search the public register.',
                }}
                onRetry={() => navigate('/public-assets')}
                title="This asset tag cannot be opened"
              />
            )}

            {tagView && tagLookup && !tagLookup.error && (
              <div role="note" style={{ ...PANEL_STYLE, display: 'flex', gap: '0.55rem', alignItems: 'flex-start' }}>
                <QrCode size={18} aria-hidden="true" style={{ color: 'var(--accent-main)', flexShrink: 0, marginTop: 2 }} />
                <div>
                  <strong style={{ fontSize: '0.88rem' }}>Scanned municipal asset tag</strong>
                  <p style={{ margin: '0.15rem 0 0', fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
                    The tag is a lookup key only; it does not grant staff access. The approved public record is shown below.
                  </p>
                </div>
              </div>
            )}

            {tagView && activeDetail && (
              <>
                <AssetPublicDetail
                  asset={activeDetail}
                  onReport={(publicId) => openReportFor(publicId, tagToken)}
                  onBack={() => navigate('/public-assets')}
                />
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <Link className="btn btn-secondary" to="/public-assets">
                    Open the full public register
                  </Link>
                </div>
              </>
            )}

            {!tagView && activeDetail && (
              <AssetPublicDetail
                asset={activeDetail}
                onReport={(publicId) => openReportFor(publicId)}
                onBack={() => setPublicDetail(null)}
              />
            )}

            {!tagView && !activeDetail && activeDetailError && (
              <AssetRegistryErrorState
                error={activeDetailError}
                onRetry={() => setPublicDetailError(null)}
                title="This public asset record could not be loaded"
              />
            )}

            {!tagView && !activeDetail && !activeDetailError && data.publicData && (
              <>
                <AssetStaleDataNotice freshness={data.publicData.freshness} />
                <AssetPublicRegister
                  data={data.publicData}
                  jurisdictions={data.jurisdictions}
                  categories={data.categories}
                  wards={wards}
                  filters={publicFilters}
                  onFiltersChange={setPublicFilters}
                  onReset={() => {
                    setPublicFilters(DEFAULT_PUBLIC_FILTERS);
                    setPublicDetail(null);
                  }}
                  onPageChange={(page) => setPublicFilters((previous) => ({ ...previous, page }))}
                  onReport={(publicId) => openReportFor(publicId)}
                  onSelect={selectPublicAsset}
                  generatedAt={data.publicData.generatedAt}
                />
              </>
            )}

            {!tagView && !data.publicData && !data.publicError && <AssetRegistrySkeleton />}
          </section>
        )}

        {tab === 'report' && (
          <section aria-labelledby="asset-report-section-heading" style={{ display: 'grid', gap: '1rem' }}>
            <h2 id="asset-report-section-heading" style={{ margin: 0, fontSize: '1.2rem' }}>
              Report a visible fault on a public asset
            </h2>
            <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--text-secondary)', maxWidth: '74ch' }}>
              {reportAsset
                ? `You are reporting against ${reportAsset.publicId}${reportQrToken ? ' from a scanned QR tag' : ''}.`
                : 'Scan the tag on the asset or choose it from the public register. Reports are unverified observations and enter a municipal triage queue.'}
            </p>
            {reportQrToken && (
              <div
                role="note"
                style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.84rem', color: 'var(--text-secondary)' }}
              >
                <ShieldCheck size={17} aria-hidden="true" style={{ color: 'var(--accent-main)', flexShrink: 0, marginTop: 2 }} />
                <p style={{ margin: 0 }}>
                  This report is bound to the scanned tag. The tag identifies the asset only; it cannot change the asset, open a
                  work order or authorise a repair.
                </p>
              </div>
            )}
            <div style={PANEL_STYLE}>
              <AssetFaultReportForm
                asset={reportAsset}
                assets={data.publicOptions}
                qrToken={reportQrToken}
                onSubmit={submitReport}
                onCancel={() => {
                  setReportResult(null);
                  setReportAsset(null);
                  setReportQrToken('');
                }}
                serviceError={error}
                result={reportResult}
              />
            </div>

            <div style={{ ...PANEL_STYLE, gap: '0.6rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>Track an existing fault report</h3>
              <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
                Enter the public reference you received. Tracking returns only approved public status fields — never your device
                key, internal notes or other reporters&apos; details.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <label style={{ display: 'grid', gap: '0.3rem', fontSize: '0.82rem', fontWeight: 700 }}>
                  Public reference
                  <input
                    className="form-input"
                    value={trackingCode}
                    maxLength={40}
                    placeholder="AST-REP-XXXXXX"
                    onChange={(event) => setTrackingCode(event.target.value.toUpperCase())}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={lookupReport}
                  disabled={trackingCode.trim().length < 4}
                >
                  Check status
                </button>
              </div>
              {trackingError && (
                <p role="alert" style={{ margin: 0, color: 'var(--error, #ef4444)', fontSize: '0.84rem' }}>
                  {trackingError.userMessage || trackingError.message}
                </p>
              )}
              {trackingResult && (
                <div role="status" style={{ display: 'grid', gap: '0.4rem', fontSize: '0.84rem' }}>
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <strong>{trackingResult.publicReference}</strong>
                    <AssetStatusBadge
                      tone={trackingResult.state === 'resolved' ? 'success' : 'scheduled'}
                      label={trackingResult.stateLabel}
                      prefix="Status"
                    />
                  </div>
                  <span>
                    {trackingResult.categoryLabel} · severity {trackingResult.severityLabel}
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>{trackingResult.resolutionMessage}</span>
                  <span style={{ color: 'var(--text-tertiary)' }}>{trackingResult.source}</span>
                </div>
              )}
            </div>
          </section>
        )}

        {tab === 'staff' && (
          !staff ? (
            <AssetPermissionDenied />
          ) : data.staffLoadError ? (
            <AssetRegistryErrorState
              error={data.staffLoadError}
              onRetry={refresh}
              title="The staff workspace could not be loaded"
            />
          ) : !data.staffData ? (
            <AssetRegistrySkeleton label="Loading the municipal asset staff workspace…" />
          ) : (
            <AssetStaffWorkspace
              key={`asset-workspace-${reloadToken}`}
              data={data.staffData}
              permissions={permissions}
              staffTab={staffTab}
              onStaffTabChange={setStaffTab}
              onCreateAsset={handleCreateAsset}
              onUpdateAsset={handleUpdateAsset}
              onTransitionAsset={handleTransitionAsset}
              onScheduleInspection={handleScheduleInspection}
              onStartInspection={handleStartInspection}
              onCompleteInspection={handleCompleteInspection}
              onVerifyInspection={handleVerifyInspection}
              onTriageReport={handleTriageReport}
              onReviewReport={handleReviewReport}
              onReviewTriage={handleReviewTriage}
              onCreateWorkOrder={handleCreateWorkOrder}
              onTransitionOrder={handleTransitionOrder}
              onCompleteOrder={handleCompleteOrder}
              onVerifyOrder={handleVerifyOrder}
              onIssueQr={handleIssueQr}
              onRevokeQr={handleRevokeQr}
              onRetention={handleRetention}
              onMigrate={handleMigrate}
              onRollback={handleRollback}
              onRefresh={refresh}
              error={error}
              notice={notice}
              issuedQr={issuedQr}
            />
          )
        )}

        <footer
          style={{
            marginTop: '2rem',
            borderTop: '1px solid var(--border-light)',
            paddingTop: '0.9rem',
            fontSize: '0.78rem',
            color: 'var(--text-tertiary)',
          }}
        >
          <p style={{ margin: 0, display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <MapPin size={14} aria-hidden="true" /> Public locations use an approximately 1 km grid. This register is a local-first
            demonstration: changes are stored on this device and are not a substitute for a municipal record of decision. Staff
            actions are append-only in the audit trail; verified repair events are never edited in place.
          </p>
        </footer>
      </div>
    </div>
  );
}
