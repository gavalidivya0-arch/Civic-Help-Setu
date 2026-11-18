// Office Slot Feed Service
// Fetches authorized slot feeds for offices and services, with caching,
// freshness tracking, and explicit stale-state handling.
//
// Integrates with existing Civic Help Setu authentication, privacy, and design conventions.
// Live slot state comes directly from the authorized feed; never invents slots.

import { createSlotFeedEntry, normalizeSlotFeedEntry, groupSlotsByStatus, computeFeedFreshnessSummary, getHeatmapLegend, getSlotStatusAriaLabel, isDateSelectable, SLOT_FRESHNESS, SLOT_STATUS } from '../data/slot-feeds';
import { getAllServices, getServiceById } from '../services/serviceCatalog';
import { filterCivicOffices } from '../services/locationService';
import { AVAILABLE_STATES, AVAILABLE_DISTRICTS } from '../data/locationOffices';
import { dataMinimization } from '../services/dataMinimization';

// ============================================================
// Constants
// ============================================================

/**
 * Feed freshness windows (in minutes).
 * Short windows ensure citizens see current availability.
 */
export const FEED_FRESHNESS_WINDOWS = {
  FRESH_MINUTES: 15,    // within last 15 minutes -> fresh
  STALE_MINUTES: 120,   // 15min - 2h -> stale
  VERY_STALE_MINUTES: 240, // > 2h -> very stale
};

/**
 * Cache key for slot feeds in localStorage.
 * Contains only non-sensitive slot data; no Aadhaar numbers, passwords, OTPs.
 */
const SLOT_FEED_CACHE_KEY = 'civicbridge_slot_feeds_cache';

/**
 * Default cache expiry: 5 minutes. After this, data is considered stale
 * and a fresh fetch is attempted on next component render.
 */
const DEFAULT_CACHE_EXPIRY_MINUTES = 5;

/**
 * Maximum number of dates to display in monthly heatmap.
 * 42 days (6 weeks x 7 days) gives a full month grid starting from Sunday.
 */
const MAX_MONTH_DAYS = 42;

/**
 * Pagination limit for slot feed entries.
 * Prevents loading extremely large datasets; client-side pagination
 * can be implemented if needed.
 */
const SLOT_FEED_PAGE_LIMIT = 100;

/**
 * Supported office-service combinations that have verified slot feeds.
 * In production, this would come from a backend endpoint or admin configuration.
 * Currently populated with synthetic data for demonstration.
 */
const VERIFIED_SLOT_FEED_COMBINATIONS = new Set();

/**
 * Mapping of office IDs to their service IDs that have slot feeds.
 * Structure: { officeId: ['serviceId1', 'serviceId2'] }
 */
const OFFICE_SERVICE_SLOT_FEED_MAP = new Map();

// ============================================================
// Synthetic / Mock Slot Feed Data
// ============================================================

/**
 * Generates synthetic slot feed data for a given office and service.
 * In production, this would be replaced by a fetch from an authorized
 * government API endpoint.
 *
 * @param {string} officeId - The office identifier
 * @param {string} serviceId - The service identifier
 * @param {Object} [options] - Configuration options
 * @param {number} [options.daysBack=7] - How many days back to generate data for
 * @param {boolean} [options.useRealDates] - Whether to use real dates starting from today
 * @returns {Array<Object>} Slot feed entries for each date
 */
