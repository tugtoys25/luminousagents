# Architecture

## Product boundaries

Casinos of Mayfair is a confidential B2B brokerage platform, not a consumer gambling service. The
planned product combines public opportunity discovery, buyer accounts, a staff operating system, and
approval-controlled confidential document access. Sprint 0 establishes only the runtime foundation.

## Runtime and data flow

- One Cloudflare Worker named `mayfair-platform`, implemented in strict TypeScript with Hono.
- Hono JSX server rendering is reserved for public pages and dashboard pages in later sprints.
- D1 is the system of record; schema changes will be additive, numbered SQL migrations.
- R2 is for files and must remain private. Confidential documents will be streamed by the Worker only
  after authorization, never served as public URLs.
- KV is for cache/configuration/rate-limit support, not authoritative business data.
- Queues are for asynchronous notifications and audit fan-out; consumers and dead-letter handling are
  introduced when those workflows are implemented.
- Cloudflare Access SSO/MFA plus a server-side role check protects staff routes. Buyer/seller login is
  planned around one-time email codes and hashed session tokens, not passwords.
- Zod is the boundary validation library for request bodies, environment configuration, imports, and
  queue payloads as those features are added.

## Request path

All requests pass through request-ID middleware and baseline security headers. Routes should call
services; services call repositories; repositories alone write SQL. All opportunity responses must go
through a single tier-aware serializer once opportunity data is implemented. Authorization must be
checked on the server regardless of what navigation or controls the UI hides.

## Environments

`dev`, `staging`, and `production` use separate D1/R2/KV/Queue resources. The current Wrangler file
contains placeholder identifiers and names solely to define the intended binding shape. It is not
safe or deployable until each resource has been provisioned and the real IDs/names substituted.

## Delivery sequence

1. Foundation and runtime health.
2. Data model, legacy import verification, public pages, SEO and design tokens.
3. Staff Access, roles, opportunity CMS and audit log.
4. Enquiries and CRM-lite.
5. Buyer accounts, NDA workflow, compliance grants and secure data room.
6. Hardening, legal review, backups/restore, load/security checks and controlled launch.

Seller portal, full deal pipeline, e-signature/Workflows, advanced analytics, AI search/matching, mobile
apps, real-time chat, microservices and multi-tenancy are outside the initial MVP scope.
