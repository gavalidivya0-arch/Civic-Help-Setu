import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PublicAssetRegistry from './PublicAssetRegistry';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock('../context/NetworkContext', () => ({
  useNetwork: () => ({ isOnline: true }),
}));

const createMemoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
};

const renderPage = (path) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/public-assets" element={<PublicAssetRegistry />} />
        <Route path="/public-assets/tag/:token" element={<PublicAssetRegistry />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  globalThis.localStorage = createMemoryStorage();
});

afterEach(() => {
  delete globalThis.localStorage;
});

describe('PublicAssetRegistry page', () => {
  it('renders the public register with privacy and QR-tag guidance', () => {
    const html = renderPage('/public-assets');

    expect(html).toContain('Public Asset Maintenance &amp; Repair History Registry');
    expect(html).toContain('QR tags are lookup keys only');
    expect(html).toContain('A QR tag only identifies a public asset');
    expect(html).toContain('Approved public asset register');
    expect(html).toContain('BLR-AST-0001');
    expect(html).toContain('Report a fault');
    expect(html).not.toContain('Staff workspace');
    expect(html).not.toContain('internalNotes');
    expect(html).not.toContain('reporterKeyHash');
  });

  it('opens a scanned QR tag as a public detail page with verified history', () => {
    const html = renderPage('/public-assets/tag/demo-tag-play-koramangala-6b2e8d4a1c9f7e30');

    expect(html).toContain('Scanned municipal asset tag');
    expect(html).toContain('BLR-AST-0003');
    expect(html).toContain('Verified repair history');
    expect(html).toContain('slide panel');
    expect(html).toContain('Open the full public register');
    expect(html).not.toContain('recordedBy');
    expect(html).not.toContain('warranty until 2029');
    expect(html).not.toContain('reporterKeyHash');
  });

  it('shows a recoverable error for an invalid or revoked QR tag', () => {
    const html = renderPage('/public-assets/tag/not-a-real-token-but-long-enough-x');

    expect(html).toContain('This asset tag cannot be opened');
    expect(html).toContain('invalid, expired or has been revoked');
    expect(html).toContain('ASSET_QR_INVALID');
  });
});
