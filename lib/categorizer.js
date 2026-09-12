/* =========================================================
   PHYNEX — PRODUCT AUTO-CATEGORIZER
   =========================================================
   A small, dependency-free keyword classifier that looks at a
   product's name, description, specifications, brand and tags
   and suggests which store category (and, where useful,
   subcategory) it belongs in.

   Why keyword-based instead of calling an external AI/LLM API:
   - No extra API key, cost, or network dependency in the
     checkout-critical product-creation path.
   - Fully deterministic and instant — works offline and can't
     fail with a timeout or rate limit while a seller is saving
     a listing.
   - Easy for the PHYNEX team to extend: add words to a list,
     no prompt engineering required.

   This is intentionally conservative: it only overrides a
   product's category when it finds a confident keyword match.
   If nothing matches well, the seller's own category choice
   (or "Other") is left alone rather than guessing.
   ========================================================= */

'use strict';

/* Each rule: category name (must match a row in the categories
   table), an optional subcategory label, and keyword groups.
   "strong" keywords alone are enough to classify something.
   "supporting" keywords only count when combined with another
   supporting/strong hit, to avoid one-word false positives
   (e.g. "case" alone shouldn't mean "Phones & Tablets"). */
const RULES = [
    {
        category: 'Computers & Laptops',
        subcategory: 'Laptops',
        strong: [
            'laptop', 'laptops', 'macbook', 'macbook air', 'macbook pro',
            'chromebook', 'ultrabook', 'notebook computer', 'notebook pc',
            'gaming laptop', 'thinkpad', 'ideapad', 'zenbook', 'vivobook',
            'elitebook', 'probook', 'latitude laptop', 'inspiron'
        ],
        supporting: []
    },
    {
        category: 'Computers & Laptops',
        subcategory: 'Desktops & Monitors',
        strong: [
            'desktop computer', 'desktop pc', 'all-in-one pc', 'tower pc',
            'gaming pc', 'motherboard', 'graphics card', 'gpu', 'processor cpu'
        ],
        supporting: [
            'monitor', 'keyboard', 'computer mouse', 'ssd', 'hard drive',
            'ram', 'pc case', 'power supply', 'printer', 'scanner'
        ]
    },
    {
        category: 'Phones & Tablets',
        strong: [
            'smartphone', 'iphone', 'samsung galaxy', 'android phone',
            'ipad', 'tablet', 'phone case', 'screen protector'
        ],
        supporting: ['sim card', 'phone charger', 'power bank']
    },
    {
        category: 'Gaming',
        strong: [
            'playstation', 'ps5', 'ps4', 'xbox', 'nintendo switch',
            'gaming console', 'game controller', 'joystick', 'gaming headset',
            'video game'
        ],
        supporting: ['gamepad', 'gaming chair', 'gaming mouse']
    },
    {
        category: 'Electronics',
        strong: [
            'television', ' tv ', 'smart tv', 'bluetooth speaker', 'soundbar',
            'home theatre', 'headphones', 'earphones', 'earbuds', 'smartwatch',
            'drone', 'router', 'projector'
        ],
        supporting: ['charger', 'cable', 'adapter', 'battery pack']
    },
    {
        category: 'Cameras & Photography',
        strong: ['camera', 'dslr', 'mirrorless camera', 'gopro', 'camera lens', 'tripod'],
        supporting: ['memory card']
    },
    {
        category: 'Fashion',
        strong: [
            'shirt', 't-shirt', 'dress', 'jeans', 'jacket', 'hoodie',
            'trouser', 'trousers', 'skirt', 'suit', 'blazer', 'kitenge',
            'ankara', 'sweater'
        ],
        supporting: ['clothing', 'outfit']
    },
    {
        category: 'Shoes & Bags',
        strong: [
            'sneakers', 'sneaker', 'boots', 'sandals', 'heels', 'loafers',
            'handbag', 'backpack', 'wallet', 'suitcase', 'travel bag', 'clutch bag'
        ],
        supporting: ['shoe']
    },
    {
        category: 'Beauty & Personal Care',
        strong: [
            'makeup', 'lipstick', 'foundation cream', 'skincare', 'perfume',
            'shampoo', 'conditioner', 'lotion', 'sunscreen', 'nail polish',
            'hair extension', 'wig'
        ],
        supporting: ['cream', 'cosmetic']
    },
    {
        category: 'Home & Garden',
        strong: [
            'curtain', 'rug', 'carpet', 'wall decor', 'garden tool',
            'flower pot', 'lawn mower', 'bedding set', 'duvet'
        ],
        supporting: ['decor', 'pillow']
    },
    {
        category: 'Furniture',
        strong: [
            'sofa', 'couch', 'mattress', 'wardrobe', 'dining table',
            'office chair', 'bookshelf', 'coffee table', 'bed frame', 'cabinet'
        ],
        supporting: ['chair', 'table', 'shelf']
    },
    {
        category: 'Appliances',
        strong: [
            'refrigerator', 'fridge', 'microwave', 'blender', 'washing machine',
            'cooker', 'gas cooker', 'oven', 'kettle', 'iron box', 'air conditioner',
            'water dispenser', 'vacuum cleaner', 'toaster'
        ],
        supporting: ['fan']
    },
    {
        category: 'Grocery',
        strong: [
            'rice', 'cooking oil', 'sugar', 'wheat flour', 'maize flour',
            'beverage', 'snack pack', 'bottled water', 'tea leaves', 'coffee beans'
        ],
        supporting: []
    },
    {
        category: 'Health & Wellness',
        strong: [
            'vitamin', 'supplement', 'thermometer', 'first aid kit',
            'face mask', 'blood pressure monitor', 'wellness'
        ],
        supporting: []
    },
    {
        category: 'Baby & Kids',
        strong: [
            'diaper', 'diapers', 'baby stroller', 'baby crib', 'baby food',
            'kids toy', 'toy car', 'baby carrier', 'feeding bottle'
        ],
        supporting: ['toy']
    },
    {
        category: 'Sports & Outdoors',
        strong: [
            'football', 'basketball', 'gym equipment', 'treadmill', 'tent',
            'bicycle', 'dumbbell', 'yoga mat', 'camping gear', 'fishing rod'
        ],
        supporting: []
    },
    {
        category: 'Automotive',
        strong: [
            'car tyre', 'car tire', 'engine oil', 'car battery', 'motorcycle',
            'car spare part', 'car accessory', 'helmet', 'brake pad', 'car seat cover'
        ],
        supporting: []
    },
    {
        category: 'Books & Stationery',
        strong: [
            'textbook', 'novel', 'exercise book', 'story book', 'stationery',
            'ballpoint pen', 'ream of paper'
        ],
        supporting: ['pen', 'pencil']
    },
    {
        category: 'Jewelry & Watches',
        strong: [
            'necklace', 'bracelet', 'earrings', 'pendant', 'wrist watch',
            'wristwatch', 'gold ring', 'silver ring'
        ],
        supporting: ['ring', 'watch']
    },
    {
        category: 'Pet Supplies',
        strong: ['dog food', 'cat food', 'pet leash', 'pet collar', 'aquarium', 'pet cage'],
        supporting: ['pet']
    },
    {
        category: 'Industrial & Tools',
        strong: [
            'power drill', 'hammer drill', 'wrench set', 'toolbox', 'generator',
            'welding machine', 'angle grinder', 'tool set'
        ],
        supporting: ['toolkit']
    },
    {
        category: 'Services',
        strong: [
            'repair service', 'installation service', 'cleaning service',
            'consultation service', 'delivery service'
        ],
        supporting: []
    }
];

