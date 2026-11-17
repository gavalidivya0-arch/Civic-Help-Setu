import { useState } from 'react';
import { AlertTriangle, Camera, Check, Send, X } from 'lucide-react';
import {
  ALLOWED_EVIDENCE_MIME_TYPES,
  ASSET_API_LIMITS,
  ASSET_CONDITIONS,
  ASSET_CONDITION_LABELS,
  ASSET_STATUS,
  ASSET_STATUS_LABELS,
  INSPECTION_TYPES,
  INSPECTION_TYPE_LABELS,
  TRIAGE_DECISIONS,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_PRIORITY_LABELS,
  WORK_ORDER_TYPES,
  WORK_ORDER_TYPE_LABELS,
} from '../../services/assetRegistryConstants';

const labelStyle = { display: 'grid', gap: '0.3rem', fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' };
const errorStyle = { color: 'var(--error, #ef4444)', fontSize: '0.78rem', fontWeight: 500 };
const rowStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.7rem' };

function FormError({ error }) {
  if (!error) return null;
  return (
    <p role="alert" style={{ ...errorStyle, margin: 0 }}>
      {error.userMessage || error.message}
    </p>
  );
}

function EvidenceInput({ evidence, setEvidence, max = 1 }) {
  const [fileError, setFileError] = useState('');
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
      setEvidence((previous) =>
        [...previous, { mimeType: file.type, sizeBytes: file.size, url: reader.result, caption: '' }].slice(0, max)
      );
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  };
  return (
    <div style={{ display: 'grid', gap: '0.35rem' }}>
      <span style={{ ...labelStyle, gap: 0 }}>Completion photos (at least one is required)</span>
      <label className="btn btn-secondary" style={{ justifySelf: 'start', cursor: 'pointer' }}>
        <Camera size={15} aria-hidden="true" /> Add a validated image
        <input type="file" accept={ALLOWED_EVIDENCE_MIME_TYPES.join(',')} onChange={handleFile} style={{ display: 'none' }} />
      </label>
      {fileError && <span style={errorStyle}>{fileError}</span>}
      {evidence.length > 0 && (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '0.3rem' }}>
          {evidence.map((item, index) => (
            <li key={`${item.mimeType}-${index}`} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', fontSize: '0.8rem' }}>
              <img src={item.url} alt="" width={32} height={32} style={{ borderRadius: '0.3rem', objectFit: 'cover' }} />
              Image {index + 1} · {(item.sizeBytes / 1024).toFixed(0)} KB · EXIF stripped
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '0.15rem 0.45rem', fontSize: '0.74rem' }}
                onClick={() => setEvidence((previous) => previous.filter((_, itemIndex) => itemIndex !== index))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AssetForm({ asset = null, jurisdictions = [], categories = [], locations = [], onSubmit, onCancel, serviceError }) {
  const [values, setValues] = useState({
    jurisdictionId: asset?.jurisdictionId || jurisdictions[0]?.id || '',
    categoryId: asset?.categoryId || categories[0]?.id || '',
    locationId: asset?.locationId || '',
    name: asset?.name || '',
    publicDescription: asset?.publicDescription || '',
    internalNotes: asset?.internalNotes || '',
    installedOn: asset?.installedOn ? String(asset.installedOn).slice(0, 10) : '',
    inspectionIntervalDays: asset?.inspectionIntervalDays || 180,
    isPubliclyListed: asset?.isPubliclyListed !== false,
  });
  const set = (field, value) => setValues((previous) => ({ ...previous, [field]: value }));
  const filteredLocations = locations.filter((location) => location.jurisdictionId === values.jurisdictionId);

  return (
    <form
      noValidate
      style={{ display: 'grid', gap: '0.8rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.({
          ...values,
          name: values.name.trim(),
          publicDescription: values.publicDescription.trim(),
          internalNotes: values.internalNotes.trim(),
          installedOn: values.installedOn || undefined,
          inspectionIntervalDays: Number(values.inspectionIntervalDays),
        });
      }}
    >
      <div style={rowStyle}>
        <label style={labelStyle}>
          Jurisdiction
          <select
            className="form-input"
            value={values.jurisdictionId}
            disabled={Boolean(asset)}
            onChange={(event) => {
              set('jurisdictionId', event.target.value);
              set('locationId', '');
            }}
          >
            {jurisdictions.map((jurisdiction) => (
              <option key={jurisdiction.id} value={jurisdiction.id}>
                {jurisdiction.name}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Category
          <select className="form-input" value={values.categoryId} onChange={(event) => set('categoryId', event.target.value)}>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Location
          <select className="form-input" value={values.locationId} onChange={(event) => set('locationId', event.target.value)}>
            <option value="">Choose an existing location</option>
            {filteredLocations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.ward} — {location.landmark}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={labelStyle}>
        Public asset name
        <input
          className="form-input"
          value={values.name}
          maxLength={ASSET_API_LIMITS.maxNameLength}
          onChange={(event) => set('name', event.target.value)}
        />
      </label>
      <label style={labelStyle}>
        Public description
        <textarea
          className="form-input"
          rows={3}
          maxLength={ASSET_API_LIMITS.maxDescriptionLength}
          value={values.publicDescription}
          onChange={(event) => set('publicDescription', event.target.value)}
        />
      </label>
      <label style={labelStyle}>
        Internal notes (never published)
        <textarea
          className="form-input"
          rows={2}
          maxLength={ASSET_API_LIMITS.maxNotesLength}
          value={values.internalNotes}
          onChange={(event) => set('internalNotes', event.target.value)}
        />
      </label>
      <div style={rowStyle}>
        <label style={labelStyle}>
          Installed on
          <input className="form-input" type="date" value={values.installedOn} onChange={(event) => set('installedOn', event.target.value)} />
        </label>
        <label style={labelStyle}>
          Inspection interval (days)
          <input
            className="form-input"
            type="number"
            min={ASSET_API_LIMITS.minInspectionIntervalDays}
            max={ASSET_API_LIMITS.maxInspectionIntervalDays}
            value={values.inspectionIntervalDays}
            onChange={(event) => set('inspectionIntervalDays', event.target.value)}
          />
        </label>
        <label style={{ ...labelStyle, gridTemplateColumns: 'auto 1fr', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={values.isPubliclyListed}
            onChange={(event) => set('isPubliclyListed', event.target.checked)}
          />
          Publish in the public register
        </label>
      </div>
      <FormError error={serviceError} />
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button type="submit" className="btn btn-primary">
          <Send size={15} aria-hidden="true" /> {asset ? 'Save asset details' : 'Register asset and issue QR tag'}
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

export function AssetStatusForm({ asset, onSubmit, onCancel, serviceError }) {
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const next = {
    active: [ASSET_STATUS.SUSPENDED, ASSET_STATUS.RETIRED],
    suspended: [ASSET_STATUS.ACTIVE, ASSET_STATUS.RETIRED],
    retired: [ASSET_STATUS.ARCHIVED],
    archived: [ASSET_STATUS.RETIRED],
  }[asset.status] || [];
  return (
    <form
      noValidate
      style={{ display: 'grid', gap: '0.7rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!to) {
          setError('Choose the next lifecycle state.');
          return;
        }
        if (reason.trim().length < 5) {
          setError('Write at least 5 characters explaining the change.');
          return;
        }
        setError('');
        onSubmit?.(to, reason.trim());
      }}
    >
      <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
        Current state: <strong>{ASSET_STATUS_LABELS[asset.status]}</strong>. Allowed next states: {next.map((state) => ASSET_STATUS_LABELS[state]).join(', ') || 'none'}.
      </p>
      <label style={labelStyle}>
        Next state
        <select className="form-input" value={to} onChange={(event) => setTo(event.target.value)}>
          <option value="">Choose a state</option>
          {next.map((state) => (
            <option key={state} value={state}>
              {ASSET_STATUS_LABELS[state]}
            </option>
          ))}
        </select>
      </label>
      <label style={labelStyle}>
        Reason
        <textarea className="form-input" rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      {error && <span style={errorStyle}>{error}</span>}
      <FormError error={serviceError} />
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn-primary">
          <Check size={15} aria-hidden="true" /> Apply lifecycle change
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

export function InspectionScheduleForm({ assets = [], defaultAssetId = '', onSubmit, onCancel, serviceError }) {
  const [values, setValues] = useState(() => ({
    assetId: defaultAssetId || assets[0]?.id || '',
    type: INSPECTION_TYPES.ROUTINE,
    scheduledFor: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    internalNotes: '',
  }));
  return (
    <form
      noValidate
      style={{ display: 'grid', gap: '0.7rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.(values);
      }}
    >
      <label style={labelStyle}>
        Asset
        <select className="form-input" value={values.assetId} onChange={(event) => setValues({ ...values, assetId: event.target.value })}>
          {assets.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.publicId} — {asset.name}
            </option>
          ))}
        </select>
      </label>
      <div style={rowStyle}>
        <label style={labelStyle}>
          Inspection type
          <select className="form-input" value={values.type} onChange={(event) => setValues({ ...values, type: event.target.value })}>
            {Object.values(INSPECTION_TYPES).map((type) => (
              <option key={type} value={type}>
                {INSPECTION_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Scheduled date
          <input
            className="form-input"
            type="date"
            value={values.scheduledFor}
            onChange={(event) => setValues({ ...values, scheduledFor: event.target.value })}
          />
        </label>
      </div>
      <label style={labelStyle}>
        Internal notes (never published)
        <textarea
          className="form-input"
          rows={2}
          maxLength={ASSET_API_LIMITS.maxNotesLength}
          value={values.internalNotes}
          onChange={(event) => setValues({ ...values, internalNotes: event.target.value })}
        />
      </label>
      <FormError error={serviceError} />
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn-primary">
          Schedule inspection
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

export function InspectionCompleteForm({ inspection, onSubmit, onCancel, serviceError }) {
  const [findings, setFindings] = useState('');
  const [conditionAfter, setConditionAfter] = useState(inspection.conditionAfter || ASSET_CONDITIONS.FAIR);
  const [evidence, setEvidence] = useState([]);
  return (
    <form
      noValidate
      style={{ display: 'grid', gap: '0.7rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.({ findings, conditionAfter, evidence });
      }}
    >
      <label style={labelStyle}>
        Inspection findings
        <textarea
          className="form-input"
          rows={3}
          minLength={10}
          maxLength={ASSET_API_LIMITS.maxDescriptionLength}
          value={findings}
          onChange={(event) => setFindings(event.target.value)}
        />
      </label>
      <label style={labelStyle}>
        Condition after inspection
        <select className="form-input" value={conditionAfter} onChange={(event) => setConditionAfter(event.target.value)}>
          {Object.values(ASSET_CONDITIONS).map((condition) => (
            <option key={condition} value={condition}>
              {ASSET_CONDITION_LABELS[condition]}
            </option>
          ))}
        </select>
      </label>
      <EvidenceInput evidence={evidence} setEvidence={setEvidence} max={ASSET_API_LIMITS.maxEvidencePerOrder} />
      <FormError error={serviceError} />
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn-primary">
          Complete inspection
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

export function WorkOrderForm({ assets = [], faultReports = [], defaultAssetId = '', onSubmit, onCancel, serviceError }) {
  const [values, setValues] = useState(() => ({
    assetId: defaultAssetId || assets[0]?.id || '',
    faultReportId: '',
    title: '',
    description: '',
    type: WORK_ORDER_TYPES.REPAIR,
    priority: WORK_ORDER_PRIORITIES.MEDIUM,
    assignedTeam: '',
    dueAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    internalNotes: '',
  }));
  const set = (field, value) => setValues((previous) => ({ ...previous, [field]: value }));
  const matchingReports = faultReports.filter((report) => report.asset?.publicId === assets.find((asset) => asset.id === values.assetId)?.publicId);
  return (
    <form
      noValidate
      style={{ display: 'grid', gap: '0.7rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.({
          ...values,
          faultReportId: values.faultReportId || undefined,
          title: values.title.trim(),
          description: values.description.trim(),
          assignedTeam: values.assignedTeam.trim(),
        });
      }}
    >
      <div style={rowStyle}>
        <label style={labelStyle}>
          Asset
          <select className="form-input" value={values.assetId} onChange={(event) => set('assetId', event.target.value)}>
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.publicId} — {asset.name}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Linked citizen report (optional)
          <select className="form-input" value={values.faultReportId} onChange={(event) => set('faultReportId', event.target.value)}>
            <option value="">No linked report</option>
            {matchingReports.map((report) => (
              <option key={report.id} value={report.id}>
                {report.publicReference} — {report.categoryLabel}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Work type
          <select className="form-input" value={values.type} onChange={(event) => set('type', event.target.value)}>
            {Object.values(WORK_ORDER_TYPES).map((type) => (
              <option key={type} value={type}>
                {WORK_ORDER_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Priority
          <select className="form-input" value={values.priority} onChange={(event) => set('priority', event.target.value)}>
            {Object.values(WORK_ORDER_PRIORITIES).map((priority) => (
              <option key={priority} value={priority}>
                {WORK_ORDER_PRIORITY_LABELS[priority]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={labelStyle}>
        Title
        <input className="form-input" value={values.title} maxLength={120} onChange={(event) => set('title', event.target.value)} />
      </label>
      <label style={labelStyle}>
        Public work description
        <textarea
          className="form-input"
          rows={2}
          maxLength={ASSET_API_LIMITS.maxDescriptionLength}
          value={values.description}
          onChange={(event) => set('description', event.target.value)}
        />
      </label>
      <div style={rowStyle}>
        <label style={labelStyle}>
          Assigned team
          <input className="form-input" value={values.assignedTeam} maxLength={120} onChange={(event) => set('assignedTeam', event.target.value)} />
        </label>
        <label style={labelStyle}>
          Due date
          <input className="form-input" type="date" value={values.dueAt} onChange={(event) => set('dueAt', event.target.value)} />
        </label>
      </div>
      <label style={labelStyle}>
        Internal notes (never published)
        <textarea
          className="form-input"
          rows={2}
          maxLength={ASSET_API_LIMITS.maxNotesLength}
          value={values.internalNotes}
          onChange={(event) => set('internalNotes', event.target.value)}
        />
      </label>
      <FormError error={serviceError} />
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn-primary">
          Create work order
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

export function WorkOrderCompleteForm({ order, onSubmit, onCancel, serviceError }) {
  const [closureSummary, setClosureSummary] = useState('');
  const [publicSummary, setPublicSummary] = useState('');
  const [conditionAfter, setConditionAfter] = useState(order.conditionAfter || ASSET_CONDITIONS.GOOD);
  const [costInr, setCostInr] = useState('');
  const [evidence, setEvidence] = useState([]);
  return (
    <form
      noValidate
      style={{ display: 'grid', gap: '0.7rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.({
          closureSummary,
          publicSummary,
          conditionAfter,
          costInr: costInr === '' ? undefined : Number(costInr),
          evidence,
        });
      }}
    >
      <label style={labelStyle}>
        Internal closure notes
        <textarea
          className="form-input"
          rows={2}
          maxLength={ASSET_API_LIMITS.maxDescriptionLength}
          value={closureSummary}
          onChange={(event) => setClosureSummary(event.target.value)}
        />
      </label>
      <label style={labelStyle}>
        Public repair summary
        <textarea
          className="form-input"
          rows={2}
          maxLength={600}
          value={publicSummary}
          onChange={(event) => setPublicSummary(event.target.value)}
        />
      </label>
      <div style={rowStyle}>
        <label style={labelStyle}>
          Condition after repair
          <select className="form-input" value={conditionAfter} onChange={(event) => setConditionAfter(event.target.value)}>
            {Object.values(ASSET_CONDITIONS).map((condition) => (
              <option key={condition} value={condition}>
                {ASSET_CONDITION_LABELS[condition]}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Recorded cost (INR, optional)
          <input className="form-input" type="number" min="0" max="10000000" value={costInr} onChange={(event) => setCostInr(event.target.value)} />
        </label>
      </div>
      <EvidenceInput evidence={evidence} setEvidence={setEvidence} max={ASSET_API_LIMITS.maxEvidencePerOrder} />
      <FormError error={serviceError} />
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn-primary">
          Complete work order with evidence
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

export function ReportTriageForm({ report, onSubmit, onCancel, serviceError }) {
  const [values, setValues] = useState({
    priority: report.priority || 'medium',
    assignedTeam: report.assignedTeam || '',
    triageNotes: report.triageNotes || '',
  });
  return (
    <form
      noValidate
      style={{ display: 'grid', gap: '0.6rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.(values);
      }}
    >
      <div style={rowStyle}>
        <label style={labelStyle}>
          Priority
          <select className="form-input" value={values.priority} onChange={(event) => setValues({ ...values, priority: event.target.value })}>
            {Object.values(WORK_ORDER_PRIORITIES).map((priority) => (
              <option key={priority} value={priority}>
                {WORK_ORDER_PRIORITY_LABELS[priority]}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Assigned team
          <input
            className="form-input"
            value={values.assignedTeam}
            maxLength={120}
            onChange={(event) => setValues({ ...values, assignedTeam: event.target.value })}
          />
        </label>
      </div>
      <label style={labelStyle}>
        Internal triage notes
        <textarea
          className="form-input"
          rows={2}
          maxLength={ASSET_API_LIMITS.maxNotesLength}
          value={values.triageNotes}
          onChange={(event) => setValues({ ...values, triageNotes: event.target.value })}
        />
      </label>
      <FormError error={serviceError} />
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn-primary">
          Save triage
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

export function TriageReviewForm({ suggestion, onSubmit, onCancel, serviceError }) {
  const [decision, setDecision] = useState(TRIAGE_DECISIONS.ACCEPTED);
  const [editedPriority, setEditedPriority] = useState(suggestion.suggestedPriority || 'medium');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  return (
    <form
      noValidate
      style={{ display: 'grid', gap: '0.6rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        if (decision === TRIAGE_DECISIONS.REJECTED && reason.trim().length < 5) {
          setError('Explain why the suggestion was rejected.');
          return;
        }
        setError('');
        onSubmit?.({
          decision,
          editedPriority: decision === TRIAGE_DECISIONS.EDITED ? editedPriority : undefined,
          reason: reason.trim(),
        });
      }}
    >
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {[TRIAGE_DECISIONS.ACCEPTED, TRIAGE_DECISIONS.EDITED, TRIAGE_DECISIONS.REJECTED].map((option) => (
          <button
            key={option}
            type="button"
            className={decision === option ? 'btn btn-primary' : 'btn btn-secondary'}
            aria-pressed={decision === option}
            onClick={() => setDecision(option)}
          >
            {option === 'accepted' ? 'Accept suggestion' : option === 'edited' ? 'Edit priority' : 'Reject suggestion'}
          </button>
        ))}
      </div>
      {decision === TRIAGE_DECISIONS.EDITED && (
        <label style={labelStyle}>
          Human-chosen priority
          <select className="form-input" value={editedPriority} onChange={(event) => setEditedPriority(event.target.value)}>
            {Object.values(WORK_ORDER_PRIORITIES).map((priority) => (
              <option key={priority} value={priority}>
                {WORK_ORDER_PRIORITY_LABELS[priority]}
              </option>
            ))}
          </select>
        </label>
      )}
      <label style={labelStyle}>
        Reviewer reason (required when rejecting)
        <textarea className="form-input" rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      {error && <span style={errorStyle}>{error}</span>}
      <FormError error={serviceError} />
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn-primary">
          Record human review
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

export function ReasonForm({ title = 'Record a decision', label = 'Reason', minLength = 5, onSubmit, onCancel, serviceError }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  return (
    <form
      noValidate
      style={{ display: 'grid', gap: '0.6rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        if (reason.trim().length < minLength) {
          setError(`Write at least ${minLength} characters explaining this decision.`);
          return;
        }
        setError('');
        onSubmit?.(reason.trim());
      }}
    >
      <h4 style={{ margin: 0, fontSize: '0.95rem' }}>{title}</h4>
      <label style={labelStyle}>
        {label}
        <textarea className="form-input" rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      {error && <span style={errorStyle}>{error}</span>}
      <FormError error={serviceError} />
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn-primary">
          Submit
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          <X size={14} aria-hidden="true" /> Cancel
        </button>
      </div>
    </form>
  );
}

export { AlertTriangle };
