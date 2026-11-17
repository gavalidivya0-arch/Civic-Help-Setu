/**
 * Domain vocabulary for the QR-Based Public Asset Maintenance and Repair
 * History Registry (#750).
 *
 * This file is the single source of truth for storage keys, roles,
 * capabilities, states, allowed transitions, limits and error codes. The
 * service layer enforces these values; UI components only translate labels.
 */

export const ASSET_REGISTRY_SCHEMA_VERSION = 1;

export const ASSET_STORAGE_KEYS = Object.freeze({
  meta: 'civicbridge_asset_registry_meta_v1',
  categories: 'civicbridge_asset_categories_v1',
  locations: 'civicbridge_asset_locations_v1',
  assets: 'civicbridge_asset_registry_v1',
  inspections: 'civicbridge_asset_inspections_v1',
  reports: 'civicbridge_asset_fault_reports_v1',
  workOrders: 'civicbridge_asset_work_orders_v1',
  repairEvents: 'civicbridge_asset_repair_events_v1',
  evidence: 'civicbridge_asset_repair_evidence_v1',
  qrTokens: 'civicbridge_asset_qr_tokens_v1',
  triage: 'civicbridge_asset_triage_suggestions_v1',
  audit: 'civicbridge_asset_audit_events_v1',
  idempotency: 'civicbridge_asset_idempotency_v1',
  rateLimit: 'civicbridge_asset_rate_limit_v1',
  actionNonces: 'civicbridge_asset_action_nonces_v1',
  migrationBackup: 'civicbridge_asset_migration_backup_v1',
  legacyAssets: 'civicbridge_assets_v1',
  legacyReports: 'civicbridge_asset_reports_v1',
});

export const ASSET_COLLECTION_KEYS = Object.freeze([
  ASSET_STORAGE_KEYS.categories,
  ASSET_STORAGE_KEYS.locations,
  ASSET_STORAGE_KEYS.assets,
  ASSET_STORAGE_KEYS.inspections,
  ASSET_STORAGE_KEYS.reports,
  ASSET_STORAGE_KEYS.workOrders,
  ASSET_STORAGE_KEYS.repairEvents,
  ASSET_STORAGE_KEYS.evidence,
  ASSET_STORAGE_KEYS.qrTokens,
  ASSET_STORAGE_KEYS.triage,
  ASSET_STORAGE_KEYS.audit,
]);

export const ASSET_ROLES = Object.freeze({
  CITIZEN: 'citizen',
  OPERATOR: 'operator',
  REVIEWER: 'reviewer',
  ADMIN: 'admin',
});

export const STAFF_ASSET_ROLES = Object.freeze([
  ASSET_ROLES.OPERATOR,
  ASSET_ROLES.REVIEWER,
  ASSET_ROLES.ADMIN,
]);

export const ASSET_ROLE_LABELS = Object.freeze({
  [ASSET_ROLES.CITIZEN]: 'Citizen',
  [ASSET_ROLES.OPERATOR]: 'Maintenance operator',
  [ASSET_ROLES.REVIEWER]: 'Maintenance reviewer',
  [ASSET_ROLES.ADMIN]: 'Registry administrator',
});

/**
 * Least-privilege capability table. Role checks happen inside the service,
 * not only in the page or route guard.
 */