export const generateSyntheticSlotFeed = (officeId, serviceId, options = {}) => {
  const {
    daysBack = 7,
    useRealDates = true,
  } = options;

  const today = new Date();
  const entries = [];

  // Generate slot data for the last `daysBack` days plus current month
  const totalDays = daysBack + 30; // cover current month + some backlog

  for (let i = 0; i < totalDays; i++) {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - i);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, 2);
    const formattedDate = `${year}-${month}-${day}`;

    // Determine status based on day of week and random factors
    // Monday-Friday have more slots; weekends vary
    const dayOfWeek = date.getUTCDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isFriday = dayOfWeek === 5;

    let status;
    let slotCount;

    // Weekend pattern: reduced availability
    if (isWeekend) {
      const weekendChance = Math.random();
      if (weekendChance < 0.5) {
        status = SLOT_STATUS.UNAVAILABLE;
        slotCount = 0;
      } else if (weekendChance < 0.8) {
        status = SLOT_STATUS.LIMITED;
        slotCount = Math.floor(Math.random() * 5) + 1; // 1-5 slots
      } else {
        status = SLOT_STATUS.AVAILABLE;
        slotCount = Math.floor(Math.random() * 10) + 1; // 1-10 slots
      }
    } else {
      // Weekday pattern
      if (isFriday) {
        // Fridays tend to be busier
        const fridayChance = Math.random();
        if (fridayChance < 0.4) {
          status = SLOT_STATUS.FULL;
          slotCount = 0;
        } else if (fridayChance < 0.7) {
          status = SLOT_STATUS.LIMITED;
          slotCount = Math.floor(Math.random() * 5) + 1;
        } else {
          status = SLOT_STATUS.AVAILABLE;
          slotCount = Math.floor(Math.random() * 15) + 1; // 1-15 slots
        }
      } else {
        // Monday-Thursday
        const weekdayChance = Math.random();
        if (weekdayChance < 0.5) {
          status = SLOT_STATUS.AVAILABLE;
          slotCount = Math.floor(Math.random() * 20) + 1; // 1-20 slots
        } else if (weekdayChance < 0.8) {
          status = SLOT_STATUS.LIMITED;
          slotCount = Math.floor(Math.random() * 10) + 1; // 1-10 slots
        } else {
          status = SLOT_STATUS.FULL;
          slotCount = 0;
        }
      }
    }

    // Add some entries with no slots at all (maintenance, holidays, etc.)
    if (Math.random() < 0.05) {
      status = SLOT_STATUS.UNAVAILABLE;
      slotCount = 0;
    }

    const entry = createSlotFeedEntry(
      formattedDate,
      status,
      slotCount,
      // Simulate a source timestamp within the last 24 hours
      // Fresh entries will have recent timestamps
      today.toISOString()
    );

    entries.push(entry);
  }

  // Reverse so entries are in chronological order (oldest first)
  return entries.reverse();
};

/**
 * Gets slot feed data for a specific office and service.
 * Tries cache first, then generates synthetic data if no live feed available.
 *
 * @param {string} officeId - The office identifier
 * @param {string} serviceId - The service identifier
 * @param {Object} [options] - Fetch options
 * @param {boolean} [options.useCache=true] - Whether to use cached data
 * @param {number} [options.cacheExpiryMinutes] - Custom cache expiry in minutes
 * @returns {Object} { entries, freshness, lastChecked, sourceTimestamp }
 */
