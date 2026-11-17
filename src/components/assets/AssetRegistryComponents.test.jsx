import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AssetPublicRegister, { AssetPublicDetail } from './AssetPublicRegister';
import AssetFaultReportForm, { validateAssetFaultReportForm } from './AssetFaultReportForm';
import AssetStaffWorkspace from './AssetStaffWorkspace';
import {
  AssetOfflineNotice,
  AssetPermissionDenied,
  AssetRegistryEmptyState,
  AssetRegistryErrorState,
  AssetRegistrySkeleton,
} from './AssetStates';
import { setCurrentActor } from '../../services/accessControl';
import { ensureAssetRegistryData } from '../../services/assetRegistryService';
import {
  getAssetAuditTrail,
  getAssetInspectionReminders,
  getAssetMigrationStatus,
  getAssetRegistrySummary,
  getAssetStorage,
  getPlanningJurisdictions,
  getPublicAssetByQrToken,
  getPublicAssets,
  listAssetCategories,
  listAssetInspections,
  listAssetLocations,
  listFaultReports,
  listStaffAssets,
  listTriageSuggestions,
  listWorkOrders,
} from '../../services/assetRegistryService';

const createMemoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
};

const admin = { id: 'admin_1', username: 'Registry Administrator', role: 'admin', raw: { publicMetadata: {} } };

let storage;

beforeEach(() => {
  storage = createMemoryStorage();
  ensureAssetRegistryData({ storage, nowMs: Date.parse('2026-11-16T08:00:00.000Z') });
  globalThis.localStorage = storage;
  setCurrentActor(null);
});

afterEach(() => {
  delete globalThis.localStorage;
  setCurrentActor(null);
});

const publicData = () => getPublicAssets({ pageSize: 50 }, storage);

describe('AssetPublicRegister — approved public projection', () => {
  it('renders approved cards, filters and no internal fields', () => {
    const html = renderToStaticMarkup(
      <AssetPublicRegister
        data={publicData()}
        jurisdictions={getPlanningJurisdictions()}
        categories={listAssetCategories(storage)}
        wards={getPlanningJurisdictions()[0].wards}
        filters={{}}
        onReport={() => {}}
        onSelect={() => {}}
      />
    );

    expect(html).toContain('Approved public asset register');
    expect(html).toContain('Filter the public asset register');
    expect(html).toContain('BLR-AST-0001');
    expect(html).toContain('Condition:');
    expect(html).toContain('approximately 1 km grid');
    expect(html).toContain('Report a fault for BLR-AST-0001');
    expect(html).toContain('No verified repair recorded');
    expect(html).not.toContain('internalNotes');
    expect(html).not.toContain('reporterKeyHash');
    expect(html).not.toContain('warranty');
  });

  it('renders the empty state when filters exclude every asset', () => {
    const emptyData = getPublicAssets({ jurisdictionId: 'del', search: 'no-such-asset-name' }, storage);
    const html = renderToStaticMarkup(
      <AssetPublicRegister
        data={emptyData}
        jurisdictions={getPlanningJurisdictions()}
        categories={listAssetCategories(storage)}
        wards={[]}
        filters={{}}
        onReset={() => {}}
      />
    );
    expect(html).toContain('No public assets match these filters');
    expect(html).toContain('Reset filters');
  });
});

describe('AssetPublicDetail — verified repair and inspection history', () => {
  it('shows verified repair history without staff identifiers or evidence URLs', () => {
    const asset = getPublicAssetByQrToken('demo-tag-play-koramangala-6b2e8d4a1c9f7e30', {}, storage);
    const html = renderToStaticMarkup(<AssetPublicDetail asset={asset} onReport={() => {}} onBack={() => {}} />);

    expect(html).toContain('Verified repair history');
    expect(html).toContain('Verified inspection history');
    expect(html).toContain('slide panel');
    expect(html).toContain('Only approved public fields are shown');
    expect(html).not.toContain('recordedBy');
    expect(html).not.toContain('completion photo data');
    expect(html).not.toContain('data:image/png;base64');
  });
});

