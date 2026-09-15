# PHYNEX marketplace fixes

## Latest update (Sep 2026, round 2)
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
4. Deploy.
5. Keep your existing M-PESA, email, Google and admin environment variables. Do not commit `.env`.

The delivered archive intentionally excludes the existing `.env` file because it can contain secrets.
