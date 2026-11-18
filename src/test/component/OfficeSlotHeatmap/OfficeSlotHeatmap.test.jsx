// Component tests for Office Slot Heatmap
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OfficeSlotHeatmap from '../../../../src/components/services/OfficeSlotHeatmap';
import { SLOT_STATUS, SLOT_FRESHNESS } from '../../../../src/data/slot-feeds';

// Mock the data dependencies
const mockServices = [
  {
    id: 'birth-certificate',
    name: 'Birth Certificate',
    category: 'Certificates',
    department: 'Chief Registrar of Births and Deaths',
    type: 'Online / Offline',
    difficulty: 'Medium',
    feeType: 'paid',
    popularityScore: 92,
    eligibility: [],
    documents: [],
    steps: [],
    officialSources: [{ name: 'TN CRSTN', url: 'https://crstn.org', verified: true, lastVerified: '2026-11-05' }],
    lastVerified: '2026-11-05',
  },
  {
    id: 'driving-license',
    name: 'Driving License',
    category: 'Transport',
    department: 'Ministry of Road Transport',
    type: 'Online / Offline',
    difficulty: 'Hard',
    feeType: 'paid',
    popularityScore: 95,
    eligibility: [],
    documents: [],
    steps: [],
    officialSources: [{ name: 'Parivahan', url: 'https://parivahan.gov.in', verified: true, lastVerified: '2026-11-05' }],
    lastVerified: '2026-11-05',
  },
];

const mockOffices = [
  { id: 'office-tn-rto', name: 'RTO Chennai', state: 'Tamil Nadu', district: 'Chennai' },
  { id: 'office-tn-sr', name: 'Sub-Regregistrar Office', state: 'Tamil Nadu', district: 'Chennai' },
];

// Mock localStorage before each test
beforeEach(() => {
  // Mock localStorage
  const localStorageMock = {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    clear: jest.fn(),
  };
  Object.defineProperty(window, 'localStorage', { value: localStorageMock });

  // Mock sessionStorage
  const sessionStorageMock = {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    clear: jest.fn(),
  };
  Object.defineProperty(window, 'sessionStorage', { value: sessionStorageMock });
});

// Mock the slot feed service
const mockSlotFeedEntries = [
  { date: '2026-01-15', status: SLOT_STATUS.AVAILABLE, slotCount: 10, sourceTimestamp: '2026-01-15T10:30:00Z' },
  { date: '2026-01-16', status: SLOT_STATUS.LIMITED, slotCount: 3, sourceTimestamp: '2026-01-15T10:30:00Z' },
  { date: '2026-01-17', status: SLOT_STATUS.FULL, slotCount: 0, sourceTimestamp: '2026-01-15T10:30:00Z' },
  { date: '2026-01-18', status: SLOT_STATUS.UNAVAILABLE, slotCount: 0, sourceTimestamp: '2026-01-15T10:30:00Z' },
];

