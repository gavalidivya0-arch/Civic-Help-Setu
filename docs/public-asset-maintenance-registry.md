# QR-Based Public Asset Maintenance and Repair History Registry (#750)

## 1. What this module does

The public asset registry is a separately scoped civic workflow for a municipality to:

- register public benches, street furniture, bus shelters, playground equipment and similar maintainable assets;
- print a non-sensitive QR tag for each asset and resolve that tag to an approved public record;
- let a resident view condition, inspection timing and verified repair history, and report a visible fault;
- let authorised staff schedule and verify inspections, triage citizen reports, raise and complete evidence-backed work orders, verify repairs and read the audit trail;
- keep repair events append-only and expose only approved fields publicly.

Routes:

| Route | Purpose |
| --- | --- |
| `/public-assets` | Primary page: public register, fault reporting, report tracking and the staff workspace |
| `/public-assets/tag/:token` | QR-tag lookup route. The token is a lookup key only |
| `/asset-registry` | Alias used by municipal staff shortcuts |

Navigation: the Navbar entry is **Public Asset Registry** (`src/components/Navbar.jsx`) and uses the `QrCode` icon.

## 2. Architecture and trust boundary

```text
src/pages/PublicAssetRegistry.jsx          page orchestration, tabs, form state, service calls
src/components/assets/*.jsx                presentation, accessible controls, no business rules
src/services/assetRegistryService.js       public import surface (barrel)
src/services/assetRegistryConstants.js     enums, labels, transitions, capabilities, limits, error codes, storage keys
src/services/assetRegistryValidation.js    storage, transactions, sanitisation, token signing, evidence validation, pagination
src/services/assetAccessControl.js         asset role and jurisdiction resolution
src/services/assetRegistryMigrations.js    bootstrap, schema migration, rollback and index manifest
src/services/assetTriageService.js         deterministic, explainable triage rules
src/services/assetRegistryCore.js          projections, reads, audit chain, idempotency, public lookup
src/services/assetLifecycleService.js      asset create/update, lifecycle status, QR tags, staff action tokens
src/services/assetInspectionService.js     inspection scheduling and transitions
src/services/assetFaultService.js          citizen reports, duplicate/rate controls, triage and review
src/services/assetWorkOrderService.js      work orders, repair completion/verification, retention, citizen scrub
src/data/publicAssetData.js                demonstration categories, locations, assets and history
api/_lib/handlers/asset-fault-reports.js   optional server-side citizen intake
api/[...path].js                           Vercel-style route dispatch for `POST /api/asset-fault-reports`
```

The React layer never decides whether an action is allowed and never writes registry storage directly. Buttons and tabs are hidden or disabled for usability only; the service re-checks every capability, jurisdiction and state transition.

This is a local-first application. The browser service layer is the trusted boundary for the demonstration: the signed-in actor registered by `AuthProvider` is the only source of role and jurisdiction facts. The optional server handler is a citizen-intake path, not a full remote registry. It stores no raw QR tag, reporter key, IP address or user agent, and it never exposes queue contents over HTTP.

## 3. Persistence model

Each normalised collection is a JSON array in `localStorage`, accessed only through the service. Multi-key writes use a snapshot/commit/restore transaction: if any write fails, every key in the transaction is restored to its previous value.

Required collections:

| Collection | Storage key | Core entity |
| --- | --- | --- |
| Asset register | `civicbridge_asset_registry_v1` | `PublicAsset` |
| Categories | `civicbridge_asset_categories_v1` | `AssetCategory` |
| Locations | `civicbridge_asset_locations_v1` | `AssetLocation` |
| Inspections | `civicbridge_asset_inspections_v1` | `AssetInspection` |
| Fault reports | `civicbridge_asset_fault_reports_v1` | `FaultReport` |
| Work orders | `civicbridge_asset_work_orders_v1` | `WorkOrder` |
| Repair evidence | `civicbridge_asset_repair_evidence_v1` | validated image metadata/content |
| QR tokens | `civicbridge_asset_qr_tokens_v1` | `QrToken` (hash + prefix only) |

Supporting collections:

