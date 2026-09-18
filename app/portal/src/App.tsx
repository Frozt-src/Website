import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { SignedIn, SignedOut, SignIn, UserButton } from '@clerk/clerk-react';
import { useApi } from './auth';
import { ApiError, isPreviewMode, navigate } from './api';
import type { MeResponse } from './api';
import Overview from './screens/Overview';
import Invoices from './screens/Invoices';
import InvoiceDetail from './screens/InvoiceDetail';
import Services from './screens/Services';
import NoAccount from './screens/NoAccount';

type Route =
  | { name: 'overview' }
  | { name: 'invoices' }
  | { name: 'invoice'; id: string }
  | { name: 'services' };

function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'invoices' && parts.length === 2) return { name: 'invoice', id: parts[1] };
  if (parts[0] === 'invoices') return { name: 'invoices' };
  if (parts[0] === 'services') return { name: 'services' };
  return { name: 'overview' };
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

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={event => {
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

function Header() {
  return (
    <header className="portal-header">
      <NavLink href="/">
        <span className="portal-wordmark">MONOLITH</span>
        <span className="portal-tag">Portal</span>
      </NavLink>
      <nav className="portal-nav" aria-label="Portal navigation">
        <NavLink href="/invoices">Invoices</NavLink>
        <NavLink href="/services">Services</NavLink>
      </nav>
      {/* Clerk's UserButton requires a mounted ClerkProvider, which preview mode never has. */}
      {!isPreviewMode() && <UserButton />}
    </header>
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

  if (noAccount) return <NoAccount />;
  if (loadError) {
    return (
      <main className="portal-main portal-notice">
        <p className="portal-error">{loadError}</p>
      </main>
    );
  }
  if (!me) {
    return (
      <main className="portal-main portal-notice">
        <p className="portal-meta">Loading…</p>
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
