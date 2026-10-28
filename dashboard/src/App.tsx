import { useEffect, useRef } from 'react';
import { createBrowserRouter, createRoutesFromElements, Navigate, Outlet, Route, RouterProvider, useLocation, useRouteError, useSearchParams } from 'react-router';
import { capturePageView, captureDashboardLoaded } from '@/lib/telemetry';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Layout } from '@/components/layout/Layout';
import DashboardPage from '@/pages/DashboardPage';
import SessionsPage from '@/pages/SessionsPage';
import SessionDetailPage from '@/pages/SessionDetailPage';
import InsightsPage from '@/pages/InsightsPage';
import AnalyticsPage from '@/pages/AnalyticsPage';
import SettingsPage from '@/pages/SettingsPage';
import ExportPage from '@/pages/ExportPage';
import JournalPage from '@/pages/JournalPage';
import PatternsPage from '@/pages/PatternsPage';
import RagChatPage from '@/pages/RagChatPage';
import LabelPage from '@/pages/LabelPage';

const ROUTE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/chat': 'Agent Chat',
  '/sessions': 'Sessions',
  '/insights': 'Insights',
  '/analytics': 'Analytics',
  '/patterns': 'Patterns',
  '/label': 'Labeling',
  '/export': 'Export',
  '/journal': 'Journal',
  '/settings': 'Settings',
};

function RouteEffects() {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const insightParam = searchParams.get('insight');
  const navStartRef = useRef<number>(Date.now());

  // Scroll to top on route change, unless deep-linking to a specific insight
  useEffect(() => {
    const isInsightDeepLink = pathname === '/insights' && insightParam;
    if (!isInsightDeepLink) {
      window.scrollTo(0, 0);
    }
  }, [pathname, insightParam]);

  // Update document.title per route, track page views, and capture dashboard_loaded
  useEffect(() => {
    const segment = '/' + pathname.split('/')[1];
    const page = ROUTE_TITLES[segment];
    document.title = page ? `${page} — Code Insights` : 'Code Insights';

    // Track page view on every route change
    capturePageView(pathname);

    // Capture dashboard_loaded with time since navigation started
    if (page) {
      const loadTimeMs = Date.now() - navStartRef.current;
      captureDashboardLoaded(page.toLowerCase(), loadTimeMs);
    }
    // Reset nav start for next navigation
    navStartRef.current = Date.now();
  }, [pathname]);

  return null;
}

// Route errors bubble to the app-level ErrorBoundary, as with the previous <BrowserRouter> setup,
// instead of the data router's built-in error screen.
function RethrowRouteError(): never {
  throw useRouteError();
}

function RootRoute() {
  return (
    <>
      <RouteEffects />
      <Outlet />
    </>
  );
}

// Data router (not <BrowserRouter>) so pages can use useBlocker for unsaved-changes prompts.
const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<RootRoute />} errorElement={<RethrowRouteError />}>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/chat" element={<RagChatPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route path="/insights" element={<InsightsPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/patterns" element={<PatternsPage />} />
        <Route path="/label" element={<LabelPage />} />
        <Route path="/label/:sessionId" element={<LabelPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/export" element={<ExportPage />} />
        <Route path="/journal" element={<JournalPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Route>,
  ),
);

export default function App() {
  return (
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  );
}
