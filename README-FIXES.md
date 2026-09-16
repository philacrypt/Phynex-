# PHYNEX marketplace fixes

## Latest update (Sep 2026, round 5) — real product reviews + delivery location dropdowns
Two separate fixes bundled together:

**1. Product reviews were fake — now they're real.**
The homepage's 5 static demo product cards showed hardcoded, made-up star
ratings (e.g. "★★★★★ (24)") that were never connected to any real
customer feedback. Meanwhile, the product popup's Reviews tab could
*display* real approved reviews, but there was no way for a customer to
actually submit one — the "Leave a review" flow didn't exist.

- Removed the fake star ratings from all 5 static homepage cards.
- The product popup's top rating badge no longer echoes stray leftover
  text (previously it sometimes showed the fake stars, sometimes "Sell by
  [seller]") — it now shows the real average rating (e.g. "★★★★☆ 4.2 (12
  reviews)") or "No reviews yet".
- Added a working star-picker + comment form inside the product popup's
  Reviews tab.
- Added a new endpoint, `POST /api/products/:id/reviews`, which:
  - requires the customer to be logged in,
  - only accepts the review if that customer has a **paid order
    containing that exact product** (a real verified-purchase check —
    this was one of the known gaps),
  - blocks a customer from reviewing the same product twice,
  - saves the review as `pending`, which flows into the existing admin
    Reviews tab for approval exactly like before.
- Two new columns were added to the `reviews` table (`customer_id`,
  `order_id`) via the existing safe `ensureColumn` migration, so no
  manual database changes are needed on deploy.
- **Note:** because this is tied to real paid orders, no reviews will
  appear on a fresh/low-traffic store until real customers with paid
  orders start submitting them — that's intentional, not a bug.

**2. Checkout delivery location was two free-text fields — now real dropdowns.**
`checkout.html`'s "County" and "Town or city" fields used to be plain
text inputs, so a customer could type anything (typos, made-up places,
inconsistent naming), which made delivery routing unreliable.

- Added `kenya-locations.js`, a new static file containing all 47 Kenya
  counties and their 295 sub-counties.
- `checkout.html` now shows a County dropdown and a Sub-county/Town
  dropdown that cascades from it, instead of free text. The delivery
  address free-text field (estate/street/landmark) was kept, since Kenya
  has no standard dataset below sub-county level.
- The dropdowns use the exact same field IDs (`deliveryCounty`,
  `deliveryLocation`) the existing checkout JS and backend already
  expected, so no other code needed to change.
- **Deploy note:** `kenya-locations.js` must be placed in the project
  root (same level as `checkout.html`/`script.js`) so Express's existing
  `express.static(__dirname)` can serve it.

## Previous update (Sep 2026, round 4) — product images now go to Cloudinary
Uploaded product images/videos are now uploaded straight to Cloudinary (a
free external image host) instead of being saved to local disk, so they
survive server restarts/redeploys no matter which host runs this app or
whether that host has a persistent disk attached.

- **Set up (required):** create a free account at cloudinary.com, then add
  three environment variables to your host (Render, Northflank, etc.):
  `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
  (all three are shown on your Cloudinary dashboard home page).
- **Without those variables set**, uploads automatically fall back to local
  disk under `PHYNEX_DATA_DIR/uploads` exactly like before — so nothing
  breaks if you haven't set up Cloudinary yet, but images will still
  disappear on restart unless `PHYNEX_DATA_DIR` is on a persistent disk.
- **This only affects newly-uploaded images from now on** — existing
  product images already saved under `/uploads/...` are untouched and will
  keep working as long as that folder still exists; they won't be migrated
  to Cloudinary automatically.
- No new npm dependency was added — this uses Cloudinary's plain HTTP
  upload API via `fetch`, which Node already provides.

## Previous update (Sep 2026, round 3) — checkout was never actually wired up
Before this update the backend (`server.js`) already had a fully working,
persistent order + M-PESA system: it saved every order to SQLite, reserved
and released stock, verified the Daraja callback, and let admins update
order status. **None of that was reachable from the storefront**, because
`checkout.html` had its own separate, self-contained demo `<script>` block
that never called the backend at all — it faked an order number with
`Date.now()`, read/wrote a fake cart, and never loaded `script.js`, which is
where the real M-PESA checkout logic already lived (`initCheckoutPayment`,
`pollPaymentStatus`, etc., all built to match `checkout.html`'s exact
element IDs). This is why the page said "Order submission is currently a
local demo."

- **`checkout.html` now loads `script.js`** instead of its own fake inline
  script, so "Pay with M-PESA" calls the real `/api/mpesa/stkpush`
  endpoint, polls `/api/mpesa/status/:checkoutRequestId`, and only shows
  the confirmation screen once the backend confirms the payment actually
  succeeded. The outdated "local demo" notice was removed.
- **Order confirmation email.** When the Daraja callback marks an order as
  paid, the customer is now emailed a receipt (order number, items,
  totals, delivery address) using the existing `EMAIL_HOST` / `EMAIL_USER`
  / `EMAIL_PASSWORD` configuration — no new environment variables needed.
  A duplicate-callback guard makes sure this email is only ever sent once
  per order.
- **Order status emails.** When an admin moves an order to
  `processing` / `shipped` / `delivered` / `cancelled` from the Orders
  tab in `admin.html`, the customer now gets a short status-update email
  too.
- **JSON-only error responses.** Previously, a malformed request body,
  an oversized payload, a request to a nonexistent `/api/...` endpoint,
  or an unexpected server error could fall through to Express's default
  HTML error page. Any of those would break `fetch(...).json()` calls on
  the front end with `Unexpected token '<' ... is not valid JSON`. All of
  these now return proper JSON with an appropriate status code instead.

## Previous update (Sep 2026, round 2)
- **Product images no longer disappear after a restart/redeploy.**
  Uploaded images/videos were being saved to a folder inside the app's own
  code directory (`__dirname/uploads`), which is wiped every time the
  server restarts or redeploys - even though the database (which still
  remembered the image's URL) was correctly saved to the persistent disk.
  Uploads are now saved under the same persistent directory as the
  database (`PHYNEX_DATA_DIR/uploads`), so they survive restarts and
  redeploys exactly like the database does. **No extra Render setup is
  needed beyond what's already below** - the existing persistent disk
  mounted at `/data` now holds both `phynex.db` and the `uploads` folder.
  If you're moving from the old version, copy any existing images from
  the app folder's `uploads/` directory into `/data/uploads/` once after
  deploying this update, or previously-uploaded images will still be
  missing (only newly-uploaded ones are protected automatically).
- **Seller/admin category dropdowns now match the store's real
  categories, so the AI auto-categorizer and manual category choices
  agree.** The "Add Product" category dropdown in `seller-dashboard.html`
  and `admin.html` used a hardcoded list of category names (e.g.
  "Laptops & Computers", "Gaming Consoles", "PC Gaming") that didn't
  match any of the real categories seeded in the database (e.g.
  "Computers & Laptops", "Gaming"). Since the auto-categorizer only
  overrides a seller's chosen category when it's very confident, most
  products kept whatever mismatched category the seller picked - a
  category that didn't exist anywhere else in the store, so the product
  never showed up on any category page or count. The seller dashboard's
  dropdown now loads its options live from `/api/categories`, and the
  admin dropdowns now use the live category list (with a corrected
  fallback list) instead of the old mismatched one.
  - **Existing products already saved with one of the old bogus category
    names will still need fixing.** Open each affected product in the
    admin panel and re-save it with a category from the corrected
    dropdown (or re-run the categorizer via
    `node scripts/backfill-categories.js --apply`, which re-scans every
    product's name/description and fixes categories it recognizes with
    high confidence).

## Previous update (Sep 2026)
- **Add to Cart / Buy Now fixed on the homepage.** Both buttons now use a single
  delegated click listener in `script.js` instead of inline `onclick="..."`
  attributes, so they keep working for the 5 static homepage cards, cards
  cloned into "New Arrivals", and any live marketplace product card - even if
  a browser extension or future template change would otherwise break inline
  handlers. `index.html` now loads `script.js?v=20260912` so browsers won't
  keep serving a cached, pre-fix copy - after deploying, do a hard refresh
  (Ctrl/Cmd+Shift+R) once to be sure you're on the new file.
- **AI auto-categorization added.** `lib/categorizer.js` is a fast, local
  keyword classifier (no external API key needed) that looks at a product's
  name/description/specifications and suggests the right store category.
  - A confident match (e.g. anything with "laptop", "macbook", etc.) always
    wins and routes the product to "Computers & Laptops -> Laptops",
    overriding a wrong category if needed.
  - A lower-confidence match only fills in a category the seller/admin left
    blank - it never overrides a deliberate choice for products that don't
    have to live in one specific category.
  - Wired into seller product submission, admin "add product," and admin
    "edit product."
  - `scripts/backfill-categories.js` re-scans every product already in the
    database and fixes/fills in categories. Run `node scripts/backfill-categories.js`
    for a dry-run report, then `node scripts/backfill-categories.js --apply`
    to save the changes.

## What was fixed
- Products are stored in a configurable persistent data directory. On Render, use a Persistent Disk mounted at `/data` and set `PHYNEX_DATA_DIR=/data`.
- Public product API always loads every approved product from SQLite; the homepage no longer limits seller listings to eight items.
- Checkout now uses the real database price and stock instead of trusting browser-supplied prices.
- Stock is reserved during an M-PESA checkout and released when payment fails/expires; paid orders deduct stock once.
- M-PESA callbacks can recover an order from SQLite after a server restart instead of relying only on in-memory payment data.
- Customer and seller login sessions expire after 7 days and login attempts are rate-limited.
- Password minimum is 8 characters.
- Admin-created categories are seeded with a broad marketplace category set and are available through `/api/categories`.
- The main site's category area and `categories.html` load categories from the admin-managed database.
- `category.html` now loads live approved products rather than a hard-coded product list.

## Render setup (required for products/orders to survive restarts)
1. Create/attach a Render Persistent Disk to the web service.
2. Mount it at `/data`.
3. Add environment variable `PHYNEX_DATA_DIR=/data`.
4. (Optional but recommended) Add `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`
   and `CLOUDINARY_API_SECRET` from a free cloudinary.com account, so
   product images survive even without a persistent disk.
5. Deploy.
6. Keep your existing M-PESA, email, Google and admin environment variables. Do not commit `.env`.

The delivered archive intentionally excludes the existing `.env` file because it can contain secrets.
