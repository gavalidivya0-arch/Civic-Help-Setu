// Unit tests for slot feed data model
import {
  SLOT_STATUS,
  SLOT_FRESHNESS,
  createSlotFeedEntry,
  normalizeSlotFeedEntry,
  groupSlotsByStatus,
  computeFeedFreshnessSummary,
  getSlotStatusLabel,
  getSlotStatusAriaLabel,
  getHeatmapLegend,
  isDateSelectable,
} from '../data/slot-feeds';

describe('Slot Status Constants', () => {
  test('SLOT_STATUS has all required statuses', () => {
    expect(SLOT_STATUS.AVAILABLE).toBe('available');
    expect(SLOT_STATUS.LIMITED).toBe('limited');
    expect(SLOT_STATUS.FULL).toBe('full');
    expect(SLOT_STATUS.UNAVAILABLE).toBe('unavailable');
  });

  test('SLOT_FRESHNESS has all required freshness states', () => {
    expect(SLOT_FRESHNESS.FRESH).toBe('fresh');
    expect(SLOT_FRESHNESS.STALE).toBe('stale');
    expect(SLOT_FRESHNESS.VERY_STALE).toBe('veryStale');
    expect(SLOT_FRESHNESS.NO_FEED).toBe('noFeed');
  });
});

describe('createSlotFeedEntry', () => {
  test('creates entry with fresh feed freshness', () => {
    const entry = createSlotFeedEntry('2026-01-15', SLOT_STATUS.AVAILABLE, 10, '2026-01-15T10:30:00Z');
    expect(entry.status).toBe(SLOT_STATUS.AVAILABLE);
    expect(entry.slotCount).toBe(10);
    expect(entry.sourceTimestamp).toBe('2026-01-15T10:30:00Z');
    expect(entry.feedFreshness).toBe(SLOT_FRESHNESS.FRESH);
  });

  test('creates entry with stale feed freshness', () => {
    const entry = createSlotFeedEntry('2026-01-15', SLOT_STATUS.AVAILABLE, 10, '2026-01-14T10:30:00Z');
    expect(entry.feedFreshness).toBe(SLOT_FRESHNESS.STALE);
  });

  test('creates entry with very stale feed freshness', () => {
    const entry = createSlotFeedEntry('2026-01-15', SLOT_STATUS.AVAILABLE, 10, '2026-01-13T10:30:00Z');
    expect(entry.feedFreshness).toBe(SLOT_FRESHNESS.VERY_STALE);
  });

  test('creates entry with no source timestamp', () => {
    const entry = createSlotFeedEntry('2026-01-15', SLOT_STATUS.AVAILABLE, 10);
    expect(entry.sourceTimestamp).toBeNull();
    expect(entry.feedFreshness).toBe(SLOT_FRESHNESS.NO_FEED);
  });

  test('creates entry with zero slot count', () => {
    const entry = createSlotFeedEntry('2026-01-15', SLOT_STATUS.FULL, 0);
    expect(entry.slotCount).toBe(0);
    expect(entry.status).toBe(SLOT_STATUS.FULL);
  });
});

describe('normalizeSlotFeedEntry', () => {
  test('normalizes valid entry', () => {
    const result = normalizeSlotFeedEntry({
      date: '2026-01-15',
      status: SLOT_STATUS.AVAILABLE,
      slotCount: 5,
      sourceTimestamp: '2026-01-15T10:30:00Z',
    });
    expect(result).toBeDefined();
    expect(result.date).toBe('2026-01-15');
    expect(result.status).toBe(SLOT_STATUS.AVAILABLE);
    expect(result.slotCount).toBe(5);
  });

  test('rejects invalid date format', () => {
    const result = normalizeSlotFeedEntry({
      date: 'invalid',
      status: SLOT_STATUS.AVAILABLE,
    });
    expect(result).toBeNull();
  });

  test('rejects invalid status', () => {
    const result = normalizeSlotFeedEntry({
      date: '2026-01-15',
      status: 'invalid_status',
    });
    expect(result).toBeNull();
  });

  test('rejects null entry', () => {
    const result = normalizeSlotFeedEntry(null);
    expect(result).toBeNull();
  });

  test('rejects undefined entry', () => {
    const result = normalizeSlotFeedEntry(undefined);
    expect(result).toBeNull();
  });

  test('normalizes entry with null slotCount', () => {
    const result = normalizeSlotFeedEntry({
      date: '2026-01-15',
      status: SLOT_STATUS.AVAILABLE,
      slotCount: null,
      sourceTimestamp: '2026-01-15T10:30:00Z',
    });
    expect(result.slotCount).toBeNull();
  });
});

describe('groupSlotsByStatus', () => {
  test('groups entries by status', () => {
    const entries = [
      { date: '2026-01-15', status: SLOT_STATUS.AVAILABLE, slotCount: 5 },
      { date: '2026-01-16', status: SLOT_STATUS.FULL, slotCount: 0 },
      { date: '2026-01-17', status: SLOT_STATUS.AVAILABLE, slotCount: 3 },
    ];
    const groups = groupSlotsByStatus(entries);
    expect(groups[SLOT_STATUS.AVAILABLE].length).toBe(2);
    expect(groups[SLOT_STATUS.FULL].length).toBe(1);
    expect(groups[SLOT_STATUS.LIMITED].length).toBe(0);
    expect(groups[SLOT_STATUS.UNAVAILABLE].length).toBe(0);
  });
});

