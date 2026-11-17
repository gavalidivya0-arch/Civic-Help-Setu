/**
 * api/asset-fault-reports.js
 * Server-side intake for citizen fault reports against public assets (#750).
 *
 * The browser module keeps the full local-first workflow (assets, inspections,
 * work orders, audit chain) on the device. This endpoint is the production
 * intake path for deployments that place a trusted service in front of that
 * store: it validates the same public contract before a report can enter a
 * municipal queue.
 *
 * Invariants enforced:
 *  - POST only; no queue contents are exposed over HTTP.
 *  - A QR tag or public asset reference is required. The tag is a lookup key,
 *    never an authorisation claim.
 *  - Zero PII: Aadhaar, PAN, e-mail, phone numbers and reporter device keys are
 *    rejected before a record is queued.
 *  - Evidence is restricted to JPEG, PNG or WebP within the shared size limit.
 *  - Rate limiting and single-flight deduplication via abuseGuard.
 *  - No IP address, user agent or reporter key is written into the queue.
 */

import { clientKey, createRateLimiter, createSingleFlight } from '../abuseGuard.js';
import {
  ALLOWED_EVIDENCE_MIME_TYPES,
  ASSET_API_LIMITS,
  FAULT_CATEGORIES,
  REPORT_SEVERITIES,
} from '../../../src/services/assetRegistryConstants.js';

const rateLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 1000 });
const singleFlight = createSingleFlight();

/** In-memory queue for municipal review. Contains approved intake fields only. */
export const ASSET_FAULT_REPORT_QUEUE = [];

/** Short-lived receipt map so a retried POST returns the same public reference. */
const receipts = new Map();
const RECEIPT_TTL_MS = 10 * 60 * 1000;

const AADHAAR_REGEX = /\b\d{4}\s?\d{4}\s?\d{4}\b/;
const PAN_REGEX = /\b[A-Z]{5}\d{4}[A-Z]\b/i;
const PHONE_REGEX = /(?<!\d)(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/;
const EMAIL_REGEX = /\b[^\s@]+@[^\s@]+\.[^\s@]{2,}\b/i;
const PUBLIC_ID_REGEX = /^[A-Z]{2,6}-AST-\d{4}$/;
const QR_TOKEN_REGEX = /^[A-Za-z0-9_-]{20,160}$/;
const PUBLIC_REFERENCE_PREFIX = 'AST-REP-';

const FORBIDDEN_REPORTER_KEYS = Object.freeze([
  'reporterKey',
  'reporterKeyHash',
  'reporterName',
  'reporterEmail',
  'reporterPhone',
  'phone',
  'email',
  'aadhaar',
  'pan',
  'ip',
  'userAgent',
]);

const sanitizeText = (value, maxLength = 1500) => {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, maxLength);
};

const isSafeEvidenceUrl = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  if (/^https:\/\/[^\s]+$/i.test(value)) return true;
  return /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(value);
};

/**
 * Stable, non-identifying public reference. The input is a hash of the
 * idempotency material, never a device key or an IP address.
 */
export const generateAssetReportReference = (seed) => {
  let hash = 0x811c9dc5;
  const source = String(seed || Date.now());
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const unsigned = hash >>> 0;
  const first = (unsigned & 0xffff).toString(36).toUpperCase().padStart(4, '0');
  const second = ((unsigned >>> 16) & 0xffff).toString(36).toUpperCase().padStart(2, '0');
  return `${PUBLIC_REFERENCE_PREFIX}${first}${second}`.slice(0, 14);
};

