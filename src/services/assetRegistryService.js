/**
 * Public import surface for the QR-Based Public Asset Maintenance and Repair
 * History Registry (#750).
 *
 * React pages and tests import from this one module. The implementation is
 * split across a shared core plus lifecycle, inspection, fault and work-order
 * modules so each file stays reviewable; every write still goes through the
 * same trusted-service checks.
 */

export * from './assetRegistryConstants';
export * from './assetRegistryCore';
export * from './assetLifecycleService';
export * from './assetInspectionService';
export * from './assetFaultService';
export * from './assetWorkOrderService';
export { getAssetStorage } from './assetRegistryValidation';
export { analyzeFaultTriage } from './assetTriageService';
export {
  ASSET_CATEGORY_SEED,
  ASSET_DEMO_QR_TOKENS,
  ASSET_JURISDICTIONS,
  ASSET_LOCATION_SEED,
} from '../data/publicAssetData';