export const ASSET_CAPABILITIES = Object.freeze({
  'asset.public.read': {
    roles: STAFF_ASSET_ROLES.concat(ASSET_ROLES.CITIZEN),
    description: 'Read approved public asset facts and verified repair history',
  },
  'asset.staff.read': {
    roles: STAFF_ASSET_ROLES,
    description: 'Read the staff registry, including private notes and evidence metadata',
  },
  'asset.create': {
    roles: [ASSET_ROLES.OPERATOR, ASSET_ROLES.ADMIN],
    description: 'Register a public asset and its first QR tag',
  },
  'asset.update': {
    roles: [ASSET_ROLES.OPERATOR, ASSET_ROLES.ADMIN],
    description: 'Correct asset details without changing lifecycle state',
  },
  'asset.retire': {
    roles: [ASSET_ROLES.REVIEWER, ASSET_ROLES.ADMIN],
    description: 'Suspend, retire, archive or restore an asset',
  },
  'asset.qr.issue': {
    roles: [ASSET_ROLES.OPERATOR, ASSET_ROLES.ADMIN],
    description: 'Issue or rotate a public QR lookup tag',
  },
  'asset.qr.revoke': {
    roles: [ASSET_ROLES.ADMIN],
    description: 'Revoke a QR tag that should no longer resolve',
  },
  'asset.action.issue': {
    roles: STAFF_ASSET_ROLES,
    description: 'Create a short-lived signed staff action token',
  },
  'asset.action.consume': {
    roles: STAFF_ASSET_ROLES,
    description: 'Consume a signed staff action token',
  },
  'inspection.schedule': {
    roles: [ASSET_ROLES.OPERATOR, ASSET_ROLES.ADMIN],
    description: 'Schedule an asset inspection',
  },
  'inspection.complete': {
    roles: [ASSET_ROLES.OPERATOR, ASSET_ROLES.ADMIN],
    description: 'Record inspection findings and evidence',
  },
  'inspection.verify': {
    roles: [ASSET_ROLES.REVIEWER, ASSET_ROLES.ADMIN],
    description: 'Verify a completed inspection and update the public condition',
  },
  'report.submit': {
    roles: STAFF_ASSET_ROLES.concat(ASSET_ROLES.CITIZEN),
    description: 'Submit a citizen fault report',
  },
  'report.triage': {
    roles: [ASSET_ROLES.OPERATOR, ASSET_ROLES.REVIEWER, ASSET_ROLES.ADMIN],
    description: 'Triage a citizen fault report',
  },
  'report.review': {
    roles: [ASSET_ROLES.REVIEWER, ASSET_ROLES.ADMIN],
    description: 'Reject or mark a fault report as a duplicate',
  },
  'order.manage': {
    roles: [ASSET_ROLES.OPERATOR, ASSET_ROLES.ADMIN],
    description: 'Create, assign and update work orders',
  },
  'order.complete': {
    roles: [ASSET_ROLES.OPERATOR, ASSET_ROLES.ADMIN],
    description: 'Complete a work order with closure evidence',
  },
  'order.verify': {
    roles: [ASSET_ROLES.REVIEWER, ASSET_ROLES.ADMIN],
    description: 'Verify and close a completed work order',
  },
  'triage.review': {
    roles: [ASSET_ROLES.OPERATOR, ASSET_ROLES.REVIEWER, ASSET_ROLES.ADMIN],
    description: 'Accept, edit or reject an automated triage suggestion',
  },
  'audit.read': {
    roles: [ASSET_ROLES.REVIEWER, ASSET_ROLES.ADMIN],
    description: 'Read the append-only asset audit trail',
  },
  'retention.manage': {
    roles: [ASSET_ROLES.ADMIN],
    description: 'Apply retention and archival policy',
  },
  'registry.migrate': {
    roles: [ASSET_ROLES.ADMIN],
    description: 'Run, inspect or roll back a registry migration',
  },
});

export const ASSET_CONDITIONS = Object.freeze({
  GOOD: 'good',
  FAIR: 'fair',
  POOR: 'poor',
  OUT_OF_SERVICE: 'out_of_service',
  UNKNOWN: 'unknown',
});

export const ASSET_CONDITION_LABELS = Object.freeze({
  [ASSET_CONDITIONS.GOOD]: 'Good — usable',
  [ASSET_CONDITIONS.FAIR]: 'Fair — monitor',
  [ASSET_CONDITIONS.POOR]: 'Poor — repair needed',
  [ASSET_CONDITIONS.OUT_OF_SERVICE]: 'Out of service — unsafe to use',
  [ASSET_CONDITIONS.UNKNOWN]: 'Not assessed',
});

export const ASSET_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  RETIRED: 'retired',
  ARCHIVED: 'archived',
});

