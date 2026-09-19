import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App';
import { ApiContext, AuthApiProvider } from './auth';
import './portal.css';

// A minimal header for the two screens that can render before Clerk is ever configured — no nav,
// no UserButton, since there is no session and no ClerkProvider ancestor to support either.
function BootstrapHeader() {
  return (
    <header className="portal-header">
      <span className="portal-header-brand">
        <span className="portal-wordmark">MONOLITH</span>
        <span className="portal-tag">Portal</span>
      </span>
    </header>
  );
}

function NotConfigured() {
  return (
    <>
      <BootstrapHeader />
      <main className="portal-main portal-notice">
        <h1>Portal is not configured</h1>
        <p role="status">Sign-in is not available yet. Please check back later.</p>
      </main>
    </>
  );
}

function CouldNotReach({ onRetry }: { onRetry: () => void }) {
  return (
    <>
      <BootstrapHeader />
      <main className="portal-main portal-notice">
        <h1>Couldn’t reach the portal</h1>
        <p role="alert">Check your connection and try again.</p>
        <button type="button" className="portal-button" onClick={onRetry}>
          Retry
        </button>
      </main>
    </>
  );
}

// Distinguishes a genuinely empty publishable key (portal not configured) from a fetch that never
// got an answer (offline, DNS failure, a 5xx) — the two need different screens and only the latter
// gets a retry.
async function loadClerkKey(): Promise<{ ok: true; key: string } | { ok: false }> {
  try {
    const response = await fetch('/api/public-config');
    if (!response.ok) return { ok: false };
    const config = (await response.json()) as { clerkPublishableKey?: string };
    return { ok: true, key: config.clerkPublishableKey ?? '' };
  } catch {
    return { ok: false };
  }
}

async function bootstrap(): Promise<void> {
  const mount = document.getElementById('root');
  if (!mount) return;
  const root = createRoot(mount);

  // Preview mode never talks to the API or to Clerk: it renders App with fixture data so the
  // screens can be reviewed without any backend or Clerk credentials. The condition is written
  // inline (not via a helper) so `vite build` can fold it to a literal `false` and tree-shake the
  // dynamic import — and the whole ./preview chunk — out of the production bundle entirely.
  if (import.meta.env.DEV && import.meta.env.MODE === 'preview') {
    const { createPreviewApiClient } = await import('./preview');
    root.render(
      <StrictMode>
        <ApiContext.Provider value={createPreviewApiClient()}>
          <App />
        </ApiContext.Provider>
      </StrictMode>,
    );
    return;
  }

  // Re-run on Retry: renders into the same root, so a Retry click never re-creates it.
  const attempt = async (): Promise<void> => {
    const result = await loadClerkKey();
    if (!result.ok) {
      root.render(
        <StrictMode>
          <CouldNotReach onRetry={() => void attempt()} />
        </StrictMode>,
      );
      return;
    }
    if (!result.key) {
      root.render(
        <StrictMode>
          <NotConfigured />
        </StrictMode>,
      );
      return;
    }
    root.render(
      <StrictMode>
        <ClerkProvider publishableKey={result.key} afterSignOutUrl="/">
          <AuthApiProvider>
            <App />
          </AuthApiProvider>
        </ClerkProvider>
      </StrictMode>,
    );
  };

  await attempt();
}

void bootstrap();