function normalize(text) {
    return ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ').trim() + ' ';
}

function countHits(haystack, words) {
    let hits = 0;
    for (const word of words) {
        if (haystack.indexOf(word.toLowerCase()) !== -1) hits++;
    }
    return hits;
}

/**
 * Suggest a category/subcategory for a product.
 *
 * @param {Object} product - { name, description, specifications, brand, tags }
 * @param {string[]} availableCategories - category names that currently
 *        exist in the store (e.g. from the categories table). The
 *        suggestion is only returned if it is one of these, so a
 *        custom/renamed category set never gets an invalid value.
 * @returns {{category:string, subcategory:string, confidence:number}|null}
 */
function suggestCategory(product, availableCategories) {

    const haystackStrong = normalize(
        [product.name, product.specifications, product.brand].filter(Boolean).join(' ')
    );

    const haystackAll = normalize(
        [product.name, product.description, product.specifications, product.brand, product.tags]
            .filter(Boolean)
            .join(' ')
    );

    const allowed = Array.isArray(availableCategories)
        ? new Set(availableCategories.map(function (c) { return String(c || '').toLowerCase(); }))
        : null;

    let best = null;

    for (const rule of RULES) {

        if (allowed && !allowed.has(rule.category.toLowerCase())) continue;

        const strongHitsInName = countHits(haystackStrong, rule.strong);
        const strongHitsAnywhere = countHits(haystackAll, rule.strong);
        const supportingHits = countHits(haystackAll, rule.supporting || []);

        let score = 0;

        // A strong keyword found in the product name/specs/brand is the
        // most reliable signal (this is what makes "laptop" in a title
        // reliably win the "Computers & Laptops" category).
        if (strongHitsInName > 0) score += strongHitsInName * 3;
        else if (strongHitsAnywhere > 0) score += strongHitsAnywhere * 2;

        if (supportingHits > 1) score += supportingHits; // need 2+ supporting words

        if (score === 0) continue;

        if (!best || score > best.score) {
            best = {
                category: rule.category,
                subcategory: rule.subcategory || '',
                score: score
            };
        }
    }

    if (!best) return null;

    return {
        category: best.category,
        subcategory: best.subcategory,
        confidence: best.score >= 3 ? 'high' : 'medium'
    };
}

module.exports = { suggestCategory };