export const ASSET_STATUS_LABELS = Object.freeze({
  [ASSET_STATUS.ACTIVE]: 'In service',
  [ASSET_STATUS.SUSPENDED]: 'Suspended — safety hold',
  [ASSET_STATUS.RETIRED]: 'Retired from service',
  [ASSET_STATUS.ARCHIVED]: 'Archived record',
});

export const ASSET_STATUS_TRANSITIONS = Object.freeze({
  [ASSET_STATUS.ACTIVE]: [ASSET_STATUS.SUSPENDED, ASSET_STATUS.RETIRED],
  [ASSET_STATUS.SUSPENDED]: [ASSET_STATUS.ACTIVE, ASSET_STATUS.RETIRED],
  [ASSET_STATUS.RETIRED]: [ASSET_STATUS.ARCHIVED],
  [ASSET_STATUS.ARCHIVED]: [ASSET_STATUS.RETIRED],
});

export const INSPECTION_STATES = Object.freeze({
  SCHEDULED: 'scheduled',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  VERIFIED: 'verified',
  MISSED: 'missed',
  CANCELLED: 'cancelled',
});

export const INSPECTION_STATE_LABELS = Object.freeze({
  [INSPECTION_STATES.SCHEDULED]: 'Scheduled',
  [INSPECTION_STATES.IN_PROGRESS]: 'In progress',
  [INSPECTION_STATES.COMPLETED]: 'Completed — awaiting verification',
  [INSPECTION_STATES.VERIFIED]: 'Verified',
  [INSPECTION_STATES.MISSED]: 'Missed',
  [INSPECTION_STATES.CANCELLED]: 'Cancelled',
});

export const INSPECTION_STATE_TRANSITIONS = Object.freeze({
  [INSPECTION_STATES.SCHEDULED]: [INSPECTION_STATES.IN_PROGRESS, INSPECTION_STATES.COMPLETED, INSPECTION_STATES.MISSED, INSPECTION_STATES.CANCELLED],
  [INSPECTION_STATES.IN_PROGRESS]: [INSPECTION_STATES.COMPLETED, INSPECTION_STATES.CANCELLED],
  [INSPECTION_STATES.COMPLETED]: [INSPECTION_STATES.VERIFIED],
  [INSPECTION_STATES.VERIFIED]: [],
  [INSPECTION_STATES.MISSED]: [INSPECTION_STATES.SCHEDULED, INSPECTION_STATES.CANCELLED],
  [INSPECTION_STATES.CANCELLED]: [INSPECTION_STATES.SCHEDULED],
});

export const INSPECTION_TYPES = Object.freeze({
  ROUTINE: 'routine',
  SAFETY: 'safety',
  CITIZEN_FOLLOW_UP: 'citizen_follow_up',
  POST_REPAIR: 'post_repair',
  SEASONAL: 'seasonal',
});

export const INSPECTION_TYPE_LABELS = Object.freeze({
  [INSPECTION_TYPES.ROUTINE]: 'Routine condition check',
  [INSPECTION_TYPES.SAFETY]: 'Safety inspection',
  [INSPECTION_TYPES.CITIZEN_FOLLOW_UP]: 'Citizen report follow-up',
  [INSPECTION_TYPES.POST_REPAIR]: 'Post-repair check',
  [INSPECTION_TYPES.SEASONAL]: 'Seasonal inspection',
});

export const FAULT_REPORT_STATES = Object.freeze({
  SUBMITTED: 'submitted',
  TRIAGED: 'triaged',
  CONVERTED: 'converted',
  RESOLVED: 'resolved',
  REJECTED: 'rejected',
  DUPLICATE: 'duplicate',
});

export const FAULT_REPORT_STATE_LABELS = Object.freeze({
  [FAULT_REPORT_STATES.SUBMITTED]: 'Submitted — awaiting triage',
  [FAULT_REPORT_STATES.TRIAGED]: 'Triaged — awaiting work order',
  [FAULT_REPORT_STATES.CONVERTED]: 'Work order raised',
  [FAULT_REPORT_STATES.RESOLVED]: 'Repair verified and resolved',
  [FAULT_REPORT_STATES.REJECTED]: 'Closed without action',
  [FAULT_REPORT_STATES.DUPLICATE]: 'Linked to an existing report',
});