describe('AssetFaultReportForm — client validation and success state', () => {
  it('requires an asset, category, severity and a descriptive observation', () => {
    const errors = validateAssetFaultReportForm({ description: 'short' });
    expect(errors.assetPublicId).toBeTruthy();
    expect(errors.category).toBeTruthy();
    expect(errors.description).toBeTruthy();
  });

  it('accepts a valid observation and renders a duplicate-safe confirmation', () => {
    expect(
      validateAssetFaultReportForm({
        assetPublicId: 'BLR-AST-0001',
        category: 'damage',
        severity: 'major',
        description: 'One timber slat is loose and a fixing bolt is protruding from the seat.',
      })
    ).toEqual({});

    const html = renderToStaticMarkup(
      <AssetFaultReportForm
        asset={{ publicId: 'BLR-AST-0001', name: 'Indiranagar bus-stop bench' }}
        result={{
          duplicate: true,
          message: 'This report is already in the municipal queue.',
          publicReport: {
            publicReference: 'AST-REP-7K2M9Q',
            stateLabel: 'Submitted',
            createdAt: '2026-11-16T08:00:00.000Z',
          },
        }}
      />
    );

    expect(html).toContain('This report is already queued');
    expect(html).toContain('AST-REP-7K2M9Q');
    expect(html).toContain('citizen report, not a verified municipal inspection');
  });

  it('renders accessibility help and privacy guidance', () => {
    const html = renderToStaticMarkup(<AssetFaultReportForm assets={[]} />);
    expect(html).toContain('Reports are unverified observations');
    expect(html).toContain('Do not include your name, phone number, email, Aadhaar');
    expect(html).toContain('At least 20 characters');
    expect(html).toContain('JPEG, PNG or WebP');
  });
});

describe('AssetStaffWorkspace — scoped operational controls', () => {
  const staffData = () => {
    setCurrentActor(admin);
    const data = {
      assets: listStaffAssets({ pageSize: 100 }, storage),
      inspections: listAssetInspections({ pageSize: 100 }, storage),
      orders: listWorkOrders({ pageSize: 100 }, storage),
      reports: listFaultReports({ pageSize: 100 }, storage),
      triage: listTriageSuggestions({ pageSize: 100 }, storage),
      summary: getAssetRegistrySummary(storage),
      reminders: getAssetInspectionReminders({}, storage),
      audit: getAssetAuditTrail({ pageSize: 20 }, storage),
      migration: getAssetMigrationStatus(getAssetStorage()),
      categories: listAssetCategories(storage),
      locations: listAssetLocations({}, storage),
      jurisdictions: getPlanningJurisdictions(),
    };
    setCurrentActor(null);
    return data;
  };

  it('renders scoped tables, audit chain and migration status for an administrator', () => {
    const html = renderToStaticMarkup(
      <AssetStaffWorkspace
        data={staffData()}
        permissions={{
          canCreate: true,
          canUpdate: true,
          canRetire: true,
          canIssueQr: true,
          canRevokeQr: true,
          canScheduleInspection: true,
          canCompleteInspection: true,
          canVerifyInspection: true,
          canTriage: true,
          canReviewReport: true,
          canReviewTriage: true,
          canManageOrders: true,
          canCompleteOrder: true,
          canVerifyOrder: true,
          canMigrate: true,
          canManageRetention: true,
        }}
      />
    );

    expect(html).toContain('Municipal asset maintenance workspace');
    expect(html).toContain('Assets in scope');
    expect(html).toContain('Inspection reminders');
    expect(html).toContain('Registry freshness');
    expect(html).toContain('Triage is advisory and versioned');

    const assetsHtml = renderToStaticMarkup(
      <AssetStaffWorkspace
        data={staffData()}
        permissions={{
          canCreate: true,
          canUpdate: true,
          canRetire: true,
          canIssueQr: true,
          canRevokeQr: true,
          canScheduleInspection: true,
          canCompleteInspection: true,
          canVerifyInspection: true,
          canTriage: true,
          canReviewReport: true,
          canReviewTriage: true,
          canManageOrders: true,
          canCompleteOrder: true,
          canVerifyOrder: true,
          canMigrate: true,
          canManageRetention: true,
        }}
        staffTab="assets"
      />
    );
    expect(assetsHtml).toContain('Registered public assets');
    expect(assetsHtml).toContain('BLR-AST-0001');
    expect(assetsHtml).toContain('Register asset');
  });

  it('does not render restricted controls when permissions are absent', () => {
    const html = renderToStaticMarkup(
      <AssetStaffWorkspace data={staffData()} permissions={{}} staffTab="assets" />
    );
    expect(html).toContain('Registered public assets');
    expect(html).not.toContain('Register asset');
    expect(html).not.toContain('QR tags');
    expect(html).not.toContain('Lifecycle');
  });
});

describe('Asset registry state components', () => {
  it('renders loading, empty, error, offline and permission states with text labels', () => {
    expect(renderToStaticMarkup(<AssetRegistrySkeleton />)).toContain('Loading the public asset register');
    expect(renderToStaticMarkup(<AssetRegistryEmptyState />)).toContain('No public assets match these filters');
    const errorHtml = renderToStaticMarkup(
      <AssetRegistryErrorState error={{ code: 'ASSET_QR_INVALID', userMessage: 'Tag revoked.' }} onRetry={() => {}} />
    );
    expect(errorHtml).toContain('Error code: ASSET_QR_INVALID');
    expect(errorHtml).toContain('Retry');
    expect(renderToStaticMarkup(<AssetOfflineNotice />)).toContain('Offline mode');
    expect(renderToStaticMarkup(<AssetPermissionDenied />)).toContain('Staff workspace requires a municipal asset role');
  });
});