describe('computeFeedFreshnessSummary', () => {
  test('returns NO_FEED for empty entries', () => {
    const result = computeFeedFreshnessSummary([]);
    expect(result.freshness).toBe(SLOT_FRESHNESS.NO_FEED);
    expect(result.lastChecked).toBeNull();
    expect(result.description).toContain('No slot feed available');
  });

  test('returns FRESH when all entries are fresh', () => {
    const entries = [
      createSlotFeedEntry('2026-01-15', SLOT_STATUS.AVAILABLE, 10, '2026-01-15T10:30:00Z'),
      createSlotFeedEntry('2026-01-16', SLOT_STATUS.AVAILABLE, 5, '2026-01-15T11:00:00Z'),
    ];
    const result = computeFeedFreshnessSummary(entries);
    expect(result.freshness).toBe(SLOT_FRESHNESS.FRESH);
    expect(result.description).toContain('fresh');
  });

  test('returns STALE when some entries are stale', () => {
    const entries = [
      createSlotFeedEntry('2026-01-15', SLOT_STATUS.AVAILABLE, 10, '2026-01-14T10:30:00Z'),
      createSlotFeedEntry('2026-01-16', SLOT_STATUS.AVAILABLE, 5, '2026-01-13T10:30:00Z'),
    ];
    const result = computeFeedFreshnessSummary(entries);
    expect(result.freshness).toBe(SLOT_FRESHNESS.STALE);
    expect(result.lastChecked).toBe('2026-01-14T10:30:00Z');
  });

  test('returns VERY_STALE when all entries are very stale', () => {
    const entries = [
      createSlotFeedEntry('2026-01-15', SLOT_STATUS.AVAILABLE, 10, '2026-01-12T10:30:00Z'),
      createSlotFeedEntry('2026-01-16', SLOT_STATUS.AVAILABLE, 5, '2026-01-11T10:30:00Z'),
    ];
    const result = computeFeedFreshnessSummary(entries);
    expect(result.freshness).toBe(SLOT_FRESHNESS.VERY_STALE);
    expect(result.lastChecked).toBe('2026-01-12T10:30:00Z');
  });
});

describe('getSlotStatusLabel', () => {
  test('returns correct labels for all statuses', () => {
    expect(getSlotStatusLabel(SLOT_STATUS.AVAILABLE)).toBe('Available slots');
    expect(getSlotStatusLabel(SLOT_STATUS.LIMITED)).toBe('Limited availability');
    expect(getSlotStatusLabel(SLOT_STATUS.FULL)).toBe('No available slots');
    expect(getSlotStatusLabel(SLOT_STATUS.UNAVAILABLE)).toBe('Unavailable');
  });
});

describe('getSlotStatusAriaLabel', () => {
  test('includes slot count when provided', () => {
    expect(getSlotStatusAriaLabel(SLOT_STATUS.AVAILABLE, 5)).toBe('Available slots - 5 slot(s) available');
    expect(getSlotStatusAriaLabel(SLOT_STATUS.LIMITED, 2)).toBe('Limited availability - 2 slot(s) available');
    expect(getSlotStatusAriaLabel(SLOT_STATUS.FULL, 0)).toBe('No available slots - 0 slot(s) available');
  });

  test('returns base label when slotCount is null', () => {
    expect(getSlotStatusAriaLabel(SLOT_STATUS.AVAILABLE, null)).toBe('Available slots');
    expect(getSlotStatusAriaLabel(SLOT_STATUS.FULL, undefined)).toBe('No available slots');
  });
});

describe('getHeatmapLegend', () => {
  test('returns legend with all statuses', () => {
    const legend = getHeatmapLegend();
    expect(legend.length).toBe(4);
    expect(legend.some((item) => item.key === SLOT_STATUS.AVAILABLE)).toBe(true);
    expect(legend.some((item) => item.key === SLOT_STATUS.LIMITED)).toBe(true);
    expect(legend.some((item) => item.key === SLOT_STATUS.FULL)).toBe(true);
    expect(legend.some((item) => item.key === SLOT_STATUS.UNAVAILABLE)).toBe(true);
  });
});

describe('isDateSelectable', () => {
  test('returns true for fresh entries', () => {
    const entry = createSlotFeedEntry('2026-01-15', SLOT_STATUS.AVAILABLE, 10, '2026-01-15T10:30:00Z');
    expect(isDateSelectable(entry)).toBe(true);
  });

  test('returns false for very stale entries', () => {
    const entry = createSlotFeedEntry('2026-01-15', SLOT_STATUS.AVAILABLE, 10, '2026-01-12T10:30:00Z');
    expect(isDateSelectable(entry)).toBe(false);
  });

  test('returns false for no feed entries', () => {
    const entry = createSlotFeedEntry('2026-01-15', SLOT_STATUS.AVAILABLE, 10);
    // No timestamp means NO_FEED freshness
    expect(isDateSelectable(entry)).toBe(false);
  });
});