export const FAULT_REPORT_STATE_TRANSITIONS = Object.freeze({
  [FAULT_REPORT_STATES.SUBMITTED]: [FAULT_REPORT_STATES.TRIAGED, FAULT_REPORT_STATES.REJECTED, FAULT_REPORT_STATES.DUPLICATE],
  [FAULT_REPORT_STATES.TRIAGED]: [FAULT_REPORT_STATES.CONVERTED, FAULT_REPORT_STATES.REJECTED, FAULT_REPORT_STATES.DUPLICATE],
  [FAULT_REPORT_STATES.CONVERTED]: [FAULT_REPORT_STATES.RESOLVED],
  [FAULT_REPORT_STATES.RESOLVED]: [],
  [FAULT_REPORT_STATES.REJECTED]: [],
  [FAULT_REPORT_STATES.DUPLICATE]: [],
});

export const FAULT_CATEGORIES = Object.freeze({
  DAMAGE: 'damage',
  VANDALISM: 'vandalism',
  SAFETY_HAZARD: 'safety_hazard',
  WEAR: 'wear',
  MISSING_PART: 'missing_part',
  CLEANLINESS: 'cleanliness',
  OTHER: 'other',
});

export const FAULT_CATEGORY_LABELS = Object.freeze({
  [FAULT_CATEGORIES.DAMAGE]: 'Broken or damaged',
  [FAULT_CATEGORIES.VANDALISM]: 'Vandalism or graffiti',
  [FAULT_CATEGORIES.SAFETY_HAZARD]: 'Safety hazard',
  [FAULT_CATEGORIES.WEAR]: 'Worn out',
  [FAULT_CATEGORIES.MISSING_PART]: 'Missing part',
  [FAULT_CATEGORIES.CLEANLINESS]: 'Needs cleaning',
  [FAULT_CATEGORIES.OTHER]: 'Other issue',
});

export const REPORT_SEVERITIES = Object.freeze({
  COSMETIC: 'cosmetic',
  MINOR: 'minor',
  MAJOR: 'major',
  SAFETY_HAZARD: 'safety_hazard',
});

export const REPORT_SEVERITY_LABELS = Object.freeze({
  [REPORT_SEVERITIES.COSMETIC]: 'Cosmetic — still usable',
  [REPORT_SEVERITIES.MINOR]: 'Minor — usable with care',
  [REPORT_SEVERITIES.MAJOR]: 'Major — difficult to use',
  [REPORT_SEVERITIES.SAFETY_HAZARD]: 'Safety hazard — do not use',
});

export const WORK_ORDER_STATES = Object.freeze({
  DRAFT: 'draft',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in_progress',
  BLOCKED: 'blocked',
  COMPLETED: 'completed',
  VERIFIED: 'verified',
  CANCELLED: 'cancelled',
});

export const WORK_ORDER_STATE_LABELS = Object.freeze({
  [WORK_ORDER_STATES.DRAFT]: 'Draft',
  [WORK_ORDER_STATES.ASSIGNED]: 'Assigned',
  [WORK_ORDER_STATES.IN_PROGRESS]: 'In progress',
  [WORK_ORDER_STATES.BLOCKED]: 'Blocked',
  [WORK_ORDER_STATES.COMPLETED]: 'Completed — awaiting verification',
  [WORK_ORDER_STATES.VERIFIED]: 'Verified and closed',
  [WORK_ORDER_STATES.CANCELLED]: 'Cancelled',
});

