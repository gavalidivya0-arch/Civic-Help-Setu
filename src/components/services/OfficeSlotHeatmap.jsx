// Office Slot Availability Heatmap Component
// Renders a monthly heatmap calendar showing appointment slot availability
// from verified slot feeds. Color-independent text legend, accessible list alternative.
// Integrates with existing Civic Help Setu authentication, privacy, and design conventions.
//
// Primary user flow:
// 1. Citizen selects a supported office and service
// 2. App fetches an authorized slot feed
// 3. Calendar displays available, limited, full, or unavailable dates
// 4. Citizen selects a date to inspect the official booking destination
// 5. If no live feed exists, shows only office-published appointment instructions

import React, { useState, useEffect, useCallback, useRef } from 'react';
import PropTypes from 'prop-types';
import {
  CalendarDays,
  CalendarX,
  Info,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Times,
  Loader2,
  Moon,
  Sun,
  ArrowRight,
  ArrowLeft,
} from 'lucide-react';
import {
  SLOT_STATUS,
  SLOT_FRESHNESS,
  getSlotStatusLabel,
  getSlotStatusAriaLabel,
  getHeatmapLegend,
  isDateSelectable,
  computeFeedFreshnessSummary,
  groupSlotsByStatus,
} from '../../data/slot-feeds';
import {
  buildSlotFeedForService,
  hasVerifiedSlotFeed,
  getAppointmentInstructions,
  canViewSlotFeed,
  getOfficialBookingUrl,
} from '../../services/officeSlotFeedService';
import { DataFreshnessTrustBadge } from '../DataFreshnessTrustBadge';
import { InlineStatusLegend } from '../common/InlineStatusLegend';
import { useToast } from '../../context/ToastContext';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

/**
 * Heatmap color palette descriptions (color-independent text).
 * These are used for the legend and aria labels.
 * Design: Use color+text combination; text is the primary means of identification.
 */
const STATUS_CONFIG = {
  [SLOT_STATUS.AVAILABLE]: {
    label: 'Available',
    aria: 'Available slots',
    description: 'Slots are available for booking on this date',
    bgClass: 'bg-slot-available',
    borderClass: 'border-slot-available',
  },
  [SLOT_STATUS.LIMITED]: {
    label: 'Limited',
    aria: 'Limited availability',
    description: 'Few slots remaining - book soon',
    bgClass: 'bg-slot-limited',
    borderClass: 'border-slot-limited',
  },
  [SLOT_STATUS.FULL]: {
    label: 'Full',
    aria: 'No available slots',
    description: 'No slots available on this date',
    bgClass: 'bg-slot-full',
    borderClass: 'border-slot-full',
  },
  [SLOT_STATUS.UNAVAILABLE]: {
    label: 'Unavailable',
    aria: 'Unavailable',
    description: 'Appointment services not offered on this date',
    bgClass: 'bg-slot-unavailable',
    borderClass: 'border-slot-unavailable',
  },
};

/**
 * Main heatmap calendar component.
 * Renders a monthly grid of slot availability.
 */