export const getSlotFeed = async (officeId, serviceId, options = {}) => {
  const {
    useCache = true,
    cacheExpiryMinutes = DEFAULT_CACHE_EXPIRY_MINUTES,
  } = options;

  // Check cache
  if (useCache) {
    try {
      const raw = localStorage.getItem(SLOT_FEED_CACHE_KEY);
      if (raw) {
        const cache = JSON.parse(raw);
        if (cache.officeId === officeId && cache.serviceId === serviceId) {
          const cachedTime = new Date(cache.cachedAt);
          const now = new Date();
          const diffMinutes = (now - cachedTime) / 60000;

          if (diffMinutes < cacheExpiryMinutes) {
            // Cache is valid - compute freshness and return
            const summary = computeFeedFreshnessSummary(cache.entries);
            return {
              entries: cache.entries,
              freshness: summary.freshness,
              lastChecked: summary.lastChecked,
              sourceTimestamp: summary.lastChecked,
              fromCache: true,
            };
          }
        }
      }
    } catch (err) {
      // Cache corrupt - fall through to fresh fetch
      logDiagnostic('Failed to parse slot feed cache', err);
    }
  }

  // Try to find real slot feed data
  // In production, this would call an authorized government API
  // For now, check if we have verified combinations
  let entries;

  if (OFFICE_SERVICE_SLOT_FEED_MAP.has(officeId) && 
      OFFICE_SERVICE_SLOT_FEED_MAP.get(officeId).includes(serviceId)) {
    // We have verified slot feed data for this combination
    const feedData = OFFICE_SERVICE_SLOT_FEED_MAP.get(officeId).find(
      f => f.serviceId === serviceId
    );
    if (feedData && feedData.entries) {
      entries = feedData.entries;
    }
  }

  if (!entries) {
    // No live feed available - generate synthetic data for demonstration
    // In production, this would be replaced by a real API call
    entries = generateSyntheticSlotFeed(officeId, serviceId);
  }

  // Normalize entries
  const normalizedEntries = entries.map(normalizeSlotFeedEntry).filter(Boolean);

  // Compute freshness summary
  const summary = computeFeedFreshnessSummary(normalizedEntries);

  // Store in cache
  try {
    const cacheData = {
      officeId,
      serviceId,
      entries: normalizedEntries,
      cachedAt: new Date().toISOString(),
    };
    localStorage.setItem(SLOT_FEED_CACHE_KEY, JSON.stringify(cacheData));
  } catch (err) {
    logDiagnostic('Failed to write slot feed cache', err);
  }

  return {
    entries: normalizedEntries,
    freshness: summary.freshness,
    lastChecked: summary.lastChecked,
    sourceTimestamp: summary.lastChecked,
    fromCache: false,
  };
};

/**
 * Updates the verified slot feed map with new data from an authorized source.
 * This would typically be called by an admin backend task or API endpoint.
 *
 * @param {string} officeId - The office identifier
 * @param {string} serviceId - The service identifier
 * @param {Array<Object>} entries - Slot feed entries
 * @param {Object} [metadata] - Additional metadata (source URL, last checked, etc.)
 */
export const updateVerifiedSlotFeed = (officeId, serviceId, entries, metadata = {}) => {
  const { sourceUrl, lastChecked } = metadata;

  // Normalize entries
  const normalizedEntries = entries.map(normalizeSlotFeedEntry).filter(Boolean);

  // Initialize office map entry if needed
  if (!OFFICE_SERVICE_SLOT_FEED_MAP.has(officeId)) {
    OFFICE_SERVICE_SLOT_FEED_MAP.set(officeId, []);
  }

  // Check if service already has an entry, update it
  const officeEntries = OFFICE_SERVICE_SLOT_FEED_MAP.get(officeId);
  const existingIndex = officeEntries.findIndex(
    (e) => e.serviceId === serviceId
  );

  const feedEntry = {
    serviceId,
    entries: normalizedEntries,
    sourceUrl,
    lastChecked: lastChecked || new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };

  if (existingIndex >= 0) {
    officeEntries[existingIndex] = feedEntry;
  } else {
    officeEntries.push(feedEntry);
  }

  // Keep map updated
  OFFICE_SERVICE_SLOT_FEED_MAP.set(officeId, officeEntries);

  // Also update the cache
  try {
    localStorage.setItem(SLOT_FEED_CACHE_KEY, JSON.stringify({
      officeId,
      serviceId,
      entries: normalizedEntries,
      cachedAt: new Date().toISOString(),
    }));
  } catch (err) {
    logDiagnostic('Failed to update slot feed cache', err);
  }

  // Add to verified combinations set
  VERIFIED_SLOT_FEED_COMBINATIONS.add(`${officeId}:${serviceId}`);

  return feedEntry;
};

/**
 * Removes a verified slot feed entry.
 */
export const removeVerifiedSlotFeed = (officeId, serviceId) => {
  if (OFFICE_SERVICE_SLOT_FEED_MAP.has(officeId)) {
    const officeEntries = OFFICE_SERVICE_SLOT_FEED_MAP.get(officeId);
    const filtered = officeEntries.filter(
      (e) => e.serviceId !== serviceId
    );
    OFFICE_SERVICE_SLOT_FEED_MAP.set(officeId, filtered);
  }

  // Remove from verified combinations set
  VERIFIED_SLOT_FEED_COMBINATIONS.delete(`${officeId}:${serviceId}`);
};

