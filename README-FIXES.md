# PHYNEX marketplace fixes

## Latest update (Sep 2026) — AI image-based auto-categorization
- **Sellers no longer have to pick a category by hand.** As soon as a
  seller attaches a product photo in the "Add product" form
  (`seller-dashboard.html`), the photo is sent to a new endpoint,
  `POST /api/seller/categorize-image`, which uses Claude's vision
  model (`lib/image-categorizer.js`) to identify the product and
  suggest the matching store category (e.g. a laptop photo →
  "Computers & Laptops", a dress → "Fashion", shoes → "Shoes & Bags",
  a sofa → "Furniture", packaged food → "Grocery").
- **Confidence check.** Every suggestion comes back with a confidence
  score:
  - High confidence → the category is filled in automatically; the
    seller can still click "Not right? Choose a different category"
    to override it.
  - Medium confidence → the seller is asked "Is this **<category>**?"
    with Yes/Confirm or No/pick-manually buttons, so a low-confidence
    guess never gets saved without a human checking it.
  - No image, an unclear photo, or the AI service unavailable/not
    configured → the category dropdown (now populated from the same
    live category list used everywhere else on the site) is shown so
    the seller can pick manually, exactly like before this feature
    existed.
- **Nothing breaks without an API key.** Set `ANTHROPIC_API_KEY` in
  `.env` to turn this on. Without it, `classifyProductImage()` returns
  `{ available: false }` immediately and the site behaves exactly as
  it did before — product submission, the existing keyword-based
  `lib/categorizer.js` fallback, and admin add/edit product all work
  unchanged.
- The final safety net is unchanged: `applyAutoCategory()` in
  `server.js` still runs the text-based keyword categorizer as a
  fallback, and only trusts the AI's image-based category when the
  seller confirmed it or the AI was confident *and* the category is
  one that actually exists in the store's category list.

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