export const WORK_ORDER_STATE_TRANSITIONS = Object.freeze({
  [WORK_ORDER_STATES.DRAFT]: [WORK_ORDER_STATES.ASSIGNED, WORK_ORDER_STATES.CANCELLED],
  [WORK_ORDER_STATES.ASSIGNED]: [WORK_ORDER_STATES.IN_PROGRESS, WORK_ORDER_STATES.BLOCKED, WORK_ORDER_STATES.COMPLETED, WORK_ORDER_STATES.CANCELLED],
  [WORK_ORDER_STATES.IN_PROGRESS]: [WORK_ORDER_STATES.BLOCKED, WORK_ORDER_STATES.COMPLETED, WORK_ORDER_STATES.CANCELLED],
  [WORK_ORDER_STATES.BLOCKED]: [WORK_ORDER_STATES.IN_PROGRESS, WORK_ORDER_STATES.CANCELLED],
  [WORK_ORDER_STATES.COMPLETED]: [WORK_ORDER_STATES.VERIFIED],
  [WORK_ORDER_STATES.VERIFIED]: [],
  [WORK_ORDER_STATES.CANCELLED]: [],
});

export const WORK_ORDER_TYPES = Object.freeze({
  REPAIR: 'repair',
  REPLACEMENT: 'replacement',
  CLEANING: 'cleaning',
  PAINTING: 'painting',
  SAFETY_MAKE_SAFE: 'safety_make_safe',
  INSPECTION_FOLLOW_UP: 'inspection_follow_up',
});

export const WORK_ORDER_TYPE_LABELS = Object.freeze({
  [WORK_ORDER_TYPES.REPAIR]: 'Repair',
  [WORK_ORDER_TYPES.REPLACEMENT]: 'Replace part or asset',
  [WORK_ORDER_TYPES.CLEANING]: 'Clean',
  [WORK_ORDER_TYPES.PAINTING]: 'Paint or refinish',
  [WORK_ORDER_TYPES.SAFETY_MAKE_SAFE]: 'Make safe',
  [WORK_ORDER_TYPES.INSPECTION_FOLLOW_UP]: 'Inspection follow-up',
});

export const WORK_ORDER_PRIORITIES = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  URGENT: 'urgent',
});

export const WORK_ORDER_PRIORITY_LABELS = Object.freeze({
  [WORK_ORDER_PRIORITIES.LOW]: 'Low',
  [WORK_ORDER_PRIORITIES.MEDIUM]: 'Medium',
  [WORK_ORDER_PRIORITIES.HIGH]: 'High',
  [WORK_ORDER_PRIORITIES.URGENT]: 'Urgent — safety risk',
});

export const QR_TOKEN_STATES = Object.freeze({
  ACTIVE: 'active',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
});

export const QR_TOKEN_STATE_LABELS = Object.freeze({
  [QR_TOKEN_STATES.ACTIVE]: 'Active',
  [QR_TOKEN_STATES.REVOKED]: 'Revoked',
  [QR_TOKEN_STATES.EXPIRED]: 'Expired',
});

export const TRIAGE_DECISIONS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  EDITED: 'edited',
  REJECTED: 'rejected',
});

export const TRIAGE_DECISION_LABELS = Object.freeze({
  [TRIAGE_DECISIONS.PENDING]: 'Awaiting human review',
  [TRIAGE_DECISIONS.ACCEPTED]: 'Accepted by staff',
  [TRIAGE_DECISIONS.EDITED]: 'Edited by staff',
  [TRIAGE_DECISIONS.REJECTED]: 'Rejected by staff',
});

export const TRIAGE_RULESET_VERSION = 'asset-triage-rules-v1';
export const TRIAGE_MODEL_ID = 'deterministic-asset-maintenance-rules-v1';

