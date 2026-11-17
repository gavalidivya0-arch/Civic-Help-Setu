/**
 * Least-privilege asset-registry authorisation.
 *
 * Site-wide roles remain "admin" and "citizen". A municipality can provision
 * an administrator with an additional asset role (`operator` or `reviewer`)
 * and one or more jurisdiction ids. This module narrows that permission; it
 * never widens it. The signed-in actor registered by AuthProvider is the only
 * source of role or jurisdiction facts.
 */

import { getCurrentActor } from './accessControl';
import { ASSET_CAPABILITIES, ASSET_ERROR_CODES, ASSET_ROLES, STAFF_ASSET_ROLES } from './assetRegistryConstants';
import { createAssetError } from './assetRegistryValidation';

const isKnownStaffRole = (role) => STAFF_ASSET_ROLES.includes(role);

export const resolveAssetRole = (actor = getCurrentActor()) => {
  if (!actor || typeof actor !== 'object') return ASSET_ROLES.CITIZEN;

  const metadata = actor.raw?.publicMetadata || {};
  const claimed = actor.assetRole || actor.raw?.publicMetadata?.assetRole || metadata.assetRole || null;
  const siteRole = actor.role || metadata.role || null;

  if (siteRole === ASSET_ROLES.ADMIN) {
    return isKnownStaffRole(claimed) ? claimed : ASSET_ROLES.ADMIN;
  }
  if (isKnownStaffRole(siteRole) && (!claimed || claimed === siteRole)) {
    return siteRole;
  }
  return ASSET_ROLES.CITIZEN;
};

export const resolveActorJurisdictions = (actor = getCurrentActor()) => {
  if (!actor || typeof actor !== 'object') return [];
  const metadata = actor.raw?.publicMetadata || {};
  const candidates = [
    actor.jurisdictionId,
    actor.jurisdiction,
    metadata.jurisdictionId,
    metadata.jurisdiction,
    ...(Array.isArray(actor.jurisdictionIds) ? actor.jurisdictionIds : []),
    ...(Array.isArray(metadata.jurisdictionIds) ? metadata.jurisdictionIds : []),
  ];
  return [...new Set(
    candidates
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim())
  )];
};

export const actorHasAllJurisdictions = (actor = getCurrentActor()) =>
  resolveAssetRole(actor) === ASSET_ROLES.ADMIN && resolveActorJurisdictions(actor).length === 0;

/** null means "all jurisdictions" (full registry administrator). */
export const getScopedJurisdictions = (actor = getCurrentActor()) =>
  actorHasAllJurisdictions(actor) ? null : resolveActorJurisdictions(actor);

export const isAssetStaff = (actor = getCurrentActor()) =>
  STAFF_ASSET_ROLES.includes(resolveAssetRole(actor));

export const canAsset = (capability, actor = getCurrentActor(), { allowAnonymous = false } = {}) => {
  const rule = ASSET_CAPABILITIES[capability];
  if (!rule) return false;
  if (!actor && !allowAnonymous) return false;
  return rule.roles.includes(resolveAssetRole(actor));
};

export const assertAssetCapability = (capability, actor = getCurrentActor(), { allowAnonymous = false } = {}) => {
  const rule = ASSET_CAPABILITIES[capability];
  if (!rule) {
    throw createAssetError(ASSET_ERROR_CODES.UNKNOWN_CAPABILITY, `Unknown asset capability: ${capability}`);
  }
  if (!actor && !allowAnonymous) {
    throw createAssetError(ASSET_ERROR_CODES.UNAUTHENTICATED);
  }
  const role = resolveAssetRole(actor);
  if (!rule.roles.includes(role)) {
    throw createAssetError(ASSET_ERROR_CODES.PERMISSION_DENIED, `Role ${role} cannot perform ${capability}.`);
  }
  return role;
};

export const assertAssetJurisdiction = (actor, jurisdictionId, { forRead = false } = {}) => {
  if (!jurisdictionId) {
    throw createAssetError(ASSET_ERROR_CODES.VALIDATION_ERROR, 'A jurisdiction is required.');
  }
  if (actorHasAllJurisdictions(actor)) return true;
  const scoped = resolveActorJurisdictions(actor);
  if (scoped.includes(jurisdictionId)) return true;
  throw createAssetError(
    ASSET_ERROR_CODES.JURISDICTION_FORBIDDEN,
    `Actor is not assigned to jurisdiction ${jurisdictionId}.`,
    {
      details: { requiredJurisdiction: jurisdictionId },
      userMessage: forRead
        ? 'This record belongs to a jurisdiction you are not assigned to.'
        : 'You cannot change a record outside your assigned jurisdiction.',
    }
  );
};

export const actorIdentity = (actor = getCurrentActor()) => {
  if (!actor || typeof actor !== 'object') return null;
  const id = String(actor.id || actor.username || actor.email || '').trim();
  if (!id) return null;
  return {
    id,
    label: String(actor.fullName || actor.username || actor.email || 'Staff member').trim().slice(0, 120),
    role: resolveAssetRole(actor),
    jurisdictions: resolveActorJurisdictions(actor),
  };
};

export const requireActorIdentity = (actor = getCurrentActor()) => {
  const identity = actorIdentity(actor);
  if (!identity) throw createAssetError(ASSET_ERROR_CODES.UNAUTHENTICATED);
  return identity;
};

export const listAssetCapabilities = (actor = getCurrentActor()) =>
  Object.entries(ASSET_CAPABILITIES)
    .filter(([, rule]) => rule.roles.includes(resolveAssetRole(actor)))
    .map(([capability]) => capability);

export const canUseAssetStaffWorkspace = (actor = getCurrentActor()) => isAssetStaff(actor);
