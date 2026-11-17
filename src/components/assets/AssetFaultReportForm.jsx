/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, Send, ShieldCheck, Trash2 } from 'lucide-react';
import {
  ALLOWED_EVIDENCE_MIME_TYPES,
  ASSET_API_LIMITS,
  FAULT_CATEGORIES,
  FAULT_CATEGORY_LABELS,
  REPORT_SEVERITIES,
  REPORT_SEVERITY_LABELS,
} from '../../services/assetRegistryConstants';

const initialForm = {
  assetPublicId: '',
  category: '',
  severity: 'minor',
  description: '',
  evidence: [],
};

const labelStyle = { display: 'grid', gap: '0.3rem', fontSize: '0.84rem', fontWeight: 700, color: 'var(--text-primary)' };
const errorStyle = { color: 'var(--error, #ef4444)', fontSize: '0.78rem', fontWeight: 500 };

export function validateAssetFaultReportForm(values = {}, { requireAsset = true } = {}) {
  const errors = {};
  if (requireAsset && !values.assetPublicId) {
    errors.assetPublicId = 'Choose the public asset you are reporting.';
  }
  if (!Object.values(FAULT_CATEGORIES).includes(values.category)) {
    errors.category = 'Choose the kind of visible problem you observed.';
  }
  if (!Object.values(REPORT_SEVERITIES).includes(values.severity)) {
    errors.severity = 'Choose how severe the problem looks.';
  }
  const description = String(values.description || '').trim();
  if (description.length < 20) {
    errors.description = 'Describe what you can see in at least 20 characters.';
  }
  if (description.length > ASSET_API_LIMITS.maxDescriptionLength) {
    errors.description = `Keep the description under ${ASSET_API_LIMITS.maxDescriptionLength} characters.`;
  }
  if (Array.isArray(values.evidence) && values.evidence.length > ASSET_API_LIMITS.maxAttachmentsPerReport) {
    errors.evidence = `Attach at most ${ASSET_API_LIMITS.maxAttachmentsPerReport} images.`;
  }
  return errors;
}