export const ASSET_AUDIT_ACTIONS = Object.freeze({
  ASSET_CREATED: 'asset.created',
  ASSET_UPDATED: 'asset.updated',
  ASSET_STATUS_CHANGED: 'asset.status_changed',
  ASSET_RETIRED: 'asset.retired',
  QR_ISSUED: 'qr.issued',
  QR_REVOKED: 'qr.revoked',
  ACTION_TOKEN_ISSUED: 'staff_action.issued',
  ACTION_TOKEN_CONSUMED: 'staff_action.consumed',
  INSPECTION_SCHEDULED: 'inspection.scheduled',
  INSPECTION_COMPLETED: 'inspection.completed',
  INSPECTION_VERIFIED: 'inspection.verified',
  INSPECTION_TRANSITIONED: 'inspection.transitioned',
  REPORT_SUBMITTED: 'report.submitted',
  REPORT_TRIAGED: 'report.triaged',
  REPORT_REJECTED: 'report.rejected',
  REPORT_DUPLICATE: 'report.duplicate',
  REPORT_CONVERTED: 'report.converted',
  REPORT_RESOLVED: 'report.resolved',
  WORK_ORDER_CREATED: 'work_order.created',
  WORK_ORDER_UPDATED: 'work_order.updated',
  WORK_ORDER_TRANSITIONED: 'work_order.transitioned',
  REPAIR_RECORDED: 'repair.recorded',
  TRIAGE_SUGGESTED: 'triage.suggested',
  TRIAGE_REVIEWED: 'triage.reviewed',
  RETENTION_APPLIED: 'retention.applied',
  MIGRATION_RUN: 'migration.run',
  MIGRATION_ROLLBACK: 'migration.rollback',
  OVERRIDE_RECORDED: 'override.recorded',
});

export const ASSET_API_LIMITS = Object.freeze({
  defaultPageSize: 12,
  maxPageSize: 50,
  maxSearchLength: 80,
  maxNameLength: 120,
  maxDescriptionLength: 1000,
  maxNotesLength: 1200,
  maxReasonLength: 500,
  maxAttachmentsPerReport: 3,
  maxEvidencePerOrder: 5,
  maxAttachmentBytes: 5 * 1024 * 1024,
  maxImageDataUrlLength: 2_000_000,
  reportRateLimit: 3,
  reportRateWindowMs: 60 * 60 * 1000,
  duplicateReportCooldownMs: 10 * 60 * 1000,
  inspectionReminderDays: 30,
  defaultInspectionIntervalDays: 180,
  minInspectionIntervalDays: 30,
  maxInspectionIntervalDays: 730,
  actionTokenTtlMs: 10 * 60 * 1000,
  qrTokenBytes: 24,
  maxQrTokensPerAsset: 10,
  staleAfterDays: 30,
  closedReportRetentionDays: 365,
});

export const ALLOWED_EVIDENCE_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

export const ASSET_ERROR_CODES = Object.freeze({
  UNAUTHENTICATED: 'ASSET_UNAUTHENTICATED',
  PERMISSION_DENIED: 'ASSET_PERMISSION_DENIED',
  JURISDICTION_FORBIDDEN: 'ASSET_JURISDICTION_FORBIDDEN',
  VALIDATION_ERROR: 'ASSET_VALIDATION_ERROR',
  NOT_FOUND: 'ASSET_NOT_FOUND',
  INVALID_TRANSITION: 'ASSET_INVALID_TRANSITION',
  DUPLICATE_REPORT: 'ASSET_DUPLICATE_REPORT',
  RATE_LIMITED: 'ASSET_RATE_LIMITED',
  STORAGE_ERROR: 'ASSET_STORAGE_ERROR',
  QR_INVALID: 'ASSET_QR_INVALID',
  ACTION_TOKEN_INVALID: 'ASSET_ACTION_TOKEN_INVALID',
  ACTION_TOKEN_EXPIRED: 'ASSET_ACTION_TOKEN_EXPIRED',
  ACTION_TOKEN_REPLAYED: 'ASSET_ACTION_TOKEN_REPLAYED',
  ACTION_TOKEN_SCOPE: 'ASSET_ACTION_TOKEN_SCOPE',
  IDEMPOTENCY_CONFLICT: 'ASSET_IDEMPOTENCY_CONFLICT',
  REFERENCE_NOT_FOUND: 'ASSET_REFERENCE_NOT_FOUND',
  UNSAFE_ATTACHMENT: 'ASSET_UNSAFE_ATTACHMENT',
  MIGRATION_ERROR: 'ASSET_MIGRATION_ERROR',
  AUDIT_CHAIN_BROKEN: 'ASSET_AUDIT_CHAIN_BROKEN',
  CONFLICT: 'ASSET_CONFLICT',
  UNKNOWN_CAPABILITY: 'ASSET_UNKNOWN_CAPABILITY',
});

