import { MapPin, QrCode, Search, ShieldCheck, Wrench } from 'lucide-react';
import { AssetStatusBadge, AssetRegistryEmptyState } from './AssetStates';
import {
  ASSET_CONDITIONS,
  ASSET_CONDITION_LABELS,
  ASSET_STATUS,
  ASSET_STATUS_LABELS,
} from '../../services/assetRegistryConstants';

const panelStyle = {
  border: '1px solid var(--border-main)',
  borderRadius: '0.9rem',
  padding: '1rem',
  background: 'var(--surface-raised, var(--glass-bg))',
  display: 'grid',
  gap: '0.55rem',
};

const labelStyle = { display: 'grid', gap: '0.3rem', fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' };

const conditionTone = (condition) => condition || 'unknown';

const formatDate = (value) => (value ? new Date(value).toLocaleDateString('en-IN') : 'Not recorded');

export function AssetFilters({ filters = {}, onChange, onReset, jurisdictions = [], categories = [], wards = [], resultCount = null }) {
  const set = (field, value) => onChange?.({ ...filters, [field]: value, page: 1 });
  return (
    <fieldset className="asset-filter-panel">
      <legend>
        <Search size={16} aria-hidden="true" /> Filter the public asset register
      </legend>
      <div className="asset-filter-grid">
        <label style={labelStyle}>
          Search
          <input
            className="form-input"
            type="search"
            value={filters.search || ''}
            maxLength={80}
            placeholder="Asset name, reference, ward or landmark"
            onChange={(event) => set('search', event.target.value)}
          />
        </label>
        <label style={labelStyle}>
          Municipal jurisdiction
          <select className="form-input" value={filters.jurisdictionId || ''} onChange={(event) => set('jurisdictionId', event.target.value)}>
            <option value="">All supported jurisdictions</option>
            {jurisdictions.map((jurisdiction) => (
              <option key={jurisdiction.id} value={jurisdiction.id}>
                {jurisdiction.name} — {jurisdiction.state}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Ward
          <select className="form-input" value={filters.ward || ''} onChange={(event) => set('ward', event.target.value)}>
            <option value="">All wards</option>
            {wards.map((ward) => (
              <option key={ward} value={ward}>
                {ward}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Category
          <select className="form-input" value={filters.categoryId || ''} onChange={(event) => set('categoryId', event.target.value)}>
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Condition
          <select className="form-input" value={filters.condition || ''} onChange={(event) => set('condition', event.target.value)}>
            <option value="">All conditions</option>
            {Object.values(ASSET_CONDITIONS).map((condition) => (
              <option key={condition} value={condition}>
                {ASSET_CONDITION_LABELS[condition]}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Service status
          <select className="form-input" value={filters.status || ''} onChange={(event) => set('status', event.target.value)}>
            <option value="">All statuses</option>
            {Object.values(ASSET_STATUS).map((status) => (
              <option key={status} value={status}>
                {ASSET_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="asset-filter-actions">
        <button type="button" className="btn btn-secondary" onClick={onReset}>
          Reset filters
        </button>
        {typeof resultCount === 'number' && (
          <span role="status" style={{ fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
            {resultCount} public asset{resultCount === 1 ? '' : 's'} match this view.
          </span>
        )}
      </div>
    </fieldset>
  );
}

export function AssetSummaryCards({ summary }) {
  if (!summary) return null;
  const cards = [
    { label: 'Public assets in view', value: summary.totalAssets },
    { label: 'Repairs verified', value: summary.verifiedRepairs || 0 },
    { label: 'Open fault reports', value: summary.openFaults },
    { label: 'Categories represented', value: summary.byCategory?.length || 0 },
  ];
  return (
    <div className="asset-summary-grid">
      {cards.map((card) => (
        <div key={card.label} style={panelStyle}>
          <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-tertiary)' }}>{card.label}</span>
          <strong style={{ fontSize: '1.5rem', color: 'var(--text-primary)' }}>{card.value}</strong>
        </div>
      ))}
    </div>
  );
}

export function AssetPublicCard({ asset, onReport, onSelect }) {
  return (
    <article style={panelStyle} aria-labelledby={`asset-${asset.publicId}`}>
      <div className="asset-card-heading">
        <div>
          <h3 id={`asset-${asset.publicId}`} style={{ margin: 0, fontSize: '1.02rem', color: 'var(--text-primary)' }}>
            {asset.name}
          </h3>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
            {asset.publicId} · {asset.category.label} · {asset.location.ward}
          </p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
          <AssetStatusBadge tone={conditionTone(asset.condition)} label={`Condition: ${asset.conditionLabel}`} prefix="Condition" />
          <AssetStatusBadge tone={asset.status} label={`Service: ${asset.statusLabel}`} prefix="Service" />
        </div>
      </div>

      {asset.publicDescription && (
        <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--text-secondary)' }}>{asset.publicDescription}</p>
      )}

      <dl className="asset-detail-grid">
        <div>
          <dt>Approximate location</dt>
          <dd>
            <MapPin size={13} aria-hidden="true" /> {asset.location.landmark || asset.location.locality || asset.location.ward} ·{' '}
            {asset.location.grid} ({asset.location.precision})
          </dd>
        </div>
        <div>
          <dt>Next inspection</dt>
          <dd>{asset.inspectionTiming?.label || 'Not scheduled'}</dd>
        </div>
        <div>
          <dt>Last verified repair</dt>
          <dd>{asset.lastRepairAt ? formatDate(asset.lastRepairAt) : 'No verified repair recorded'}</dd>
        </div>
        <div>
          <dt>Public repair history</dt>
          <dd>
            {asset.repairCount} verified repair{asset.repairCount === 1 ? '' : 's'}
          </dd>
        </div>
      </dl>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        <button type="button" className="btn btn-secondary" onClick={() => onSelect?.(asset.publicId)}>
          View public history
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onReport?.(asset.publicId)}
          aria-label={`Report a fault for ${asset.publicId}`}
        >
          <Wrench size={15} aria-hidden="true" /> Report a fault
        </button>
      </div>
      <p style={{ margin: 0, fontSize: '0.76rem', color: 'var(--text-tertiary)' }}>
        Source: {asset.source}. Last updated {asset.updatedAt ? new Date(asset.updatedAt).toLocaleString('en-IN') : 'unknown'}.
      </p>
    </article>
  );
}

export default function AssetPublicRegister({
  data,
  jurisdictions = [],
  categories = [],
  wards = [],
  filters = {},
  onFiltersChange,
  onReset,
  onPageChange,
  onReport,
  onSelect,
  generatedAt,
}) {
  if (!data) return null;
  return (
    <section aria-labelledby="public-asset-register-heading" style={{ display: 'grid', gap: '1rem' }}>
      <div>
        <h2 id="public-asset-register-heading" style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-primary)' }}>
          Approved public asset register
        </h2>
        <p style={{ margin: '0.2rem 0 0', fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
          {data.summary.totalAssets} public asset{data.summary.totalAssets === 1 ? '' : 's'} in this view. Generated{' '}
          {generatedAt ? new Date(generatedAt).toLocaleString('en-IN') : 'just now'}. Only approved fields and verified repairs are
          published.
        </p>
      </div>

      <AssetFilters
        filters={filters}
        onChange={onFiltersChange}
        onReset={onReset}
        jurisdictions={jurisdictions}
        categories={categories}
        wards={wards}
        resultCount={data.summary.totalAssets}
      />
      <AssetSummaryCards summary={data.summary} />

      {data.items.length === 0 ? (
        <AssetRegistryEmptyState onReset={onReset} />
      ) : (
        <div style={{ display: 'grid', gap: '0.8rem' }}>
          {data.items.map((asset) => (
            <AssetPublicCard key={asset.publicId} asset={asset} onReport={onReport} onSelect={onSelect} />
          ))}
        </div>
      )}

      {data.totalPages > 1 && (
        <nav aria-label="Public asset register pages" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!data.hasPreviousPage}
            onClick={() => onPageChange?.(data.page - 1)}
          >
            Previous page
          </button>
          <span role="status" style={{ fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
            Page {data.page} of {data.totalPages} · {data.total} assets
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!data.hasNextPage}
            onClick={() => onPageChange?.(data.page + 1)}
          >
            Next page
          </button>
        </nav>
      )}
    </section>
  );
}

export function AssetPublicDetail({ asset, onReport, onBack }) {
  if (!asset) return null;
  const history = asset.maintenanceHistory || [];
  const inspections = asset.inspectionHistory || [];
  return (
    <section aria-labelledby="asset-public-detail-heading" style={{ display: 'grid', gap: '1rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <p style={{ margin: 0, fontSize: '0.8rem', fontWeight: 700, color: 'var(--accent-main)' }}>
            <QrCode size={14} aria-hidden="true" /> Public asset record
          </p>
          <h2 id="asset-public-detail-heading" style={{ margin: '0.1rem 0 0', fontSize: '1.35rem' }}>
            {asset.name}
          </h2>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
            {asset.publicId} · {asset.category.label} · {asset.location.ward}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          <AssetStatusBadge tone={asset.condition} label={`Condition: ${asset.conditionLabel}`} prefix="Condition" />
          <AssetStatusBadge tone={asset.status} label={`Service: ${asset.statusLabel}`} prefix="Service" />
        </div>
      </div>

      {onBack && (
        <button type="button" className="btn btn-secondary" style={{ justifySelf: 'start' }} onClick={onBack}>
          Back to the public register
        </button>
      )}

      <div style={{ ...panelStyle, display: 'grid', gap: '0.7rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
          <ShieldCheck size={18} aria-hidden="true" style={{ color: 'var(--accent-main)', flexShrink: 0, marginTop: 2 }} />
          <p style={{ margin: 0 }}>{asset.publicFieldsNote}</p>
        </div>
        <dl className="asset-detail-grid">
          <div>
            <dt>Approximate location</dt>
            <dd>
              {asset.location.landmark || asset.location.locality || asset.location.ward} · {asset.location.grid} (
              {asset.location.precision})
            </dd>
          </div>
          <div>
            <dt>Installed</dt>
            <dd>{asset.installedYear || 'Not recorded'}</dd>
          </div>
          <div>
            <dt>Last verified inspection</dt>
            <dd>{formatDate(asset.lastInspectedAt)}</dd>
          </div>
          <div>
            <dt>Next inspection</dt>
            <dd>{asset.inspectionTiming?.label || 'Not scheduled'}</dd>
          </div>
        </dl>
        {asset.canReportFault && (
          <button type="button" className="btn btn-primary" style={{ justifySelf: 'start' }} onClick={() => onReport?.(asset.publicId)}>
            <Wrench size={15} aria-hidden="true" /> Report a fault for this asset
          </button>
        )}
      </div>

      <div style={{ ...panelStyle, gap: '0.7rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.02rem' }}>Verified repair history</h3>
        {history.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.87rem', color: 'var(--text-secondary)' }}>
            No verified repair has been published for this asset yet.
          </p>
        ) : (
          <ol style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: '0.65rem' }}>
            {history.map((repair) => (
              <li key={repair.publicReference} style={{ fontSize: '0.87rem', color: 'var(--text-secondary)' }}>
                <strong style={{ color: 'var(--text-primary)' }}>{repair.publicReference}</strong> · completed{' '}
                {formatDate(repair.completedAt)}
                {repair.verifiedAt ? ` · verified ${formatDate(repair.verifiedAt)}` : ''}
                <p style={{ margin: '0.15rem 0 0' }}>{repair.publicSummary}</p>
                {repair.evidenceCount > 0 && (
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
                    {repair.evidenceCount} approved completion photo{repair.evidenceCount === 1 ? '' : 's'} on file.
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div style={{ ...panelStyle, gap: '0.7rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.02rem' }}>Verified inspection history</h3>
        {inspections.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.87rem', color: 'var(--text-secondary)' }}>
            No verified inspection has been published for this asset yet.
          </p>
        ) : (
          <ol style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: '0.65rem' }}>
            {inspections.map((inspection) => (
              <li key={`${inspection.publicId}-${inspection.completedAt}`} style={{ fontSize: '0.87rem', color: 'var(--text-secondary)' }}>
                <strong style={{ color: 'var(--text-primary)' }}>{inspection.typeLabel}</strong> · {formatDate(inspection.completedAt)} ·{' '}
                {inspection.conditionLabel}
                {inspection.summary && <p style={{ margin: '0.15rem 0 0' }}>{inspection.summary}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
