# Monolith inquiry API

Cloudflare Worker with private D1 storage. This API saves inquiries and, once the optional notification binding is configured, emails each one to the owner. There is no public read endpoint, admin UI, or delivery SLA.

## Contract

POST `/inquiries` (alias `/api/inquiries`), `Content-Type: application/json` (charset accepted), with Origin exactly `https://mnlith.dev` or `https://www.mnlith.dev`.

```json
{"name":"Alex Doe","email":"alex@example.com","company":"Example","service":"managed-it","teamSize":"11-50","message":"We need help improving our systems.","consent":true,"website":""}
```

Service values: `managed-it`, `security`, `cloud`, `automation`, `not-sure`. `teamSize` must be `1-10`, `11-50`, `51-200`, `201+` or empty. `name`, `email`, `company`, `service` and `teamSize` must be single lines; every field rejects control characters and bidirectional overrides. `teamSize` and `website` may be omitted. `website` is an empty honeypot, not the company URL. Limits: 16 KiB body, name 120, email 254, company 160, service 40, teamSize 40, message 10–5000 characters. The response is `201 {"id":"UUID","status":"saved"}` only after a successful D1 insert. Frontend must show success only for 201 and must preserve the draft on failure. A 429 means wait an hour; 503 means storage/configuration unavailable. GET or HEAD `/health` indicates the Worker is running, not that its database is ready.

## Required configuration

- D1 binding `DB`, with `migrations/0001_inquiries.sql` applied.
- Worker secret `RATE_LIMIT_SECRET`, at least 32 random characters. Generate securely locally and enter with `wrangler secret put`; never commit it or print it into task logs.
- Daily cron, e.g. `0 3 * * *`.
- Custom API domain `api.mnlith.dev`, with Cloudflare terminating requests so `CF-Connecting-IP` is trustworthy.
- Frontend API URL `https://api.mnlith.dev/inquiries`.

The origins are intentionally hardcoded in the Worker. Wrangler's ALLOWED_ORIGINS variable is not used. Do not broaden production CORS for local development.

From the repository root, after authenticating Wrangler and reviewing the target account:

```powershell
npx wrangler d1 create monolith-inquiries --config api/wrangler.jsonc
# Put the returned database_id in api/wrangler.jsonc's DB binding.
npx wrangler d1 migrations apply monolith-inquiries --remote --config api/wrangler.jsonc
npx wrangler secret put RATE_LIMIT_SECRET --config api/wrangler.jsonc
npx wrangler deploy --config api/wrangler.jsonc
```

Check health and preflight. Submit one explicitly labelled deployment test from the production form, confirm its ID exists in the private D1 console, and remove that test row. No live inquiry is sent during automated testing.

## Privacy and operations

Inquiries contain contact details and consent time. Review them in Cloudflare's authenticated D1 console; secure dashboard access with MFA and least privilege. Establish a human review cadence because no email notification is implemented. Do not paste real inquiry contents into public logs or issue trackers. The scheduled handler removes records older than 90 days from the live database and rate-limit records older than one day. Daily scheduling means deletion can occur up to one day after the 90-day threshold; provider backups may have their own retention. Monitor scheduled execution failures.

Rate limits use HMAC-SHA256 of the Cloudflare-supplied client IPv4 address, or of its /64 prefix for IPv6, and a secret; raw IP addresses are not stored. One atomic SQLite UPSERT permits five accepted attempts in a one-hour window starting at the first attempt. Failed inserts consume an attempt. Rate counters and inquiries are separate writes: a storage error never produces success. Shared NAT users share the limit. Rotating the secret resets existing IP quotas.

Origin checking, honeypot and rate limits mitigate ordinary spam; Origin is not authentication and distributed bots can still submit. There is no secret embedded in the frontend. Add a server-verified challenge if observed abuse justifies it. The API never returns inquiry records and never logs request bodies. Cloudflare platform logs/retention must be configured separately.

Workers Logs is enabled with invocation logs off, so only the Worker's own structured failure lines are kept (3 days on Workers Free, 7 on Paid): `inquiry_service_unavailable`, `inquiry_store_failed`, `purge_inquiries_failed`, `purge_rate_limits_failed`. They never contain request bodies, names, email or IP addresses. Review them in Cloudflare → Workers → monolith-api → Logs. A failed purge still runs the other purge and marks the cron invocation as failed.

## Deletion requests

To delete someone's inquiries, run in the D1 console (Storage & databases → D1 → monolith-inquiries → Console), with their address in both places:

    SELECT COUNT(*) FROM inquiries WHERE lower(email) = lower('person@example.com');
    DELETE FROM inquiries WHERE lower(email) = lower('person@example.com');

Check that the delete's change count matches the count, delete any copies in the business mailbox, and reply to the requester. D1 Time Travel backups keep the deleted rows for up to 7 days (Workers Free) or 30 days (Paid), then they expire. They can't be purged sooner.

## Verification

`node --test api/tests/*.test.ts` (Node 24+) runs request-level tests with native SQLite executing the actual SQL through a small D1 transport adapter. Tests cover validation, exact origins, preflight, content type, streamed size limits, real insertion and returned ID, database failures, concurrent quota consumption, window expiry, retention and CORS aliases. `npx tsc -p api/tsconfig.json --noEmit` checks Worker types. These are local integration tests, not evidence that Cloudflare resources have been deployed.

References: [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/), [Cloudflare request headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

## Inquiry notifications (off until activated)

When a `send_email` binding named `NOTIFY` exists, each successfully stored inquiry is emailed to eldritch@mnlith.dev from inquiries@notify.mnlith.dev. It's plain text with Reply-To set to the customer and subject "New website inquiry: <service>". Sending runs after the 201 response through `ctx.waitUntil`. A failed send is logged as `inquiry_notify_failed` and never affects the stored inquiry or the response, so D1 stays the system of record. Rate-limited and rejected submissions are never emailed.

To activate (owner, one time):

1. Upgrade Workers to the Paid plan (Cloudflare dashboard → Workers & Pages → Plans). Email Sending to arbitrary recipients isn't available on Free.
2. Compute → Email Service → Email Sending: onboard the subdomain `notify.mnlith.dev` and let Cloudflare add its DNS records. Do not enable Email Routing on `mnlith.dev` itself, because it would replace the iCloud MX records. Afterwards confirm that `mnlith.dev` still has only the iCloud MX records and exactly one `_dmarc` TXT record.
3. Add to `api/wrangler.jsonc`:
   `"send_email": [{ "name": "NOTIFY", "destination_address": "eldritch@mnlith.dev", "allowed_sender_addresses": ["inquiries@notify.mnlith.dev"] }],`
4. `npm run api:deploy`, submit one labelled test inquiry from https://mnlith.dev, check that the received message shows `dkim=pass` and `dmarc=pass` in its headers, then delete the test row in the D1 console.

Emailed inquiries also live in the mailbox. The privacy notice already covers this ("may also be sent to our business mailbox"). Delete mailbox copies when handling deletion requests.
