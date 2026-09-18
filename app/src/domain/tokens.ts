// Payment-link tokens: 32 random bytes, base64url, no padding (43 characters).
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function generateToken(randomBytes: (length: number) => Uint8Array): string {
  const bytes = randomBytes(32);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isWellFormedToken(value: string): boolean {
  return tokenPattern.test(value);
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