| Collection | Storage key | Purpose |
| --- | --- | --- |
| Repair events | `civicbridge_asset_repair_events_v1` | append-only repair history |
| Triage suggestions | `civicbridge_asset_triage_suggestions_v1` | explainable advisory output and human decision |
| Audit events | `civicbridge_asset_audit_events_v1` | hash-chained append-only trail |
| Idempotency | `civicbridge_asset_idempotency_v1` | retry-safe write results |
| Rate limits | `civicbridge_asset_rate_limit_v1` | per-device citizen submission window |
| Staff action nonces | `civicbridge_asset_action_nonces_v1` | single-use signed action tokens |
| Schema metadata | `civicbridge_asset_registry_meta_v1` | version stamp, demo flag, per-install action secret, index manifest |
| Migration backup | `civicbridge_asset_migration_backup_v1` | exact pre-migration snapshot |
| Citizen reporter key | `civicbridge_asset_reporter_key` | random local key for rate limiting and duplicate detection; owned citizen data |
| Legacy register/reports | `civicbridge_assets_v1`, `civicbridge_asset_reports_v1` | read during migration only |

Every operational record carries `id`, a public reference where relevant, `createdAt`, `updatedAt`, `createdBy` or equivalent actor metadata, and `schemaVersion`. Relationships are validated inside the service: an asset must reference a known category and location; an inspection, fault report or work order must reference an existing asset; a work order may reference a report or inspection for the same asset; a repair event is created only from a completed work order.

### Query index manifest

`ASSET_REGISTRY_INDEX_MANIFEST` in `assetRegistryMigrations.js` documents the bounded filters that the service relies on:

- jurisdiction;
- status + category;
- `createdAt` for newest-first pagination and retention scans;
- bounded search text over public ID, name, ward, locality and category label;
- QR token hash (exact lookup only, never a token listing);
- fault-report state + jurisdiction + created date;
- work-order state + assignee + due date;
- inspection due date;
- public reference + public ID.

List endpoints accept `page` and `pageSize`; page size is capped by `ASSET_API_LIMITS.maxPageSize` (50).

## 4. Roles, capabilities and jurisdiction scope

Site-wide roles remain `admin` and `citizen`. The asset domain narrows an administrator through trusted public metadata:

```js
{
  id: 'staff_1',
  username: 'Ward operator',
  role: 'admin',
  raw: { publicMetadata: { assetRole: 'operator', jurisdictionId: 'blr' } }
}
```

Allowed asset roles are `operator`, `reviewer` and `admin`. A citizen can never obtain staff access by passing a role in a request; only the signed-in actor is read.

| Capability | Operator | Reviewer | Admin |
| --- | :---: | :---: | :---: |
| Public register and approved history | yes | yes | yes |
| Staff register, private notes and evidence metadata | yes | yes | yes |
| Register / correct an asset | yes | — | yes |
| Suspend, retire, archive or restore | — | yes | yes |
| Issue / rotate a QR tag | yes | — | yes |
| Revoke a QR tag | — | — | yes |
| Issue / consume a short-lived staff action token | yes | yes | yes |
| Schedule / complete an inspection | yes | — | yes |
| Verify an inspection | — | yes | yes |
| Submit a citizen fault report | yes | yes | yes |
| Triage a citizen report | yes | yes | yes |
| Reject or mark a report duplicate | — | yes | yes |
| Create / assign / update / complete a work order | yes | — | yes |
| Verify a completed work order | — | yes | yes |
| Accept / edit / reject a triage suggestion | yes | yes | yes |
| Read the audit trail | — | yes | yes |
| Apply retention | — | — | yes |
| Run or roll back a migration | — | — | yes |

A full administrator with no jurisdiction metadata sees all jurisdictions. A staff member with one or more jurisdiction IDs sees only those jurisdictions. A staff member with no jurisdiction metadata sees no scoped records and cannot write outside an assigned jurisdiction. Citizens and anonymous visitors can read the public projection without being narrowed to an empty list.

## 5. Domain states

Transitions are defined once in `assetRegistryConstants.js` and enforced by the service.

