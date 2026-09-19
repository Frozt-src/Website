// Production Clerk adapters. Only index.ts wires these; tests inject fakes through AppDeps.
import { createClerkClient, verifyToken } from '@clerk/backend';
import type { ClerkUsers, SessionVerifier } from '../deps.ts';

export interface ClerkSessionConfig {
  secretKey: string;
  jwtKey: string;
  authorizedParties: string[];
  logError(event: string, error: unknown): void;
}

export function clerkSessionVerifier(config: ClerkSessionConfig): SessionVerifier {
  // With a jwtKey the check is networkless; otherwise the JWKS is fetched with the secret key.
  const keyOptions = config.jwtKey ? { jwtKey: config.jwtKey } : { secretKey: config.secretKey };
  return {
    async verify(token: string) {
      try {
        const payload = await verifyToken(token, { ...keyOptions, authorizedParties: config.authorizedParties });
        return payload.sub ? { userId: payload.sub } : null;
      } catch (error) {
        // The failing token is never part of the log line.
        config.logError('session_verify_failed', error);
        return null;
      }
    },
  };
}

export function clerkUsersClient(config: { secretKey: string }): ClerkUsers {
  return {
    async primaryVerifiedEmail(userId: string) {
      // Only reached on a first login, so the client is built on demand rather than per request.
      const user = await createClerkClient({ secretKey: config.secretKey }).users.getUser(userId);
      const primary = user.emailAddresses.find(address => address.id === user.primaryEmailAddressId);
      return primary && primary.verification?.status === 'verified' ? primary.emailAddress : null;
    },
  };
}
