import { useState } from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ClipboardList,
  Database,
  FileSearch,
  Plus,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { AssetStatusBadge, AssetInlineAlert } from './AssetStates';
import {
  AssetForm,
  AssetStatusForm,
  InspectionCompleteForm,
  InspectionScheduleForm,
  ReasonForm,
  ReportTriageForm,
  TriageReviewForm,
  WorkOrderCompleteForm,
  WorkOrderForm,
} from './AssetForms';
import {
  ASSET_API_LIMITS,
  ASSET_STATUS_LABELS,
  FAULT_REPORT_STATES,
  FAULT_REPORT_STATE_LABELS,
  INSPECTION_STATES,
  INSPECTION_STATE_LABELS,
  TRIAGE_DECISION_LABELS,
  WORK_ORDER_STATES,
  WORK_ORDER_STATE_LABELS,
} from '../../services/assetRegistryConstants';

const panelStyle = {
  border: '1px solid var(--border-main)',
  borderRadius: '0.9rem',
  padding: '1rem',
  background: 'var(--surface-raised, var(--glass-bg))',
  display: 'grid',
  gap: '0.7rem',
};

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem' };
const thStyle = { textAlign: 'left', padding: '0.45rem', borderBottom: '1px solid var(--border-main)', color: 'var(--text-tertiary)' };
const tdStyle = { padding: '0.45rem', borderBottom: '1px solid var(--border-main)', color: 'var(--text-secondary)', verticalAlign: 'top' };
const smallButton = { padding: '0.28rem 0.55rem', fontSize: '0.76rem' };

const formatDate = (value) => (value ? new Date(value).toLocaleDateString('en-IN') : '—');
const formatDateTime = (value) => (value ? new Date(value).toLocaleString('en-IN') : '—');

