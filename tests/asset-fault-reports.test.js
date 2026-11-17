import { describe, it, expect, beforeEach } from 'vitest';
import handler, {
  ASSET_FAULT_REPORT_QUEUE,
  generateAssetReportReference,
  validateAssetFaultReportPayload,
} from '../api/_lib/handlers/asset-fault-reports.js';

const VALID_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

const validPayload = () => ({
  qrToken: 'demo-tag-bench-indiranagar-9f4c2a7e8b1d6c05',
  category: 'damage',
  severity: 'major',
  description: 'One timber slat is loose and a fixing bolt is protruding from the seat.',
  evidence: [{ mimeType: 'image/png', sizeBytes: 128, url: VALID_IMAGE, caption: 'Loose slat' }],
});

const makeRes = () => {
  const response = { statusCode: 0, body: null, headers: {} };
  return {
    response,
    setHeader: (name, value) => {
      response.headers[name] = value;
    },
    status(code) {
      response.statusCode = code;
      return {
        json(data) {
          response.body = data;
          return response;
        },
      };
    },
  };
};

let ipCounter = 0;
const nextIp = () => `10.20.0.${++ipCounter}`;

const request = async (body, { method = 'POST', ip = nextIp(), headers = {} } = {}) => {
  const res = makeRes();
  await handler(
    {
      method,
      headers: { 'x-vercel-forwarded-for': ip, ...headers },
      body,
      socket: { remoteAddress: ip },
    },
    res
  );
  return res.response;
};

beforeEach(() => {
  ASSET_FAULT_REPORT_QUEUE.length = 0;
});

