/**
 * Validation, storage and token primitives for the public asset registry.
 *
 * Every write reaches the service layer through these helpers. Browser forms
 * validate for usability only; the service never trusts that they ran.
 */

import {
  ALLOWED_EVIDENCE_MIME_TYPES,
  ASSET_API_LIMITS,
  ASSET_ERROR_CODES,
  ASSET_ERROR_MESSAGES,
} from './assetRegistryConstants';
import { minimizeForExternal } from '../utils/dataMinimization';
import { safeHttpUrl, sanitizePlainText } from '../utils/safeContent';

export class AssetServiceError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} [message] developer context
   * @param {{ fieldErrors?: Record<string,string>, details?: object, userMessage?: string }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message || ASSET_ERROR_MESSAGES[code] || ASSET_ERROR_MESSAGES[ASSET_ERROR_CODES.VALIDATION_ERROR]);
    this.name = 'AssetServiceError';
    this.code = code;
    this.userMessage = extra.userMessage || ASSET_ERROR_MESSAGES[code] || ASSET_ERROR_MESSAGES[ASSET_ERROR_CODES.VALIDATION_ERROR];
    this.fieldErrors = extra.fieldErrors || {};
    this.details = extra.details || {};
  }
}

export const createAssetError = (code, message, extra) => new AssetServiceError(code, message, extra);

export const getAssetStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export const safeReadJson = (storage, key, fallback) => {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

export const safeWriteJson = (storage, key, value) => {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

export const removeStorageKey = (storage, key) => {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // The caller reports the larger failure.
  }
};

export const nowIso = (nowMs = Date.now()) => new Date(nowMs).toISOString();
export const cloneJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const randomSuffix = () => {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  } catch {
    // Fall through.
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
};

export const newAssetId = (prefix) => `${prefix}_${randomSuffix()}`;

/** FNV-1a. Used for non-secret fingerprints and the audit hash chain. */
export const hashString = (value = '') => {
  let hash = 0x811c9dc5;
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/**
 * cyrb128-style 128-bit non-cryptographic digest. QR lookup tokens have 192
 * bits of entropy, so a fast digest is enough to avoid storing the raw token;
 * this is not a password hash and must not be used for credentials.
 */
export const hashToken = (value = '') => {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [h1, h2, h3, h4].map((part) => (part >>> 0).toString(16).padStart(8, '0')).join('');
};

export const sanitizePlain = (value, { max = 500, multiline = false } = {}) =>
  sanitizePlainText(value, { max, multiline }).trim();

/** Public narrative text: no markup, no obvious personal identifiers. */
export const sanitizePublicNarrative = (value, { max = ASSET_API_LIMITS.maxDescriptionLength, multiline = true } = {}) =>
  minimizeForExternal(sanitizePlainText(value, { max, multiline })).trim();

export const requireString = (value, field, { min = 1, max = 500, multiline = false, code = ASSET_ERROR_CODES.VALIDATION_ERROR } = {}) => {
  const clean = sanitizePlain(value, { max, multiline });
  if (clean.length < min) {
    throw createAssetError(code, `${field} must be at least ${min} characters.`, {
      fieldErrors: { [field]: `${field} must be at least ${min} characters.` },
    });
  }
  return clean;
};

export const optionalString = (value, field, { max = 500, multiline = false } = {}) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, `${field} must be text.`, {
      fieldErrors: { [field]: `${field} must be text.` },
    });
  }
  return sanitizePlain(value, { max, multiline });
};

export const requireEnum = (value, enumObject, field) => {
  const allowed = Object.values(enumObject);
  if (!allowed.includes(value)) {
    throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, `${field} must be one of ${allowed.join(', ')}.`, {
      fieldErrors: { [field]: `Choose one of: ${allowed.join(', ')}.` },
    });
  }
  return value;
};

