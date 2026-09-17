# Monolith website design

## Goal and delivery
Create a credible, cinematic IT consulting and managed-services website at the established https://mnlith.dev. Preserve Frozt-src/Website, GitHub Pages, Cloudflare DNS, and all six existing email records. The user explicitly commissioned research, original imagery, agent-led scaffolding, frontend/backend implementation, and a ready-to-ship deployment.

## Positioning
Present managed IT, security and continuity, cloud and infrastructure, and practical automation/development. Primary audience is growing businesses; precise company size and territory are not claimed. No fabricated clients, certifications, testimonials, metrics, response times, or support guarantees. Research lives in docs/research and distinguishes reported profitability from adjusted margins and private-provider surveys.

## Visual system
Photoreal original basalt monolith in glacial mist anchors a full-viewport hero. Suspended dark stone supports a quieter editorial section. Charcoal #080b0d, basalt #111619, slate #7f929c, fog #c4d2d8, ice #edf5f7. Space Grotesk display and Manrope body are self-hosted. Oversized readable type, thin structural borders, generous negative space, custom three-pillar brand mark. Motion uses layered parallax, deliberate text entrances, transitions, and reveals; native scrolling remains intact. Reduced-motion preference disables nonessential motion. All content remains reachable by keyboard and touch at narrow/mobile widths.

## Content and interactions
Hero, service capabilities, integrated approach, Assess/Build/Maintain process, FAQ, inquiry form, privacy information, footer. Navigation and CTAs scroll to real sections. Mobile navigation opens/closes accessibly. Contact form provides inline validation, pending, success, and retryable error states. No simulated delivery. Original image sources are preserved outside the repository; web assets are optimized WebP.

## Architecture
React + TypeScript + Vite and Motion on GitHub Pages, deployed through GitHub Actions. Cloudflare Worker on api.mnlith.dev and D1 store private inquiries. Java is unnecessary for this scope and would require separate hosting. No new customer portal, payment system, analytics, cookies, or public administration endpoint.

## API and data
POST /inquiries accepts name, email, company, service, optional teamSize, message, consent=true, and empty website honeypot. Returns 201 only after durable storage. Enforce exact production origin allowlist, JSON content type, bounded request size, field constraints, and atomic rate limit. Never store raw IP; use keyed hashing. Private messages expire after 90 days through a daily scheduled purge. GET /health reveals no private content. No email delivery claim: initial delivery destination is the private Cloudflare D1 inbox, with direct business email alternative. Deployment must prove saved test inquiry and rejection of malformed requests.

## Acceptance
Production build and typecheck pass. Backend validation/failure/rate-limit tests pass. Desktop/mobile visual checks, keyboard navigation, reduced-motion behavior, real asset loading, and end-to-end inquiry success/failure verified. HTTPS works at root and www redirect. Original static site remains recoverable from Git history. No secrets enter repository or client bundle. Cloudflare authorization is an explicit user-dependent deployment prerequisite.