export const ASSET_ERROR_MESSAGES = Object.freeze({
  [ASSET_ERROR_CODES.UNAUTHENTICATED]: 'Sign in to use the asset registry.',
  [ASSET_ERROR_CODES.PERMISSION_DENIED]: 'Your role does not allow this action.',
  [ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN]: 'This asset belongs to a jurisdiction you are not assigned to.',
  [ASSET_ERROR_CODES.VALIDATION_ERROR]: 'Check the highlighted fields and try again.',
  [ASSET_ERROR_CODES.NOT_FOUND]: 'That record could not be found.',
  [ASSET_ERROR_CODES.INVALID_TRANSITION]: 'That status change is not allowed. Refresh and choose one of the available next steps.',
  [ASSET_ERROR_CODES.DUPLICATE_REPORT]: 'A very similar report was already submitted from this device. Use the existing reference.',
  [ASSET_ERROR_CODES.RATE_LIMITED]: 'Too many submissions from this device. Try again later.',
  [ASSET_ERROR_CODES.STORAGE_ERROR]: 'The device could not save this change. Your input is still on screen; retry when storage is available.',
  [ASSET_ERROR_CODES.QR_INVALID]: 'This asset tag is not active. Ask the municipal office for help or look up the asset in the public register.',
  [ASSET_ERROR_CODES.ACTION_TOKEN_INVALID]: 'This staff action link is not valid. Sign in and open the asset from the staff registry.',
  [ASSET_ERROR_CODES.ACTION_TOKEN_EXPIRED]: 'This staff action link has expired. Create a new one from the staff registry.',
  [ASSET_ERROR_CODES.ACTION_TOKEN_REPLAYED]: 'This staff action link was already used. Create a new one if another action is needed.',
  [ASSET_ERROR_CODES.ACTION_TOKEN_SCOPE]: 'This staff action link is for a different asset or role.',
  [ASSET_ERROR_CODES.IDEMPOTENCY_CONFLICT]: 'This retry key was already used for a different request. Refresh before retrying.',
  [ASSET_ERROR_CODES.REFERENCE_NOT_FOUND]: 'A linked record is missing. Choose an existing category, location or asset.',
  [ASSET_ERROR_CODES.UNSAFE_ATTACHMENT]: 'One of the images is not an accepted JPEG, PNG or WebP file, or is too large.',
  [ASSET_ERROR_CODES.MIGRATION_ERROR]: 'The registry migration could not be completed. The previous snapshot was kept.',
  [ASSET_ERROR_CODES.AUDIT_CHAIN_BROKEN]: 'The audit trail failed its integrity check. Stop making changes and restore a trusted backup.',
  [ASSET_ERROR_CODES.CONFLICT]: 'The record changed in another tab. Refresh before trying again.',
  [ASSET_ERROR_CODES.UNKNOWN_CAPABILITY]: 'That action is not part of the asset registry.',
});

const TRANSITIONS = Object.freeze({
  asset: ASSET_STATUS_TRANSITIONS,
  inspection: INSPECTION_STATE_TRANSITIONS,
  report: FAULT_REPORT_STATE_TRANSITIONS,
  workOrder: WORK_ORDER_STATE_TRANSITIONS,
});

export const canTransition = (kind, from, to) => {
  const map = TRANSITIONS[kind];
  if (!map) return false;
  return Array.isArray(map[from]) && map[from].includes(to);
};

export const allowedNextStates = (kind, from) => {
  const map = TRANSITIONS[kind];
  return map && Array.isArray(map[from]) ? [...map[from]] : [];
};

export const isKnownValue = (enumObject, value) => Object.values(enumObject).includes(value);
