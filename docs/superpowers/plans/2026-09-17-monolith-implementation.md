# Monolith Implementation Plan

> For agentic workers: use subagent-driven-development with scoped file ownership and parent integration/review.

**Goal:** Deliver a cinematic, credible Monolith site with a real private inquiry backend at mnlith.dev.
**Architecture:** GitHub Pages React frontend plus Cloudflare Worker and D1; existing domain/email configuration preserved.
**Tech Stack:** React, TypeScript, Vite, Motion, Cloudflare Workers, D1, GitHub Actions.
**Spec:** ../specs/2026-09-17-monolith-design.md

## Global constraints
- No invented credentials, customers, statistics, guarantees, or testimonials.
- No secrets in repository or frontend. Exact HTTPS origin allowlist.
- Preserve existing domain and all email records; backend uses api.mnlith.dev.
- Honor reduced motion and accessible mobile/keyboard interactions.

## Deliverables and ownership
- [x] Research agent: sourced profitability comparison and business brief in docs/research.
- [x] Asset agent: two original photoreal landscape images; parent checks and encodes WebP.
- [x] Architecture agent: package/TypeScript/Vite configuration, public/CNAME, GitHub Actions workflow, Worker configuration.
- [ ] Frontend agent: src/App.tsx, components, styles, content, custom favicon; real inquiry form contract.
- [ ] Backend agent: api/src, migration and tests; durable writes, validation, consent, origin control, private rate limiter, retention.
- [ ] Parent: inspect implementation, integrate assets, run test/build/Worker dry-run, open coherent preview.
- [ ] Independent review: identify actionable regressions/security/accessibility issues; implement necessary fixes.
- [ ] Parent: provision D1/Worker after Cloudflare authorization, apply migration and secret, verify real backend.
- [ ] Parent: deploy reviewed frontend through GitHub Actions, verify public HTTPS and www redirect, actual browser inquiry with synthetic test data, record deployment evidence.

## Verification commands
Run `npm test`, `npm run build`, and `npm run api:check` after implementation. Exercise browser navigation, FAQ, mobile menu, privacy dialog, form validation, success and network failure. Check asset requests and console for runtime errors. Confirm D1 contains exactly the synthetic inquiry sent in launch test without exposing customer records. Verify GitHub deployment run status and Pages custom-domain configuration.

## Execution ruling
The user explicitly requested agent-led implementation and publication. Continue authorized reversible implementation rather than introduce additional design approval loops. Ask for necessary business facts asynchronously. Cloudflare persistent-access consent remains a distinct required approval. Keep existing site live until complete replacement passes checks.