function StaffTabButton({ active, onClick, icon: Icon, label, count }) {
  return (
    <button
      type="button"
      className={active ? 'btn btn-primary' : 'btn btn-secondary'}
      aria-pressed={active}
      onClick={onClick}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.5rem 0.9rem', fontSize: '0.86rem' }}
    >
      <Icon size={15} aria-hidden="true" /> {label}
      {typeof count === 'number' && (
        <span
          aria-label={`${count} item${count === 1 ? '' : 's'}`}
          style={{
            background: active ? 'rgba(255,255,255,0.22)' : 'var(--glass-bg)',
            borderRadius: '999px',
            padding: '0.05rem 0.4rem',
            fontSize: '0.72rem',
            fontWeight: 800,
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function SummaryCards({ summary }) {
  if (!summary) return null;
  const cards = [
    { label: 'Assets in scope', value: summary.totalAssets },
    { label: 'Suspended', value: summary.suspendedAssets },
    { label: 'Overdue inspections', value: summary.overdueInspections },
    { label: 'Open work orders', value: summary.openWorkOrders },
    { label: 'Pending reports', value: summary.pendingFaultReports },
    { label: 'Triage reviews', value: summary.pendingTriageReview },
  ];
  return (
    <div className="asset-summary-grid">
      {cards.map((card) => (
        <div key={card.label} style={panelStyle}>
          <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-tertiary)' }}>{card.label}</span>
          <strong style={{ fontSize: '1.45rem', color: 'var(--text-primary)' }}>{card.value}</strong>
        </div>
      ))}
    </div>
  );
}

export default function AssetStaffWorkspace({
  data,
  permissions = {},
  staffTab = 'overview',
  onStaffTabChange,
  onCreateAsset,
  onUpdateAsset,
  onTransitionAsset,
  onScheduleInspection,
  onStartInspection,
  onCompleteInspection,
  onVerifyInspection,
  onTriageReport,
  onReviewReport,
  onReviewTriage,
  onCreateWorkOrder,
  onTransitionOrder,
  onCompleteOrder,
  onVerifyOrder,
  onIssueQr,
  onRevokeQr,
  onRetention,
  onMigrate,
  onRollback,
  onRefresh,
  error = null,
  notice = null,
  issuedQr = null,
}) {
  const [action, setAction] = useState(null);
  const assets = data?.assets?.items || [];
  const inspections = data?.inspections?.items || [];
  const reports = data?.reports?.items || [];
  const orders = data?.orders?.items || [];
  const triage = data?.triage?.items || [];
  const summary = data?.summary;
  const selectedAsset = action?.asset || null;
  const close = () => setAction(null);

  const panel = (title, content) => (
    <div style={panelStyle} aria-live="polite">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '1rem' }}>{title}</h3>
        <button type="button" className="btn btn-secondary" style={smallButton} onClick={close}>
          Close form
        </button>
      </div>
      {content}
    </div>
  );

  return (
    <section aria-labelledby="asset-staff-heading" style={{ display: 'grid', gap: '1rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '0.6rem', alignItems: 'center' }}>
        <div>
          <h2 id="asset-staff-heading" style={{ margin: 0, fontSize: '1.2rem' }}>
            Municipal asset maintenance workspace
          </h2>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
            Scoped to your assigned jurisdiction. Every action is written to the hash-chained audit trail.
          </p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={onRefresh}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh workspace
        </button>
      </div>

      {notice && <AssetInlineAlert tone="success" title="Saved">{notice}</AssetInlineAlert>}
      {error && <AssetInlineAlert tone="error" title="The action could not be completed">{error.userMessage || error.message}</AssetInlineAlert>}
      {issuedQr && (
        <AssetInlineAlert tone="success" title="New QR lookup tag issued">
          <p style={{ margin: 0 }}>
            Print this tag for <strong>{issuedQr.assetPublicId}</strong>. It is a lookup key only and never grants a staff action.
          </p>
          <p style={{ margin: '0.35rem 0 0', wordBreak: 'break-all', fontFamily: 'var(--font-mono, monospace)' }}>
            {issuedQr.path}
          </p>
          <a className="btn btn-secondary" style={{ marginTop: '0.45rem', justifySelf: 'start' }} href={issuedQr.path}>
            Open the public tag page
          </a>
        </AssetInlineAlert>
      )}

      <SummaryCards summary={summary} />

      {data?.summary?.freshness?.isStale && (
        <AssetInlineAlert tone="warning" title="Register data may be stale">
          Last updated {formatDateTime(data.summary.freshness.lastUpdatedAt)}. Reconfirm inspection dates before planning work.
        </AssetInlineAlert>
      )}

      <div role="group" aria-label="Staff workspace sections" className="asset-tab-list">
        <StaffTabButton active={staffTab === 'overview'} onClick={() => onStaffTabChange?.('overview')} icon={ClipboardList} label="Overview" />
        <StaffTabButton active={staffTab === 'assets'} onClick={() => onStaffTabChange?.('assets')} icon={QrCode} label="Assets & QR" count={data?.assets?.total} />
        <StaffTabButton active={staffTab === 'inspections'} onClick={() => onStaffTabChange?.('inspections')} icon={CheckCircle2} label="Inspections" count={data?.inspections?.total} />
        <StaffTabButton active={staffTab === 'reports'} onClick={() => onStaffTabChange?.('reports')} icon={AlertCircle} label="Fault reports" count={data?.reports?.pendingCount} />
        <StaffTabButton active={staffTab === 'triage'} onClick={() => onStaffTabChange?.('triage')} icon={Bot} label="Triage review" count={data?.summary?.pendingTriageReview} />
        <StaffTabButton active={staffTab === 'orders'} onClick={() => onStaffTabChange?.('orders')} icon={Wrench} label="Work orders" count={data?.orders?.total} />
        <StaffTabButton active={staffTab === 'audit'} onClick={() => onStaffTabChange?.('audit')} icon={Database} label="Audit & operations" />
      </div>

      {staffTab === 'overview' && (
        <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          <div style={panelStyle}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>Inspection reminders</h3>
            {(data?.reminders?.overdue?.length || 0) === 0 && (data?.reminders?.upcoming?.length || 0) === 0 ? (
              <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>No inspections are overdue or due in the next {ASSET_API_LIMITS.inspectionReminderDays} days.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: '0.45rem', fontSize: '0.85rem' }}>
                {[...(data?.reminders?.overdue || []), ...(data?.reminders?.upcoming || [])].slice(0, 8).map((item) => (
                  <li key={item.assetId}>
                    <strong>{item.publicId}</strong> — {item.name}: {item.timing.label}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div style={panelStyle}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>Registry freshness</h3>
            <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
              {summary?.freshness?.source}. Last updated {formatDateTime(summary?.freshness?.lastUpdatedAt)}.
            </p>
            <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
              {summary?.overdueWorkOrders || 0} work order{summary?.overdueWorkOrders === 1 ? '' : 's'} past due ·{' '}
              {summary?.pendingInspectionVerification || 0} inspection{summary?.pendingInspectionVerification === 1 ? '' : 's'} awaiting verification.
            </p>
            <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-tertiary)' }}>
              Triage is advisory and versioned. Accept, edit or reject suggestions under Triage review; nothing is applied
              automatically.
            </p>
          </div>
        </div>
      )}

      {staffTab === 'assets' && (
        <div style={{ display: 'grid', gap: '1rem' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'space-between' }}>
            <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
              {data?.assets?.total || 0} registered asset{data?.assets?.total === 1 ? '' : 's'} in your scope.
            </p>
            {permissions.canCreate && (
              <button type="button" className="btn btn-primary" style={smallButton} onClick={() => setAction({ kind: 'create' })}>
                <Plus size={14} aria-hidden="true" /> Register asset
              </button>
            )}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle} aria-label="Registered public assets">
              <thead>
                <tr>
                  <th style={thStyle} scope="col">Public ID</th>
                  <th style={thStyle} scope="col">Asset</th>
                  <th style={thStyle} scope="col">Condition</th>
                  <th style={thStyle} scope="col">Service</th>
                  <th style={thStyle} scope="col">Inspection</th>
                  <th style={thStyle} scope="col">Open</th>
                  <th style={thStyle} scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={asset.id}>
                    <td style={tdStyle}>{asset.publicId}</td>
                    <td style={tdStyle}>
                      <strong style={{ color: 'var(--text-primary)' }}>{asset.name}</strong>
                      <div style={{ fontSize: '0.76rem' }}>{asset.category?.label} · {asset.location?.ward}</div>
                    </td>
                    <td style={tdStyle}><AssetStatusBadge tone={asset.condition} label={asset.conditionLabel} prefix="Condition" /></td>
                    <td style={tdStyle}><AssetStatusBadge tone={asset.status} label={ASSET_STATUS_LABELS[asset.status]} prefix="Service" /></td>
                    <td style={tdStyle}>{asset.inspectionTiming?.label}</td>
                    <td style={tdStyle}>{asset.counts?.pendingFaultReports || 0} reports · {asset.counts?.openWorkOrders || 0} orders</td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                        {permissions.canUpdate && (
                          <button type="button" className="btn btn-secondary" style={smallButton} onClick={() => setAction({ kind: 'edit', asset })}>
                            Edit
                          </button>
                        )}
                        {permissions.canRetire && (
                          <button type="button" className="btn btn-secondary" style={smallButton} onClick={() => setAction({ kind: 'status', asset })}>
                            Lifecycle
                          </button>
                        )}
                        {permissions.canIssueQr && (
                          <button type="button" className="btn btn-secondary" style={smallButton} onClick={() => setAction({ kind: 'qr', asset })}>
                            QR tags
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {action?.kind === 'create' && panel('Register a public asset', (
            <AssetForm
              jurisdictions={data.jurisdictions}
              categories={data.categories}
              locations={data.locations}
              onSubmit={onCreateAsset}
              onCancel={close}
              serviceError={error}
            />
          ))}
          {action?.kind === 'edit' && panel(`Edit ${selectedAsset.publicId}`, (
            <AssetForm
              asset={selectedAsset}
              jurisdictions={data.jurisdictions}
              categories={data.categories}
              locations={data.locations}
              onSubmit={(input) => onUpdateAsset(selectedAsset, input)}
              onCancel={close}
              serviceError={error}
            />
          ))}
          {action?.kind === 'status' && panel(`Lifecycle for ${selectedAsset.publicId}`, (
            <AssetStatusForm asset={selectedAsset} onSubmit={(to, reason) => onTransitionAsset(selectedAsset, to, reason)} onCancel={close} serviceError={error} />
          ))}
          {action?.kind === 'qr' && panel(`QR tags for ${selectedAsset.publicId}`, (
            <div style={{ display: 'grid', gap: '0.8rem' }}>
              <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
                QR tags are lookup keys only. They never grant access to staff actions. Only a hash of each tag is stored; copy the
                link when it is issued because the raw token cannot be shown again.
              </p>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-primary" style={smallButton} onClick={() => onIssueQr(selectedAsset, { revokeExisting: false, reason: 'Additional tag issued' })}>
                  Issue another tag
                </button>
                <button type="button" className="btn btn-secondary" style={smallButton} onClick={() => onIssueQr(selectedAsset, { revokeExisting: true, reason: 'Rotated by staff' })}>
                  Rotate and revoke existing tags
                </button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={tableStyle} aria-label={`QR tags for ${selectedAsset.publicId}`}>
                  <thead>
                    <tr>
                      <th style={thStyle} scope="col">Prefix</th>
                      <th style={thStyle} scope="col">State</th>
                      <th style={thStyle} scope="col">Issued</th>
                      <th style={thStyle} scope="col">Revoked</th>
                      <th style={thStyle} scope="col">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selectedAsset.qrTokens || []).map((token) => (
                      <tr key={token.id}>
                        <td style={tdStyle}>{token.tokenPrefix}…</td>
                        <td style={tdStyle}>{token.stateLabel}</td>
                        <td style={tdStyle}>{formatDate(token.issuedAt)}</td>
                        <td style={tdStyle}>{token.revokedAt ? `${formatDate(token.revokedAt)} — ${token.revokeReason}` : '—'}</td>
                        <td style={tdStyle}>
                          {permissions.canRevokeQr && token.state === 'active' && (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={smallButton}
                              onClick={() => setAction({ kind: 'revokeQr', asset: selectedAsset, token })}
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {action?.kind === 'revokeQr' && panel(`Revoke tag ${action.token.tokenPrefix}…`, (
            <ReasonForm title="Revoke this QR tag" label="Reason" minLength={10} onSubmit={(reason) => onRevokeQr(action.asset, action.token, reason)} onCancel={close} serviceError={error} />
          ))}
        </div>
      )}

      {staffTab === 'inspections' && (
        <div style={{ display: 'grid', gap: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
            <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
              Completed findings stay private until a reviewer verifies them. {data?.inspections?.pendingVerification || 0} awaiting verification.
            </p>
            {permissions.canScheduleInspection && (
              <button type="button" className="btn btn-primary" style={smallButton} onClick={() => setAction({ kind: 'scheduleInspection' })}>
                <Plus size={14} aria-hidden="true" /> Schedule inspection
              </button>
            )}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle} aria-label="Asset inspections">
              <thead>
                <tr>
                  <th style={thStyle} scope="col">Inspection</th>
                  <th style={thStyle} scope="col">Asset</th>
                  <th style={thStyle} scope="col">Type</th>
                  <th style={thStyle} scope="col">State</th>
                  <th style={thStyle} scope="col">Scheduled</th>
                  <th style={thStyle} scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {inspections.map((inspection) => (
                  <tr key={inspection.id}>
                    <td style={tdStyle}>{inspection.publicId}</td>
                    <td style={tdStyle}>{inspection.asset?.publicId || '—'}<div style={{ fontSize: '0.76rem' }}>{inspection.asset?.name}</div></td>
                    <td style={tdStyle}>{inspection.typeLabel}</td>
                    <td style={tdStyle}><AssetStatusBadge tone={inspection.state === 'verified' ? 'success' : 'scheduled'} label={INSPECTION_STATE_LABELS[inspection.state]} prefix="State" /></td>
                    <td style={tdStyle}>{formatDate(inspection.scheduledFor)}</td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                        {permissions.canCompleteInspection && [INSPECTION_STATES.SCHEDULED, INSPECTION_STATES.MISSED].includes(inspection.state) && (
                          <button type="button" className="btn btn-secondary" style={smallButton} onClick={() => onStartInspection(inspection)}>
                            Start
                          </button>
                        )}
                        {permissions.canCompleteInspection && [INSPECTION_STATES.SCHEDULED, INSPECTION_STATES.IN_PROGRESS].includes(inspection.state) && (
                          <button type="button" className="btn btn-secondary" style={smallButton} onClick={() => setAction({ kind: 'completeInspection', inspection })}>
                            Record findings
                          </button>
                        )}
                        {permissions.canVerifyInspection && inspection.state === INSPECTION_STATES.COMPLETED && (
                          <button type="button" className="btn btn-primary" style={smallButton} onClick={() => setAction({ kind: 'verifyInspection', inspection })}>
                            Verify
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {action?.kind === 'scheduleInspection' && panel('Schedule an asset inspection', (
            <InspectionScheduleForm assets={assets} onSubmit={onScheduleInspection} onCancel={close} serviceError={error} />
          ))}
          {action?.kind === 'completeInspection' && panel(`Record findings for ${action.inspection.publicId}`, (
            <InspectionCompleteForm inspection={action.inspection} onSubmit={(input) => onCompleteInspection(action.inspection, input)} onCancel={close} serviceError={error} />
          ))}
          {action?.kind === 'verifyInspection' && panel(`Verify ${action.inspection.publicId}`, (
            <ReasonForm title="Verify this inspection" label="Verification notes" minLength={5} onSubmit={(reason) => onVerifyInspection(action.inspection, reason)} onCancel={close} serviceError={error} />
          ))}
        </div>
      )}

      {staffTab === 'reports' && (
        <div style={{ display: 'grid', gap: '1rem' }}>
          <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
            Citizen reports are unverified observations. Reporter keys are retained only as a one-way hash for rate limiting and
            duplicate detection; they are never shown in public views.
          </p>
          <div style={{ display: 'grid', gap: '0.7rem' }}>
            {reports.map((report) => (
              <article key={report.id} style={panelStyle} aria-labelledby={`report-${report.publicReference}`}>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <div>
                    <h3 id={`report-${report.publicReference}`} style={{ margin: 0, fontSize: '0.95rem' }}>
                      {report.publicReference} — {report.categoryLabel}
                    </h3>
                    <p style={{ margin: '0.15rem 0 0', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                      {report.asset?.publicId} · {report.asset?.name} · submitted {formatDateTime(report.createdAt)}
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                    <AssetStatusBadge tone={report.severity === 'safety_hazard' ? 'poor' : 'scheduled'} label={report.severityLabel} prefix="Severity" />
                    <AssetStatusBadge tone="neutral" label={FAULT_REPORT_STATE_LABELS[report.state]} prefix="State" />
                  </div>
                </div>
                <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>{report.description}</p>
                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                  Reporter: {report.reporterLabel || 'Resident'} · evidence files: {report.evidenceIds?.length || 0} (staff only)
                  {report.priorityLabel ? ` · priority ${report.priorityLabel}` : ''}
                  {report.assignedTeam ? ` · team ${report.assignedTeam}` : ''}
                </p>
                {report.triageSuggestion && (
                  <div style={{ ...panelStyle, padding: '0.7rem', gap: '0.35rem' }}>
                    <strong style={{ fontSize: '0.84rem', display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                      <Bot size={14} aria-hidden="true" /> Advisory triage · {TRIAGE_DECISION_LABELS[report.triageSuggestion.decision]}
                    </strong>
                    <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{report.triageSuggestion.rationale}</p>
                    <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
                      Suggested priority: {report.triageSuggestion.suggestedPriority} · confidence{' '}
                      {Math.round((report.triageSuggestion.confidence || 0) * 100)}% · rules {report.triageSuggestion.rulesetVersion}
                    </p>
                    {report.triageSuggestion.decision === 'pending' && (
                      <button type="button" className="btn btn-secondary" style={{ ...smallButton, justifySelf: 'start' }} onClick={() => setAction({ kind: 'reviewTriage', item: report.triageSuggestion, report })}>
                        Review suggestion
                      </button>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                  {permissions.canTriage && report.state === FAULT_REPORT_STATES.SUBMITTED && (
                    <button type="button" className="btn btn-secondary" style={smallButton} onClick={() => setAction({ kind: 'triageReport', report })}>
                      Triage
                    </button>
                  )}
                  {permissions.canReviewReport && [FAULT_REPORT_STATES.SUBMITTED, FAULT_REPORT_STATES.TRIAGED].includes(report.state) && (
                    <>
                      <button type="button" className="btn btn-secondary" style={smallButton} onClick={() => setAction({ kind: 'rejectReport', report })}>
                        Reject
                      </button>
                      <button type="button" className="btn btn-secondary" style={smallButton} onClick={() => setAction({ kind: 'duplicateReport', report })}>
                        Mark duplicate
                      </button>
                    </>
                  )}
                  {permissions.canManageOrders && report.state === FAULT_REPORT_STATES.TRIAGED && (
                    <button type="button" className="btn btn-primary" style={smallButton} onClick={() => setAction({ kind: 'orderFromReport', report })}>
                      Raise work order
                    </button>
                  )}
                </div>
              </article>
            ))}
            {reports.length === 0 && <p style={{ margin: 0, color: 'var(--text-secondary)' }}>No fault reports match this queue.</p>}
          </div>
          {action?.kind === 'triageReport' && panel(`Triage ${action.report.publicReference}`, (
            <ReportTriageForm report={action.report} onSubmit={(input) => onTriageReport(action.report, input)} onCancel={close} serviceError={error} />
          ))}
          {action?.kind === 'reviewTriage' && panel(`Review advisory suggestion for ${action.report.publicReference}`, (
            <TriageReviewForm suggestion={action.item} onSubmit={(input) => onReviewTriage(action.item, input)} onCancel={close} serviceError={error} />
          ))}
          {action?.kind === 'rejectReport' && panel(`Reject ${action.report.publicReference}`, (
            <ReasonForm title="Close without action" label="Reason shown to the reviewer and audit trail" minLength={5} onSubmit={(reason) => onReviewReport(action.report, { decision: FAULT_REPORT_STATES.REJECTED, reason })} onCancel={close} serviceError={error} />
          ))}
          {action?.kind === 'duplicateReport' && panel(`Mark ${action.report.publicReference} as a duplicate`, (
            <div style={{ display: 'grid', gap: '0.6rem' }}>
              <label style={{ display: 'grid', gap: '0.3rem', fontSize: '0.84rem', fontWeight: 700 }}>
                Link to an existing report for the same asset (optional)
                <select
                  className="form-input"
                  value={action.duplicateOf || ''}
                  onChange={(event) => setAction({ ...action, duplicateOf: event.target.value })}
                >
                  <option value="">No exact link recorded</option>
                  {reports
                    .filter((item) => item.asset?.publicId === action.report.asset?.publicId && item.publicReference !== action.report.publicReference)
                    .map((item) => (
                      <option key={item.id} value={item.publicReference}>
                        {item.publicReference} — {item.categoryLabel}
                      </option>
                    ))}
                </select>
              </label>
              <ReasonForm
                title="Duplicate decision"
                label="Reason"
                minLength={5}
                onSubmit={(reason) =>
                  onReviewReport(action.report, {
                    decision: FAULT_REPORT_STATES.DUPLICATE,
                    reason,
                    duplicateOfReference: action.duplicateOf || undefined,
                  })
                }
                onCancel={close}
                serviceError={error}
              />
            </div>
          ))}
          {action?.kind === 'orderFromReport' && panel(`Raise a work order for ${action.report.publicReference}`, (
            <WorkOrderForm
              assets={assets}
              faultReports={reports}
              defaultAssetId={action.report.asset?.id || ''}
              onSubmit={onCreateWorkOrder}
              onCancel={close}
              serviceError={error}
            />
          ))}
        </div>
      )}

      {staffTab === 'triage' && (
        <div style={{ display: 'grid', gap: '1rem' }}>
          <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
            The ruleset is versioned and explainable. It can only suggest a priority; a human must accept, edit or reject every
            suggestion. It never retires assets, closes work orders or changes access.
          </p>
          {triage.map((item) => (
            <article key={item.id} style={panelStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: '0.92rem' }}>
                  {item.report?.publicReference} · {item.asset?.publicId}
                </strong>
                <AssetStatusBadge tone={item.decision === 'pending' ? 'due_soon' : 'success'} label={TRIAGE_DECISION_LABELS[item.decision]} prefix="Review" />
              </div>
              <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-secondary)' }}>{item.rationale}</p>
              <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.4rem', margin: 0, fontSize: '0.8rem' }}>
                <div><dt style={{ fontWeight: 700 }}>Ruleset</dt><dd style={{ margin: 0 }}>{item.rulesetVersion}</dd></div>
                <div><dt style={{ fontWeight: 700 }}>Suggested priority</dt><dd style={{ margin: 0 }}>{item.suggestedPriority}</dd></div>
                <div><dt style={{ fontWeight: 700 }}>Confidence</dt><dd style={{ margin: 0 }}>{Math.round((item.confidence || 0) * 100)}%</dd></div>
                <div><dt style={{ fontWeight: 700 }}>Runs automatically</dt><dd style={{ margin: 0 }}>{item.canApplyAutomatically ? 'Yes' : 'No — human review required'}</dd></div>
              </dl>
              {item.decision === 'pending' && permissions.canReviewTriage && (
                <button type="button" className="btn btn-secondary" style={{ ...smallButton, justifySelf: 'start' }} onClick={() => setAction({ kind: 'reviewTriage', item, report: item.report })}>
                  Review suggestion
                </button>
              )}
            </article>
          ))}
          {triage.length === 0 && <p style={{ margin: 0, color: 'var(--text-secondary)' }}>No triage suggestions are waiting.</p>}
          {action?.kind === 'reviewTriage' && panel(`Review advisory suggestion for ${action.report?.publicReference || 'report'}`, (
            <TriageReviewForm suggestion={action.item} onSubmit={(input) => onReviewTriage(action.item, input)} onCancel={close} serviceError={error} />
          ))}
        </div>
      )}

      {staffTab === 'orders' && (
        <div style={{ display: 'grid', gap: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
            <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
              Completion requires closure notes and at least one validated image. A reviewer verifies the repair before a public
              repair event is published.
            </p>
            {permissions.canManageOrders && (
              <button type="button" className="btn btn-primary" style={smallButton} onClick={() => setAction({ kind: 'createOrder' })}>
                <Plus size={14} aria-hidden="true" /> Create work order
              </button>
            )}
          </div>
          <div style={{ display: 'grid', gap: '0.7rem' }}>
            {orders.map((order) => (
              <article key={order.id} style={panelStyle}>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: '0.95rem' }}>{order.publicReference} — {order.title}</h3>
                    <p style={{ margin: '0.15rem 0 0', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                      {order.asset?.publicId} · {order.typeLabel} · {order.assignedTeam || 'Unassigned'} · due {formatDate(order.dueAt)}
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                    <AssetStatusBadge tone={order.priority === 'urgent' ? 'poor' : 'scheduled'} label={order.priorityLabel} prefix="Priority" />
                    <AssetStatusBadge tone={order.state === 'verified' ? 'success' : 'neutral'} label={WORK_ORDER_STATE_LABELS[order.state]} prefix="State" />
                  </div>
                </div>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{order.description}</p>
                {order.closureSummary && (
                  <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-tertiary)' }}>
                    Closure: {order.closureSummary} · evidence {order.evidence?.length || 0} file(s)
                  </p>
                )}
                <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                  {permissions.canManageOrders && [WORK_ORDER_STATES.ASSIGNED, WORK_ORDER_STATES.BLOCKED].includes(order.state) && (
                    <button type="button" className="btn btn-secondary" style={smallButton} onClick={() => onTransitionOrder(order, { to: WORK_ORDER_STATES.IN_PROGRESS })}>
                      Start work
                    </button>
                  )}
                  {permissions.canCompleteOrder && [WORK_ORDER_STATES.ASSIGNED, WORK_ORDER_STATES.IN_PROGRESS, WORK_ORDER_STATES.BLOCKED].includes(order.state) && (
                    <button type="button" className="btn btn-primary" style={smallButton} onClick={() => setAction({ kind: 'completeOrder', order })}>
                      Complete with evidence
                    </button>
                  )}
                  {permissions.canManageOrders && [WORK_ORDER_STATES.ASSIGNED, WORK_ORDER_STATES.IN_PROGRESS].includes(order.state) && (
                    <button type="button" className="btn btn-secondary" style={smallButton} onClick={() => setAction({ kind: 'cancelOrder', order })}>
                      Cancel
                    </button>
                  )}
                  {permissions.canVerifyOrder && order.state === WORK_ORDER_STATES.COMPLETED && (
                    <button type="button" className="btn btn-primary" style={smallButton} onClick={() => setAction({ kind: 'verifyOrder', order })}>
                      Verify repair
                    </button>
                  )}
                </div>
              </article>
            ))}
            {orders.length === 0 && <p style={{ margin: 0, color: 'var(--text-secondary)' }}>No work orders match this view.</p>}
          </div>
          {action?.kind === 'createOrder' && panel('Create a work order', (
            <WorkOrderForm assets={assets} faultReports={reports} onSubmit={onCreateWorkOrder} onCancel={close} serviceError={error} />
          ))}
          {action?.kind === 'completeOrder' && panel(`Complete ${action.order.publicReference}`, (
            <WorkOrderCompleteForm order={action.order} onSubmit={(input) => onCompleteOrder(action.order, input)} onCancel={close} serviceError={error} />
          ))}
          {action?.kind === 'cancelOrder' && panel(`Cancel ${action.order.publicReference}`, (
            <ReasonForm title="Cancel this work order" label="Cancellation reason" minLength={5} onSubmit={(reason) => onTransitionOrder(action.order, { to: WORK_ORDER_STATES.CANCELLED, reason })} onCancel={close} serviceError={error} />
          ))}
          {action?.kind === 'verifyOrder' && panel(`Verify ${action.order.publicReference}`, (
            <ReasonForm title="Verify the completed repair" label="Verification notes" minLength={5} onSubmit={(reason) => onVerifyOrder(action.order, { verificationNotes: reason })} onCancel={close} serviceError={error} />
          ))}
        </div>
      )}

      {staffTab === 'audit' && (
        <div style={{ display: 'grid', gap: '1rem' }}>
          <div style={panelStyle}>
            <h3 style={{ margin: 0, fontSize: '1rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <ShieldCheck size={16} aria-hidden="true" /> Hash-chained audit trail
            </h3>
            <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
              {data?.audit?.chain?.valid
                ? `Chain verified across ${data.audit.chain.total} event${data.audit.chain.total === 1 ? '' : 's'}.`
                : 'The audit chain failed its integrity check. Stop making changes and restore a trusted backup.'}
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle} aria-label="Asset registry audit trail">
                <thead>
                  <tr>
                    <th style={thStyle} scope="col">When</th>
                    <th style={thStyle} scope="col">Action</th>
                    <th style={thStyle} scope="col">Entity</th>
                    <th style={thStyle} scope="col">Actor</th>
                    <th style={thStyle} scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.audit?.items || []).map((event) => (
                    <tr key={event.id}>
                      <td style={tdStyle}>{formatDateTime(event.createdAt)}</td>
                      <td style={tdStyle}>{event.action}</td>
                      <td style={tdStyle}>{event.entityType}</td>
                      <td style={tdStyle}>{event.actorLabel}</td>
                      <td style={tdStyle}>{event.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={panelStyle}>
            <h3 style={{ margin: 0, fontSize: '1rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <Database size={16} aria-hidden="true" /> Migration, indexes and retention
            </h3>
            <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
              Schema version {data?.migration?.schemaVersion || 0} of {data?.migration?.latestSchemaVersion || 1} ·{' '}
              {data?.migration?.initialized ? 'initialised' : 'not initialised'} ·{' '}
              {data?.migration?.backupAvailable ? 'rollback snapshot available' : 'no rollback snapshot'}.
            </p>
            <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
              {(data?.migration?.indexes || []).map((index) => (
                <li key={index.name}>
                  <strong>{index.name}</strong> ({index.fields.join(', ')}): {index.purpose}
                </li>
              ))}
            </ul>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {permissions.canMigrate && (
                <button type="button" className="btn btn-secondary" style={smallButton} onClick={onMigrate}>
                  <FileSearch size={14} aria-hidden="true" /> Apply schema migration
                </button>
              )}
              {permissions.canMigrate && (
                <button type="button" className="btn btn-secondary" style={smallButton} onClick={onRollback}>
                  Roll back to snapshot
                </button>
              )}
              {permissions.canManageRetention && (
                <button type="button" className="btn btn-secondary" style={smallButton} onClick={onRetention}>
                  Apply retention policy
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
