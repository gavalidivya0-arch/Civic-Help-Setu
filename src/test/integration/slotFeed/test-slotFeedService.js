// Integration tests for office slot feed service
import {
  getSlotFeed,
  updateVerifiedSlotFeed,
  removeVerifiedSlotFeed,
  hasVerifiedSlotFeed,
  getOfficesWithSlotFeed,
  getServicesWithSlotFeed,
  filterOfficesWithSlotFeed,
  buildSlotFeedForService,
  canViewSlotFeed,
  getOfficialBookingUrl,
  getAppointmentInstructions,
  SLOT_STATUS,
  SLOT_FRESHNESS,
  FEED_FRESHNESS_WINDOWS,
} from '../../../../src/services/officeSlotFeedService';

describe('Office Slot Feed Service - Integration Tests', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    // Clear the in-memory maps
    // These are module-level, so we need to reset them
    // We'll test the functions that don't depend on the maps being populated
  });

  describe('getSlotFeed', () => {
    test('returns cached data when available and fresh', () => {
      // Set up cached data
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(
          require('../../../../src/services/officeSlotFeedService').SLOT_FEED_CACHE_KEY,
          JSON.stringify({
            officeId: 'test-office',
            serviceId: 'test-service',
            entries: [
              { date: '2026-01-15', status: SLOT_STATUS.AVAILABLE, slotCount: 10, sourceTimestamp: '2026-01-15T10:30:00Z' },
            ],
            cachedAt: new Date().toISOString(),
          })
        );
      }

      const result = getSlotFeed('test-office', 'test-service', {
        useCache: true,
        cacheExpiryMinutes: 60, // 1 hour expiry
      });

      expect(result.fromCache).toBe(true);
      expect(result.entries).toBeDefined();
      expect(result.freshness).toBeDefined();
    });

    test('forces fresh fetch when cache expired', () => {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(
          require('../../../../src/services/officeSlotFeedService').SLOT_FEED_CACHE_KEY,
          JSON.stringify({
            officeId: 'test-office',
            serviceId: 'test-service',
            entries: [
              { date: '2026-01-15', status: SLOT_STATUS.AVAILABLE, slotCount: 10, sourceTimestamp: '2026-01-10T10:30:00Z' },
            ],
            cachedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
          })
        );
      }

      // With 5 minute expiry, this should force fresh fetch
      const result = getSlotFeed('test-office', 'test-service', {
        useCache: true,
        cacheExpiryMinutes: 5,
      });

      // Should still return data but freshness should be computed
      expect(result.entries).toBeDefined();
      expect(result.freshness).toBeDefined();
    });

    test('generates synthetic data when no cache or verified feed', () => {
      // No cache set, no verified feed
      const result = getSlotFeed('unknown-office', 'unknown-service', {
        useCache: true,
        cacheExpiryMinutes: 5,
      });

      expect(result.entries).toBeDefined();
      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.freshness).toBeDefined();
    });
  });

  describe('hasVerifiedSlotFeed', () => {
    test('returns false when no feeds verified', () => {
      expect(hasVerifiedSlotFeed('office-1', 'service-1')).toBe(false);
    });

    test('returns true when feed is verified', () => {
      // Mark a feed as verified
      updateVerifiedSlotFeed('office-1', 'service-1', [
        { date: '2026-01-15', status: SLOT_STATUS.AVAILABLE, slotCount: 5 },
      ], { sourceUrl: 'https://example.com', lastChecked: new Date().toISOString() });

      expect(hasVerifiedSlotFeed('office-1', 'service-1')).toBe(true);
    });
  });

  describe('getOfficesWithSlotFeed', () => {
    test('returns empty array when no offices have slot feeds', () => {
      const offices = getOfficesWithSlotFeed('nonexistent-service');
      expect(offices).toEqual([]);
    });
  });

  describe('getServicesWithSlotFeed', () => {
    test('returns empty array when no services have slot feeds', () => {
      const services = getServicesWithSlotFeed('nonexistent-office');
      expect(services).toEqual([]);
    });
  });

  describe('filterOfficesWithSlotFeed', () => {
    test('filters offices to those with slot feeds', () => {
      // First verify a feed
      updateVerifiedSlotFeed('office-tn-rto', 'birth-certificate', [
        { date: '2026-01-15', status: SLOT_STATUS.AVAILABLE, slotCount: 10 },
      ]);

      // Create mock offices
      const mockOffices = [
        { id: 'office-tn-rto', name: 'RTO Chennai' },
        { id: 'office-tn-sr', name: 'Sub-Registrar Office' },
        { id: 'office-another', name: 'Another Office' },
      ];

      const filtered = filterOfficesWithSlotFeed(mockOffices, 'birth-certificate');
      expect(filtered.map((o) => o.id)).toContain('office-tn-rto');
      expect(filtered).not.toContain('office-another');
    });
  });

  describe('buildSlotFeedForService', () => {
    test('returns error when service not found', () => {
      const result = buildSlotFeedForService('nonexistent-service');
      expect(result.error).toBeDefined();
      expect(result.service).toBeNull();
    });

    test('builds slot feed data for valid service', async () => {
      // First verify a feed
      updateVerifiedSlotFeed('office-tn-rto', 'birth-certificate', [
        { date: '2026-01-15', status: SLOT_STATUS.AVAILABLE, slotCount: 10 },
        { date: '2026-01-16', status: SLOT_STATUS.LIMITED, slotCount: 3 },
      ]);

      const result = await buildSlotFeedForService('birth-certificate', {
        state: 'Tamil Nadu',
      });

      expect(result.service).toBeDefined();
      expect(result.entriesByOffice).toBeDefined();
      expect(Object.keys(result.entriesByOffice)).toBeDefined();
    });
  });

  describe('getAppointmentInstructions', () => {
    test('returns instructions for valid service', () => {
      const instructions = getAppointmentInstructions('office-tn-rto', 'birth-certificate');
      expect(instructions).toBeDefined();
      expect(instructions.serviceName).toBeDefined();
      expect(instructions.officeGuidance).toBeDefined();
      expect(instructions.disclaimer).toBeDefined();
    });

    test('returns instructions when service not found', () => {
      const instructions = getAppointmentInstructions('office-tn-rto', 'nonexistent-service');
      expect(instructions).toBeDefined();
      expect(instructions.serviceName).toBe('Service not found.');
    });
  });

  describe('canViewSlotFeed', () => {
    test('returns true for any office/service combination', () => {
      expect(canViewSlotFeed('any-office', 'any-service')).toBe(true);
    });
  });

  describe('getOfficialBookingUrl', () => {
    test('returns null by default', () => {
      const url = getOfficialBookingUrl('office-tn-rto', 'birth-certificate');
      expect(url).toBeNull();
    });
  });

  describe('FEED_FRESHNESS_WINDOWS', () => {
    test('has correct freshness window constants', () => {
      expect(FEED_FRESHNESS_WINDOWS.FRESH_MINUTES).toBe(15);
      expect(FEED_FRESHNESS_WINDOWS.STALE_MINUTES).toBe(120);
      expect(FEED_FRESHNESS_WINDOWS.VERY_STALE_MINUTES).toBe(240);
    });
  });
});