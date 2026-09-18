# Moving mnlith.dev from GitHub Pages to Cloudflare

One-time runbook. Dashboard steps need the Cloudflare account owner because Wrangler's login can't edit DNS, zone settings or rules. Work in order and don't skip verification.

Never touch these DNS records: MX (iCloud), TXT `v=spf1 include:icloud.com ~all`, TXT `apple-domain=…`, CNAME `sig1._domainkey`, TXT `_dmarc`, and the `api` Worker record.

## 0. Before you start

- [ ] Two-factor authentication is on for Cloudflare, GitHub and the Apple ID. None of those accounts uses an `@mnlith.dev` address as its only login or recovery email.
- [ ] Cloudflare → Domain Registration: auto-renew is on for mnlith.dev with a valid payment method.
- [ ] Export the zone: Cloudflare → mnlith.dev → DNS → Records → Import and Export → Export (keep the file for rollback).
- [ ] `npm ci && npm run deploy:check` succeeds on the release commit.

## 1. Zone settings (no visible effect yet)

- [ ] SSL/TLS → Edge Certificates: **Always Use HTTPS** on; **Minimum TLS Version** 1.2.
- [ ] Rules → Redirect Rules → Create: *If* wildcard pattern, Request URL `https://www.mnlith.dev/*`. *Then* target URL `https://mnlith.dev/${1}`, status 301, preserve query string on.
- [ ] Confirm these are off for mnlith.dev because they inject scripts or cookies: Scrape Shield → Email Address Obfuscation; Speed → Rocket Loader; Zaraz; Web Analytics automatic setup; Security → Bot Fight Mode / JavaScript Detections.
- [ ] Network → **Pseudo IPv4** is **Off** (or "Add header"), never "Overwrite headers" — the inquiry API rate-limits IPv6 visitors per /64 and needs their real address.

## 2. Apex cutover (seconds of downtime)

- [ ] DNS → Records: delete the four `A mnlith.dev` records `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.
- [ ] Immediately run `npm run deploy`. Wrangler attaches the Custom Domain and creates its DNS record and certificate.
- [ ] `npm run verify:site` shows every check PASS. `curl -sI http://mnlith.dev/` returns 301 to `https://mnlith.dev/`.

If the deploy fails, re-create the four A records from the export to restore GitHub Pages, fix the problem, and retry.

## 3. www

- [ ] DNS → Records: edit `www` from `CNAME frozt-src.github.io` to `AAAA 100::`, **Proxied**.
- [ ] `curl -sI "https://www.mnlith.dev/privacy?x=1"` returns 301 to `https://mnlith.dev/privacy?x=1`.

## 4. Production checks

- [ ] In a browser, https://mnlith.dev loads with no console errors. The menu, capability accordion and privacy link work at phone and desktop widths.
- [ ] Submit one inquiry labelled "Cutover test" and confirm the success message. In D1 → monolith-inquiries → Console, delete that row and the two synthetic launch rows from 2026-09-17: `SELECT id, datetime(created_at,'unixepoch'), name FROM inquiries;` then `DELETE FROM inquiries WHERE id IN ('…');`.
- [ ] The page source contains no `/cdn-cgi/` scripts (`curl -s https://mnlith.dev/ | grep cdn-cgi` prints nothing).
- [ ] Optional: SSL Labs and Mozilla Observatory against https://mnlith.dev; Facebook Sharing Debugger / LinkedIn Post Inspector for the share image.
- [ ] After the first inquiry, open Cloudflare → Workers → monolith-api → Logs and confirm entries show only the Worker's structured event lines (no request bodies, names, emails or IP addresses).

## 5. After at least 24 hours: take the site off GitHub

- [ ] `gh api -X DELETE repos/Frozt-src/Website/pages` (removes GitHub Pages).
- [ ] Review third-party GitHub App access (GitHub → Settings → Applications) such as Qodo and the ChatGPT Codex connector, and remove any you don't want reading a private repository.
- [ ] Turn on Dependabot alerts and security updates for the repository.
- [ ] `gh repo edit Frozt-src/Website --visibility private --accept-visibility-change-consequences`. On GitHub Free this switches off secret scanning and push protection. Keep secrets only in Worker secrets and `.dev.vars` (git-ignored).
- [ ] Delete the `gh-pages` branch (`git push origin --delete gh-pages`), the `github-pages` environment and the `VITE_API_URL` Actions variable. Disable the unused wiki.
- [ ] GitHub → Settings → Emails: turn on "Keep my email addresses private" and "Block command line pushes that expose my email".

## 6. Optional

- Verify mnlith.dev in Google Search Console and Bing Webmaster Tools and submit `https://mnlith.dev/sitemap.xml`.
- Activate inquiry email notifications (`api/README.md`).
- Add an external uptime monitor for `https://mnlith.dev/` and `https://api.mnlith.dev/health`.
