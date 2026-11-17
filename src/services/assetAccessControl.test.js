import { describe, it, expect, afterEach } from 'vitest';
import { setCurrentActor } from './accessControl';
import {
  assertAssetCapability,
  assertAssetJurisdiction,
  canAsset,
  canUseAssetStaffWorkspace,
  getScopedJurisdictions,
  isAssetStaff,
  listAssetCapabilities,
  resolveAssetRole,
  resolveActorJurisdictions,
} from './assetAccessControl';
import { ASSET_ERROR_CODES, ASSET_ROLES } from './assetRegistryConstants';

afterEach(() => setCurrentActor(null));

const makeActor = (metadata, overrides = {}) => ({
  id: 'actor_1',
  username: 'Actor',
  role: 'admin',
  raw: { publicMetadata: metadata },
  ...overrides,
});

describe('asset access control', () => {
  it('resolves staff roles from signing metadata without widening site roles', () => {
    expect(resolveAssetRole(null)).toBe(ASSET_ROLES.CITIZEN);
    expect(resolveAssetRole({ id: 'citizen', role: 'citizen' })).toBe(ASSET_ROLES.CITIZEN);
    expect(resolveAssetRole(makeActor({ assetRole: 'operator' }))).toBe(ASSET_ROLES.OPERATOR);
    expect(resolveAssetRole(makeActor({ assetRole: 'reviewer', role: 'reviewer' }))).toBe(ASSET_ROLES.REVIEWER);
    expect(resolveAssetRole(makeActor({ assetRole: 'operator' }, { role: 'citizen' }))).toBe(ASSET_ROLES.CITIZEN);
    expect(resolveAssetRole(makeActor({ assetRole: 'nonsense' }))).toBe(ASSET_ROLES.ADMIN);
  });

  it('collects and de-duplicates jurisdiction assignments', () => {
    const actor = makeActor({ jurisdictionId: 'blr', jurisdictionIds: ['blr', 'del'] }, { jurisdictionId: 'del' });
    expect(resolveActorJurisdictions(actor).sort()).toEqual(['blr', 'del']);
    expect(getScopedJurisdictions(actor).sort()).toEqual(['blr', 'del']);
    setCurrentActor(makeActor({}, { role: 'admin' }));
    expect(getScopedJurisdictions()).toBeNull();
  });

  it('checks capabilities per role and supports explicit anonymous public reads', () => {
    expect(canAsset('asset.public.read', null, { allowAnonymous: true })).toBe(true);
    expect(canAsset('asset.staff.read', null, { allowAnonymous: true })).toBe(false);
    expect(canAsset('asset.staff.read', makeActor({ assetRole: 'operator' }))).toBe(true);
    expect(canAsset('asset.retire', makeActor({ assetRole: 'operator' }))).toBe(false);
    expect(canAsset('asset.retire', makeActor({ assetRole: 'reviewer' }))).toBe(true);
    expect(isAssetStaff(makeActor({ assetRole: 'reviewer' }))).toBe(true);
    expect(isAssetStaff({ id: 'citizen', role: 'citizen' })).toBe(false);
    expect(canUseAssetStaffWorkspace(makeActor({ assetRole: 'operator' }))).toBe(true);
    expect(listAssetCapabilities(makeActor({ assetRole: 'reviewer' }))).toContain('order.verify');
    expect(listAssetCapabilities(makeActor({ assetRole: 'reviewer' }))).not.toContain('asset.create');
  });

  it('throws stable codes for missing roles and unknown capabilities', () => {
    expect(() => assertAssetCapability('asset.staff.read', null)).toThrowError(
      expect.objectContaining({ code: ASSET_ERROR_CODES.UNAUTHENTICATED })
    );
    expect(() => assertAssetCapability('asset.create', makeActor({ assetRole: 'reviewer' }))).toThrowError(
      expect.objectContaining({ code: ASSET_ERROR_CODES.PERMISSION_DENIED })
    );
    expect(() => assertAssetCapability('asset.nonsense', makeActor({ assetRole: 'admin' }))).toThrowError(
      expect.objectContaining({ code: ASSET_ERROR_CODES.UNKNOWN_CAPABILITY })
    );
  });

  it('enforces jurisdiction scope for reads and writes', () => {
    const operator = makeActor({ assetRole: 'operator', jurisdictionId: 'blr' });
    expect(assertAssetJurisdiction(operator, 'blr')).toBe(true);
    expect(() => assertAssetJurisdiction(operator, 'del')).toThrowError(
      expect.objectContaining({ code: ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN })
    );
    const administrator = makeActor({});
    expect(assertAssetJurisdiction(administrator, 'del')).toBe(true);
  });
});