export const requireIsoDate = (value, field, { notFuture = false, notPast = false, nowMs = Date.now() } = {}) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, `${field} is required.`, {
      fieldErrors: { [field]: `${field} is required.` },
    });
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, `${field} must be a valid date.`, {
      fieldErrors: { [field]: `${field} must be a valid date.` },
    });
  }
  if (notFuture && parsed > nowMs + 24 * 60 * 60 * 1000) {
    throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, `${field} cannot be in the future.`, {
      fieldErrors: { [field]: `${field} cannot be in the future.` },
    });
  }
  if (notPast && parsed < nowMs - 24 * 60 * 60 * 1000) {
    throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, `${field} cannot be in the past.`, {
      fieldErrors: { [field]: `${field} cannot be in the past.` },
    });
  }
  return new Date(parsed).toISOString();
};

export const optionalIsoDate = (value, field, options) => {
  if (value === undefined || value === null || value === '') return null;
  return requireIsoDate(value, field, options);
};

export const requireNumberRange = (value, field, min, max) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, `${field} must be between ${min} and ${max}.`, {
      fieldErrors: { [field]: `${field} must be between ${min} and ${max}.` },
    });
  }
  return num;
};

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Opaque, high-entropy token. Never derived from a public id or sequence.
 * @param {number} [bytes]
 */
export const generateOpaqueToken = (bytes = ASSET_API_LIMITS.qrTokenBytes) => {
  const length = Math.max(16, Math.min(64, Math.floor(Number(bytes) || ASSET_API_LIMITS.qrTokenBytes)));
  const output = [];
  try {
    const buffer = new Uint8Array(length);
    globalThis.crypto.getRandomValues(buffer);
    for (const byte of buffer) output.push(BASE64URL[byte % 64]);
  } catch {
    for (let i = 0; i < length; i += 1) {
      output.push(BASE64URL[Math.floor(Math.random() * BASE64URL.length)]);
    }
  }
  return output.join('');
};

export const isOpaqueToken = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(value.trim());

export const tokenPrefix = (token) => (typeof token === 'string' ? token.slice(0, 6) : '');

export const safeEqual = (left, right) => {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
};

export const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
};

export const encodeTokenPayload = (payload) => {
  const json = stableStringify(payload);
  try {
    return globalThis.btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  } catch {
    return json;
  }
};

export const decodeTokenPayload = (encoded) => {
  try {
    const padded = String(encoded || '').replace(/-/g, '+').replace(/_/g, '/');
    const json = globalThis.atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return JSON.parse(json);
  } catch {
    try {
      return JSON.parse(String(encoded || ''));
    } catch {
      return null;
    }
  }
};

export const signActionPayload = (payload, secret) => hashToken(`${stableStringify(payload)}|${secret}`);

const SAFE_IMAGE_DATA_URI = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]{8,}$/;

export const isSafeEvidenceUrl = (value) => {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.length > ASSET_API_LIMITS.maxImageDataUrlLength) return false;
  // eslint-disable-next-line no-control-regex -- control characters are rejected on purpose
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return false;
  if (SAFE_IMAGE_DATA_URI.test(text)) return true;
  const safe = safeHttpUrl(text);
  if (!safe) return false;
  return !/\.svg(?:$|\?)/i.test(safe);
};

/**
 * Validates repair/report evidence before any bytes are stored. SVG, HTML,
 * documents, scripts and oversized files are rejected.
 */
