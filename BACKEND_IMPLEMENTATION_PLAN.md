# W3Skool Backend — Implementation Plan (for the Flutterwave + ownership work)

Companion to `Frontend/EXECUTION_REPORT.md`. The React frontend now consumes the contracts below; this document
specifies the backend work to make them real. The backend stays the **single source of truth** for price,
splits, ownership, payment status, certificate eligibility, quiz scores, unlocking and enrollment.

Stack (existing): Express 4, Mongoose 8, JWT (`authenticate`/`authorize('admin')`), Flutterwave v3 via
`services/flutterwave.service.js`, `{ $data }` / `{ error: { code, message, details } }` envelopes.
Roles: `student`, `admin` only. **No `teacher` role.**

---

## 0. Golden rules
- Never trust client values for price, split, fee, reference, ownership, subaccount, payment status, certificate eligibility, quiz score, enrollment or unlocking.
- Every admin resource is scoped to the **authenticated admin** (`req.user.id`). A student calling `/admin/*` → `403 FORBIDDEN`.
- All new endpoints use the existing envelopes and helpers (`sendSuccess`, `sendError`, `AppError`, `asyncHandler`).
- Secret keys live only in env; only the Flutterwave **public** key may reach the client.

---

## 1. New/changed environment variables
```
FLUTTERWAVE_SECRET_KEY=        # existing
FLUTTERWAVE_PUBLIC_KEY=        # already referenced by payment.controller — required for window checkout
FLUTTERWAVE_WEBHOOK_HASH=      # existing
FLUTTERWAVE_PLATFORM_FEE_PCT=  # NEW optional, default 0 (e.g. 1.4 for the % Flutterwave charges)
CLIENT_URL=                    # existing, used for redirect + certificate verify links
```
`FLUTTERWAVE_PUBLIC_KEY` may be returned to the client (safe/public); never return the secret key.

---

## 2. Payments — Window checkout

### `POST /payments/checkout`  *(auth: student/admin; body: `{ courseId, redirectUrl }`)*
Purpose: return a **trusted** Flutterwave Inline (window) config plus the amount breakdown. Same validation as
`/payments/initiate` (course published, not already enrolled, `redirectUrl` on the allow-list).

- **Free course** → enroll immediately, respond `{ paymentRequired: false, courseId }`.
- **Already enrolled** → `409 ALREADY_ENROLLED`.
- **Paid course**: create a `Payment` (`pending`, own `txRef`, `amount` from **our DB**) and respond:

```json
{
  "paymentRequired": true,
  "currency": "NGN",
  "txRef": "w3s_<courseId>_<userId>_<ts>",
  "summary": { "coursePrice": 25000, "flutterwaveFee": 350, "total": 25350, "feeInclusive": false },
  "config": {
    "public_key": "<FLUTTERWAVE_PUBLIC_KEY>",
    "tx_ref": "w3s_…",
    "amount": 25350,
    "currency": "NGN",
    "payment_options": "card,banktransfer,ussd",
    "redirect_url": "<redirectUrl>",
    "customer": { "email": "…", "name": "…", "phonenumber": "…" },
    "customizations": { "title": "W3Skool", "description": "<course title>", "logo": "https://…/assets/logo.png" },
    "meta": { "courseId": "…", "userId": "…" },
    "subaccounts": [ { "id": "<owner FW subaccount id>", "transaction_split_ratio": 1 } ]
  }
}
```

Rules:
- `amount` = `total` = what the student is charged. Compute `flutterwaveFee` server-side (from `FLUTTERWAVE_PLATFORM_FEE_PCT` or a fee table) and set `total` accordingly; when the fee is already inside the course price, set `feeInclusive: true` and `total = coursePrice`.
- The `subaccounts` entry must come from the course **owner**'s stored subaccount; if the owner has none, the course is not payable (see §4 publish check).
- **The client must not recompute any of these numbers.** Reject any client-sent `amount`, `fee`, `total`, `txRef` or `split`.

### `GET /payments/verify?txRef=&transactionId=`  *(existing — keep)*
On the inline `callback`, the frontend redirects to `/payment/callback`, which calls this. It must, idempotently:
verify with Flutterwave, compare `amount >= payment.amount`, `currency`, `tx_ref`, `status === 'successful'`,
then mark `verified` and create the enrollment. The frontend never marks enrollment from the checkout callback.

### Webhook *(existing — keep)*
`verif-hash` validated; settle/complete the payment even if the student never returns.

---

## 3. Flutterwave payouts / subaccount (admin)