| Entity | States and transitions |
| --- | --- |
| Asset | `active` → `suspended` / `retired`; `suspended` → `active` / `retired`; `retired` ↔ `archived` |
| Inspection | `scheduled` → `in_progress` / `completed` / `missed` / `cancelled`; `in_progress` → `completed` / `cancelled`; `completed` → `verified`; `missed` → `scheduled` / `cancelled`; `cancelled` → `scheduled` |
| Fault report | `submitted` → `triaged` / `rejected` / `duplicate`; `triaged` → `converted` / `rejected` / `duplicate`; `converted` → `resolved` |
| Work order | `draft` → `assigned` / `cancelled`; `assigned` → `in_progress` / `blocked` / `completed` / `cancelled`; `in_progress` → `blocked` / `completed` / `cancelled`; `blocked` → `in_progress` / `cancelled`; `completed` → `verified`; `verified` and `cancelled` are terminal |
| Triage suggestion | `pending` → `accepted` / `edited` / `rejected`; decisions are terminal |

Invalid transitions return `ASSET_INVALID_TRANSITION` with a plain-language `userMessage` and the allowed next states. A completed work order can only be verified; a verified or cancelled order cannot be edited. A verified or cancelled inspection cannot be completed again. A verified repair event is never edited in place.

Work-order completion requires closure notes of at least 10 characters, a public summary, a resulting condition and at least one validated image. Verification records the reviewer and timestamp on the work order, resolves the linked citizen report, updates the asset, and makes the linked repair event visible in the public history.

## 6. Validation, privacy and retry safety

- Every write validates enum values, lengths, ranges, ISO dates, references and jurisdiction inside the service. Form validation is only a usability layer.
- Text is trimmed and length-limited. Public narratives pass through `sanitizePlainText` and `minimizeForExternal`, which strip markup and redact obvious email addresses, phone numbers and credential-like strings.
- Evidence is limited to JPEG, PNG or WebP, 5 MB per image and a bounded count. Data URLs are checked structurally. SVG, documents, scripts and oversized payloads are rejected with `ASSET_UNSAFE_ATTACHMENT`.
- Retryable writes accept an idempotency key. A replay returns the original result with `replayed: true`; reuse with a different payload returns `ASSET_IDEMPOTENCY_CONFLICT`.
- Citizen submission is rate-limited to 3 reports per hour per reporter key. A near-identical report from the same device and asset within 10 minutes is returned as a duplicate instead of creating another record.
- Public QR tags are high-entropy opaque tokens. Only a token hash and a short prefix are stored. A revoked, expired, unknown or malformed tag returns the same generic `ASSET_QR_INVALID` response, so a tag cannot be enumerated from the public route.
- Error objects expose stable codes (`ASSET_PERMISSION_DENIED`, `ASSET_JURISDICTION_FORBIDDEN`, `ASSET_VALIDATION_ERROR`, `ASSET_INVALID_TRANSITION`, `ASSET_RATE_LIMITED`, `ASSET_QR_INVALID`, `ASSET_STORAGE_ERROR`, etc.) plus a `userMessage`, `fieldErrors` and bounded `details`.
- Public projections are built field by field. They exclude internal record IDs, reporter keys or hashes, private notes, staff names, precise locations and evidence URLs. Locations are published only as ward, locality, landmark and an approximately 1 km grid.
- Repair evidence files are staff-only. Public repair history exposes the public reference, public summary, completion date, verification date and evidence count, never the image URL or uploader.

## 7. Explainable triage

Triage is advisory only and deterministic.

- Input window: report category, reported severity, visible-symptom terms in the citizen description, and the asset's public category, condition and status.
- The ruleset version is `asset-triage-rules-v1`; the model identifier is `deterministic-asset-maintenance-rules-v1`.
- Every suggestion records the ruleset version, execution timestamp, input window, confidence, score, rationale and per-factor explanations.
- Suggestions carry `requiresHumanReview: true`, `canApplyAutomatically: false` and explicit prohibited uses: automatic asset retirement, automatic access denial, automatic work-order closure and automatic priority without human review.
- The deterministic rules are the fallback. No external model or API is called, so there is no model-outage path to fail. External adapters are intentionally not used.
- An operator, reviewer or administrator can accept, edit or reject the suggestion. The decision, reason, applied priority and ruleset version are audited. Rejection requires a short reason. The suggestion never changes lifecycle state on its own.

