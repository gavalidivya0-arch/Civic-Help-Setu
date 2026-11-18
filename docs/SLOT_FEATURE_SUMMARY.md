# Service Appointment Availability Heatmap - Feature Summary

## Overview
This feature implements a monthly heatmap calendar showing appointment slot availability from verified government slot feeds. Citizens can see at a glance which dates have available, limited, full, or unavailable slots, and select a date to inspect the official booking destination.

## Primary User Flow

1. **Citizen selects a supported office and service** from the services directory
2. **App fetches an authorized slot feed** from the government API
3. **Calendar displays available, limited, full, or unavailable dates** with color-independent text labels
4. **Citizen selects a date** to inspect the official booking destination
5. **If no live feed exists**, shows only office-published appointment instructions

## Data Model

### Slot Status
- `available` - Slots are available for booking
- `limited` - Few slots remaining - book soon
- `full` - No slots available on this date
- `unavailable` - Appointment services not offered on this date

### Feed Freshness
- `fresh` - Checked within last 15 minutes
- `stale` - Checked 15min - 2h ago
- `veryStale` - Checked > 2h ago
- `noFeed` - No live feed available

### Slot Feed Entry
```json
{
  "date": "2026-01-15",
  "status": "available",
  "slotCount": 10,
  "sourceTimestamp": "2026-01-15T10:30:00Z",
  "feedFreshness": "fresh"
}
```

## Components

### OfficeSlotHeatmap
- Renders monthly grid calendar (42 days: 6 weeks x 7 days)
- Color-independent text legend for all statuses
- Slot count details when supplied
- Date selection with official booking destination navigation
- Accessible list alternative for every chart element
- Loading, empty, error, stale-data, and permission-denied states
- Keyboard navigation (arrow keys, Home, End)
- Reduced-motion support
- Shows feed freshness and last checked time

### Data Flow
1. `buildSlotFeedForService(serviceId, options)` - Main data fetching function
2. `getSlotFeed(officeId, serviceId, options)` - With caching and freshness
3. `updateVerifiedSlotFeed(officeId, serviceId, entries, metadata)` - Admin update
4. `normalizeSlotFeedEntry(entry)` - Validation and normalization

## API Integration

### Endpoints (to be implemented on backend)
- `GET /api/slot-feeds?officeId=&serviceId=&dateRange=` - Fetch verified slot feeds
- `POST /api/slot-feeds/verify` - Admin: Verify and store slot feed data
- `GET /api/slot-feeds/freshness` - Get feed freshness summary

### Request Validation
- Validate officeId and serviceId against service catalogue
- Validate date ranges are within reasonable bounds
- Return structured error responses for malformed inputs
- Pagination support for large datasets (default: 100 entries per page)

### Response Format
```json
{
  "entries": [
    {
      "date": "2026-01-15",
      "status": "available",
      "slotCount": 10,
      "sourceTimestamp": "2026-01-15T10:30:00Z",
      "feedFreshness": "fresh"
    }
  ],
  "freshnessSummary": {
    "freshness": "fresh",
    "lastChecked": "2026-01-15T10:30:00Z",
    "description": "Slot availability data is currently fresh."
  }
}
```

## Security, Privacy, and Accessibility

### Data Minimization
- Only slot status and count data is collected
- No Aadhaar numbers, passwords, OTPs, or uploaded document contents
- No personal identifiers exposed in logs or UI

### Authentication
- Slot feed data is publicly available civic information
- No authentication required for citizens to view appointment availability
- Administrative endpoints have role-based access control
- All requests validated on both client and server

### Accessibility
- Color-independent text labels for all statuses
- Visible focus indicators on interactive elements
- Semantic HTML with proper aria-labels
- Keyboard navigation support (arrow keys, Home, End)
- Screen reader friendly aria-labels on all cells
- Reduced-motion support
- Accessible list alternative for every chart element
- `sr-only` text for supplementary information

### Data Freshness
- Short freshness windows (15 min fresh, 2h very stale)
- Explicit stale-state handling and UI marking
- "Last checked" timestamp displayed
- Manual refresh button available

### Error Handling
- Structured error responses on both client and server
- Graceful degradation when feeds are unavailable
- No-feed offices show guidance rather than guessed slots
- Loading, empty, error, and stale-data states all handled

## Tests

### Unit Tests (`src/test/unit/slotFeed/test-slotFeed.js`)
- Slot status constants
- Entry creation and normalization
- Status grouping
- Feed freshness summary computation
- Status labels and aria labels
- Heatmap legend generation
- Date selectability

### Component Tests (`src/test/component/OfficeSlotHeatmap/OfficeSlotHeatmap.test.jsx`)
- Renders without crashing
- Shows loading state
- Displays heatmap calendar grid
- Shows slot count details
- Shows feed freshness indicator
- Handles date selection
- Shows accessible aria labels
- Shows no-feed instructions
- Keyboard navigation support
- Color-independent text labels
- Month navigation
- Reduced motion preference

### Integration Tests (`src/test/integration/slotFeed/test-slotFeedService.js`)
- Cached data retrieval
- Cache expiry and fresh fetch
- Synthetic data generation
- Verified feed tracking
- Office/service filtering
- Service not found errors
- Appointment instructions
- Default constants

## Environment Variables

### Required
- `VITE_SLOT_FEED_API_BASE` - Base URL for slot feed API (optional, for production)
- `VITE_SLOT_FEED_CACHE_TTL` - Cache time-to-live in minutes (default: 5)

### Optional (for development/mock mode)
- `VITE_MOCK_SLOT_FEEDS` - Enable mock slot feed data (default: true)

## Manual Verification Steps

1. **Start the development server**: `npm run dev`
2. **Navigate to a service page** with slot feed data
3. **Verify heatmap calendar renders** with correct date grid
4. **Check status labels** are text-independent (not color-only)
5. **Select a date** and verify it navigates to official booking portal
6. **Test month navigation** (prev/next month buttons)
7. **Verify keyboard navigation** works with arrow keys
8. **Check feed freshness** is displayed and updates on refresh
9. **Test error states** (simulate failed feed fetch)
10. **Verify no-feed guidance** shows when no live data available
11. **Test responsive behavior** (desktop and mobile)
12. **Run test suite**: `npm test`

## Sample Synthetic Data for Reviewers

```javascript
// Example slot feed entries for a birth-certificate service at RTO Chennai
const exampleEntries = [
  { date: '2026-01-15', status: 'available', slotCount: 15, sourceTimestamp: '2026-01-15T10:30:00Z' },
  { date: '2026-01-16', status: 'limited', slotCount: 3, sourceTimestamp: '2026-01-15T10:30:00Z' },
  { date: '2026-01-17', status: 'full', slotCount: 0, sourceTimestamp: '2026-01-15T10:30:00Z' },
  { date: '2026-01-18', status: 'unavailable', slotCount: 0, sourceTimestamp: '2026-01-15T10:30:00Z' },
];

// Example freshness summary
const freshnessSummary = {
  freshness: 'fresh',
  lastChecked: '2026-01-15T10:30:00Z',
  description: 'Slot availability data is currently fresh.',
};
```

## Design Conventions Reused

- **Authentication**: Existing Clerk auth integration
- **Privacy**: Data minimization following existing patterns
- **Design**: Consistent with existing heatmap/calendar components in the codebase
- **Accessibility**: Following established InlineStatusLegend, DataFreshnessTrustBadge patterns
- **Error handling**: Structured error responses per existing service patterns
- **Caching**: LocalStorage-based caching with short TTL following existing patterns