export default function AssetFaultReportForm({
  asset = null,
  assets = [],
  qrToken = '',
  onSubmit,
  onCancel,
  submitting = false,
  serviceError = null,
  result = null,
}) {
  const [values, setValues] = useState({ ...initialForm, assetPublicId: asset?.publicId || '' });
  const [errors, setErrors] = useState({});
  const [fileError, setFileError] = useState('');
  const requireAsset = !asset;

  const set = (field, value) => setValues((previous) => ({ ...previous, [field]: value }));

  const handleFile = (event) => {
    const file = event.target.files?.[0];
    setFileError('');
    if (!file) return;
    if (!ALLOWED_EVIDENCE_MIME_TYPES.includes(file.type)) {
      setFileError('Choose a JPEG, PNG or WebP image. SVG and documents are not accepted.');
      return;
    }
    if (file.size > ASSET_API_LIMITS.maxAttachmentBytes) {
      setFileError('The image is larger than 5 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      setValues((previous) => ({
        ...previous,
        evidence: [...previous.evidence, { mimeType: file.type, sizeBytes: file.size, url: reader.result, caption: '' }].slice(
          0,
          ASSET_API_LIMITS.maxAttachmentsPerReport
        ),
      }));
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const validation = validateAssetFaultReportForm(values, { requireAsset });
    setErrors(validation);
    if (Object.keys(validation).length > 0) return;
    onSubmit?.({
      qrToken: qrToken || undefined,
      assetPublicId: asset?.publicId || values.assetPublicId,
      category: values.category,
      severity: values.severity,
      description: values.description.trim(),
      evidence: values.evidence,
    });
  };

  if (result?.publicReport) {
    return (
      <section aria-labelledby="asset-report-success-heading" style={{ display: 'grid', gap: '0.75rem' }}>
        <div role="status" style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
          <CheckCircle2 size={22} aria-hidden="true" style={{ color: 'var(--success, #10b981)', flexShrink: 0 }} />
          <div>
            <h3 id="asset-report-success-heading" style={{ margin: 0, fontSize: '1.05rem' }}>
              {result.duplicate ? 'This report is already queued' : 'Fault report received'}
            </h3>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              {result.message} This is a citizen report, not a verified municipal inspection.
            </p>
          </div>
        </div>
        <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.6rem', margin: 0 }}>
          <div>
            <dt style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-tertiary)' }}>Public reference</dt>
            <dd style={{ margin: 0, fontFamily: 'var(--font-mono, monospace)', fontSize: '1.05rem', fontWeight: 800 }}>
              {result.publicReport.publicReference}
            </dd>
          </div>
          <div>
            <dt style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-tertiary)' }}>Status</dt>
            <dd style={{ margin: 0 }}>{result.publicReport.stateLabel}</dd>
          </div>
          <div>
            <dt style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-tertiary)' }}>Recorded</dt>
            <dd style={{ margin: 0 }}>{new Date(result.publicReport.createdAt).toLocaleString('en-IN')}</dd>
          </div>
        </dl>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Report another asset
          </button>
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate style={{ display: 'grid', gap: '0.8rem' }}>
      <div role="note" style={{ display: 'flex', gap: '0.55rem', alignItems: 'flex-start', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        <ShieldCheck size={18} aria-hidden="true" style={{ color: 'var(--accent-main)', flexShrink: 0, marginTop: 2 }} />
        <p style={{ margin: 0 }}>
          Reports are unverified observations. Do not include your name, phone number, email, Aadhaar or any personal identity
          number. Public status pages return only approved fields.
        </p>
      </div>

      <label style={labelStyle}>
        Public asset
        {asset ? (
          <input className="form-input" value={`${asset.publicId} — ${asset.name}`} readOnly />
        ) : (
          <select
            className="form-input"
            value={values.assetPublicId}
            aria-invalid={Boolean(errors.assetPublicId)}
            aria-describedby={errors.assetPublicId ? 'asset-public-id-error' : undefined}
            onChange={(event) => set('assetPublicId', event.target.value)}
          >
            <option value="">Choose a public asset</option>
            {assets.map((item) => (
              <option key={item.publicId} value={item.publicId}>
                {item.publicId} — {item.name} ({item.location.ward})
              </option>
            ))}
          </select>
        )}
        {errors.assetPublicId && (
          <span id="asset-public-id-error" style={errorStyle}>
            {errors.assetPublicId}
          </span>
        )}
      </label>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.7rem' }}>
        <label style={labelStyle}>
          Kind of problem
          <select
            className="form-input"
            value={values.category}
            aria-invalid={Boolean(errors.category)}
            onChange={(event) => set('category', event.target.value)}
          >
            <option value="">Choose a category</option>
            {Object.values(FAULT_CATEGORIES).map((category) => (
              <option key={category} value={category}>
                {FAULT_CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
          {errors.category && <span style={errorStyle}>{errors.category}</span>}
        </label>
        <label style={labelStyle}>
          How severe does it look?
          <select className="form-input" value={values.severity} onChange={(event) => set('severity', event.target.value)}>
            {Object.values(REPORT_SEVERITIES).map((severity) => (
              <option key={severity} value={severity}>
                {REPORT_SEVERITY_LABELS[severity]}
              </option>
            ))}
          </select>
          {errors.severity && <span style={errorStyle}>{errors.severity}</span>}
        </label>
      </div>

      <label style={labelStyle}>
        What can you see?
        <textarea
          className="form-input"
          rows={4}
          maxLength={ASSET_API_LIMITS.maxDescriptionLength}
          value={values.description}
          aria-invalid={Boolean(errors.description)}
          aria-describedby={errors.description ? 'asset-description-error' : 'asset-description-help'}
          onChange={(event) => set('description', event.target.value)}
        />
        <span id="asset-description-help" style={{ fontSize: '0.78rem', fontWeight: 500, color: 'var(--text-tertiary)' }}>
          Describe the visible problem, not who caused it. At least 20 characters. No personal contact details.
        </span>
        {errors.description && (
          <span id="asset-description-error" style={errorStyle}>
            {errors.description}
          </span>
        )}
      </label>

      <div style={{ display: 'grid', gap: '0.35rem' }}>
        <span style={{ ...labelStyle, gap: 0 }}>Photos (optional, up to {ASSET_API_LIMITS.maxAttachmentsPerReport})</span>
        <label className="btn btn-secondary" style={{ justifySelf: 'start', cursor: 'pointer' }}>
          <Camera size={15} aria-hidden="true" /> Add a JPEG, PNG or WebP photo
          <input type="file" accept={ALLOWED_EVIDENCE_MIME_TYPES.join(',')} onChange={handleFile} style={{ display: 'none' }} />
        </label>
        {fileError && <span style={errorStyle}>{fileError}</span>}
        {errors.evidence && <span style={errorStyle}>{errors.evidence}</span>}
        {values.evidence.length > 0 && (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '0.35rem' }}>
            {values.evidence.map((item, index) => (
              <li
                key={`${item.mimeType}-${index}`}
                style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.82rem', color: 'var(--text-secondary)' }}
              >
                <img src={item.url} alt="" width={40} height={40} style={{ borderRadius: '0.35rem', objectFit: 'cover' }} />
                <span>
                  Image {index + 1} · {(item.sizeBytes / 1024).toFixed(0)} KB · EXIF stripped on upload
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '0.2rem 0.5rem', fontSize: '0.76rem' }}
                  onClick={() =>
                    setValues((previous) => ({ ...previous, evidence: previous.evidence.filter((_, itemIndex) => itemIndex !== index) }))
                  }
                  aria-label={`Remove image ${index + 1}`}
                >
                  <Trash2 size={13} aria-hidden="true" /> Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {serviceError && (
        <div role="alert" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', color: 'var(--error, #ef4444)' }}>
          <AlertTriangle size={17} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
          <p style={{ margin: 0, fontSize: '0.86rem' }}>{serviceError.userMessage || serviceError.message}</p>
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          <Send size={15} aria-hidden="true" /> {submitting ? 'Sending…' : 'Submit fault report'}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