## 8. Migrations, rollback, retention and deletion

Schema version: **1** (`ASSET_REGISTRY_SCHEMA_VERSION`).

`ensureAssetRegistryData` bootstraps categories, locations, the index manifest, schema metadata and a clearly labelled demonstration register on first use. It never overwrites a non-empty collection.

`migrateAssetRegistry` is restricted to the `registry.migrate` capability (administrator):

1. reads the current version stamp;
2. reads legacy `civicbridge_assets_v1` and `civicbridge_asset_reports_v1` records, normalising IDs, categories, locations and schema metadata;
3. writes a full pre-migration snapshot to `civicbridge_asset_migration_backup_v1`;
4. applies all collections in one transaction;
5. appends a migration audit event and stamps the new version.

`rollbackAssetRegistry` restores the snapshot exactly and removes the backup key. Both actions are exposed in the staff page's migration panel and the audit chain records the run/rollback.

Retention: closed citizen reports (`resolved`, `rejected`, `duplicate`) older than 365 days are archived in place on demand through `applyAssetRetentionPolicy`. The description is replaced with an archival marker, the reporter hash/label and attachment links are cleared, matching `FaultReport` evidence is removed and an audit event records the counts. Work orders, repair events, inspections and the asset register are retained as municipal operating records.

Privacy Centre: **Clear my data** deletes the citizen `civicbridge_asset_reporter_key`. When it exists and the report collection has been used, it also scrubs the citizen-authored content from that device's fault reports: description → `[Cleared at citizen request]`, reporter hash/label removed, evidence links removed and matching `FaultReport` images deleted. Work-order closure evidence and the municipal report record are retained because work orders and repair history reference them. See [DATA_RETENTION.md](DATA_RETENTION.md).

## 9. Audit trail and staff action tokens

Privileged actions append hash-chained audit events with:

- actor ID and display label, resolved asset role and jurisdiction;
- action, entity type/ID, reason and timestamp;
- bounded change summary and safe details;
- `previousHash` and `hash`.

`verifyAssetAuditChain` detects a changed event, a broken link or a reordered trail. The staff page surfaces "hash chain broken" and instructs staff to stop writes and restore a trusted backup.

Staff action tokens are signed, actor-bound, asset-bound, single-use and short-lived (default 10 minutes, capped at 30 minutes). The token payload includes the asset, action, actor, role, jurisdiction, issue time, expiry and a nonce. Consumption verifies the signature, expiry, actor, action capability, asset jurisdiction and nonce replay, then appends an audit event. The per-install signing secret is stored in schema metadata.

**Local-first limitation:** the staff workspace currently authorises writes from the signed-in actor's role and jurisdiction directly. The signed action-token primitives exist and are tested, but they are not yet required by every staff form. In a deployed municipal system, put the service contract behind a server, require an action token or equivalent server session for each write, and keep the same state machines and projections.

## 10. Optional server intake

`POST /api/asset-fault-reports` is a citizen-intake endpoint for deployments that place a trusted service in front of the browser registry:

- accepts a QR tag or a public asset ID, category, severity, description and optional evidence references;
- rejects reporter keys, names, email, phone, Aadhaar, PAN, IP and user-agent fields;
- validates the same enums, text length, image type/size and URL scheme as the browser service;
- rate-limits by connection and de-duplicates identical payloads for 10 minutes;
- returns a stable public reference and `pending_review` status;
- never exposes the queue over HTTP and never stores the raw tag, IP address or user agent.

The in-memory queue is a demonstration adapter. A production deployment must move the queue into the municipal case-management store and connect intake to the same report/triage service contract.

## 11. User experience and accessibility