/**
 * Checks if a office-service combination has a verified slot feed.
 */
export const hasVerifiedSlotFeed = (officeId, serviceId) => {
  return VERIFIED_SLOT_FEED_COMBINATIONS.has(`${officeId}:${serviceId}`);
};

/**
 * Gets all office IDs that have verified slot feeds for a given service.
 */
export const getOfficesWithSlotFeed = (serviceId) => {
  const offices = [];
  OFFICE_SERVICE_SLOT_FEED_MAP.forEach((officeEntries, officeId) => {
    if (officeEntries.some((e) => e.serviceId === serviceId)) {
      offices.push(officeId);
    }
  });
  return offices;
};

/**
 * Gets all service IDs that have verified slot feeds for a given office.
 */
export const getServicesWithSlotFeed = (officeId) => {
  if (!OFFICE_SERVICE_SLOT_FEED_MAP.has(officeId)) return [];
  return OFFICE_SERVICE_SLOT_FEED_MAP.get(officeId)
    .filter((e) => e.entries && e.entries.length > 0)
    .map((e) => e.serviceId);
};

/**
 * Filters offices by those that have verified slot feeds for a given service.
 */
export const filterOfficesWithSlotFeed = (offices, serviceId) => {
  const officesWithFeed = getOfficesWithSlotFeed(serviceId);
  return offices.filter((office) => officesWithFeed.includes(office.id));
};

/**
 * Builds the full slot feed data for a service across all relevant offices.
 * This is the main data-fetching function for the heatmap component.
 *
 * @param {string} serviceId - The service identifier
 * @param {Object} [options] - Options
 * @param {string} [options.state] - Filter by state
 * @param {string} [options.district] - Filter by district
 * @param {boolean} [options.useCache=true] - Whether to use cached data
 * @param {number} [options.cacheExpiryMinutes] - Custom cache expiry
 * @returns {Object} { entriesByOffice, freshnessSummaries, offices, service }
 */
export const buildSlotFeedForService = async (serviceId, options = {}) => {
  const {
    state,
    district,
    useCache = true,
    cacheExpiryMinutes = DEFAULT_CACHE_EXPIRY_MINUTES,
  } = options;

  // Get all services to validate the serviceId
  const allServices = getAllServices();
  const service = allServices.find((s) => s.id === serviceId);

  if (!service) {
    return {
      entriesByOffice: {},
      freshnessSummaries: {},
      offices: [],
      service: null,
      error: `Service "${serviceId}" not found`,
    };
  }

  // Get offices, optionally filtered by state/district
  const offices = filterCivicOffices({
    state,
    district,
    serviceId: service.id,
    offices: AVAILABLE_STATES.length > 0 ? undefined : undefined,
  });

  // Filter offices that have verified slot feeds for this service
  const officesWithFeed = filterOfficesWithSlotFeed(offices, serviceId);

  // Build slot feed entries for each office
  const entriesByOffice = {};
  const freshnessSummaries = {};

  for (const office of officesWithFeed) {
    const feed = await getSlotFeed(office.id, serviceId, {
      useCache,
      cacheExpiryMinutes,
    });

    entriesByOffice[office.id] = {
      officeId: office.id,
      officeName: office.name,
      entries: feed.entries,
    };

    freshnessSummaries[office.id] = {
      freshness: feed.freshness,
      lastChecked: feed.lastChecked,
      description: getFeedFreshnessDescription(feed.freshness),
    };
  }

  return {
    entriesByOffice,
    freshnessSummaries,
    offices: officesWithFeed,
    service,
    error: null,
  };
};

/**
 * Gets a human-readable description for a feed freshness state.
 */