describe('asset fault report server intake (#750)', () => {
  it('accepts a valid public-asset report', () => {
    expect(validateAssetFaultReportPayload(validPayload())).toEqual([]);
  });

  it('requires a QR tag or a public asset reference', () => {
    const payload = validPayload();
    delete payload.qrToken;
    const errors = validateAssetFaultReportPayload(payload);
    expect(errors.some((error) => error.startsWith('asset:'))).toBe(true);

    const withPublicId = { ...payload, assetPublicId: 'BLR-AST-0001' };
    expect(validateAssetFaultReportPayload(withPublicId)).toEqual([]);
  });

  it('rejects malformed QR tags and public references', () => {
    expect(
      validateAssetFaultReportPayload({ ...validPayload(), qrToken: 'short' }).some((error) =>
        error.startsWith('qrToken:')
      )
    ).toBe(true);
    expect(
      validateAssetFaultReportPayload({ ...validPayload(), assetPublicId: '../../admin' }).some((error) =>
        error.startsWith('assetPublicId:')
      )
    ).toBe(true);
  });

  it('rejects invalid categories, severities and short descriptions', () => {
    const errors = validateAssetFaultReportPayload({
      ...validPayload(),
      category: 'not_a_category',
      severity: 'catastrophic',
      description: 'broken',
    });
    expect(errors.some((error) => error.startsWith('category:'))).toBe(true);
    expect(errors.some((error) => error.startsWith('severity:'))).toBe(true);
    expect(errors.some((error) => error.startsWith('description:'))).toBe(true);
  });

  it('strictly rejects personal data and reporter device keys', () => {
    const aadhaar = validateAssetFaultReportPayload({
      ...validPayload(),
      description: 'Bench near Aadhaar 1234 5678 9012 is broken beyond repair.',
    });
    expect(aadhaar.some((error) => error.includes('Aadhaar'))).toBe(true);

    const pan = validateAssetFaultReportPayload({
      ...validPayload(),
      description: 'Tax record ABCDE1234F is linked to the damaged bench slat.',
    });
    expect(pan.some((error) => error.includes('PAN'))).toBe(true);

    const phone = validateAssetFaultReportPayload({
      ...validPayload(),
      description: 'The bench slat is loose; call 9876543210 to arrange repair.',
    });
    expect(phone.some((error) => error.includes('phone'))).toBe(true);

    const email = validateAssetFaultReportPayload({
      ...validPayload(),
      description: 'The bench slat is loose; contact resident@example.com about it.',
    });
    expect(email.some((error) => error.includes('e-mail'))).toBe(true);

    const deviceKey = validateAssetFaultReportPayload({
      ...validPayload(),
      reporterKey: 'resident-device-key-1',
    });
    expect(deviceKey.some((error) => error.startsWith('reporterKey:'))).toBe(true);
  });

  it('validates attachment type, size and URL scheme', () => {
    const svg = validateAssetFaultReportPayload({
      ...validPayload(),
      evidence: [{ mimeType: 'image/svg+xml', sizeBytes: 100, url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }],
    });
    expect(svg.some((error) => error.includes('JPEG, PNG and WebP'))).toBe(true);

    const oversized = validateAssetFaultReportPayload({
      ...validPayload(),
      evidence: [{ mimeType: 'image/png', sizeBytes: 99_999_999, url: VALID_IMAGE }],
    });
    expect(oversized.some((error) => error.includes('Image size'))).toBe(true);

    const insecure = validateAssetFaultReportPayload({
      ...validPayload(),
      evidence: [{ mimeType: 'image/png', sizeBytes: 100, url: 'http://example.com/photo.png' }],
    });
    expect(insecure.some((error) => error.includes('https://'))).toBe(true);
  });

  it('generates a stable, non-identifying public reference', () => {
    const first = generateAssetReportReference('seed-value');
    const second = generateAssetReportReference('seed-value');
    expect(first).toBe(second);
    expect(first).toMatch(/^AST-REP-[A-Z0-9]{6}$/);
  });

  it('queues a valid report with no raw tag, reporter key or IP address', async () => {
    const payload = validPayload();
    const result = await request(payload, { ip: '10.30.0.1' });
    expect(result.statusCode).toBe(201);
    expect(result.body.success).toBe(true);
    expect(result.body.reference).toMatch(/^AST-REP-[A-Z0-9]{6}$/);
    expect(ASSET_FAULT_REPORT_QUEUE).toHaveLength(1);
    const record = ASSET_FAULT_REPORT_QUEUE[0];
    expect(record.reference).toBe(result.body.reference);
    expect(record.status).toBe('pending_review');
    expect(record.evidenceCount).toBe(1);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(payload.qrToken);
    expect(serialized).not.toContain('10.30.0.1');
    expect(serialized).not.toContain('reporterKey');
  });

  it('returns the same reference for an identical retry', async () => {
    const payload = validPayload();
    const first = await request(payload, { ip: '10.31.0.1' });
    const second = await request(payload, { ip: '10.31.0.1' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.reference).toBe(first.body.reference);
    expect(ASSET_FAULT_REPORT_QUEUE).toHaveLength(1);
  });

  it('rejects an invalid payload with 400 and queues nothing', async () => {
    const result = await request({ ...validPayload(), description: 'bad' }, { ip: '10.32.0.1' });
    expect(result.statusCode).toBe(400);
    expect(result.body.error).toBe('Validation failed');
    expect(ASSET_FAULT_REPORT_QUEUE).toHaveLength(0);
  });

  it('rejects malformed JSON with 400', async () => {
    const result = await request('{not-json', { ip: '10.33.0.1' });
    expect(result.statusCode).toBe(400);
    expect(result.body.error).toContain('Malformed JSON');
  });

  it('rate-limits repeated submissions from one connection', async () => {
    const ip = '10.34.0.1';
    for (let index = 0; index < 10; index += 1) {
      const payload = {
        ...validPayload(),
        description: `The bench has a distinct visible fault recorded as report ${index} for rate limiting.`,
      };
      const result = await request(payload, { ip });
      expect(result.statusCode).toBe(201);
    }
    const blocked = await request(
      { ...validPayload(), description: 'The bench has one more distinct fault for the rate-limit test.' },
      { ip }
    );
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['Retry-After']).toBeTruthy();
    expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('allows only POST and never exposes queue contents', async () => {
    const get = await request(null, { method: 'GET', ip: '10.35.0.1' });
    expect(get.statusCode).toBe(405);
    expect(get.body.error).toContain('Method Not Allowed');
    expect(get.headers.Allow).toBe('POST');
    expect(get.body.items).toBeUndefined();

    const remove = await request(null, { method: 'DELETE', ip: '10.36.0.1' });
    expect(remove.statusCode).toBe(405);
  });
});
