import { useCallback, useEffect, useState } from 'react';
import { SignedIn, SignedOut, SignIn, UserButton } from '@clerk/clerk-react';
import { useApi } from './auth';
import { ApiError, isPreviewMode } from './api';
import type { MeResponse } from './api';
import Link from './Link';
import Overview from './screens/Overview';
import Invoices from './screens/Invoices';
import InvoiceDetail from './screens/InvoiceDetail';
import Services from './screens/Services';
import NoAccount from './screens/NoAccount';

type Route =
  | { name: 'overview' }
  | { name: 'invoices' }
  | { name: 'invoice'; id: string }
  | { name: 'services' }
  | { name: 'not-found' };

const routeTitle: Record<Route['name'], string> = {
  overview: 'Overview',
  invoices: 'Invoices',
  invoice: 'Invoice',
  services: 'Services',
  'not-found': 'Page not found',
};

function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'overview' };
  if (parts[0] === 'invoices' && parts.length === 1) return { name: 'invoices' };
  if (parts[0] === 'invoices' && parts.length === 2) return { name: 'invoice', id: parts[1] };
  if (parts[0] === 'services' && parts.length === 1) return { name: 'services' };
  return { name: 'not-found' };
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  return route;
}

function Header() {
  return (
    <header className="portal-header">
      <Link href="/" className="portal-header-brand">
        <span className="portal-wordmark">MONOLITH</span>
        <span className="portal-tag">Portal</span>
      </Link>
      <nav className="portal-nav" aria-label="Portal navigation">
        <Link href="/invoices">Invoices</Link>
        <Link href="/services">Services</Link>
      </nav>
      {/* Clerk's UserButton requires a mounted ClerkProvider, which preview mode never has. */}
      {!isPreviewMode() && <UserButton />}
    </header>
  );
}

function NotFound() {
  return (
    <section className="portal-section" aria-labelledby="not-found-title">
      <h1 id="not-found-title">Page not found</h1>
      <p className="portal-meta">We couldn’t find that page.</p>
      <Link href="/" className="portal-button">
        Go home
      </Link>
    </section>
  );
}

function AuthenticatedApp() {
  const api = useApi();
  const route = useRoute();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadMe = useCallback(() => {
    let cancelled = false;
    setLoadError(null);
    api
      .me()
      .then(response => {
        if (!cancelled) setMe(response);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 403 && error.code === 'no_account') {
          setNoAccount(true);
          return;
        }
        setLoadError('We could not load your account. Please try again.');
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => loadMe(), [loadMe]);

  // Announce each route change to assistive tech and keyboard users, the way a full page
  // navigation would: update the tab title, move focus to the new screen's heading, reset scroll.
  // Keyed on `me` too so this also fires once the very first screen finishes loading, not just on
  // later route changes.
  useEffect(() => {
    if (!me) return;
    document.title = `${routeTitle[route.name]} — Monolith Portal`;
    window.scrollTo(0, 0);
    const heading = document.querySelector<HTMLElement>('main h1');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus();
    }
  }, [route, me]);

  if (noAccount) {
    return (
      <>
        <Header />
        <NoAccount />
      </>
    );
  }
  if (loadError) {
    return (
      <>
        <Header />
        <main className="portal-main portal-notice">
          <h1>Something went wrong</h1>
          <p className="portal-error" role="alert">
            {loadError}
          </p>
          <button type="button" className="portal-button" onClick={() => loadMe()}>
            Try again
          </button>
        </main>
      </>
    );
  }
  if (!me) {
    return (
      <main className="portal-main portal-notice">
        <p className="portal-meta" role="status">
          Loading…
        </p>
      </main>
    );
  }

  return (
    <>
      <Header />
      <main className="portal-main">
        {route.name === 'overview' && <Overview me={me} />}
        {route.name === 'invoices' && <Invoices />}
        {route.name === 'invoice' && <InvoiceDetail id={route.id} />}
        {route.name === 'services' && <Services />}
        {route.name === 'not-found' && <NotFound />}
      </main>
    </>
  );
}

export default function App() {
  // Preview mode has no ClerkProvider ancestor, so it never renders SignedIn/SignedOut/SignIn —
  // those assert they are wrapped by one and would throw.
  if (isPreviewMode()) return <AuthenticatedApp />;

  return (
    <>
      <SignedOut>
        <main className="portal-main portal-signin">
          <SignIn routing="hash" />
        </main>
      </SignedOut>
      <SignedIn>
        <AuthenticatedApp />
      </SignedIn>
    </>
  );
}
