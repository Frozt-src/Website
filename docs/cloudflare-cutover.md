# Moving mnlith.dev from GitHub Pages to Cloudflare

One-time runbook. Dashboard steps need the Cloudflare account owner because Wrangler's login can't edit DNS, zone settings or rules. Work in order and don't skip verification.

Never touch these DNS records: MX (iCloud), TXT `v=spf1 include:icloud.com ~all`, TXT `apple-domain=…`, CNAME `sig1._domainkey`, TXT `_dmarc`, and the `api` Worker record.

## 0. Before you start

- [ ] Two-factor authentication is on for Cloudflare, GitHub and the Apple ID. None of those accounts uses an `@mnlith.dev` address as its only login or recovery email.
- [ ] Cloudflare → Domain Registration: auto-renew is on for mnlith.dev with a valid payment method.
- [ ] Export the zone: Cloudflare → mnlith.dev → DNS → Records → Import and Export → Export (keep the file for rollback).
- [ ] `npm ci && npm run deploy:check` succeeds on the release commit.
- [ ] `npx wrangler whoami` shows the account that owns mnlith.dev (the Worker deploy must not stop at a login prompt mid-cutover).

## 1. Zone settings (no visible effect yet)

- [ ] SSL/TLS → Edge Certificates: **Always Use HTTPS** on; **Minimum TLS Version** 1.2.
- [ ] Rules → Redirect Rules → Create: *If* wildcard pattern, Request URL `https://www.mnlith.dev/*`. *Then* target URL `https://mnlith.dev/${1}`, status 301, preserve query string on.
- [ ] Confirm these are off for mnlith.dev because they inject scripts or cookies: Scrape Shield → Email Address Obfuscation; Speed → Rocket Loader; Zaraz; Web Analytics automatic setup; Security → Bot Fight Mode / JavaScript Detections.
- [ ] Network → **Pseudo IPv4** is **Off** (or "Add header"), never "Overwrite headers" — the inquiry API rate-limits IPv6 visitors per /64 and needs their real address.

## 1a. Release the hardened inquiry API (independent of DNS)

- [ ] `npm run api:check && npm run api:deploy` (tests run first).
- [ ] `curl -sI https://api.mnlith.dev/health` returns `200` (the previous API version answered HEAD with 404).

## 2. Apex cutover (brief downtime)

Resolvers that look up mnlith.dev during the gap may cache the empty answer for up to 30 minutes, so do this at a quiet time and keep the gap short.

- [ ] `npm test && npm run build` (so the deploy itself only uploads).
- [ ] DNS → Records: delete every apex record that points at GitHub: the four `A mnlith.dev` records `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`, and any `AAAA mnlith.dev` records `2606:50c0:8000::153`–`2606:50c0:8003::153`.
- [ ] Immediately run `npx wrangler deploy`. Wrangler attaches the Custom Domain and creates its DNS record and certificate.
- [ ] Wait until `nslookup mnlith.dev 1.1.1.1` no longer returns `185.199.*` addresses (usually within 5 minutes; run `ipconfig /flushdns` first).
- [ ] `npm run verify:site` shows every check PASS. `curl -sI http://mnlith.dev/` returns 301 to `https://mnlith.dev/`.

**Rollback (valid until step 5):** if the deploy fails, or any check in steps 2–4 fails, remove the Custom Domain (Workers & Pages → monolith-site → Settings → Domains & Routes → remove `mnlith.dev`), re-create the GitHub A/AAAA records from the export, and restore `www` to `CNAME frozt-src.github.io` (DNS only). GitHub Pages is still published, so the old site returns.

## 3. www

- [ ] DNS → Records: edit `www` from `CNAME frozt-src.github.io` to `AAAA 100::`, **Proxied**.
- [ ] `curl -sI "https://www.mnlith.dev/privacy?x=1"` returns 301 to `https://mnlith.dev/privacy?x=1`.
- [ ] `curl -sI http://www.mnlith.dev/` returns a 301 (to https), and following redirects ends at `https://mnlith.dev/` (`curl -sIL http://www.mnlith.dev/ | grep -i ^location`).

## 4. Production checks

- [ ] In a browser, https://mnlith.dev loads with no console errors. The menu, capability accordion and privacy link work at phone and desktop widths.
- [ ] Submit one inquiry labelled "Cutover test" and confirm the success message. In D1 → monolith-inquiries → Console, delete that row and the two synthetic launch rows from 2026-09-17: `SELECT id, datetime(created_at,'unixepoch'), name FROM inquiries;` then `DELETE FROM inquiries WHERE id IN ('…');`.
- [ ] The page source contains no `/cdn-cgi/` scripts (`curl -s https://mnlith.dev/ | grep cdn-cgi` prints nothing).
- [ ] Optional: SSL Labs and Mozilla Observatory against https://mnlith.dev; Facebook Sharing Debugger / LinkedIn Post Inspector for the share image.
- [ ] After the first inquiry, open Cloudflare → Workers → monolith-api → Logs and confirm entries show only the Worker's structured event lines (no request bodies, names, emails or IP addresses).

## 5. After at least 24 hours: take the site off GitHub

- [ ] DNS → Records shows no record pointing at `185.199.*`, `2606:50c0:*` or `*.github.io`. Only then remove GitHub Pages; a leftover record would let another GitHub account claim the domain.
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
