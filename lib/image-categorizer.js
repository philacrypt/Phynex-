/* =========================================================
   PHYNEX — AI IMAGE CATEGORIZER
   =========================================================
   Looks at an uploaded product PHOTO (not just the text the
   seller typed) and asks Claude's vision model which store
   category it belongs to.

   Design goals:
   - Never break product submission if this fails. Any missing
     API key, network error, bad response, or unsupported image
     type simply returns `{ available: false }` so the caller
     can fall back to the existing text-based categorizer
     (lib/categorizer.js) or plain manual category selection.
   - Never invent a category that doesn't exist in the store.
     The model is given the exact list of category names that
     are currently seeded/admin-managed in the database and is
     told to only choose from that list.
   - Always return a confidence score so the caller can decide
     whether to auto-assign the category or ask the seller to
     confirm it first.
   ========================================================= */

'use strict';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Small, fast, inexpensive vision model — appropriate for a
// simple "what kind of product is this" classification that
// runs on every product photo upload. Override with
// ANTHROPIC_MODEL in .env if you'd rather use a different model.
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// Anything at/above this is confident enough to auto-assign the
// category without bothering the seller.
const HIGH_CONFIDENCE_THRESHOLD = 0.75;

// Below this, the image genuinely didn't give the model enough
// to go on — treat it the same as "no suggestion" rather than
// asking the seller to confirm a near-random guess.
const LOW_CONFIDENCE_THRESHOLD = 0.35;

const SUPPORTED_MIME_TYPES = {
    'image/jpeg': true,
    'image/jpg': true,
    'image/png': true,
    'image/webp': true,
    'image/gif': true
};

function isSupportedImage(mimeType) {
    return !!SUPPORTED_MIME_TYPES[String(mimeType || '').toLowerCase()];
}

function clampConfidence(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(1, number));
}

/**
 * Pull the first {...} JSON object out of a model reply, tolerating
 * accidental markdown code fences or a stray sentence around it.
 */
function extractJson(text) {
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    try {
        return JSON.parse(candidate.slice(start, end + 1));
    } catch (error) {
        return null;
    }
}

/**
 * Ask Claude's vision model to classify a single product photo.
 *
 * @param {Object} options
 * @param {Buffer} options.buffer - raw image bytes
 * @param {string} options.mimeType - e.g. "image/jpeg"
 * @param {string[]} options.availableCategories - category names the
 *        suggestion must be chosen from (or left null/empty)
 * @param {string} [options.productName] - optional extra context, e.g.
 *        whatever name the seller has typed so far
 * @returns {Promise<Object>} always resolves (never throws) with:
 *        { available: false, reason } or
 *        { available: true, category, subcategory, confidence,
 *          needsConfirmation, reason }
 */
async function classifyProductImage(options) {
    const buffer = options && options.buffer;
    const mimeType = options && options.mimeType;
    const availableCategories = (options && options.availableCategories) || [];
    const productName = (options && options.productName) || '';

    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
        return { available: false, reason: 'AI image categorization is not configured (missing ANTHROPIC_API_KEY).' };
    }

    if (!buffer || !buffer.length) {
        return { available: false, reason: 'No image provided.' };
    }

    if (!isSupportedImage(mimeType)) {
        return { available: false, reason: 'Unsupported image type for AI categorization.' };
    }

    if (!availableCategories.length) {
        return { available: false, reason: 'No store categories configured yet.' };
    }

    const categoryList = availableCategories.join(', ');

    const prompt =
        'You are classifying a product photo for an online marketplace. ' +
        'Look at the image and decide which ONE store category it belongs to. ' +
        'You must choose the category name EXACTLY as written from this list, ' +
        'with no changes: [' + categoryList + ']. ' +
        (productName ? ('The seller entered this product name: "' + productName + '". ') : '') +
        'If a more specific subcategory is obvious (e.g. "Laptops" within a computers ' +
        'category), include it, otherwise leave subcategory as an empty string. ' +
        'Reply with ONLY a JSON object and nothing else (no markdown, no commentary), ' +
        'in exactly this shape: ' +
        '{"category":"<one item from the list>","subcategory":"<string or empty>",' +
        '"confidence":<number between 0 and 1>,"reason":"<a few words>"}. ' +
        'confidence should reflect how certain you are from the image alone: use a ' +
        'high value (0.8-1.0) only when the product type is visually unambiguous, ' +
        'a mid value (0.4-0.7) when it is a reasonable guess, and a low value ' +
        '(0-0.3) when the photo is unclear, generic, or could fit several categories.';

    let response;
    try {
        response = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
                max_tokens: 300,
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: mimeType,
                                    data: buffer.toString('base64')
                                }
                            },
                            { type: 'text', text: prompt }
                        ]
                    }
                ]
            })
        });
    } catch (error) {
        return { available: false, reason: 'Could not reach the AI categorization service.' };
    }

    if (!response.ok) {
        return { available: false, reason: 'AI categorization service returned an error (' + response.status + ').' };
    }

    let data;
    try {
        data = await response.json();
    } catch (error) {
        return { available: false, reason: 'AI categorization service returned an unreadable response.' };
    }

    const textBlock = Array.isArray(data.content)
        ? data.content.filter(function (block) { return block && block.type === 'text'; })
            .map(function (block) { return block.text; }).join('\n')
        : '';

    const parsed = extractJson(textBlock);

    if (!parsed || !parsed.category) {
        return { available: false, reason: 'AI categorization service returned an unexpected format.' };
    }

    const allowed = new Set(availableCategories.map(function (c) { return String(c || '').toLowerCase(); }));
    const matchedCategory = availableCategories.find(function (c) {
        return String(c).toLowerCase() === String(parsed.category).toLowerCase();
    });

    if (!matchedCategory || !allowed.has(String(parsed.category).toLowerCase())) {
        // The model picked something outside the allowed list - treat as
        // unusable rather than saving a category that doesn't exist.
        return { available: false, reason: 'AI suggested a category outside the current category list.' };
    }

    const confidence = clampConfidence(parsed.confidence);

    if (confidence < LOW_CONFIDENCE_THRESHOLD) {
        return { available: false, reason: 'AI was not confident enough to suggest a category from this image.' };
    }

    return {
        available: true,
        category: matchedCategory,
        subcategory: String(parsed.subcategory || '').trim(),
        confidence: confidence,
        needsConfirmation: confidence < HIGH_CONFIDENCE_THRESHOLD,
        reason: String(parsed.reason || '').trim()
    };
}

module.exports = {
    classifyProductImage,
    HIGH_CONFIDENCE_THRESHOLD,
    LOW_CONFIDENCE_THRESHOLD,
    isSupportedImage
};