- The public register has search, jurisdiction, ward, category, condition and status filters, result counts, paging and a reset action.
- The page has loading skeletons, empty states, stale-data notices, offline notices, permission-denied panels and recoverable error states with a retry action.
- Tabs are real buttons with `aria-pressed`; sections have headings and labelled groups.
- Status and priority are shown with text labels and badges, not colour alone.
- Forms use native labels, `aria-invalid`, `aria-describedby`, error summaries and visible focus styles.
- Public detail views show the source, last-updated timestamp, inspection timing and a plain-language note that citizen reports are unverified.
- Tables have captions/headers and the layout collapses to cards on narrow screens. No map or chart is required for the primary workflow.
- The public page states that a QR tag is a lookup key and never an authorisation.

## 12. Operational limits and manual fallback

Limits are defined in `ASSET_API_LIMITS`:

| Limit | Value |
| --- | --- |
| Default / maximum page size | 12 / 50 |
| Search length | 80 characters |
| Name / description / notes / reason | 120 / 1000 / 1200 / 500 characters |
| Attachments per report / evidence per order | 3 / 5 |
| Attachment size / data-URL length | 5 MB / 2,000,000 characters |
| Citizen reports per device | 3 per hour |
| Duplicate-report window | 10 minutes |
| Active QR tags per asset | 10 |
| QR token entropy | 24 random bytes |
| Staff action token TTL | 10 minutes default, 30 minutes maximum |
| Inspection interval | 30–730 days |
| Stale-data threshold | 30 days |
| Closed-report retention | 365 days |

- The register is stored on this device. It is a demonstration/local-first record, not a municipal system of record; decisions still need the official municipal process.
- Recommended practical size is a few thousand assets per device. Pagination and the index manifest keep the UI bounded, but `localStorage` quota is the hard limit. Replace the storage adapter with a server API for production and keep the service contract.
- If storage is unavailable or full, the service returns `ASSET_STORAGE_ERROR` and leaves the form input on screen.
- If a QR tag is lost, revoked or unreadable, a resident can find the asset by public ID in the public register or contact the municipal office. Staff can issue a replacement tag from the staff workspace.
- If the optional server intake is unavailable, the browser service still supports the local-first report flow. If triage is unavailable, the deterministic rules always run; there is no external model dependency.
- If migration fails, the snapshot remains and rollback restores it. If the audit chain fails verification, stop writes and restore a trusted backup.

Environment variables: none are required specifically for this module. It uses the existing app auth/network context and local storage. Do not put secrets in `VITE_` variables; they are public.

Data sources: a labelled demonstration dataset in `src/data/publicAssetData.js`, locally entered staff records, and citizen reports. Public QR tags are generated in the service; the app does not call an external QR image service for asset tags.

## 13. Testing

Targeted commands:

```bash
npx vitest run src/services/assetRegistryService.test.js
npx vitest run src/services/assetRegistryMigrations.test.js
npx vitest run src/services/assetAccessControl.test.js
npx vitest run src/services/assetTriageService.test.js
npx vitest run src/services/clearMyDataService.test.js
npx vitest run src/pages/PublicAssetRegistry.test.jsx
npx vitest run src/components/assets/AssetRegistryComponents.test.jsx
npx vitest run tests/asset-fault-reports.test.js
```

Coverage includes:

- bootstrap, schema metadata, legacy import, no-op migration, rollback and capability denial;
- invalid, malformed, expired and revoked QR tokens, hashed-only tag storage and public/private field separation;
- duplicate reports, idempotent retries, per-device rate limits and same-device duplicate detection;
- asset lifecycle, inspection, fault-report and work-order transitions and invalid transitions;
- evidence type/size/URL validation and unsafe attachment rejection;
- citizen, operator, reviewer and administrator authorisation and jurisdiction scoping;
- explainable triage determinism, provenance, human accept/edit/reject and prohibited uses;
- append-only repair events, verification via the linked work order, audit-chain tamper detection and retention without deleting repair history;
- citizen-data scrub and the "do not seed on an untouched device" clear-data case;
- public component projection, form validation, permission states, loading/empty/offline/error states and accessibility labels;
- API validation, PII rejection, malformed JSON, idempotent retry, rate limiting, POST-only behaviour and no queue exposure.

Full verification before a PR:

```bash
npm test
npm run lint
npm run lint:security
npm run build
```