const OfficeSlotHeatmap = ({
  serviceId,
  officeId,
  officeName,
  showInstructionsWhenNoFeed = true,
}) => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [service, setService] = useState(null);
  const [office, setOffice] = useState(null);
  const [entriesByOffice, setEntriesByOffice] = useState({});
  const [freshnessSummaries, setFreshnessSummaries] = useState({});
  const [serviceLoaded, setServiceLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showInstructions, setShowInstructions] = useState(false);
  const [selectedDate, setSelectedDate] = useState(null);
  const [isMonthLoading, setIsMonthLoading] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Calendar navigation state
  const [currentDate, setCurrentDate] = useState(new Date());
  const [viewDate, setViewDate] = useState(new Date());

  // Ref for keyboard navigation
  const calendarRef = useRef(null);

  // Load service and office data
  useEffect(() => {
    // Initialize service from catalogue
    const allServices = window.__CIVIC_SERVICE_CATALOG__ || [];
    const foundService = allServices.find((s) => s.id === serviceId);
    setService(foundService);
    setServiceLoaded(true);
  }, [serviceId]);

  // Load office data from location service
  useEffect(() => {
    if (!officeId) return;

    // Normalize office - use the location service's OFFICES constant
    // In production, this would come from a proper office lookup
    const officeEntries = window.__CIVIC_OFFICES__ || [];
    const foundOffice = officeEntries.find((o) => o.id === officeId);
    setOffice(foundOffice);
  }, [officeId]);

  // Fetch slot feed data when serviceId and officeId change
  useEffect(() => {
    let mounted = true;

    if (!serviceId || !officeId || !serviceLoaded) {
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    buildSlotFeedForService(serviceId, {
      state: office?.state,
      district: office?.district,
      useCache: true,
      cacheExpiryMinutes: 5,
    })
      .then((result) => {
        if (mounted) {
          setEntriesByOffice(result.entriesByOffice);
          setFreshnessSummaries(result.freshnessSummaries);

          // If no offices have verified slot feeds, show instructions
          const hasAnyFeed = Object.values(result.entriesByOffice).some(
            (officeData) => officeData.entries && officeData.entries.length > 0
          );

          if (!hasAnyFeed && showInstructionsWhenNoFeed) {
            setShowInstructions(true);
          } else {
            setShowInstructions(false);
          }

          setLoading(false);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err.message || 'Failed to load slot feed data');
          setLoading(false);
          toast.error('Failed to load appointment availability data. Please try again.');
        }
      });

    return () => {
      mounted = false;
    };
  }, [serviceId, officeId, serviceLoaded, showInstructionsWhenNoFeed]);

  // Update view date when current date changes (for navigation)
  useEffect(() => {
    setViewDate(new Date(currentDate));
  }, [currentDate]);

  // Compute legend and slot groupings
  const legend = getHeatmapLegend();
  const slotConfigs = Object.entries(STATUS_CONFIG);

  // Generate the monthly calendar grid (42 days: 6 weeks x 7 days)
  // Start from Sunday of the current month's week
  useEffect(() => {
    if (!serviceId || !officeId) return;

    const generateCalendarGrid = () => {
      const entries = entriesByOffice[officeId];
      if (!entries || entries.length === 0) return [];

      // Get all entries for this office/service
      const allEntries = entries.entries || [];

      // Build a map of date -> entry for quick lookup
      const entryMap = new Map();
      allEntries.forEach((entry) => {
        if (entry.date) entryMap.set(entry.date, entry);
      });

      // Generate grid for a full month (42 cells)
      // Start from Sunday before the 1st of the month
      const today = new Date();
      const year = today.getUTCFullYear();
      const month = today.getUTCMonth(); // 0-indexed

      // Get the first day of the current month
      const firstOfMonth = new Date(Date.UTC(year, month, 1));
      const firstDayOfWeek = firstOfMonth.getUTCDay(); // 0=Sunday, 1=Monday, ...

      // Calculate start date (go back to previous Sunday)
      let startDate = new Date(firstOfMonth);
      startDate.setUTCDate(1 - firstDayOfWeek);
      if (firstDayOfWeek === 0) {
        // If 1st is Sunday, start from previous Sunday
        startDate = new Date(firstOfMonth);
      }

      const grid = [];
      for (let i = 0; i < 42; i++) {
        const cellDate = new Date(startDate);
        cellDate.setUTCDate(startDate.getUTCDate() + i);

        const year = cellDate.getUTCFullYear();
        const month = String(cellDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(cellDate.getUTCDate()).padStart(2, 2);
        const formattedDate = `${year}-${month}-${day}`;

        const entry = entryMap.get(formattedDate);
        const status = entry ? entry.status : SLOT_STATUS.UNAVAILABLE;
        const slotCount = entry ? entry.slotCount : null;
        const feedFreshness = entry ? entry.feedFreshness : SLOT_FRESHNESS.NO_FEED;
        const isSelectable = isDateSelectable(entry);

        grid.push({
          date: formattedDate,
          day: cellDate.getUTCDate(),
          month: cellDate.getUTCMonth() + 1,
          year: cellDate.getUTCFullYear(),
          formattedDate,
          dayName: [
            'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'
          ][cellDate.getUTCDay()],
          status,
          slotCount,
          feedFreshness,
          isSelectable,
          // Aria label for this cell
          ariaLabel: getSlotStatusAriaLabel(status, slotCount),
          // Tooltip/description text
          tooltip: `${getSlotStatusLabel(status)} - ${formattedDate}${slotCount !== null ? ` (${slotCount} slot${slotCount !== 1 ? 's' : ''})` : ''}`,
        });
      }

      return grid;
    };

    setEntriesByOffice(prev => ({
      ...prev,
      [officeId]: {
        officeId,
        officeName: officeName || office?.name || 'Unknown Office',
        entries: generateCalendarGrid(),
      }
    }));
  }, [serviceId, officeId, entriesByOffice, officeName]);

  // Handle date selection
  const handleDateSelect = useCallback((dateEntry) => {
    setSelectedDate(dateEntry.formattedDate);
    setShowDatePicker(true);

    // Navigate to the official booking destination for the selected date
    // In production, this would construct a URL with the date parameter
    // and open the official government portal
    if (canViewSlotFeed(officeId, serviceId)) {
      const bookingUrl = getOfficialBookingUrl(officeId, serviceId);
      if (bookingUrl) {
        // Open in new tab with official portal
        const url = new URL(bookingUrl);
        // Could append date parameters here
        window.open(url.toString(), '_blank', { rel: 'noopener noreferrer' });
      } else {
        // No specific booking URL - show general guidance
        toast.info(
          `Selected ${dateEntry.formattedDate}. Opening official booking portal for ${service?.name || 'this service'} at ${officeName || 'this office'}.`
        );
      }
    }
  }, [officeId, serviceId, toast, service?.name, officeName]);

  // Handle "Inspect official booking destination" action
  const handleInspectBooking = useCallback((date) => {
    navigate(`/services/${serviceId}/appointment?date=${date}&office=${officeId}`);
  }, [navigate, serviceId, officeId]);

  // Navigate between months
  const prevMonth = useCallback(() => {
    setCurrentDate((d) => {
      const newDate = new Date(d);
      newDate.setUTCMonth(newDate.getUTCMonth() - 1);
      return newDate;
    });
  }, []);

  const nextMonth = useCallback(() => {
    setCurrentDate((d) => {
      const newDate = new Date(d);
      newDate.setUTCMonth(newDate.getUTCMonth() + 1);
      return newDate;
    });
  }, []);

  // Refresh slot feed data
  const refreshSlotFeed = useCallback(async () => {
    setIsMonthLoading(true);
    setError(null);

    if (!serviceId || !officeId) {
      setIsMonthLoading(false);
      return;
    }

    try {
      const result = await buildSlotFeedForService(serviceId, {
        state: office?.state,
        district: office?.district,
        useCache: false, // Force fresh fetch
        cacheExpiryMinutes: 0,
      });

      setEntriesByOffice(result.entriesByOffice);
      setFreshnessSummaries(result.freshnessSummaries);

      // Show success toast
      if (result.error) {
        toast.warning(result.error);
      } else {
        toast.success('Slot feed refreshed successfully.');
      }
    } catch (err) {
      setError(err.message || 'Failed to refresh slot feed');
      toast.error('Failed to refresh slot feed data.');
    } finally {
      setIsMonthLoading(false);
    }
  }, [serviceId, officeId]);

  // Keyboard navigation handlers
  const handleKeyDown = useCallback((event) => {
    if (!calendarRef.current) return;

    const focusedCell = calendarRef.current.querySelector(':focus');
    if (!focusedCell) return;

    const cell = focusedCell.closest('.slot-cell');
    if (!cell) return;

    const cells = Array.from(cell.parentNode.querySelectorAll('.slot-cell'));
    const currentIndex = cells.indexOf(cell);

    let newIndex = currentIndex;
    let direction = null;

    switch (event.key) {
      case 'ArrowRight':
        direction = 'right';
        newIndex = currentIndex + 1;
        break;
      case 'ArrowLeft':
        direction = 'left';
        newIndex = currentIndex - 1;
        break;
      case 'ArrowUp':
        direction = 'up';
        newIndex = currentIndex - 7; // One week back
        break;
      case 'ArrowDown':
        direction = 'down';
        newIndex = currentIndex + 7; // One week forward
        break;
      case 'Home':
        newIndex = 0; // First day of month
        break;
      case 'End':
        newIndex = 41; // Last day of month
        break;
      default:
        return;
    }

    // Wrap around
    if (newIndex >= 0 && newIndex < cells.length) {
      cells[newIndex].focus();
      event.preventDefault();
    }
  }, []);

  // Effect for keyboard shortcuts
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Render instructions when no feed available
  const renderNoFeedInstructions = () => {
    if (!showInstructions || !office) return null;

    const instructions = getAppointmentInstructions(officeId, serviceId);

    return (
      <div className="slot-no-feed-container" aria-live="polite">
        <div className="slot-no-feed-card">
          <div className="slot-no-feed-icon">
            <Info size={24} color="var(--text-tertiary)" />
          </div>
          <h3 className="slot-no-feed-title">
            No live slot availability data
          </h3>
          <p className="slot-no-feed-description">
            {instructions.lastVerified
              ? `Last verified: ${new Date(instructions.lastVerified).toLocaleDateString()}`
              : ''}
          </p>
          <p className="slot-no-feed-instructions">
            {instructions.officeGuidance}
          </p>
          {instructions.steps && instructions.steps.length > 0 && (
            <ul className="slot-no-feed-steps">
              {instructions.steps.slice(0, 3).map((step, i) => (
                <li key={i} style={{ fontSize: '0.875rem', marginBottom: '0.25rem' }}>
                  {step.description}
                </li>
              ))}
            </ul>
          )}
          <div className="slot-no-feed-disclaimer">
            <small>
              {instructions.disclaimer}
            </small>
          </div>
          {instructions.sourceUrl && (
            <a
              href={instructions.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="slot-no-feed-link"
            >
              Open official portal
            </a>
          )}
        </div>
      </div>
    );
  };

  // Render the heatmap calendar grid
  const renderCalendarGrid = useCallback(() => {
    const officeData = entriesByOffice[officeId];
    if (!officeData || !officeData.entries) return null;

    const grid = officeData.entries;

    return (
      <div
        className="slot-heatmap-calendar"
        aria-label="Monthly appointment slot availability heatmap"
        ref={calendarRef}
        role="grid"
        tabIndex={0}
      >
        <div className="slot-heatmap-header">
          <button
            type="button"
            className="slot-nav-button slot-nav-prev"
            onClick={prevMonth}
            aria-label="Previous month"
          >
            <CalendarX size={18} />
          </button>

          <span
            className="slot-heatmap-month-year"
          >
            {viewDate.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
            })}
          </span>

          <button
            type="button"
            className="slot-nav-button slot-nav-next"
            onClick={nextMonth}
            aria-label="Next month"
          >
            <CalendarDays size={18} />
          </button>
        </div>

        <div className="slot-heatmap-grid">
          {/* Day headers */}
          <div className="slot-heatmap-row">
            {[1, 2, 3, 4, 5, 6, 7].map((day) => (
              <div
                key={day}
                className="slot-heatmap-day-header"
              >
                {day}
              </div>
            ))}
          </div>

          {/* Calendar cells */}
          {grid.map((cell) => (
            <div
              key={cell.formattedDate}
              className={`slot-heatmap-cell ${cell.isSelectable ? 'selectable' : 'unselectable'} ${STATUS_CONFIG[cell.status] ? STATUS_CONFIG[cell.status].bgClass : ''} ${STATUS_CONFIG[cell.status] ? STATUS_CONFIG[cell.status].borderClass : ''}`}
              role="gridcell"
              aria-selected={cell.isSelectable}
              aria-label={cell.ariaLabel}
              tabIndex={cell.isSelectable ? 0 : -1}
              onClick={() => cell.isSelectable && handleDateSelect(cell)}
              onMouseOver={() => {
                if (cell.isSelectable) {
                  // Show tooltip on hover for desktop
                  // Tooltip handled via CSS title attribute or separate component
                }
              }}
            >
              <span className="slot-heatmap-cell-number">{cell.day}</span>

              {cell.slotCount !== null && cell.slotCount > 0 && (
                <span className="slot-heatmap-cell-count">
                  {cell.slotCount}
                </span>
              )}

              {/* Status indicator dot */}
              <span
                className="slot-heatmap-cell-indicator"
                title={cell.tooltip}
              />
            </div>
          ))}

          {/* Empty cells at the end */}
          {(() => {
            const lastCell = grid[grid.length - 1];
            if (!lastCell) return [];

            const lastDay = lastCell.day;
            const lastMonth = lastCell.month;
            const lastYear = lastCell.year;

            // Calculate how many cells are filled
            let filledCount = 0;
            for (let i = 0; i < grid.length; i++) {
              if (grid[i].day === lastDay && grid[i].month === lastMonth) {
                filledCount = i + 1;
                break;
              }
            }

            const emptyCount = 42 - filledCount;
            if (emptyCount <= 0) return [];

            return Array.from({ length: emptyCount }, (_, i) => (
              <div
                key={`empty-${i}`}
                className="slot-heatmap-cell empty-cell"
                role="gridcell"
                aria-hidden="true"
                tabIndex={-1}
              />
            ));
          })()}
        </div>

        {/* Feed freshness summary */}
        {(() => {
          const summaries = Object.values(freshnessSummaries);
          if (summaries.length === 0) return null;

          const hasFresh = summaries.some((s) => s.freshness === SLOT_FRESHNESS.FRESH);
          const hasStale = summaries.some((s) => s.freshness === SLOT_FRESHNESS.STALE);
          const hasVeryStale = summaries.some((s) => s.freshness === SLOT_FRESHNESS.VERY_STALE);
          const hasNoFeed = summaries.some((s) => s.freshness === SLOT_FRESHNESS.NO_FEED);

          if (summaries.length === 1) {
            const s = summaries[0];
            return (
              <div
                key={s.freshness}
                className="slot-heatmap-freshness"
                aria-live="polite"
              >
                <span className="slot-heatmap-freshness-icon">
                  {s.freshness === SLOT_FRESHNESS.FRESH
                    ? <CheckCircle2 size={12} color="var(--accent-main)" />
                    : s.freshness === SLOT_FRESHNESS.STALE
                      ? <AlertTriangle size={12} color="#f59e0b" />
                      : <XCircle size={12} color="var(--text-tertiary)" />
                  }
                </span>
                <span className="slot-heatmap-freshness-text">
                  {s.description}
                </span>
                {s.lastChecked && (
                  <span className="slot-heatmap-freshness-time">
                    Last checked: {new Date(s.lastChecked).toLocaleTimeString()}
                  </span>
                )}
              </div>
            );
          }

          // Multiple summaries - show aggregate
          const freshCount = summaries.filter(
            (s) => s.freshness === SLOT_FRESHNESS.FRESH
          ).length;
          const staleCount = summaries.filter(
            (s) => s.freshness === SLOT_FRESHNESS.STALE
          ).length;
          const veryStaleCount = summaries.filter(
            (s) => s.freshness === SLOT_FRESHNESS.VERY_STALE
          ).length;
          const noFeedCount = summaries.filter(
            (s) => s.freshness === SLOT_FRESHNESS.NO_FEED
          ).length;

          return (
            <div
              key="aggregate-freshness"
              className="slot-heatmap-freshness-aggregate"
              aria-live="polite"
            >
              <span className="slot-heatmap-freshness-count">
                {freshCount} fresh, {staleCount} stale, {veryStaleCount} very stale, {noFeedCount} no feed
              </span>
            </div>
          );
        })()}
      </div>
    );
  }, [entriesByOffice, officeId, freshnessSummaries, handleDateSelect, viewDate, canViewSlotFeed, officeName, serviceId]);

  // Render the component
  return (
    <div className="slot-heatmap-wrapper" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Service selector and office header */}
      {service && office && (
        <div className="slot-heatmap-header-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span
              style={{
                padding: '0.25rem 0.75rem',
                background: 'var(--accent-light)',
                color: 'var(--accent-main)',
                borderRadius: '99px',
                fontSize: '0.8125rem',
                fontWeight: '600',
              }}
            >
              {service.category}
            </span>
            <span style={{ fontWeight: '500', color: 'var(--text-primary)' }}>
              {service.name}
            </span>
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)' }}>
              at {officeName || 'Office'}
            </span>
          </div>
        </div>
      )}

      {/* Heatmap calendar or instructions */}
      <div style={{ flex: 1 }}>
        {error && (
          <div className="slot-error-state" aria-live="polite">
            <AlertTriangle size={24} color="var(--faded-red)" aria-hidden="true" />
            <p>Error loading slot availability: {error}</p>
          </div>
        )}

        {loading && !serviceLoaded && (
          <div className="slot-loading-state">
            <Loader2 size={32} />
            <p>Loading appointment availability...</p>
          </div>
        )}

        {/* Show heatmap when we have data, or instructions when no feed */}
        {serviceLoaded && (
          <>
            {showInstructions && !Object.keys(entriesByOffice[officeId] || {}).length > 0
              ? renderNoFeedInstructions()
              : renderCalendarGrid()}
          </>
        )}

        {/* Show instructions when no live feed but service exists */}
        {!serviceLoaded || (showInstructions && Object.keys(entriesByOffice[officeId] || {}).length > 0) && showInstructionsWhenNoFeed && serviceLoaded ? (
          <div style={{ marginTop: '1rem' }}>
            {renderNoFeedInstructions()}
          </div>
        ) : null}
      </div>

      {/* Date selection panel when a date is selected */}
      {selectedDate && (
        <div className="slot-date-selected-panel">
          <p>
            Selected: {selectedDate}
            {service?.name && ` for ${service.name}`}
            {officeName && ` at ${officeName}`}
          </p>
          <button
            type="button"
            onClick={() => {
              setSelectedDate(null);
              setShowDatePicker(false);
            }}
            style={{
              marginTop: '0.5rem',
              padding: '0.5rem 1rem',
              fontSize: '0.875rem',
            }}
          >
            Another date
          </button>
          <button
            type="button"
            onClick={handleInspectBooking}
            style={{
              marginTop: '0.5rem',
              padding: '0.5rem 1rem',
              fontSize: '0.875rem',
              background: 'var(--accent-main)',
              color: 'var(--bg-main)',
            }}
          >
            Inspect official booking destination
          </button>
        </div>
      )}

      {/* Legend */}
      <div className="slot-heatmap-legend" aria-label="Slot availability legend">
        <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
          {legend.map((item) => (
            <div
              key={item.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                fontSize: '0.75rem',
              }}
            >
              <span
                style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '999px',
                  border: '1px solid var(--border-light)',
                  flexShrink: 0,
                  display: 'inline-block',
                  background: item.key === SLOT_STATUS.AVAILABLE
                    ? 'var(--accent-main)'
                    : item.key === SLOT_STATUS.LIMITED
                      ? 'var(--faded-yellow)'
                      : item.key === SLOT_STATUS.FULL
                        ? 'var(--faded-red)'
                        : 'var(--border-light)',
                }}
              />
              <span>{item.label}</span>
            </div>
          ))}
        </div>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
          Color-independent legend: Available = slots open · Limited = few slots remaining · Full = no slots · Unavailable = service not offered
        </p>
      </div>
    </div>
  );
};

/**
 * Props for OfficeSlotHeatmap.
 */
OfficeSlotHeatmap.propTypes = {
  serviceId: PropTypes.string.isRequired,
  officeId: PropTypes.string.isRequired,
  officeName: PropTypes.string,
  showInstructionsWhenNoFeed: PropTypes.bool,
};

// Default props
OfficeSlotHeatmap.defaultProps = {
  showInstructionsWhenNoFeed: true,
};

// Export with TypeScript-like static types for documentation
OfficeSlotHeatmap.SLOT_STATUS = SLOT_STATUS;
OfficeSlotHeatmap.SLOT_FRESHNESS = SLOT_FRESHNESS;
OfficeSlotHeatmap.STATUS_CONFIG = STATUS_CONFIG;

export default OfficeSlotHeatmap;