const hashPayload = (value) => {
  let hash = 0x811c9dc5;
  const source = JSON.stringify(value);
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

export function validateAssetFaultReportPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Request body must be a valid JSON object.'];
  }
  const errors = [];

  for (const key of FORBIDDEN_REPORTER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      errors.push(`${key}: Reporter identity and device keys must never be sent to the server.`);
    }
  }

  const hasQrToken = typeof body.qrToken === 'string' && body.qrToken.trim().length > 0;
  const hasPublicId = typeof body.assetPublicId === 'string' && body.assetPublicId.trim().length > 0;
  if (!hasQrToken && !hasPublicId) {
    errors.push('asset: A scanned QR tag or a public asset reference is required.');
  }
  if (hasQrToken && !QR_TOKEN_REGEX.test(body.qrToken.trim())) {
    errors.push('qrToken: The tag value is malformed. Scan the current tag on the asset.');
  }
  if (hasPublicId && !PUBLIC_ID_REGEX.test(body.assetPublicId.trim().toUpperCase())) {
    errors.push('assetPublicId: Use the public reference printed on the register, for example BLR-AST-0001.');
  }

  if (!Object.values(FAULT_CATEGORIES).includes(body.category)) {
    errors.push(`category: Must be one of [${Object.values(FAULT_CATEGORIES).join(', ')}].`);
  }
  if (!Object.values(REPORT_SEVERITIES).includes(body.severity)) {
    errors.push(`severity: Must be one of [${Object.values(REPORT_SEVERITIES).join(', ')}].`);
  }

  const description = sanitizeText(body.description, ASSET_API_LIMITS.maxDescriptionLength + 1);
  if (description.length < 20) {
    errors.push('description: Describe the visible problem in at least 20 characters.');
  }
  if (description.length > ASSET_API_LIMITS.maxDescriptionLength) {
    errors.push(`description: Keep the description under ${ASSET_API_LIMITS.maxDescriptionLength} characters.`);
  }

  const evidence = body.evidence === undefined ? [] : body.evidence;
  if (!Array.isArray(evidence)) {
    errors.push('evidence: Attachments must be a list.');
  } else if (evidence.length > ASSET_API_LIMITS.maxAttachmentsPerReport) {
    errors.push(`evidence: Attach at most ${ASSET_API_LIMITS.maxAttachmentsPerReport} images.`);
  } else {
    evidence.forEach((item, index) => {
      const label = `evidence[${index}]`;
      if (!item || typeof item !== 'object') {
        errors.push(`${label}: Each attachment must be an object.`);
        return;
      }
      if (!ALLOWED_EVIDENCE_MIME_TYPES.includes(item.mimeType)) {
        errors.push(`${label}: Only JPEG, PNG and WebP images are accepted.`);
      }
      if (!Number.isFinite(item.sizeBytes) || item.sizeBytes <= 0 || item.sizeBytes > ASSET_API_LIMITS.maxAttachmentBytes) {
        errors.push(`${label}: Image size must be between 1 byte and ${ASSET_API_LIMITS.maxAttachmentBytes} bytes.`);
      }
      if (!isSafeEvidenceUrl(item.url)) {
        errors.push(`${label}: Evidence must be an https:// reference or a base64 JPEG, PNG or WebP image.`);
      }
      if (item.caption !== undefined && sanitizeText(item.caption, 201).length > 200) {
        errors.push(`${label}: Caption must be under 200 characters.`);
      }
    });
  }

  const personalText = [description, ...(Array.isArray(evidence) ? evidence.map((item) => sanitizeText(item?.caption, 200)) : [])].join(' ');
  if (AADHAAR_REGEX.test(personalText)) {
    errors.push('description: Remove Aadhaar numbers; personal identity markers are prohibited.');
  }
  if (PAN_REGEX.test(personalText)) {
    errors.push('description: Remove PAN numbers; personal tax identifiers are prohibited.');
  }
  if (PHONE_REGEX.test(personalText)) {
    errors.push('description: Remove personal phone numbers; only describe the asset fault.');
  }
  if (EMAIL_REGEX.test(personalText)) {
    errors.push('description: Remove e-mail addresses; reporter contact details are not stored.');
  }

  return errors;
}

const normalizedPayload = (body) => ({
  qrToken: typeof body.qrToken === 'string' ? body.qrToken.trim() : undefined,
  assetPublicId:
    typeof body.assetPublicId === 'string' ? body.assetPublicId.trim().toUpperCase() : undefined,
  category: body.category,
  severity: body.severity,
  description: sanitizeText(body.description, ASSET_API_LIMITS.maxDescriptionLength),
  evidence: (body.evidence || []).map((item) => ({
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    url: item.url,
    caption: sanitizeText(item.caption || '', 200),
  })),
});

const pruneReceipts = (now) => {
  for (const [key, receipt] of receipts) {
    if (now - receipt.createdAt > RECEIPT_TTL_MS) receipts.delete(key);
  }
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed. Only POST requests are accepted.' });
  }

  const caller = clientKey(req.headers || {}) || req.socket?.remoteAddress || 'unidentified-caller';
  const { allowed, retryAfterSeconds } = rateLimiter.take(caller);
  if (!allowed) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      error: 'Too many fault reports from this connection. Please wait before submitting another.',
      retryAfterSeconds,
    });
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'Malformed JSON payload.' });
    }
  }

  const errors = validateAssetFaultReportPayload(body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  const payload = normalizedPayload(body);
  const fingerprint = hashPayload({ payload, callerBucket: caller });
  const now = Date.now();
  pruneReceipts(now);
  const existing = receipts.get(fingerprint);
  if (existing) {
    return res.status(200).json({
      success: true,
      duplicate: true,
      reference: existing.reference,
      status: 'pending_review',
      message: 'This report is already queued. Use the public reference to follow its status.',
    });
  }

  return singleFlight.run(fingerprint, async () => {
    const receivedAt = new Date().toISOString();
    const reference = generateAssetReportReference(`${fingerprint}:${receivedAt}`);

    const record = {
      reference,
      asset: payload.qrToken ? { tagScanned: true } : { publicId: payload.assetPublicId },
      category: payload.category,
      severity: payload.severity,
      description: payload.description,
      evidenceCount: payload.evidence.length,
      status: 'pending_review',
      receivedAt,
      schemaVersion: 1,
    };

    // Server intake never stores the raw tag, reporter key, IP address or user agent.
    ASSET_FAULT_REPORT_QUEUE.unshift(record);
    if (ASSET_FAULT_REPORT_QUEUE.length > 200) ASSET_FAULT_REPORT_QUEUE.pop();
    receipts.set(fingerprint, { reference, createdAt: now });

    return res.status(201).json({
      success: true,
      duplicate: false,
      reference,
      status: 'pending_review',
      message:
        'Report received and queued for municipal review. This intake is not a verified inspection or a work order.',
      receivedAt,
    });
  });
}