### New model — `models/Subaccount.js`
```js
{ adminId (ObjectId, unique, ref User),                // owner
  flwSubaccountId (String),                            // Flutterwave subaccount id
  status (String enum ['pending','active','failed']),
  bankCode, bankName, accountNumber, accountName,
  businessName, businessEmail, businessContact, businessMobile,
  country (default 'NG'), splitType (default 'percentage'), splitValue (Number, e.g. 0.9),
  createdAt, updatedAt }
```

### Service additions — `services/flutterwave.service.js`
- `createSubaccount({ account_bank, account_number, business_name, business_email, business_contact, business_contact_mobile, country, split_type, split_value })` → **live** `POST /v3/subaccounts` (verified: Bearer `FLWSECK_…` secret key).
- `listBanks(country)` → **live** `GET /v3/banks/:country` (verified).
- `resolveAccount({ account_number, account_bank })` → **live** `POST /v3/accounts/resolve` (verified).
- A `401 Invalid authorization key` response means the configured secret key is wrong or belongs to the wrong (test vs live) mode — the service now returns a `FLUTTERWAVE_UNAUTHORIZED` message instead of a generic 502.

### Endpoints (`routes/admin.routes.js`, behind `authenticate, authorize('admin')`)
| Method | Path | Purpose | Response |
|---|---|---|---|
| GET | `/admin/payouts` | Connection summary + attached courses | `{ connected, subaccount?, courses:[{id,title,status,attached}], instructions:[] }` |
| GET | `/admin/payouts/subaccount` | Current subaccount | `{ subaccount: {...} \| null }` |
| GET | `/admin/payouts/banks?country=NG` | Bank list | `[{ code, name }]` |
| GET | `/admin/payouts/resolve?bankCode=&accountNumber=` | Resolve account name | `{ accountName }` |
| POST | `/admin/payouts/subaccount` | Create subaccount | `{ connected: true, subaccount }` |
| PATCH | `/admin/payouts/subaccount` | Update details | `{ connected: true, subaccount }` |

`subaccount` shape returned to the client (never expose secrets):
```json
{ "id": "…", "flwSubaccountId": "…", "status": "active", "bankCode": "044", "bankName": "Access Bank",
  "accountNumber": "****1234", "accountName": "…", "businessName": "…", "businessEmail": "…",
  "country": "NG", "splitType": "percentage", "splitValue": 0.9, "createdAt": "…" }
```
Create/update flow: validate → resolve account (confirm name) → call Flutterwave `createSubaccount` → store →
set `status`. If Flutterwave fails, `502 PAYOUT_CREATE_FAILED` with a friendly `message`. Mask `accountNumber`.
New controller: `controllers/admin/payout.admin.js` (thin; delegates to the service).

---

## 4. Course ownership + publish gating

1. **`Course` model** — add `owner: { type: ObjectId, ref: 'User', index: true }`. Migrate existing courses to the current sole admin (or leave null = platform-owned).
2. **`POST /admin/courses`** — set `owner = req.user.id`. **Ignore any client-supplied `owner`/`adminId`.**
3. **`GET /admin/courses`** — scope to owned (`Course.find({ owner: req.user.id })`). Return per course:
   ```json
   { "id","title","status","price","currency","moduleCount","unitCount","studentCount",
     "owner": { "id","name" }, "payoutReady": true }
   ```
   `payoutReady = price === 0 || ownerHasActiveSubaccount(ownerId)`.
4. **`GET /admin/courses/:id/publish-check`** — add issue when a paid course's owner has no active subaccount:
   `{ "code": "PAYOUT_NOT_SETUP", "message": "Connect your payout account before publishing a paid course." }`, enforced in `POST /admin/courses/:id/publish` (`422 PAYOUT_NOT_SETUP`).
5. Module/unit/quiz admin mutations must verify the course belongs to `req.user.id` before writing.

---

## 5. Students — pagination contract

### `GET /admin/students?search=&page=&limit=`
Change from a raw array to a paginated envelope (the UI supports both):
```json
{ "data": [ { "id","name","email","phone","createdAt","enrolledCourses","lastActiveAt" } ],
  "meta": { "page": 1, "limit": 20, "total": 137, "totalPages": 7 } }
```
Clamp `limit` (default 20, max 100); `search` matches name/email case-insensitively. Keep `/admin/students/:id` as-is.

---

## 6. Live sessions — notify students