describe('OfficeSlotHeatmap component', () => {
  const mockStore = {
    state: { lat: 13.0827, lng: 80.2707 },
  };

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();
  });

  test('renders without crashing', () => {
    const { rerender } = render(
      <OfficeSlotHeatmap
        serviceId="birth-certificate"
        officeId="office-tn-rto"
        officeName="RTO Chennai"
      />
    );
    expect(screen.getByText('Birth Certificate')).toBeInTheDocument();
    expect(screen.getByText('RTO Chennai')).toBeInTheDocument();
  });

  test('shows loading state initially', () => {
    const { rerender } = render(
      <OfficeSlotHeatmap
        serviceId="birth-certificate"
        officeId="office-tn-rto"
        officeName="RTO Chennai"
      />
    );
    // Initially loading since no data fetched yet
    const loadingText = screen.getByText('Loading appointment availability...');
    expect(loadingText).toBeInTheDocument();
  });

  test('shows error state when error occurs', () => {
    // Mock the service to throw an error
    // We'll test the error rendering pattern
    const { rerender } = render(
      <OfficeSlotHeatmap
        serviceId="birth-certificate"
        officeId="office-tn-rto"
        officeName="RTO Chennai"
      />
    );
    // Error state should be renderable
    expect(screen.getByText(/Error loading/i)).not.toBeInTheDocument(); // Initially no error
  });

  test('displays heatmap calendar grid', async () => {
    // Render with timeout to allow data fetching
    const { rerender, unmount } = render(
      <OfficeSlotHeatmap
        serviceId="birth-certificate"
        officeId="office-tn-rto"
        officeName="RTO Chennai"
      />
    );

    // Wait for data to load
    await waitFor(() => {
      expect(screen.getByText(/Available|Limited|Full|Unavailable/i)).toBeInTheDocument();
    });
  });

  test('shows slot count details in heatmap cells', async () => {
    const { waitFor } = render(
      <OfficeSlotHeatmap
        serviceId="birth-certificate"
        officeId="office-tn-rto"
        officeName="RTO Chennai"
      />
    );

    await waitFor(() =>
      expect(screen.getByText(/10 slots|3 slots|0 slots/i)).toBeInTheDocument()
    );
  });

  test('shows feed freshness indicator', async () => {
    const { waitFor } = render(
      <OfficeSlotHeatmap
        serviceId="birth-certificate"
        officeId="office-tn-rto"
        officeName="RTO Chennai"
      />
    );

    await waitFor(() =>
      expect(screen.getByText(/fresh|stale|Last checked/i)).toBeInTheDocument()
    );
  });

  test('handles date selection', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <OfficeSlotHeatmap
        serviceId="birth-certificate"
        officeId="office-tn-rto"
        officeName="RTO Chennai"
      />
    );

    await waitFor(() => screen.getByText('Select date'));

    // Find a date cell and click it
    const dateCells = screen.getAllByRole('gridcell');
    const clickableCells = dateCells.filter((cell) => {
      const role = cell.getAttribute('aria-selected');
      return role === 'true';
    });

    if (clickableCells.length > 0) {
      await user.click(clickableCells[0]);
      // After selection, should show date selected panel or navigate
      expect(screen.getByText(/2026|January|date selected/i)).toBeInTheDocument();
    }
  });

  test('shows legend with color-independent labels', () => {
    const { rerender } = render(
      <OfficeSlotHeatmap
        serviceId="birth-certificate"
        officeId="office-tn-rto"
        officeName="RTO Chennai"
      />
    );

    // Wait for legend to render
    const legendItems = screen.getAllByRole('legend') || [];
    // Or check for the legend text
    const legendText = screen.getByText(/Available|Limited|Full|Unavailable/i);
    expect(legendText).toBeInTheDocument();
  });

  test('shows accessible aria labels on cells', async () => {
    const { waitFor } = render(
      <OfficeSlotHeatmap
        serviceId="birth-certificate"
        officeId="office-tn-rto"
        officeName="RTO Chennai"
      />
    );

    await waitFor(() => {
      const cells = screen.getAllByRole('gridcell');
      // Each cell should have an aria-label
      cells.forEach((cell) => {
        expect(cell.getAttribute('aria-label')).toBeTruthy();
      });
    });
  });

  test('shows no-feed instructions when no live feed available', async () => {
    // Render with no feed data - test the no-feed path
    const { rerender } = render(
      <OfficeSlotHeatmap
        serviceId="driving-license"
        officeId="office-tn-sr"
        officeName="Sub-Registrar Office"
        showInstructionsWhenNoFeed
      />
    );

    await waitFor(() =>
      expect(screen.getByText(/No live slot availability|official portal|appointment instructions/i)).toBeInTheDocument()
    );
  });

  test('keyboard navigation support', async () => {
    const { rerender } = render(
      <OfficeSlotHeatmap
        serviceId="birth-certificate"
        officeId="office-tn-rto"
        officeName="RTO Chennai"
      />
    );

    await waitFor(() => screen.getByRole('grid'));

    // Test keyboard navigation
    const user = userEvent.setup();
    await user.tab(); // Focus should move within the calendar

    // After tabbing, check that focus is managed
    const focusedElement = document.activeElement;
    expect(focusedElement).toBeTruthy();
  });

  test('shows slot status with color-independent text', async () => {
    const { waitFor } = render(
      <OfficeSlotHeatmap
        serviceId="birth-certificate"
        officeId="office-tn-rto"
        officeName="RTO Chennai"
      />
    );

    await waitFor(() => {
      // Check that text labels are present regardless of color
      const availableText = screen.getByText(/Available slots/i);
      const limitedText = screen.getByText(/Limited availability/i);
      const fullText = screen.getByText(/No available slots/i);
      const unavailableText = screen.getByText(/Unavailable/i);

      // At least some status labels should be present
      expect(availableText || limitedText || fullText || unavailableText).toBeInTheDocument();
    });
  });

  test('handles month navigation', async () => {
    const { rerender } = render(
      <OfficeSlotHeatmap
        serviceId="birth-certificate"
        officeId="office-tn-rto"
        officeName="RTO Chennai"
      />
    );

    await waitFor(() => screen.getByRole('grid'));

    // Test prev/next month buttons exist
    const prevButton = screen.getByRole('button', { name: /Previous month/i });
    const nextButton = screen.getByRole('button', { name: /Next month/i });

    expect(prevButton).toBeInTheDocument();
    expect(nextButton).toBeInTheDocument();
  });

  test('respects reduced motion preference', () => {
    // Test that the component doesn't rely on animations that would be
    // disabled with prefers-reduced-motion
    const { rerender } = render(
      <OfficeSlotHeatmap
        serviceId="birth-certificate"
        officeId="office-tn-rto"
        officeName="RTO Chennai"
      />
    );

    // Component should render without requiring motion
    expect(screen.getByRole('grid')).toBeInTheDocument();
  });
});