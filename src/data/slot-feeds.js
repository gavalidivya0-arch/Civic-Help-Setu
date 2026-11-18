// Slot feed data model for service appointment availability.
// This defines the shape of verified slot feed data that the heatmap visualizer consumes.
// All slots come from authorized government feeds; never invent or reserve slots.

export const SLOT_STATUS = {
  AVAILABLE: 'available',
  LIMITED: 'limited',
  FULL: 'full',
  UNAVAILABLE: 'unavailable',
};

export const SLOT_FRESHNESS = {
  FRESH: 'fresh', // checked within last 15 minutes
  STALE: 'stale', // checked 15min - 2h ago
  VERY_STALE: 'veryStale', // checked > 2h ago
  NO_FEED: 'noFeed', // no live feed available
};

export const MONTH_VIEW_DAYS = 42; // 6 weeks x 7 days for consistent monthly grid

/**
 * Slot feed entry for a specific date.
 * Represents appointment slot availability for one date at one office/service.
 */
export const createSlotFeedEntry = (date, status, slotCount = null, sourceTimestamp = null) => {
  const entry = {
    date,                              // YYYY-MM-DD string
    status,                            // SLOT_STATUS.* 
    slotCount,                         // number of available slots (optional)
    sourceTimestamp,                   // ISO string when last checked
    feedFreshness: SLOT_FRESHNESS.NO_FEED, // will be set by consumer
  };

  // Set feed freshness based on source timestamp
  if (sourceTimestamp) {
    const checked = new Date(sourceTimestamp);
    const now = new Date();
    const diffMinutes = (now - checked) / 60000;

    if (diffMinutes < 15) {
      entry.feedFreshness = SLOT_FRESHNESS.FRESH;
    } else if (diffMinutes < 120) {
      entry.feedFreshness = SLOT_FRESHNESS.STALE;
    } else {
      entry.feedFreshness = SLOT_FRESHNESS.VERY_STALE;
    }
  }

  return entry;
};

/**
 * Normalizes a slot feed entry, ensuring required fields and valid values.
 */
export const normalizeSlotFeedEntry = (entry) => {
  if (!entry) return null;

  const date = entry.date ? String(entry.date).trim() : null;
  const status = entry.status ? String(entry.status).trim() : null;
  const slotCount = entry.slotCount !== undefined && entry.slotCount !== null
    ? Number(entry.slotCount)
    : null;
  const sourceTimestamp = entry.sourceTimestamp ? String(entry.sourceTimestamp).trim() : null;

  // Validate date format YYYY-MM-DD
  const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
  const dateMatch = date ? datePattern.exec(date) : null;
  const isValidDate = dateMatch && 
    new Date(Date.UTC(dateMatch[1], dateMatch[2] - 1, dateMatch[3])).getUTCFullYear() === dateMatch[1] &&
    new Date(Date.UTC(dateMatch[1], dateMatch[2] - 1, dateMatch[3])).getUTCMonth() === dateMatch[2] - 1 &&
    new Date(Date.UTC(dateMatch[1], dateMatch[2] - 1, dateMatch[3])).getUTCDate() === dateMatch[3];

  if (!date || !status || !isValidDate) return null;

  // Validate status
  const validStatuses = Object.values(SLOT_STATUS);
  if (!validStatuses.includes(status)) return null;

  return {
    date,
    status,
    slotCount: slotCount >= 0 ? slotCount : null,
    sourceTimestamp,
    feedFreshness: null, // will be computed by consumer
  };
};

/**
 * Group slot feed entries by status for legend rendering.
 */
export const groupSlotsByStatus = (entries) => {
  const groups = {
    [SLOT_STATUS.AVAILABLE]: [],
    [SLOT_STATUS.LIMITED]: [],
    [SLOT_STATUS.FULL]: [],
    [SLOT_STATUS.UNAVAILABLE]: [],
  };

  entries.forEach((entry) => {
    if (groups[entry.status]) {
      groups[entry.status].push(entry);
    }
  });

  return groups;
};

/**
 * Calculate feed freshness summary for display.
 */
export const computeFeedFreshnessSummary = (entries) => {
  if (!entries || entries.length === 0) {
    return {
      freshness: SLOT_FRESHNESS.NO_FEED,
      lastChecked: null,
      description: 'No slot feed available for this office/service.',
    };
  }

  const lastChecked = entries
    .map((e) => e.sourceTimestamp)
    .filter(Boolean)
    .sort()
    .reverse()[0] || null;

  const hasFresh = entries.some((e) => e.feedFreshness === SLOT_FRESHNESS.FRESH);
  const hasStale = entries.some((e) => e.feedFreshness === SLOT_FRESHNESS.STALE);
  const hasVeryStale = entries.some((e) => e.feedFreshness === SLOT_FRESHNESS.VERY_STALE);

  if (hasFresh) {
    return {
      freshness: SLOT_FRESHNESS.FRESH,
      lastChecked,
      description: 'Slot availability data is currently fresh.',
    };
  }

  if (hasStale) {
    return {
      freshness: SLOT_FRESHNESS.STALE,
      lastChecked,
      description: 'Slot availability data is stale. Last checked: ' + (lastChecked ? new Date(lastChecked).toLocaleDateString() : 'unknown'),
    };
  }

  if (hasVeryStale) {
    return {
      freshness: SLOT_FRESHNESS.VERY_STALE,
      lastChecked,
      description: 'Slot availability data is very stale. Last checked: ' + (lastChecked ? new Date(lastChecked).toLocaleDateString() : 'unknown'),
    };
  }

  return {
    freshness: SLOT_FRESHNESS.NO_FEED,
    lastChecked,
    description: 'No slot feed available for this office/service.',
  };
};

/**
 * Get accessible text label for a slot status, independent of color.
 */
export const getSlotStatusLabel = (status) => {
  const labels = {
    [SLOT_STATUS.AVAILABLE]: 'Available slots',
    [SLOT_STATUS.LIMITED]: 'Limited availability',
    [SLOT_STATUS.FULL]: 'No available slots',
    [SLOT_STATUS.UNAVAILABLE]: 'Unavailable',
  };
  return labels[status] || status;
};

/**
 * Get color-accessible description for a slot status.
 * Returns a text string that can be read by screen readers.
 */
export const getSlotStatusAriaLabel = (status, slotCount) => {
  const base = getSlotStatusLabel(status);
  if (slotCount !== null && slotCount !== undefined) {
    return `${base} - ${slotCount} slot(s) available`;
  }
  return base;
};

/**
 * Determines if a date is selectable in the heatmap calendar.
 * A date is selectable if the feed is fresh or stale but not very stale.
 */
export const isDateSelectable = (entry) => {
  if (!entry) return false;
  return entry.feedFreshness !== SLOT_FRESHNESS.VERY_STALE && entry.feedFreshness !== SLOT_FRESHNESS.NO_FEED;
};

/**
 * Gets the legend items for the heatmap, with color-independent text.
 */
export const getHeatmapLegend = () => [
  {
    key: SLOT_STATUS.AVAILABLE,
    label: 'Available',
    aria: 'Available slots',
    count: null,
  },
  {
    key: SLOT_STATUS.LIMITED,
    label: 'Limited',
    aria: 'Limited availability',
    count: null,
  },
  {
    key: SLOT_STATUS.FULL,
    label: 'Full',
    aria: 'No available slots',
    count: null,
  },
  {
    key: SLOT_STATUS.UNAVAILABLE,
    label: 'Unavailable',
    aria: 'Unavailable',
    count: null,
  },
];