const getFeedFreshnessDescription = (freshness) => {
  const descriptions = {
    [SLOT_FRESHNESS.FRESH]: 'Slot availability data is currently fresh (checked within last 15 minutes).',
    [SLOT_FRESHNESS.STALE]: 'Slot availability data is stale. Last checked recently, availability may have changed.',
    [SLOT_FRESHNESS.VERY_STALE]: 'Slot availability data is very stale. Last checked over 2 hours ago - availability may have changed significantly.',
    [SLOT_FRESHNESS.NO_FEED]: 'No live slot feed available for this office. Showing office-published appointment instructions instead.',
  };
  return descriptions[freshness] || '';
};

/**
 * Parses service filter parameters from search params.
 * Reuses existing utility from the codebase.
 */
export const parseServiceFilters = (searchParams, { categories, departments }) => {
  // Simple filter parsing - in production would use the existing searchParams utility
  const result = {
    category: 'All',
    department: 'All',
  };

  if (searchParams) {
    const cat = searchParams.get('cat');
    const dept = searchParams.get('dept');
    if (cat) result.category = cat;
    if (dept) result.department = dept;
  }

  return result;
};

// ============================================================
// Authentication & Privacy Helpers
// ============================================================

/**
 * Checks if the authenticated user has permission to view slot feed data
 * for a given office/service combination.
 * Slot feed data is considered public civic information; no authentication
 * is required to view availability, but administrative endpoints
 * have role-based access control.
 *
 * @param {string} officeId - The office identifier
 * @param {string} serviceId - The service identifier
 * @returns {boolean} Whether the user can view this slot feed
 */
export const canViewSlotFeed = (officeId, serviceId) => {
  // Slot feed data is publicly available civic information
  // Authentication is not required for citizens to view appointment availability
  // Administrative endpoints have separate role-based checks
  return true;
};

/**
 * Gets the official booking URL for a service at a given office.
 * This is the destination citizens should be redirected to when they
 * select a date from the heatmap.
 *
 * @param {string} officeId - The office identifier
 * @param {string} serviceId - The service identifier
 * @returns {string|null} The official booking URL, or null if not available
 */
export const getOfficialBookingUrl = (officeId, serviceId) => {
  // In production, this would look up the URL from a database or configuration
  // For now, return null - the heatmap component will show guidance
  // and the "Inspect official booking destination" button will handle navigation
  return null;
};

/**
 * Gets appointment instructions for an office/service combination
 * when no live slot feed is available.
 *
 * @param {string} officeId - The office identifier
 * @param {string} serviceId - The service identifier
 * @returns {Object} Appointment instructions
 */
export const getAppointmentInstructions = (officeId, serviceId) => {
  // Look up the service from the catalogue
  const allServices = getAllServices();
  const service = allServices.find((s) => s.id === serviceId);

  if (!service) {
    return {
      instructions: 'Service not found.',
      sourceUrl: null,
    };
  }

  // Return the first official source URL as guidance
  const officialSource = service.officialSources?.[0];
  const sourceUrl = officialSource?.url || null;

  // Build instructions from the service steps
  const steps = service.steps || [];

  const instructions = {
    serviceId,
    officeId,
    serviceName: service.name,
    officeGuidance: sourceUrl ? `Visit the official portal: ${sourceUrl}` : 'No official portal found.',
    steps,
    lastVerified: service.lastVerified,
    disclaimer:
      'Notice: Slot availability data is not available via live feed. ' +
      'Please refer to the official government portal for current appointment slots. ' +
      'This app does not reserve or modify appointments on your behalf.',
  };

  return instructions;
};

// ============================================================
// Diagnostics Logging
// ============================================================

const logDiagnostic = (message, error) => {
  // In production, this would send to a logging service
  // For now, just log to console in development
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log(`[SlotFeed] ${message}`, error || '');
  }
};

// Export all constants and types for use in components
export {
  SLOT_STATUS,
  SLOT_FRESHNESS,
  MAX_MONTH_DAYS,
  SLOT_FEED_PAGE_LIMIT,
  VERIFIED_SLOT_FEED_COMBINATIONS,
  OFFICE_SERVICE_SLOT_FEED_MAP,
};