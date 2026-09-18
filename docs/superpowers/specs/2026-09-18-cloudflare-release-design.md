# Monolith on Cloudflare: release design

Date: 18 September 2026. Supersedes the GitHub Pages hosting in `2026-09-17-monolith-design.md`; everything else in that spec stands.

## Goal

Serve https://mnlith.dev from Cloudflare, take the site off GitHub (Pages removed, repository private), and close the gaps found in the 18 September release audit so the site is ready for customers.

## Decisions (owner-directed or ruled by the implementer; the owner may overturn rulings)

1. **Hosting:** an assets-only Worker named `monolith-site` using Workers Static Assets (`dist/`), attached to `mnlith.dev` as a Custom Domain. No Worker script, so asset requests are free and don't count toward Worker request limits. Cloudflare Pages isn't used (Cloudflare recommends Workers for new projects).
2. **www:** `www.mnlith.dev` gets a 301 to `https://mnlith.dev/<path>?<query>` from a zone Single Redirect Rule, backed by a proxied `AAAA www 100::` record. `_redirects` can't redirect by host, and `run_worker_first` would bill every request.
3. **Security headers:** a single source. The Vite build emits `dist/_headers`, and the `<meta>` CSP is removed. The policy is exactly:
   `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src <API origin>; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests`
   where `<API origin>` is the origin of `VITE_API_URL`, defaulting to `https://api.mnlith.dev`. Also on every path:
   - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
   - `X-Content-Type-Options: nosniff`
   - `X-Frame-Options: DENY`
   - `Referrer-Policy: strict-origin-when-cross-origin`
   - `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
   - `Cross-Origin-Opener-Policy: same-origin`

   `/assets/*` gets `Cache-Control: public, max-age=31536000, immutable`.
4. **Not-found:** `not_found_handling: "404-page"` with a real `404.html`, so unknown paths return status 404 rather than a 200 page.
5. **Deploys:** from this machine with `npm run deploy` (tests, build, `wrangler deploy`). GitHub Actions is billing-locked and is removed. Cloudflare Workers Builds is documented as an optional later step.
6. **GitHub artifacts removed:** `CNAME`, `public/CNAME`, `scripts/publish-pages.mjs`, `.github/workflows/pages.yml`, the `publish:pages` script, the `.deploy/` ignore line, and the Dependabot `github-actions` block (no workflows remain).
7. **Privacy:** a standalone `/privacy` page replaces the footer `<details>`. It names "Monolith" and eldritch@mnlith.dev as the contact, with no invented legal name or address. It covers the data collected, its purpose, recipients (Cloudflare; Apple iCloud Mail for email), retention (90-day database purge, backups up to 30 days after deletion, rate-limit hashes about 2 days), no cookies or analytics or tracking, rights requests, and effective date 18 September 2026. The consent link opens it in a new tab so a half-written inquiry isn't lost.
8. **Release additions:**
   - `/.well-known/security.txt` (RFC 9116, Contact eldritch@mnlith.dev, Expires 2027-09-17T00:00:00.000Z)
   - sitemap with `/privacy` and `lastmod`
   - a 1200×630 JPEG share image with og width, height and type tags
   - `apple-touch-icon.png` (180×180) and `favicon.ico` (32×32)
   - a preload for the hero image
   - an Organization JSON-LD data block
9. **Accessibility and readability** (WCAG 2.2 AA):
   - focus stays visible on invalid fields
   - accessible names contain the visible text (menu button, scroll link)
   - form field borders at least 3:1
   - placeholder at least 4.5:1
   - the desktop "Let's talk" link gets a dark backing for at least 4.5:1
   - functional mobile text at least 12px and decorative microcopy at least 10px
   - mobile selects at 16px (no iOS zoom)
   - error text is not part of the field's accessible name
10. **API hardening** (`api.mnlith.dev` itself is unchanged):
    - IPv6 clients are rate-limited per /64
    - single-line fields reject line breaks, tabs, C1 controls and bidi overrides; all fields reject bidi overrides
    - `teamSize` must be one of `''`, `1-10`, `11-50`, `51-200`, `201+`
    - `HEAD /health` returns 200
    - failures are logged as one structured line with no personal data
    - Workers Logs is on with invocation logs off
    - the retention cron runs both purges even if one fails, then reports failure
11. **Inquiry notification (built but switched off):** when an optional `send_email` binding `NOTIFY` is present, each stored inquiry is emailed through `ctx.waitUntil`:
    - from `inquiries@notify.mnlith.dev` to `eldritch@mnlith.dev`, with Reply-To set to the customer
    - plain text only, subject "New website inquiry: <service label>"
    - a failed send is logged and never changes the 201 or the stored row

    Turning it on requires the owner to upgrade to Workers Paid and onboard `notify.mnlith.dev` in Cloudflare Email Sending. That is documented, and the binding isn't configured until then.

## Out of scope

- A legal entity name or address (the owner supplies these).
- Analytics.
- Turnstile (added only if abuse is observed).
- Moving the API same-origin.
- Frontend unit tests (there's no frontend test harness; verification is by build output, `wrangler dev` and a browser).

## Cutover (owner-gated; not code)

1. Deploy check passes.
2. The owner sets Always Use HTTPS, Minimum TLS 1.2, the www redirect rule, and checks that no zone feature injects scripts.
3. The owner deletes the apex GitHub A records, and `npm run deploy` runs immediately.
4. Verify.
5. Replace the www CNAME with a proxied `AAAA 100::` and verify.
6. Soak for at least 24 hours.
7. Remove GitHub Pages; make the repository private; delete the `gh-pages` branch and the `github-pages` environment.

Leave MX, SPF, `apple-domain` TXT, `sig1._domainkey`, `_dmarc` and `api` untouched throughout.

## Acceptance

- `npm test` and `npm run typecheck` pass.
- `npm run deploy:check` succeeds.
- `dist/` contains `_headers`, `404.html`, `privacy.html` and `.well-known/security.txt`, and no `CNAME` or `http-equiv` CSP.
- Under `wrangler dev`, `/` shows all the headers, `/assets/*` is immutable, an unknown path returns 404 with the 404 page, `/privacy` returns 200, and `/.well-known/security.txt` returns 200.
- In a browser there are no CSP violations; forms, menu and motion work at 1440px and 375px.
- After cutover, the same checks pass against https://mnlith.dev, and www and http redirect to `https://mnlith.dev`.
