import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App';
import { ApiContext, AuthApiProvider } from './auth';
import './portal.css';

function NotConfigured() {
  return (
    <main className="portal-main portal-notice">
      <h1>Portal is not configured</h1>
      <p>Sign-in is not available yet. Please check back later.</p>
    </main>
  );
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

  let clerkPublishableKey = '';
  try {
    const response = await fetch('/api/public-config');
    if (response.ok) {
      const config = (await response.json()) as { clerkPublishableKey?: string };
      clerkPublishableKey = config.clerkPublishableKey ?? '';
    }
  } catch {
    clerkPublishableKey = '';
  }

  if (!clerkPublishableKey) {
    root.render(
      <StrictMode>
        <NotConfigured />
      </StrictMode>,
    );
    return;
  }

  root.render(
    <StrictMode>
      <ClerkProvider publishableKey={clerkPublishableKey} afterSignOutUrl="/">
        <AuthApiProvider>
          <App />
        </AuthApiProvider>
      </ClerkProvider>
    </StrictMode>,
  );
}

void bootstrap();