`POST /admin/live-sessions` and `PATCH /admin/live-sessions/:id`:
- Accept `notifyStudents` (boolean, default `true`) and extend `platform` to `google_meet | zoom | whatsapp | other`.
- On create, or on a **material** update (title / startsAt / joinUrl changed), if `notifyStudents !== false`, enqueue notifications to enrolled students.
- Respond with `notified` (boolean) and `notifyStudents`:
```json
{ "id": "...", "title": "...", "platform": "whatsapp", "notifyStudents": true, "notified": true, "status": "scheduled" }
```
The frontend **never** sends emails; delivery is entirely server-side.

---

## 7. Error codes to add
| HTTP | Code | When |
|---|---|---|
| 404 | `PAYOUT_NOT_FOUND` | No subaccount for this admin |
| 422 | `PAYOUT_NOT_SETUP` | Publishing a paid course whose owner has no active subaccount |
| 502 | `PAYOUT_CREATE_FAILED` | Flutterwave subaccount creation failed |
| 502 | `PAYOUT_RESOLVE_FAILED` | Account resolution failed |
| 409 | `ALREADY_ENROLLED` | Existing behaviour, reused by checkout |
| 422 | `VALIDATION_ERROR` | Missing/invalid body fields |

---

## 8. Files to add / change
**Add:** `models/Subaccount.js`, `controllers/admin/payout.admin.js`, `services/payout.service.js` (optional).
**Change:** `models/Course.js` (`owner`), `services/flutterwave.service.js` (subaccount/banks/resolve),
`controllers/payment.controller.js` (`checkout`), `routes/payment.routes.js`, `routes/admin.routes.js`,
`controllers/admin/course.admin.js` (ownership + publish gate), `controllers/admin/liveSession.admin.js`
(`notifyStudents`/`notified`), `controllers/admin/student.admin.js` (pagination), `models/LiveSession.js`.

---

## 9. Security checklist
- [ ] Price/split/fee/reference computed only server-side; client values ignored.
- [ ] `/payments/verify` idempotent + re-verifies with Flutterwave every call; webhook signed.
- [ ] Subaccount secrets never returned; `accountNumber` masked.
- [ ] Every `/admin/*` route requires `authorize('admin')`; per-resource ownership enforced.
- [ ] Quiz answers/`isCorrect` never sent to students; scores computed on the server.
- [ ] Enrollment/certificate/unlock derived from server state only.
- [ ] `POST /admin/courses` ignores client `owner`/`adminId`.

---

## 10. Backend test plan
1. **Checkout**: paid course → config+summary shape; free course → immediate enroll; already enrolled → 409; client-sent amount ignored.
2. **Verify**: idempotent (double call), tampered amount fails, webhook completes without redirect.
3. **Payouts**: create → Connected; update; banks; resolve; failure paths return the documented codes.
4. **Ownership**: admin A cannot read/edit admin B's course; new course owned by creator; client `owner` ignored.
5. **Publish gate**: paid course without payout → `PAYOUT_NOT_SETUP`; after subaccount active → publishes.
6. **Students**: `{data,meta}` paging, search, limit clamp.
7. **Live sessions**: `notifyStudents` honoured; `notified` reported; material update re-notifies.
8. **Regression**: existing `/payments/initiate` (hosted link), `/student/*` and `/admin/*` behaviours unchanged.

---

## 11. Rollout order (suggested)
1. `checkout` + `verify` (unblocks window checkout; keep `initiate` alive meanwhile).
2. `Subaccount` model + Flutterwave service methods + `/admin/payouts*`.
3. Course `owner` + ownership scoping.
4. `PAYOUT_NOT_SETUP` publish gate + `payoutReady`.
5. Students pagination.
6. Live-session `notifyStudents`/`notified`.

Each step is independently shippable and non-breaking; the frontend already handles each endpoint being absent.

---

## 12. Flutterwave verification notes (checked against the live docs, Oct 2026)

- **Split creation**: `split_type: 'percentage'` + `split_value: 0.9` on `POST /v3/subaccounts` gives the
  **owner subaccount 90% of its routed share**; the platform keeps the remainder.
- **Inline/Standard checkout split**: the `subaccounts` array uses
  `{ id, transaction_split_ratio, transaction_charge, transaction_charge_type }`.
  `transaction_split_ratio` is **relative** (e.g. owner ratio `9`, merchant remainder `1`
  ⇒ 90% owner / 10% platform), **not** a decimal percentage.
- **Fee allocation**: `transaction_charge_type: 'flat_subaccount'` makes the subaccount side bear the
  transaction fee, so the **student-borne Flutterwave fee is enforced at checkout**.
- **Stale error fixed**: the backend no longer forwards Flutterwave's confusing `Invalid authorization key`
  message when computing or verifying amounts. It only surfaces as `FLUTTERWAVE_UNAUTHORIZED` when an actual
  Flutterwave API call rejects the key.
