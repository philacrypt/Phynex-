/* =========================================================
   PHYNEX — ONE-TIME CATEGORY BACKFILL
   =========================================================
   Re-runs the auto-categorizer against every existing product
   already in the database (e.g. products added before the
   auto-categorizer existed, or ones sitting in the wrong
   category). Only changes a product when the classifier finds
   a match:
     - high confidence  -> always applied (e.g. "laptop")
     - medium confidence -> only applied if the product's
       current category is empty/"Other"

   USAGE
     node scripts/backfill-categories.js            (dry run - report only)
     node scripts/backfill-categories.js --apply     (writes the changes)

   Reads the same database file/location the running server
   uses (PHYNEX_DATA_DIR, defaulting to the project folder).
   ========================================================= */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { suggestCategory } = require('../lib/categorizer');

const DATA_DIR = process.env.PHYNEX_DATA_DIR || path.join(__dirname, '..');
const db = new Database(path.join(DATA_DIR, 'phynex.db'));

const apply = process.argv.includes('--apply');

const categoryNames = db.prepare('SELECT name FROM categories').all().map(function (row) { return row.name; });

const products = db.prepare('SELECT * FROM products').all();

const update = db.prepare('UPDATE products SET category = ?, subcategory = ? WHERE id = ?');

let changed = 0;

console.log(
    apply
        ? 'Applying category backfill to ' + products.length + ' products...\n'
        : 'DRY RUN over ' + products.length + ' products (pass --apply to save changes)\n'
);

for (const product of products) {

    const currentCategory = String(product.category || '').trim();

    const suggestion = suggestCategory(
        {
            name: product.name,
            description: product.description,
            specifications: product.specifications,
            brand: product.brand,
            tags: product.tags
        },
        categoryNames
    );

    if (!suggestion) continue;

    const shouldApply =
        suggestion.confidence === 'high' ||
        !currentCategory ||
        currentCategory.toLowerCase() === 'other';

    if (!shouldApply || suggestion.category === currentCategory) continue;

    changed++;

    console.log(
        '#' + product.id + ' "' + product.name + '": ' +
        '"' + (currentCategory || '(none)') + '" -> "' + suggestion.category + '"' +
        (suggestion.subcategory ? ' / ' + suggestion.subcategory : '') +
        ' [' + suggestion.confidence + ']'
    );

    if (apply) {
        update.run(suggestion.category, suggestion.subcategory || product.subcategory || '', product.id);
    }
}

console.log(
    '\n' + changed + ' product(s) ' + (apply ? 'updated.' : 'would be updated. Re-run with --apply to save.')
);