export const validateEvidenceAttachments = (attachments = [], { max = ASSET_API_LIMITS.maxAttachmentsPerReport } = {}) => {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) {
    throw createAssetError(ASSET_ERROR_CODES.UNSAFE_ATTACHMENT, 'Attachments must be an array.');
  }
  if (attachments.length > max) {
    throw createAssetError(ASSET_ERROR_CODES.UNSAFE_ATTACHMENT, `At most ${max} images are accepted.`);
  }

  return attachments.map((attachment, index) => {
    if (!attachment || typeof attachment !== 'object') {
      throw createAssetError(ASSET_ERROR_CODES.UNSAFE_ATTACHMENT, `Attachment ${index + 1} is invalid.`);
    }
    const mimeType = String(attachment.mimeType || '').toLowerCase().trim();
    if (!ALLOWED_EVIDENCE_MIME_TYPES.includes(mimeType)) {
      throw createAssetError(ASSET_ERROR_CODES.UNSAFE_ATTACHMENT, `Attachment ${index + 1} has an unsupported type.`, {
        fieldErrors: { attachments: 'Use a JPEG, PNG or WebP image.' },
      });
    }
    const sizeBytes = Number(attachment.sizeBytes || 0);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > ASSET_API_LIMITS.maxAttachmentBytes) {
      throw createAssetError(ASSET_ERROR_CODES.UNSAFE_ATTACHMENT, `Attachment ${index + 1} is too large.`, {
        fieldErrors: { attachments: 'Each image must be 5 MB or smaller.' },
      });
    }
    if (!isSafeEvidenceUrl(attachment.url)) {
      throw createAssetError(ASSET_ERROR_CODES.UNSAFE_ATTACHMENT, `Attachment ${index + 1} failed content safety validation.`, {
        fieldErrors: { attachments: 'The image could not be verified as a safe JPEG, PNG or WebP.' },
      });
    }
    return {
      id: attachment.id || newAssetId('evidence'),
      mimeType,
      sizeBytes,
      url: attachment.url,
      caption: sanitizePublicNarrative(attachment.caption || '', { max: 180, multiline: false }),
      checksum: hashToken(`${mimeType}|${sizeBytes}|${attachment.url.slice(0, 200)}`),
      exifStripped: true,
      createdAt: attachment.createdAt || nowIso(),
    };
  });
};

export const normalizeSearch = (value = '') =>
  sanitizePlain(value, { max: ASSET_API_LIMITS.maxSearchLength, multiline: false }).toLowerCase();

export const paginate = (items, { page = 1, pageSize = ASSET_API_LIMITS.defaultPageSize } = {}) => {
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeSize = Math.min(
    ASSET_API_LIMITS.maxPageSize,
    Math.max(1, Math.floor(Number(pageSize) || ASSET_API_LIMITS.defaultPageSize))
  );
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / safeSize));
  const currentPage = Math.min(safePage, totalPages);
  const start = (currentPage - 1) * safeSize;
  return {
    items: items.slice(start, start + safeSize),
    page: currentPage,
    pageSize: safeSize,
    total,
    totalPages,
    hasNextPage: currentPage < totalPages,
    hasPreviousPage: currentPage > 1,
  };
};

/**
 * Multi-key write with rollback. localStorage has no transactions, so every
 * key is snapshotted and restored if a later write fails.
 */
export const runAssetTransaction = (storage, keys, mutator) => {
  const source = storage || getAssetStorage();
  if (!source) throw createAssetError(ASSET_ERROR_CODES.STORAGE_ERROR, 'No storage is available.');
  const before = new Map();
  const draft = new Map();
  for (const key of keys) {
    const raw = source.getItem(key);
    before.set(key, raw);
    let parsed = [];
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = [];
      }
    }
    draft.set(key, parsed);
  }

  const result = mutator(draft, { now: nowIso() });

  try {
    for (const key of keys) source.setItem(key, JSON.stringify(draft.get(key)));
  } catch (error) {
    for (const [key, raw] of before.entries()) {
      try {
        if (raw === null) source.removeItem(key);
        else source.setItem(key, raw);
      } catch {
        // Best effort; the original failure is the useful one.
      }
    }
    throw createAssetError(ASSET_ERROR_CODES.STORAGE_ERROR, `Transaction failed: ${error?.message || error}`);
  }

  return result;
};

export const changeSummary = (before, after, fields = []) =>
  fields.reduce((acc, field) => {
    const oldValue = before?.[field];
    const newValue = after?.[field];
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      acc[field] = { before: oldValue ?? null, after: newValue ?? null };
    }
    return acc;
  }, {});
