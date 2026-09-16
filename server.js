const express = require("express");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const { OAuth2Client } = require("google-auth-library");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT) || 3000;

// Express 4 does NOT forward a rejected promise from an async route
// handler to error-handling middleware automatically — an exception
// thrown inside an `async function (request, response) { ... }` route
// just becomes an unhandled rejection and the request hangs with no
// response ever sent. From the browser that looks exactly like a
// connection failure ("Network error"), even though the server is fine
// and the real problem is a bug in that one route. Wrapping every async
// route in this makes sure such errors reach the JSON error handler
// below instead of hanging the request.
function asyncHandler(fn) {
    return function (request, response, next) {
        Promise.resolve(fn(request, response, next)).catch(next);
    };
}

const payments = new Map();

app.disable("x-powered-by");

app.use(function (request, response, next) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    next();
});

// PHYNEX is normally same-origin. If an API consumer is hosted on a
// separate origin, list only those trusted origins in ALLOWED_ORIGINS.
app.use(function (request, response, next) {
    const origin = request.headers.origin;
    const allowed = String(process.env.ALLOWED_ORIGINS || "")
        .split(",").map(function (item) { return item.trim(); }).filter(Boolean);

    if (!origin || allowed.length === 0) return next();
    if (!allowed.includes(origin)) {
        return response.status(403).json({ message: "Origin is not allowed." });
    }

    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

    if (request.method === "OPTIONS") return response.sendStatus(204);
    next();
});

app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

// Explicit fallback routes for the category pages. express.static above
// should already serve these, but some hosts/build steps can be picky
// about which top-level files get deployed, so this guarantees the
// pages that "Shop now" / category taps link to always resolve instead
// of returning "Cannot GET".
app.get("/category.html", function (request, response) {
    response.sendFile(path.join(__dirname, "category.html"));
});

app.get("/categories.html", function (request, response) {
    response.sendFile(path.join(__dirname, "categories.html"));
});

/* =========================
   DATABASE
========================= */

const db = new Database(path.join(__dirname, "phynex.db"));
db.pragma("journal_mode = WAL");

db.exec(`
    CREATE TABLE IF NOT EXISTS sellers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        phone TEXT,
        password_hash TEXT NOT NULL,
        token TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        specifications TEXT,
        price INTEGER NOT NULL,
        old_price INTEGER,
        category TEXT,
        image TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        sponsored INTEGER NOT NULL DEFAULT 0,
        rejection_reason TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (seller_id) REFERENCES sellers(id)
    );

    CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        phone TEXT,
        password_hash TEXT NOT NULL,
        token TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number TEXT NOT NULL UNIQUE,
        customer_id INTEGER,
        customer_name TEXT,
        customer_email TEXT,
        customer_phone TEXT,
        county TEXT,
        location TEXT,
        address TEXT,
        instructions TEXT,
        subtotal INTEGER NOT NULL DEFAULT 0,
        delivery_fee INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        payment_method TEXT NOT NULL DEFAULT 'mpesa',
        payment_status TEXT NOT NULL DEFAULT 'pending',
        status TEXT NOT NULL DEFAULT 'pending',
        checkout_request_id TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        product_id INTEGER,
        seller_id INTEGER,
        name TEXT,
        image TEXT,
        price INTEGER NOT NULL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        slug TEXT,
        description TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT,
        value TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        product_name TEXT,
        customer_name TEXT,
        rating INTEGER,
        comment TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        description TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_type TEXT NOT NULL,
        user_id INTEGER,
        name TEXT,
        email TEXT,
        action TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blog_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        image_url TEXT,
        video_url TEXT,
        customer_id INTEGER,
        author_name TEXT,
        created_at INTEGER NOT NULL
    );
`);

/* =========================
   MIGRATIONS (safe to re-run)
========================= */

function ensureColumn(table, column, definition) {
    const columns = db.prepare("PRAGMA table_info(" + table + ")").all();
    const hasColumn = columns.some(function (col) { return col.name === column; });

    if (!hasColumn) {
        db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition);
        return true; // column was just added by this run
    }
    return false;
}

ensureColumn("products", "media", "TEXT");
ensureColumn("products", "tracking_code", "TEXT");
ensureColumn("products", "stock", "INTEGER DEFAULT 0");
ensureColumn("products", "low_stock_threshold", "INTEGER DEFAULT 5");
ensureColumn("products", "sku", "TEXT");
ensureColumn("products", "brand", "TEXT");
ensureColumn("products", "subcategory", "TEXT");
ensureColumn("products", "condition_label", "TEXT");
ensureColumn("products", "warranty", "TEXT");
ensureColumn("products", "tags", "TEXT");
ensureColumn("products", "featured", "INTEGER DEFAULT 0");

ensureColumn("sellers", "status", "TEXT DEFAULT 'approved'");
ensureColumn("sellers", "whatsapp", "TEXT");

ensureColumn("orders", "stock_deducted", "INTEGER DEFAULT 0");

ensureColumn("customers", "google_id", "TEXT");
ensureColumn("customers", "reset_token", "TEXT");
ensureColumn("customers", "reset_token_expires", "INTEGER");

// Customer authentication additions: email verification, phone OTP
// verification and HttpOnly session cookies. Safe to re-run on every
// startup; ensureColumn() is a no-op once a column already exists.
const emailVerifiedColumnIsNew = ensureColumn("customers", "email_verified_at", "INTEGER");
ensureColumn("customers", "email_verification_token_hash", "TEXT");
ensureColumn("customers", "email_verification_expires", "INTEGER");
ensureColumn("customers", "phone_verified_at", "INTEGER");
ensureColumn("customers", "phone_verification_code_hash", "TEXT");
ensureColumn("customers", "phone_verification_expires", "INTEGER");
ensureColumn("customers", "phone_verification_attempts", "INTEGER DEFAULT 0");
ensureColumn("customers", "session_token_hash", "TEXT");
ensureColumn("customers", "session_expires", "INTEGER");

// One-time backfill: this is the first startup after email verification was
// added, so accounts that already existed (and could already log in under
// the old system) are grandfathered in as email-verified. Without this,
// every pre-existing customer would be locked out on the next deploy.
if (emailVerifiedColumnIsNew) {
    db.prepare(
        "UPDATE customers SET email_verified_at = created_at WHERE email_verified_at IS NULL"
    ).run();
}

ensureColumn("reviews", "customer_id", "INTEGER");

// SPEED: the schema had no indexes at all, so every filtered lookup below
// was a full table scan. These back the exact WHERE/JOIN/ORDER BY columns
// used throughout the routes above and below. Safe to re-run on startup.
db.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_status_created ON products(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
    CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id);
    CREATE INDEX IF NOT EXISTS idx_products_sponsored ON products(sponsored);
    CREATE INDEX IF NOT EXISTS idx_products_tracking_code ON products(tracking_code);
    CREATE INDEX IF NOT EXISTS idx_reviews_product_status ON reviews(product_id, status);
    CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_checkout_request ON orders(checkout_request_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
`);

// Seed a broad, ready-to-use set of categories the first time the store
// runs (covers more than just tech so the marketplace isn't tech-only).
// This only runs once — if the admin has already added/removed categories,
// we leave their list alone.
(function seedDefaultCategories() {
    const count = db.prepare("SELECT COUNT(*) AS c FROM categories").get().c;
    if (count > 0) return;

    const defaults = [
        ["Phones & Tablets", "Mobile phones, tablets and accessories."],
        ["Computers & Laptops", "Desktops, laptops, monitors and computer parts."],
        ["Electronics", "TVs, audio, cameras and general electronics."],
        ["Gaming", "Consoles, games and gaming accessories."],
        ["Fashion & Clothing", "Men's, women's and kids' clothing."],
        ["Shoes & Footwear", "Sneakers, official shoes, sandals and boots."],
        ["Beauty & Personal Care", "Skincare, makeup, haircare and grooming."],
        ["Health & Wellness", "Supplements, fitness and wellness products."],
        ["Home & Living", "Furniture, decor, bedding and storage."],
        ["Kitchen & Appliances", "Cookware, small appliances and kitchen tools."],
        ["Groceries & Food", "Packaged foods, snacks and household groceries."],
        ["Baby & Kids", "Baby gear, toys and kids' essentials."],
        ["Toys & Games", "Toys, board games and hobby items."],
        ["Sports & Outdoors", "Fitness gear, camping and outdoor equipment."],
        ["Automotive", "Car accessories, parts and tools."],
        ["Books & Stationery", "Books, office and school supplies."],
        ["Jewelry & Watches", "Jewelry, watches and fashion accessories."],
        ["Pet Supplies", "Food, toys and accessories for pets."],
        ["Garden & Outdoor Living", "Garden tools, plants and outdoor furniture."],
        ["Other", "Anything that doesn't fit another category."]
    ];

    const insert = db.prepare(
        "INSERT INTO categories (name, slug, description, created_at) VALUES (?, ?, ?, ?)"
    );

    const now = Date.now();

    defaults.forEach(function (entry) {
        const name = entry[0];
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        try {
            insert.run(name, slug, entry[1], now);
        } catch (error) {
            // Ignore duplicates — safe to re-run.
        }
    });
})();

// Turn the old static "Flash Deals" showcase cards (which used to be
// hardcoded, non-purchasable HTML) into real, approved products owned
// by an official PHYNEX store account. This makes them behave exactly
// like any seller's product: real id, real stock, real checkout/order
// records, and eligible for real customer reviews. Runs once — if this
// store account already exists we leave everything alone.
(function seedFlashDealProducts() {

    const STORE_EMAIL = "store@phynextech.co.ke";

    let store = db.prepare("SELECT * FROM sellers WHERE email = ?").get(STORE_EMAIL);

    if (!store) {
        const passwordHash = bcrypt.hashSync(crypto.randomBytes(24).toString("hex"), 10);
        const result = db
            .prepare(
                `INSERT INTO sellers (business_name, email, phone, password_hash, status, created_at)
                 VALUES (?, ?, ?, ?, 'approved', ?)`
            )
            .run("PHYNEX Official Store", STORE_EMAIL, "", passwordHash, Date.now());
        store = db.prepare("SELECT * FROM sellers WHERE id = ?").get(result.lastInsertRowid);
    }

    const existingCount = db
        .prepare("SELECT COUNT(*) AS c FROM products WHERE seller_id = ?")
        .get(store.id).c;

    if (existingCount > 0) return;

    const items = [
        {
            name: "Dell Vostro 15 3500 i7 11th Gen 8GB 400GB SSD",
            description: "A dependable Dell laptop for work, study and everyday productivity.",
            specifications: "Intel Core i7 11th Gen | 8GB RAM | 400GB SSD",
            price: 35000,
            oldPrice: 40000,
            category: "Computers & Laptops",
            image: "images/13.jpeg",
            stock: 6
        },
        {
            name: "HP EliteDesk 830 G5 i5 8th Gen 8GB 256GB SSD",
            description: "A professionally refurbished HP desktop with responsive performance for office and home use.",
            specifications: "Intel Core i5 8th Gen | 8GB RAM | 256GB SSD",
            price: 32500,
            oldPrice: 36000,
            category: "Computers & Laptops",
            image: "images/18.jpeg",
            stock: 5
        },
        {
            name: "BT Speaker HF226",
            description: "A portable Bluetooth speaker with clear sound for music, calls and everyday entertainment.",
            specifications: "Bluetooth wireless audio | Portable design | Rechargeable battery",
            price: 2000,
            oldPrice: 2500,
            category: "Electronics",
            image: "images/19.jpeg",
            stock: 20
        },
        {
            name: "MacBook Air i5 2017 256GB SSD 8GB RAM",
            description: "A compact MacBook with a sharp display and reliable performance for everyday computing.",
            specifications: "Intel Core i5 | 8GB RAM | 256GB SSD",
            price: 20500,
            oldPrice: 35000,
            category: "Computers & Laptops",
            image: "images/17.jpeg",
            stock: 4
        },
        {
            name: "Lenovo Thinkpad T460 256GB SSD 8GB RAM",
            description: "A durable Lenovo ThinkPad with a comfortable keyboard and fast SSD storage for work on the go.",
            specifications: "Intel Core i5 | 8GB RAM | 256GB SSD",
            price: 23000,
            oldPrice: 25000,
            category: "Computers & Laptops",
            image: "images/20.jpeg",
            stock: 7
        }
    ];

    const insertProduct = db.prepare(
        `INSERT INTO products
            (seller_id, name, description, specifications, price, old_price, category, image, media, status, sponsored, tracking_code, stock, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 0, ?, ?, ?)`
    );

    const now = Date.now();

    items.forEach(function (item, index) {
        const media = JSON.stringify([{ url: item.image, type: "image" }]);
        const trackingCode = generateTrackingCode();
        insertProduct.run(
            store.id, item.name, item.description, item.specifications,
            item.price, item.oldPrice, item.category, item.image, media,
            trackingCode, item.stock, now - (items.length - index)
        );
    });
})();

/* =========================
   LOGIN RATE LIMITING (brute-force protection)
   Tracks failed sign-in attempts per IP + account identifier. After too
   many failures in a short window, further attempts are blocked for a
   cooldown period. Successful logins reset the counter.
========================= */

const LOGIN_MAX_ATTEMPTS = 6;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const loginAttempts = new Map(); // key -> { count, firstAttempt, lockedUntil }

const SENSITIVE_ACTION_WINDOW_MS = 15 * 60 * 1000;
const sensitiveActionAttempts = new Map();

function sensitiveActionRateLimited(request, action) {
    const key = action + ":" + request.ip;
    const now = Date.now();
    const entry = sensitiveActionAttempts.get(key);

    if (!entry || now - entry.windowStart > SENSITIVE_ACTION_WINDOW_MS) {
        sensitiveActionAttempts.set(key, { windowStart: now, count: 1 });
        return false;
    }

    entry.count += 1;
    return entry.count > 10;
}

function loginRateLimitKey(request, identifier) {
    return request.ip + ":" + String(identifier || "").toLowerCase();
}

function checkLoginRateLimit(request, identifier) {
    const key = loginRateLimitKey(request, identifier);
    const entry = loginAttempts.get(key);

    if (!entry) return null;

    if (entry.lockedUntil && entry.lockedUntil > Date.now()) {
        const minutesLeft = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
        return "Too many failed sign-in attempts. Please try again in " + minutesLeft + " minute" + (minutesLeft === 1 ? "" : "s") + ".";
    }

    if (entry.lockedUntil && entry.lockedUntil <= Date.now()) {
        loginAttempts.delete(key);
    }

    return null;
}

function recordLoginFailure(request, identifier) {
    const key = loginRateLimitKey(request, identifier);
    const now = Date.now();
    const entry = loginAttempts.get(key) || { count: 0, firstAttempt: now };

    if (now - entry.firstAttempt > LOGIN_WINDOW_MS) {
        entry.count = 0;
        entry.firstAttempt = now;
    }

    entry.count += 1;

    if (entry.count >= LOGIN_MAX_ATTEMPTS) {
        entry.lockedUntil = now + LOGIN_WINDOW_MS;
    }

    loginAttempts.set(key, entry);
}

function clearLoginFailures(request, identifier) {
    loginAttempts.delete(loginRateLimitKey(request, identifier));
}

/* =========================
   SMALL HELPERS
========================= */

function newToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString("hex");
}

function hashToken(token) {
    return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function parseCookies(request) {
    const header = request.headers.cookie || "";
    const cookies = {};
    header.split(";").forEach(function (part) {
        const index = part.indexOf("=");
        if (index === -1) return;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (key) cookies[key] = decodeURIComponent(value);
    });
    return cookies;
}

function setCustomerSession(response, customerId) {
    const rawToken = newToken(32);
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    db.prepare("UPDATE customers SET session_token_hash = ?, session_expires = ?, token = NULL WHERE id = ?")
        .run(hashToken(rawToken), Date.now() + maxAge, customerId);

    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    response.setHeader(
        "Set-Cookie",
        "phynex_session=" + encodeURIComponent(rawToken) +
        "; Max-Age=" + Math.floor(maxAge / 1000) +
        "; Path=/; HttpOnly; SameSite=Lax" + secure
    );
    return rawToken;
}

function clearCustomerSession(response, customerId) {
    if (customerId) {
        db.prepare("UPDATE customers SET session_token_hash = NULL, session_expires = NULL, token = NULL WHERE id = ?")
            .run(customerId);
    }
    response.setHeader(
        "Set-Cookie",
        "phynex_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax"
    );
}

function normalizeKenyanPhone(value) {
    const digits = String(value || "").replace(/\D/g, "");

    // Kenyan 10-digit mobile/service ranges currently supported by PHYNEX.
    // 07x covers the common mobile operator ranges; 010/011 cover the
    // common 01x mobile ranges requested by the store.
    if (/^0[7][0-9]\d{7}$/.test(digits)) return "+254" + digits.slice(1);
    if (/^01[01]\d{7}$/.test(digits)) return "+254" + digits.slice(1);
    if (/^2547[0-9]\d{8}$/.test(digits)) return "+" + digits;
    if (/^25401[01]\d{7}$/.test(digits)) return "+" + digits;
    return null;
}

function isPlausibleEmail(email) {
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,63}$/.test(email)) return false;
    const lower = email.toLowerCase();
    const blocked = new Set([
        "test@test.com", "fake@email.com", "abc@abc.com",
        "test@example.com", "user@example.com", "name@example.com",
        "example@example.com", "test@example.org", "test@example.net"
    ]);
    if (blocked.has(lower)) return false;
    const [local, domain] = lower.split("@");
    if (!local || !domain || local.length > 64) return false;
    if (/^(test|fake|dummy|random|asdf|abc)([0-9._-]*)$/.test(local)) return false;
    if (/^(example|invalid|localhost|test)$/i.test(domain.split(".")[0])) return false;
    return true;
}

function passwordIsStrong(password) {
    return typeof password === "string" &&
        password.length >= 8 &&
        password.length <= 128 &&
        /[A-Za-z]/.test(password) &&
        /\d/.test(password);
}

function emailVerificationConfigured() {
    return Boolean(mailTransporter && process.env.APP_URL);
}

function smsVerificationConfigured() {
    return Boolean(process.env.AT_USERNAME && process.env.AT_API_KEY && process.env.AT_SENDER_ID);
}

async function sendSms(phone, message) {
    const body = new URLSearchParams({
        username: process.env.AT_USERNAME,
        to: phone,
        message: message,
        from: process.env.AT_SENDER_ID
    });

    const response = await fetch(
        process.env.AT_SMS_URL || "https://api.africastalking.com/version1/messaging",
        {
            method: "POST",
            headers: {
                "apiKey": process.env.AT_API_KEY,
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json"
            },
            body: body.toString()
        }
    );

    if (!response.ok) {
        throw new Error("SMS provider returned HTTP " + response.status);
    }

    return response.json();
}

function generateTrackingCode() {
    let code;
    let attempts = 0;

    do {
        code = String(Math.floor(1000 + Math.random() * 9000)); // 1000-9999
        attempts++;
    } while (
        attempts < 20 &&
        db.prepare("SELECT id FROM products WHERE tracking_code = ?").get(code)
    );

    return code;
}

function generateOrderNumber() {
    return "PHX-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function logActivity(action, description) {
    try {
        db.prepare(
            "INSERT INTO activity_log (action, description, created_at) VALUES (?, ?, ?)"
        ).run(action, description || "", Date.now());
    } catch (error) {
        // Activity logging must never break the request that triggered it.
        console.error("Activity log failed:", error.message);
    }
}

// Records every login/logout so the admin can see who has been
// coming and going, and when. Never allowed to break the request
// that triggered it.
function logLogin(userType, user, action) {
    try {
        db.prepare(
            `INSERT INTO login_log (user_type, user_id, name, email, action, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
            userType,
            user ? user.id : null,
            user ? (user.business_name || user.name || "") : "",
            user ? user.email : "",
            action,
            Date.now()
        );
    } catch (error) {
        console.error("Login log failed:", error.message);
    }
}

// Admin-added products still need a seller_id (the column is NOT NULL),
// so we lazily create one internal "PHYNEX" system seller account and
// attach every admin-created product to it.
function ensureSystemSeller() {
    const existing = db
        .prepare("SELECT * FROM sellers WHERE email = ?")
        .get("admin@phynex.internal");

    if (existing) return existing;

    const passwordHash = crypto.randomBytes(24).toString("hex"); // unusable login, admin never logs in as this account

    const result = db
        .prepare(
            `INSERT INTO sellers (business_name, email, phone, password_hash, token, status, created_at)
             VALUES (?, ?, ?, ?, NULL, 'approved', ?)`
        )
        .run("PHYNEX", "admin@phynex.internal", "", passwordHash, Date.now());

    return db.prepare("SELECT * FROM sellers WHERE id = ?").get(result.lastInsertRowid);
}

const DEFAULT_SETTINGS = {
    storeName: "PHYNEX",
    supportEmail: "",
    supportPhone: "",
    description: "",
    currency: "KES (KSh)",
    deliveryFee: 300,
    lowStockThreshold: 5,
    sellerListings: true,
    requireApproval: true,
    showGaming: true,
    showNew: true,
    showSponsored: true,
    announcement: ""
};

function getSettings() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'store'").get();

    if (!row) return Object.assign({}, DEFAULT_SETTINGS);

    try {
        return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(row.value));
    } catch (error) {
        return Object.assign({}, DEFAULT_SETTINGS);
    }
}

function saveSettings(partial) {
    const merged = Object.assign({}, getSettings(), partial);

    db.prepare(
        `INSERT INTO settings (key, value) VALUES ('store', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(JSON.stringify(merged));

    return merged;
}

function publicSeller(seller) {
    return {
        id: seller.id,
        businessName: seller.business_name,
        email: seller.email,
        phone: seller.phone,
        whatsapp: seller.whatsapp || seller.phone || "",
        status: seller.status || "approved"
    };
}

function publicCustomer(customer) {
    return {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        emailVerified: Boolean(customer.email_verified_at),
        phoneVerified: Boolean(customer.phone_verified_at),
        hasGoogle: Boolean(customer.google_id)
    };
}

function googleConfigured() {
    return Boolean(process.env.GOOGLE_CLIENT_ID);
}

const googleClient = googleConfigured() ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

// Real rating/review count for a product, computed from actual
// customer-submitted, admin-approved reviews. No made-up numbers.
//
// SPEED: when listing many products, pass a pre-batched ratingsMap (see
// getRatingSummariesMap/publicProductList below) instead of letting this
// run one extra query per product — that turns an N-product listing from
// 1 + N queries into just 2.
function getRatingSummary(productId, ratingsMap) {
    if (ratingsMap) {
        return ratingsMap.get(productId) || { average: null, count: 0 };
    }

    const row = db
        .prepare(
            "SELECT COUNT(*) AS count, AVG(rating) AS average FROM reviews WHERE product_id = ? AND status = 'approved'"
        )
        .get(productId);

    return {
        average: row.count > 0 ? Math.round(row.average * 10) / 10 : null,
        count: row.count || 0
    };
}

// One query for every product in a list, instead of one query per product.
function getRatingSummariesMap(productIds) {
    const map = new Map();
    const uniqueIds = Array.from(new Set(productIds.filter(function (id) { return id != null; })));
    if (uniqueIds.length === 0) return map;

    const placeholders = uniqueIds.map(function () { return "?"; }).join(",");
    const rows = db
        .prepare(
            `SELECT product_id, COUNT(*) AS count, AVG(rating) AS average
             FROM reviews
             WHERE status = 'approved' AND product_id IN (${placeholders})
             GROUP BY product_id`
        )
        .all(...uniqueIds);

    rows.forEach(function (row) {
        map.set(row.product_id, {
            average: row.count > 0 ? Math.round(row.average * 10) / 10 : null,
            count: row.count || 0
        });
    });

    return map;
}

// Use this instead of `.map(publicProduct)` for any list of products.
function publicProductList(rows, extra) {
    const ratingsMap = getRatingSummariesMap(rows.map(function (row) { return row.id; }));
    return rows.map(function (row) {
        const mapped = publicProduct(row, ratingsMap);
        return extra ? extra(mapped, row) : mapped;
    });
}

function publicProduct(product, ratingsMap) {

    var media = [];

    if (product.media) {
        try {
            media = JSON.parse(product.media) || [];
        } catch (error) {
            media = [];
        }
    }

    // Backwards compatibility: older rows only have a single
    // "image" column and no media array yet.
    if (media.length === 0 && product.image) {
        media = [{ url: product.image, type: "image" }];
    }

    const ratingSummary = getRatingSummary(product.id, ratingsMap);

    return {
        id: product.id,
        rating: ratingSummary.average,
        reviewCount: ratingSummary.count,
        sellerId: product.seller_id,
        sellerName: product.business_name || undefined,
        sellerPhone: product.seller_phone || undefined,
        sellerWhatsapp: product.seller_whatsapp || product.seller_phone || undefined,
        name: product.name,
        description: product.description || "",
        specifications: product.specifications || "",
        price: product.price,
        oldPrice: product.old_price || null,
        category: product.category || "",
        brand: product.brand || "",
        subcategory: product.subcategory || "",
        condition: product.condition_label || "",
        warranty: product.warranty || "",
        tags: product.tags || "",
        featured: Boolean(product.featured),
        sku: product.sku || "",
        stock: product.stock != null ? product.stock : 0,
        lowStockThreshold: product.low_stock_threshold != null ? product.low_stock_threshold : 5,
        image: (media[0] && media[0].url) || product.image || "",
        images: media.filter(function (m) { return m.type === "image"; }).map(function (m) { return m.url; }),
        media: media,
        status: product.status,
        sponsored: Boolean(product.sponsored),
        rejectionReason: product.rejection_reason || null,
        trackingCode: product.tracking_code || null,
        createdAt: product.created_at
    };
}

function publicOrder(order) {
    return {
        id: order.id,
        orderNumber: order.order_number,
        customerId: order.customer_id,
        customerName: order.customer_name,
        customerEmail: order.customer_email,
        customerPhone: order.customer_phone,
        county: order.county,
        location: order.location,
        address: order.address,
        instructions: order.instructions,
        subtotal: order.subtotal,
        deliveryFee: order.delivery_fee,
        total: order.total,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        status: order.status,
        createdAt: order.created_at
    };
}

/* =========================
   SELLER AUTH MIDDLEWARE
========================= */

function requireSeller(request, response, next) {

    const header = request.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!token) {
        return response.status(401).json({ message: "Please log in as a seller." });
    }

    const seller = db
        .prepare("SELECT * FROM sellers WHERE token = ?")
        .get(token);

    if (!seller) {
        return response.status(401).json({ message: "Your session has expired. Please log in again." });
    }

    if (seller.status === "suspended") {
        return response.status(403).json({ message: "Your seller account has been suspended. Contact PHYNEX support." });
    }

    request.seller = seller;
    next();
}

// Best-effort customer lookup — does NOT block the request if there's
// no token or an invalid one. Used by checkout/payment so guest-style
// requests still work, but a logged-in customer's order gets linked
// to their account when possible.
function optionalCustomer(request) {
    const header = request.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!token) return null;

    return db.prepare("SELECT * FROM customers WHERE token = ?").get(token) || null;
}

/* =========================
   ADMIN AUTH (simple shared password)
========================= */

const adminTokens = new Set();

function requireAdmin(request, response, next) {

    const header = request.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!token || !adminTokens.has(token)) {
        return response.status(401).json({ message: "Admin login required." });
    }

    next();
}

app.post("/api/admin/login", function (request, response) {

    const password = String((request.body || {}).password || "");

    if (!process.env.ADMIN_PASSWORD) {
        return response.status(503).json({
            message: "Admin login is not configured yet. Set ADMIN_PASSWORD in .env."
        });
    }

    const lockMessage = checkLoginRateLimit(request, "admin");
    if (lockMessage) {
        return response.status(429).json({ message: lockMessage });
    }

    const expected = Buffer.from(process.env.ADMIN_PASSWORD);
    const supplied = Buffer.from(password);

    const valid =
        expected.length === supplied.length &&
        crypto.timingSafeEqual(expected, supplied);

    if (!valid) {
        recordLoginFailure(request, "admin");
        return response.status(401).json({ message: "Incorrect admin password." });
    }

    clearLoginFailures(request, "admin");

    const token = newToken();
    adminTokens.add(token);

    response.json({ token: token });
});

/* =========================
   CUSTOMER AUTHENTICATION
   Email verification + optional real SMS OTP + HttpOnly session cookie.
========================= */

function getAuthenticatedCustomer(request) {
    const cookies = parseCookies(request);
    const session = cookies.phynex_session;

    if (session) {
        const customer = db.prepare(
            "SELECT * FROM customers WHERE session_token_hash = ? AND session_expires > ?"
        ).get(hashToken(session), Date.now());

        if (customer) return customer;
    }

    // Backward-compatible only: accept an old Bearer token during migration.
    // New sessions are never returned to the browser as bearer tokens.
    const header = request.headers.authorization || "";
    if (header.startsWith("Bearer ")) {
        const token = header.slice(7);
        return db.prepare("SELECT * FROM customers WHERE token = ?").get(token) || null;
    }

    return null;
}

function requireCustomer(request, response, next) {
    const customer = getAuthenticatedCustomer(request);

    if (!customer) {
        return response.status(401).json({ message: "Please log in to continue." });
    }

    if (!customer.email_verified_at) {
        return response.status(403).json({ message: "Please verify your email before continuing." });
    }

    if (smsVerificationConfigured() && !customer.phone_verified_at) {
        return response.status(403).json({ message: "Please verify your phone number before continuing." });
    }

    request.customer = customer;
    next();
}

function optionalCustomer(request) {
    const customer = getAuthenticatedCustomer(request);
    if (!customer || !customer.email_verified_at) return null;
    if (smsVerificationConfigured() && !customer.phone_verified_at) return null;
    return customer;
}

function customerLoginAllowed(customer) {
    return Boolean(
        customer &&
        customer.email_verified_at &&
        (!smsVerificationConfigured() || customer.phone_verified_at)
    );
}

async function sendVerificationEmail(customer, rawToken) {
    if (!mailTransporter) {
        throw new Error("Email delivery is not configured.");
    }

    const baseUrl = (process.env.APP_URL || "").replace(/\/$/, "");
    const verifyUrl = baseUrl + "/api/customers/verify-email?token=" + encodeURIComponent(rawToken);

    await mailTransporter.sendMail({
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to: customer.email,
        subject: "Verify your PHYNEX email address",
        text:
            "Hi " + customer.name + ",\n\n" +
            "Please verify your PHYNEX email address by opening this link:\n" +
            verifyUrl + "\n\n" +
            "This link expires in 24 hours. If you did not create this account, ignore this message.\n\n" +
            "The PHYNEX Team",
        html:
            "<p>Hi " + escapeHtmlServer(customer.name) + ",</p>" +
            "<p>Please verify your PHYNEX email address:</p>" +
            "<p><a href=\"" + verifyUrl + "\">Verify my email address</a></p>" +
            "<p>This link expires in 24 hours. If you did not create this account, you can ignore this message.</p>"
    });
}

function escapeHtmlServer(value) {
    return String(value || "").replace(/[&<>"']/g, function (char) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
    });
}

function createEmailVerification(customerId) {
    const rawToken = newToken(32);
    db.prepare(
        "UPDATE customers SET email_verification_token_hash = ?, email_verification_expires = ? WHERE id = ?"
    ).run(hashToken(rawToken), Date.now() + 24 * 60 * 60 * 1000, customerId);
    return rawToken;
}

function createPhoneOtp(customerId) {
    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare(
        "UPDATE customers SET phone_verification_code_hash = ?, phone_verification_expires = ?, phone_verification_attempts = 0 WHERE id = ?"
    ).run(hashToken(code), Date.now() + 10 * 60 * 1000, customerId);
    return code;
}

function genericPasswordResetResponse() {
    return {
        ok: true,
        message: "If that email has an account, a reset link has been sent."
    };
}

app.post("/api/customers/register", asyncHandler(async function (request, response) {
    const body = request.body || {};
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = normalizeKenyanPhone(body.phone);
    const password = String(body.password || "");
    const confirmPassword = String(body.confirmPassword || "");

    if (!name || !email || !body.phone || !password || !confirmPassword) {
        return response.status(400).json({ message: "Full name, email, phone, password and password confirmation are required." });
    }

    if (name.length < 2 || name.length > 120) {
        return response.status(400).json({ message: "Enter a valid full name." });
    }

    if (!isPlausibleEmail(email)) {
        return response.status(400).json({ message: "Invalid email address." });
    }

    if (!phone) {
        return response.status(400).json({ message: "Invalid Kenyan phone number." });
    }

    if (password !== confirmPassword) {
        return response.status(400).json({ message: "Passwords do not match." });
    }

    if (!passwordIsStrong(password)) {
        return response.status(400).json({ message: "Password must be at least 8 characters and contain at least one letter and one number." });
    }

    if (!emailVerificationConfigured()) {
        return response.status(503).json({ message: "Email verification is not configured. Add the required email settings to the server .env." });
    }

    const existing = db.prepare("SELECT id FROM customers WHERE email = ?").get(email);
    if (existing) {
        return response.status(409).json({ message: "This email is already registered." });
    }

    const phoneOwner = db.prepare("SELECT id FROM customers WHERE phone = ?").get(phone);
    if (phoneOwner) {
        return response.status(409).json({ message: "This phone number is already registered." });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = db.prepare(
        `INSERT INTO customers
            (name, email, phone, password_hash, token, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`
    ).run(name, email, phone, passwordHash, Date.now());

    const customerId = result.lastInsertRowid;
    let customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(customerId);

    const emailToken = createEmailVerification(customerId);
    try {
        await sendVerificationEmail(customer, emailToken);
    } catch (error) {
        db.prepare(
            "DELETE FROM customers WHERE id = ?"
        ).run(customerId);
        console.error("Verification email failed:", error.message);
        return response.status(502).json({ message: "We could not send the verification email. Please try again." });
    }

    let phoneVerificationRequired = false;
    if (smsVerificationConfigured()) {
        const otp = createPhoneOtp(customerId);
        try {
            await sendSms(
                phone,
                "Your PHYNEX verification code is " + otp + ". It expires in 10 minutes."
            );
            phoneVerificationRequired = true;
        } catch (error) {
            db.prepare("DELETE FROM customers WHERE id = ?").run(customerId);
            console.error("Verification SMS failed:", error.message);
            return response.status(502).json({ message: "We could not send the phone verification code. Please try again." });
        }
    }

    logLogin("customer", customer, "register");

    response.status(201).json({
        ok: true,
        message: phoneVerificationRequired
            ? "Verification email sent. We also sent an OTP to your phone."
            : "Verification email sent.",
        emailVerificationRequired: true,
        phoneVerificationRequired: phoneVerificationRequired
    });
}));

app.get("/api/customers/verify-email", function (request, response) {
    const token = String(request.query.token || "").trim();

    if (!token || token.length < 40) {
        return response.redirect("/customer-login.html?verified=0");
    }

    const customer = db.prepare(
        `SELECT * FROM customers
         WHERE email_verification_token_hash = ?
           AND email_verification_expires > ?`
    ).get(hashToken(token), Date.now());

    if (!customer) {
        return response.redirect("/customer-login.html?verified=0");
    }

    db.prepare(
        `UPDATE customers
         SET email_verified_at = ?, email_verification_token_hash = NULL, email_verification_expires = NULL
         WHERE id = ?`
    ).run(Date.now(), customer.id);

    response.redirect("/customer-login.html?verified=1");
});

app.post("/api/customers/resend-verification", asyncHandler(async function (request, response) {
    if (sensitiveActionRateLimited(request, "email-verification")) {
        return response.json({ ok: true, message: "If that account needs verification, a new verification email has been sent." });
    }

    const email = String((request.body || {}).email || "").trim().toLowerCase();

    // Deliberately generic to avoid account enumeration.
    if (!isPlausibleEmail(email)) {
        return response.json({ ok: true, message: "If that account needs verification, a new verification email has been sent." });
    }

    const customer = db.prepare("SELECT * FROM customers WHERE email = ?").get(email);
    if (!customer || customer.email_verified_at) {
        return response.json({ ok: true, message: "If that account needs verification, a new verification email has been sent." });
    }

    const token = createEmailVerification(customer.id);
    try {
        await sendVerificationEmail(customer, token);
    } catch (error) {
        console.error("Verification resend failed:", error.message);
    }

    return response.json({ ok: true, message: "If that account needs verification, a new verification email has been sent." });
}));

app.post("/api/customers/verify-phone", function (request, response) {
    if (!smsVerificationConfigured()) {
        return response.status(503).json({ message: "Phone verification is not configured on this server." });
    }

    const customer = getAuthenticatedCustomer(request);
    if (!customer) {
        return response.status(401).json({ message: "Please log in to continue." });
    }

    const code = String((request.body || {}).code || "").trim();
    if (!/^\d{6}$/.test(code)) {
        return response.status(400).json({ message: "Invalid phone verification code." });
    }

    if (customer.phone_verification_attempts >= 5) {
        return response.status(429).json({ message: "Too many OTP attempts. Request a new code later." });
    }

    if (!customer.phone_verification_code_hash || !customer.phone_verification_expires ||
        customer.phone_verification_expires <= Date.now()) {
        return response.status(400).json({ message: "The phone verification code has expired. Request a new code." });
    }

    const valid = crypto.timingSafeEqual(
        Buffer.from(customer.phone_verification_code_hash, "hex"),
        Buffer.from(hashToken(code), "hex")
    );

    if (!valid) {
        db.prepare("UPDATE customers SET phone_verification_attempts = COALESCE(phone_verification_attempts, 0) + 1 WHERE id = ?")
            .run(customer.id);
        return response.status(400).json({ message: "Invalid phone verification code." });
    }

    db.prepare(
        `UPDATE customers
         SET phone_verified_at = ?, phone_verification_code_hash = NULL,
             phone_verification_expires = NULL, phone_verification_attempts = 0
         WHERE id = ?`
    ).run(Date.now(), customer.id);

    response.json({ ok: true, message: "Your phone number has been verified." });
});

app.post("/api/customers/resend-phone-code", asyncHandler(async function (request, response) {
    if (sensitiveActionRateLimited(request, "phone-otp")) {
        return response.status(429).json({ message: "Too many OTP requests. Please try again later." });
    }
    if (!smsVerificationConfigured()) {
        return response.status(503).json({ message: "Phone verification is not configured on this server." });
    }

    const customer = getAuthenticatedCustomer(request);
    if (!customer) return response.status(401).json({ message: "Please log in to continue." });
    if (customer.phone_verified_at) return response.json({ ok: true, message: "Phone number is already verified." });

    const otp = createPhoneOtp(customer.id);
    try {
        await sendSms(customer.phone, "Your PHYNEX verification code is " + otp + ". It expires in 10 minutes.");
    } catch (error) {
        console.error("Verification SMS resend failed:", error.message);
        return response.status(502).json({ message: "Could not send a new verification code." });
    }

    response.json({ ok: true, message: "A new phone verification code has been sent." });
}));

app.post("/api/customers/login", asyncHandler(async function (request, response) {
    const body = request.body || {};
    const identifier = String(body.identifier || body.email || body.phone || "").trim();
    const password = String(body.password || "");
    const normalizedEmail = identifier.toLowerCase();
    const normalizedPhone = normalizeKenyanPhone(identifier);

    const lockMessage = checkLoginRateLimit(request, identifier);
    if (lockMessage) return response.status(429).json({ message: lockMessage });

    const customer = db.prepare(
        normalizedPhone
            ? "SELECT * FROM customers WHERE phone = ? OR email = ?"
            : "SELECT * FROM customers WHERE email = ?"
    ).get(normalizedPhone || normalizedEmail, normalizedEmail);

    if (!customer) {
        recordLoginFailure(request, identifier);
        return response.status(401).json({ message: "Incorrect email or password." });
    }

    const valid = await bcrypt.compare(password, customer.password_hash);
    if (!valid) {
        recordLoginFailure(request, identifier);
        return response.status(401).json({ message: "Incorrect email or password." });
    }

    if (!customer.email_verified_at) {
        clearLoginFailures(request, identifier);
        return response.status(403).json({ message: "Please verify your email before logging in." });
    }

    if (smsVerificationConfigured() && !customer.phone_verified_at) {
        clearLoginFailures(request, identifier);
        setCustomerSession(response, customer.id); // limited verification session; protected APIs still reject it
        return response.status(403).json({
            message: "Please verify your phone number before logging in.",
            phoneVerificationRequired: true
        });
    }

    clearLoginFailures(request, identifier);
    setCustomerSession(response, customer.id);

    logLogin("customer", customer, "login");

    response.json({ ok: true, customer: publicCustomer(customer) });
}));

app.post("/api/customers/google", asyncHandler(async function (request, response) {
    if (!googleConfigured() || !googleClient) {
        return response.status(503).json({ message: "Google sign-in is not configured yet." });
    }

    const credential = String((request.body || {}).credential || "");
    if (!credential) return response.status(400).json({ message: "Missing Google credential." });

    let payload;
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        payload = ticket.getPayload();
    } catch (error) {
        return response.status(401).json({ message: "Could not verify that Google account." });
    }

    if (!payload || !payload.email || !payload.email_verified) {
        return response.status(401).json({ message: "Only verified Google accounts can be used to sign in." });
    }

    const email = String(payload.email).trim().toLowerCase();
    const name = String(payload.name || email.split("@")[0]).trim();
    const googleId = String(payload.sub);

    let customer = db.prepare("SELECT * FROM customers WHERE email = ?").get(email);

    if (customer) {
        if (!customer.google_id || !customer.email_verified_at) {
            db.prepare("UPDATE customers SET google_id = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?")
                .run(googleId, Date.now(), customer.id);
        }
    } else {
        const placeholderHash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 12);
        const result = db.prepare(
            `INSERT INTO customers
                (name, email, phone, password_hash, google_id, token, email_verified_at, created_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
        ).run(name, email, "", placeholderHash, googleId, Date.now(), Date.now());

        customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(result.lastInsertRowid);
    }

    if (!customer.email_verified_at) {
        return response.status(403).json({ message: "Please verify your email before logging in." });
    }

    setCustomerSession(response, customer.id);
    customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(customer.id);
    logLogin("customer", customer, "google");

    response.json({ ok: true, customer: publicCustomer(customer) });
}));

app.post("/api/customers/forgot-password", asyncHandler(async function (request, response) {
    if (sensitiveActionRateLimited(request, "password-reset")) {
        return response.json(genericPasswordResetResponse());
    }

    const email = String((request.body || {}).email || "").trim().toLowerCase();

    if (!isPlausibleEmail(email)) {
        return response.json(genericPasswordResetResponse());
    }

    const customer = db.prepare("SELECT * FROM customers WHERE email = ?").get(email);
    if (!customer) return response.json(genericPasswordResetResponse());

    const resetToken = newToken(32);
    const expires = Date.now() + 60 * 60 * 1000;

    // Store only a SHA-256 hash of the reset token.
    db.prepare("UPDATE customers SET reset_token = ?, reset_token_expires = ? WHERE id = ?")
        .run(hashToken(resetToken), expires, customer.id);

    const baseUrl = (process.env.APP_URL || "").replace(/\/$/, "");
    const resetUrl = baseUrl + "/customer-reset-password.html?token=" + encodeURIComponent(resetToken);

    if (mailTransporter) {
        try {
            await mailTransporter.sendMail({
                from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
                to: customer.email,
                subject: "Reset your PHYNEX password",
                text: "Reset your PHYNEX password here:\n" + resetUrl + "\n\nThis link expires in 1 hour and can only be used once.",
                html: "<p>Reset your PHYNEX password by clicking the link below:</p>" +
                    "<p><a href=\"" + resetUrl + "\">Reset password</a></p>" +
                    "<p>This link expires in 1 hour and can only be used once.</p>"
            });
        } catch (error) {
            console.error("Password reset email failed:", error.message);
        }
    }

    response.json(genericPasswordResetResponse());
}));

app.post("/api/customers/reset-password", asyncHandler(async function (request, response) {
    const body = request.body || {};
    const token = String(body.token || "").trim();
    const password = String(body.password || "");
    const confirmPassword = String(body.confirmPassword || "");

    if (!token) return response.status(400).json({ message: "Missing or invalid reset link." });
    if (password !== confirmPassword) return response.status(400).json({ message: "Passwords do not match." });
    if (!passwordIsStrong(password)) {
        return response.status(400).json({ message: "Password must be at least 8 characters and contain at least one letter and one number." });
    }

    const customer = db.prepare(
        "SELECT * FROM customers WHERE reset_token = ? AND reset_token_expires > ?"
    ).get(hashToken(token), Date.now());

    if (!customer) {
        return response.status(400).json({ message: "This reset link is invalid or has expired." });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    db.prepare(
        `UPDATE customers
         SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL,
             session_token_hash = NULL, session_expires = NULL, token = NULL
         WHERE id = ?`
    ).run(passwordHash, customer.id);

    logLogin("customer", customer, "password_reset");

    response.json({ ok: true, message: "Password updated successfully. Please log in again." });
}));

app.get("/api/customers/me", requireCustomer, function (request, response) {
    response.json({ customer: publicCustomer(request.customer) });
});

app.post("/api/customers/logout", function (request, response) {
    const customer = getAuthenticatedCustomer(request);
    if (customer) logLogin("customer", customer, "logout");
    clearCustomerSession(response, customer && customer.id);
    response.json({ ok: true });
});

/* =========================
   SELLER REGISTER / LOGIN
========================= */

app.post("/api/sellers/register", asyncHandler(async function (request, response) {

    const body = request.body || {};

    const businessName = String(body.businessName || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const whatsapp = String(body.whatsapp || "").trim();
    const password = String(body.password || "");

    if (!businessName || !email || !password) {
        return response.status(400).json({ message: "Business name, email and password are required." });
    }

    if (!phone) {
        return response.status(400).json({ message: "A phone number is required so buyers can reach you." });
    }

    if (!whatsapp) {
        return response.status(400).json({ message: "A WhatsApp number is required so buyers can reach you." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return response.status(400).json({ message: "Enter a valid email address." });
    }

    if (password.length < 6) {
        return response.status(400).json({ message: "Password must be at least 6 characters." });
    }

    const existing = db.prepare("SELECT id FROM sellers WHERE email = ?").get(email);

    if (existing) {
        return response.status(409).json({ message: "An account with that email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const token = newToken();

    const result = db
        .prepare(
            `INSERT INTO sellers (business_name, email, phone, whatsapp, password_hash, token, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'approved', ?)`
        )
        .run(businessName, email, phone, whatsapp, passwordHash, token, Date.now());

    const seller = db.prepare("SELECT * FROM sellers WHERE id = ?").get(result.lastInsertRowid);

    logActivity("seller_registered", businessName + " created a seller account.");
    logLogin("seller", seller, "register");

    response.json({ token: token, seller: publicSeller(seller) });
}));

app.post("/api/sellers/login", asyncHandler(async function (request, response) {

    const body = request.body || {};

    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    const lockMessage = checkLoginRateLimit(request, email);
    if (lockMessage) {
        return response.status(429).json({ message: lockMessage });
    }

    const seller = db.prepare("SELECT * FROM sellers WHERE email = ?").get(email);

    if (!seller) {
        recordLoginFailure(request, email);
        return response.status(401).json({ message: "Incorrect email or password." });
    }

    const valid = await bcrypt.compare(password, seller.password_hash);

    if (!valid) {
        recordLoginFailure(request, email);
        return response.status(401).json({ message: "Incorrect email or password." });
    }

    clearLoginFailures(request, email);

    if (seller.status === "suspended") {
        return response.status(403).json({ message: "Your seller account has been suspended. Contact PHYNEX support." });
    }

    const token = newToken();

    db.prepare("UPDATE sellers SET token = ? WHERE id = ?").run(token, seller.id);

    logLogin("seller", seller, "login");

    response.json({ token: token, seller: publicSeller(seller) });
}));

app.get("/api/sellers/me", requireSeller, function (request, response) {
    response.json({ seller: publicSeller(request.seller) });
});

app.post("/api/sellers/logout", requireSeller, function (request, response) {
    db.prepare("UPDATE sellers SET token = NULL WHERE id = ?").run(request.seller.id);
    logLogin("seller", request.seller, "logout");
    response.json({ ok: true });
});

app.put("/api/sellers/me", requireSeller, function (request, response) {

    const body = request.body || {};
    const phone = body.phone != null ? String(body.phone).trim() : request.seller.phone;
    const whatsapp = body.whatsapp != null ? String(body.whatsapp).trim() : request.seller.whatsapp;

    if (!phone || !whatsapp) {
        return response.status(400).json({ message: "Phone and WhatsApp numbers cannot be empty." });
    }

    db.prepare("UPDATE sellers SET phone = ?, whatsapp = ? WHERE id = ?").run(phone, whatsapp, request.seller.id);

    const seller = db.prepare("SELECT * FROM sellers WHERE id = ?").get(request.seller.id);

    response.json({ seller: publicSeller(seller) });
});

/* =========================
   MEDIA UPLOAD (images + short videos)
========================= */

const fs = require("fs");
const multer = require("multer");

const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use("/uploads", express.static(uploadsDir));

const mediaStorage = multer.diskStorage({
    destination: function (request, file, callback) {
        callback(null, uploadsDir);
    },
    filename: function (request, file, callback) {
        const ext = path.extname(file.originalname || "");
        const unique = Date.now() + "-" + crypto.randomBytes(6).toString("hex");
        callback(null, unique + ext);
    }
});

const mediaFileFilter = function (request, file, callback) {
    if (/^image\/|^video\//.test(file.mimetype)) {
        callback(null, true);
    } else {
        callback(new Error("Only image and video files are allowed."));
    }
};

const uploadMedia = multer({
    storage: mediaStorage,
    limits: { fileSize: 25 * 1024 * 1024, files: 6 },
    fileFilter: mediaFileFilter
});

// Separate upload handler for the admin's own "add/edit product" form,
// which uses distinct field names: a single "image" plus a "gallery" array.
const uploadAdminProductFiles = multer({
    storage: mediaStorage,
    limits: { fileSize: 25 * 1024 * 1024, files: 7 },
    fileFilter: mediaFileFilter
}).fields([
    { name: "image", maxCount: 1 },
    { name: "gallery", maxCount: 6 }
]);

function handleAdminUpload(request, response, next) {
    uploadAdminProductFiles(request, response, function (error) {
        if (error) {
            const message = error instanceof multer.MulterError
                ? (error.code === "LIMIT_FILE_SIZE" ? "Each file must be under 25MB." : error.message)
                : error.message;
            return response.status(400).json({ message: message || "Could not upload files." });
        }
        next();
    });
}

/* =========================
   SELLER — SUBMIT / VIEW OWN PRODUCTS
========================= */

app.post("/api/products", requireSeller, function (request, response, next) {

    uploadMedia.array("media", 6)(request, response, function (error) {

        if (error) {
            const message = error instanceof multer.MulterError
                ? (error.code === "LIMIT_FILE_SIZE" ? "Each file must be under 25MB." : error.message)
                : error.message;
            return response.status(400).json({ message: message || "Could not upload files." });
        }

        next();
    });

}, function (request, response) {

    const body = request.body || {};

    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();
    const specifications = String(body.specifications || "").trim();
    const price = Math.round(Number(body.price));
    const oldPrice = body.oldPrice ? Math.round(Number(body.oldPrice)) : null;
    const category = String(body.category || "").trim();
    const stock = body.stock != null && body.stock !== "" ? Math.max(0, Math.round(Number(body.stock))) : 0;

    if (!name || !Number.isFinite(price) || price < 1) {
        return response.status(400).json({ message: "Product name and a valid price are required." });
    }

    const files = request.files || [];

    const media = files.map(function (file) {
        return {
            url: "/uploads/" + file.filename,
            type: file.mimetype.indexOf("video/") === 0 ? "video" : "image"
        };
    });

    const mediaJson = JSON.stringify(media);
    const firstImage = (media.find(function (m) { return m.type === "image"; }) || media[0] || {}).url || "";
    const trackingCode = generateTrackingCode();

    const result = db
        .prepare(
            `INSERT INTO products
                (seller_id, name, description, specifications, price, old_price, category, image, media, status, sponsored, tracking_code, stock, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`
        )
        .run(
            request.seller.id, name, description, specifications, price,
            oldPrice, category, firstImage, mediaJson, trackingCode, stock, Date.now()
        );

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(result.lastInsertRowid);

    logActivity("product_submitted", request.seller.business_name + " submitted \"" + name + "\" for review.");

    response.json({ product: publicProduct(product) });
});

app.get("/api/seller/products", requireSeller, function (request, response) {

    const products = db
        .prepare("SELECT * FROM products WHERE seller_id = ? ORDER BY created_at DESC")
        .all(request.seller.id);

    response.json({ products: publicProductList(products) });
});

app.delete("/api/seller/products/:id", requireSeller, function (request, response) {

    const product = db
        .prepare("SELECT * FROM products WHERE id = ? AND seller_id = ?")
        .get(request.params.id, request.seller.id);

    if (!product) {
        return response.status(404).json({ message: "Product not found." });
    }

    db.prepare("DELETE FROM products WHERE id = ?").run(product.id);

    response.json({ ok: true });
});

/* =========================
   PUBLIC — CATEGORIES
   Lets the storefront (homepage tiles, category browsing, the seller's
   "add product" category list) always match whatever the admin has
   configured, instead of a hardcoded list baked into each page.
========================= */

app.get("/api/categories", function (request, response) {

    const rows = db.prepare("SELECT * FROM categories ORDER BY name ASC").all();

    const countStmt = db.prepare(
        "SELECT COUNT(*) AS c FROM products WHERE category = ? AND status = 'approved'"
    );

    response.json({
        categories: rows.map(function (category) {
            return {
                id: category.id,
                name: category.name,
                slug: category.slug,
                description: category.description,
                productCount: countStmt.get(category.name).c
            };
        })
    });
});

/* =========================
   PUBLIC — APPROVED PRODUCTS
========================= */

app.get("/api/products", function (request, response) {

    const sponsoredOnly = request.query.sponsored === "1";

    const rows = sponsoredOnly
        ? db.prepare(
            `SELECT products.*, sellers.business_name, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.status = 'approved' AND products.sponsored = 1
             ORDER BY products.created_at DESC`
        ).all()
        : db.prepare(
            `SELECT products.*, sellers.business_name, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.status = 'approved'
             ORDER BY products.created_at DESC`
        ).all();

    response.json({ products: publicProductList(rows) });
});

/* =========================
   PUBLIC — SINGLE PRODUCT DETAIL
   Used when a buyer taps a product image/name to see full details.
========================= */

app.get("/api/products/:id", function (request, response) {

    const product = db
        .prepare(
            `SELECT products.*, sellers.business_name, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp
             FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.id = ? AND products.status = 'approved'`
        )
        .get(request.params.id);

    if (!product) {
        return response.status(404).json({ message: "Product not found." });
    }

    response.json({ product: publicProduct(product) });
});

/* =========================
   PUBLIC — PRODUCT REVIEWS
   Anyone can read approved reviews. Only a logged-in customer who
   actually paid for that product can submit one — this is what makes
   the ratings real instead of the old hardcoded "★★★★★ (24)" text.
========================= */

app.get("/api/products/:id/reviews", function (request, response) {

    const productId = Number(request.params.id);

    if (!Number.isFinite(productId)) {
        return response.status(400).json({ message: "Invalid product id." });
    }

    const reviews = db
        .prepare(
            "SELECT id, customer_name, rating, comment, created_at FROM reviews WHERE product_id = ? AND status = 'approved' ORDER BY created_at DESC"
        )
        .all(productId);

    const summary = getRatingSummary(productId);

    response.json({
        rating: summary.average,
        reviewCount: summary.count,
        reviews: reviews.map(function (review) {
            return {
                id: review.id,
                customerName: review.customer_name,
                rating: review.rating,
                comment: review.comment,
                createdAt: review.created_at
            };
        })
    });
});

app.post("/api/products/:id/reviews", requireCustomer, function (request, response) {

    const productId = Number(request.params.id);

    if (!Number.isFinite(productId)) {
        return response.status(400).json({ message: "Invalid product id." });
    }

    const product = db.prepare("SELECT id FROM products WHERE id = ? AND status = 'approved'").get(productId);

    if (!product) {
        return response.status(404).json({ message: "Product not found." });
    }

    const body = request.body || {};
    const rating = Math.round(Number(body.rating));
    const comment = String(body.comment || "").trim();

    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
        return response.status(400).json({ message: "Please choose a rating from 1 to 5 stars." });
    }

    // Verified-purchase check: the customer must have a paid order that
    // actually contains this product.
    const purchased = db
        .prepare(
            `SELECT 1 FROM order_items
             JOIN orders ON orders.id = order_items.order_id
             WHERE order_items.product_id = ? AND orders.customer_id = ? AND orders.payment_status = 'paid'
             LIMIT 1`
        )
        .get(productId, request.customer.id);

    if (!purchased) {
        return response.status(403).json({
            message: "You can only review products you've actually bought and paid for."
        });
    }

    const existing = db
        .prepare("SELECT id FROM reviews WHERE product_id = ? AND customer_id = ?")
        .get(productId, request.customer.id);

    if (existing) {
        db.prepare(
            "UPDATE reviews SET rating = ?, comment = ?, status = 'pending', created_at = ? WHERE id = ?"
        ).run(rating, comment, Date.now(), existing.id);
    } else {
        db.prepare(
            `INSERT INTO reviews (product_id, product_name, customer_id, customer_name, rating, comment, status, created_at)
             VALUES (?, (SELECT name FROM products WHERE id = ?), ?, ?, ?, ?, 'pending', ?)`
        ).run(productId, productId, request.customer.id, request.customer.name, rating, comment, Date.now());
    }

    logActivity("review_submitted", request.customer.name + " reviewed a product (awaiting approval).");

    response.json({
        message: "Thanks! Your review has been submitted and will appear once approved."
    });
});

/* =========================
   PUBLIC — BLOG / NEWS
   Real, persisted posts (replaces the old browser-only demo posts).
   Anyone can read; only a signed-in customer can publish, so posts
   are tied to a real account instead of being anonymous/fake.
========================= */

app.get("/api/blog", function (request, response) {

    const rows = db
        .prepare("SELECT * FROM blog_posts ORDER BY created_at DESC LIMIT 60")
        .all();

    response.json({
        posts: rows.map(function (post) {
            return {
                id: post.id,
                tag: post.tag || "PHYNEX · News",
                title: post.title,
                body: post.body,
                imageUrl: post.image_url,
                videoUrl: post.video_url,
                authorName: post.author_name,
                createdAt: post.created_at
            };
        })
    });
});

app.post("/api/blog", requireCustomer, function (request, response) {

    const body = request.body || {};

    const tag = String(body.tag || "PHYNEX · News").trim().slice(0, 60);
    const title = String(body.title || "").trim();
    const postBody = String(body.body || "").trim();
    const imageUrl = String(body.imageUrl || "").trim().slice(0, 2000);
    const videoUrl = String(body.videoUrl || "").trim().slice(0, 2000);

    if (!title || !postBody) {
        return response.status(400).json({ message: "Add a headline and a story before publishing." });
    }

    if (title.length > 200) {
        return response.status(400).json({ message: "Headline is too long." });
    }

    if (postBody.length > 5000) {
        return response.status(400).json({ message: "Story is too long." });
    }

    const result = db
        .prepare(
            `INSERT INTO blog_posts (tag, title, body, image_url, video_url, customer_id, author_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(tag, title, postBody, imageUrl || null, videoUrl || null, request.customer.id, request.customer.name, Date.now());

    logActivity("blog_post", request.customer.name + " published a blog update.");

    const post = db.prepare("SELECT * FROM blog_posts WHERE id = ?").get(result.lastInsertRowid);

    response.json({
        post: {
            id: post.id,
            tag: post.tag,
            title: post.title,
            body: post.body,
            imageUrl: post.image_url,
            videoUrl: post.video_url,
            authorName: post.author_name,
            createdAt: post.created_at
        }
    });
});

/* =========================
   PUBLIC — TRACK MY PRODUCT
========================= */

app.get("/api/track/:code", function (request, response) {

    const code = String(request.params.code || "").trim();

    if (!/^\d{4}$/.test(code)) {
        return response.status(400).json({ message: "Enter the 4-digit tracking number." });
    }

    const product = db
        .prepare(
            `SELECT products.*, sellers.business_name, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.tracking_code = ?`
        )
        .get(code);

    if (!product) {
        return response.status(404).json({ message: "No product found with that tracking number." });
    }

    response.json({ product: publicProduct(product) });
});

/* =========================
   ADMIN — DASHBOARD
========================= */

app.get("/api/admin/dashboard", requireAdmin, function (request, response) {

    const totalProducts = db.prepare("SELECT COUNT(*) AS c FROM products").get().c;
    const pendingProducts = db.prepare("SELECT COUNT(*) AS c FROM products WHERE status = 'pending'").get().c;
    const totalOrders = db.prepare("SELECT COUNT(*) AS c FROM orders").get().c;
    const revenue = db.prepare("SELECT COALESCE(SUM(total), 0) AS s FROM orders WHERE payment_status = 'paid'").get().s;

    const recentOrders = db
        .prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 6")
        .all()
        .map(publicOrder);

    const pendingProductsListRows = db
        .prepare(
            `SELECT products.*, sellers.business_name, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.status = 'pending'
             ORDER BY products.created_at DESC LIMIT 6`
        )
        .all();

    const pendingProductsList = publicProductList(pendingProductsListRows);

    response.json({
        totalProducts: totalProducts,
        pendingProducts: pendingProducts,
        totalOrders: totalOrders,
        revenue: revenue,
        recentOrders: recentOrders,
        pendingProductsList: pendingProductsList
    });
});

/* =========================
   ADMIN — REVIEW / APPROVE / SPONSOR PRODUCTS
========================= */

app.get("/api/admin/products", requireAdmin, function (request, response) {

    const status = String(request.query.status || "").trim();

    const rows = status
        ? db.prepare(
            `SELECT products.*, sellers.business_name, sellers.email, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.status = ?
             ORDER BY products.created_at DESC`
        ).all(status)
        : db.prepare(
            `SELECT products.*, sellers.business_name, sellers.email, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp FROM products
             JOIN sellers ON sellers.id = products.seller_id
             ORDER BY products.created_at DESC`
        ).all();

    response.json({
        products: publicProductList(rows, function (mapped, row) {
            return Object.assign(mapped, { sellerEmail: row.email });
        })
    });
});

app.post("/api/admin/products/:id/approve", requireAdmin, function (request, response) {

    const result = db
        .prepare("UPDATE products SET status = 'approved', rejection_reason = NULL WHERE id = ?")
        .run(request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Product not found." });
    }

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(request.params.id);
    logActivity("product_approved", "Approved \"" + (product ? product.name : request.params.id) + "\".");

    response.json({ ok: true });
});

app.post("/api/admin/products/:id/reject", requireAdmin, function (request, response) {

    const reason = String((request.body || {}).reason || "").trim();

    const result = db
        .prepare("UPDATE products SET status = 'rejected', rejection_reason = ? WHERE id = ?")
        .run(reason || "Not specified", request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Product not found." });
    }

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(request.params.id);
    logActivity("product_rejected", "Rejected \"" + (product ? product.name : request.params.id) + "\" (" + (reason || "no reason given") + ").");

    response.json({ ok: true });
});

app.post("/api/admin/products/:id/sponsor", requireAdmin, function (request, response) {

    const sponsored = (request.body || {}).sponsored ? 1 : 0;

    const result = db
        .prepare("UPDATE products SET sponsored = ? WHERE id = ?")
        .run(sponsored, request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Product not found." });
    }

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(request.params.id);
    logActivity(sponsored ? "product_sponsored" : "product_unsponsored", (sponsored ? "Sponsored " : "Unsponsored ") + "\"" + (product ? product.name : request.params.id) + "\".");

    response.json({ ok: true });
});

app.post("/api/admin/products/:id/stock", requireAdmin, function (request, response) {

    const stock = Math.max(0, Math.round(Number((request.body || {}).stock)));

    if (!Number.isFinite(stock)) {
        return response.status(400).json({ message: "Enter a valid stock quantity." });
    }

    const result = db.prepare("UPDATE products SET stock = ? WHERE id = ?").run(stock, request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Product not found." });
    }

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(request.params.id);
    logActivity("stock_updated", "Set stock for \"" + (product ? product.name : request.params.id) + "\" to " + stock + ".");

    response.json({ ok: true });
});

app.delete("/api/admin/products/:id", requireAdmin, function (request, response) {

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(request.params.id);

    db.prepare("DELETE FROM products WHERE id = ?").run(request.params.id);

    if (product) {
        logActivity("product_deleted", "Deleted \"" + product.name + "\".");
    }

    response.json({ ok: true });
});

// Admin creating a product directly (not via a seller submission).
// Goes straight to "approved" since an admin is creating it themselves.
app.post("/api/admin/products", requireAdmin, handleAdminUpload, function (request, response) {

    const body = request.body || {};
    const files = request.files || {};

    const name = String(body.name || "").trim();
    const price = Math.round(Number(body.price));

    if (!name || !Number.isFinite(price) || price < 1) {
        return response.status(400).json({ message: "Product name and a valid price are required." });
    }

    const systemSeller = ensureSystemSeller();

    const mainImageFile = (files.image && files.image[0]) || null;
    const galleryFiles = files.gallery || [];

    const media = [];

    if (mainImageFile) {
        media.push({ url: "/uploads/" + mainImageFile.filename, type: "image" });
    }

    galleryFiles.forEach(function (file) {
        media.push({
            url: "/uploads/" + file.filename,
            type: file.mimetype.indexOf("video/") === 0 ? "video" : "image"
        });
    });

    const mediaJson = JSON.stringify(media);
    const firstImage = (media[0] && media[0].url) || "";
    const trackingCode = generateTrackingCode();

    const result = db
        .prepare(
            `INSERT INTO products
                (seller_id, name, description, specifications, price, old_price, category, image, media,
                 status, sponsored, tracking_code, stock, low_stock_threshold, sku, brand, subcategory,
                 condition_label, warranty, tags, featured, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            systemSeller.id,
            name,
            String(body.description || "").trim(),
            String(body.specifications || "").trim(),
            price,
            body.oldPrice ? Math.round(Number(body.oldPrice)) : null,
            String(body.category || "").trim(),
            firstImage,
            mediaJson,
            trackingCode,
            body.stock != null && body.stock !== "" ? Math.max(0, Math.round(Number(body.stock))) : 0,
            5,
            String(body.sku || "").trim(),
            String(body.brand || "").trim(),
            String(body.subcategory || "").trim(),
            String(body.condition || "").trim(),
            String(body.warranty || "").trim(),
            String(body.tags || "").trim(),
            body.featured === "true" ? 1 : 0,
            Date.now()
        );

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(result.lastInsertRowid);

    logActivity("product_created", "Admin added \"" + name + "\" directly.");

    response.json({ message: "Product created.", product: publicProduct(product) });
});

app.put("/api/admin/products/:id", requireAdmin, handleAdminUpload, function (request, response) {

    const existing = db.prepare("SELECT * FROM products WHERE id = ?").get(request.params.id);

    if (!existing) {
        return response.status(404).json({ message: "Product not found." });
    }

    const body = request.body || {};
    const files = request.files || {};

    const name = String(body.name || existing.name || "").trim();
    const price = body.price != null && body.price !== "" ? Math.round(Number(body.price)) : existing.price;

    if (!name || !Number.isFinite(price) || price < 1) {
        return response.status(400).json({ message: "Product name and a valid price are required." });
    }

    let media = [];
    try { media = JSON.parse(existing.media || "[]") || []; } catch (error) { media = []; }

    const mainImageFile = (files.image && files.image[0]) || null;
    const galleryFiles = files.gallery || [];

    if (mainImageFile) {
        const rest = media.filter(function (m, index) { return index !== 0; });
        media = [{ url: "/uploads/" + mainImageFile.filename, type: "image" }].concat(rest);
    }

    if (galleryFiles.length) {
        const mainOnly = media.length ? [media[0]] : [];
        const newGallery = galleryFiles.map(function (file) {
            return {
                url: "/uploads/" + file.filename,
                type: file.mimetype.indexOf("video/") === 0 ? "video" : "image"
            };
        });
        media = mainOnly.concat(newGallery);
    }

    const mediaJson = JSON.stringify(media);
    const firstImage = (media[0] && media[0].url) || existing.image || "";

    db.prepare(
        `UPDATE products SET
            name = ?, description = ?, specifications = ?, price = ?, old_price = ?, category = ?,
            image = ?, media = ?, stock = ?, sku = ?, brand = ?, subcategory = ?, condition_label = ?,
            warranty = ?, tags = ?, featured = ?
         WHERE id = ?`
    ).run(
        name,
        body.description != null ? String(body.description).trim() : existing.description,
        body.specifications != null ? String(body.specifications).trim() : existing.specifications,
        price,
        body.oldPrice ? Math.round(Number(body.oldPrice)) : existing.old_price,
        body.category != null ? String(body.category).trim() : existing.category,
        firstImage,
        mediaJson,
        body.stock != null && body.stock !== "" ? Math.max(0, Math.round(Number(body.stock))) : existing.stock,
        body.sku != null ? String(body.sku).trim() : existing.sku,
        body.brand != null ? String(body.brand).trim() : existing.brand,
        body.subcategory != null ? String(body.subcategory).trim() : existing.subcategory,
        body.condition != null ? String(body.condition).trim() : existing.condition_label,
        body.warranty != null ? String(body.warranty).trim() : existing.warranty,
        body.tags != null ? String(body.tags).trim() : existing.tags,
        body.featured != null ? (body.featured === "true" ? 1 : 0) : existing.featured,
        request.params.id
    );

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(request.params.id);

    logActivity("product_edited", "Admin edited \"" + name + "\".");

    response.json({ message: "Product updated.", product: publicProduct(product) });
});

/* =========================
   ADMIN — INVENTORY
========================= */

app.get("/api/admin/inventory", requireAdmin, function (request, response) {

    const rows = db.prepare("SELECT * FROM products ORDER BY stock ASC, name ASC").all();

    response.json({
        products: rows.map(function (row) {
            return {
                id: row.id,
                name: row.name,
                sku: row.sku || "",
                stock: row.stock != null ? row.stock : 0,
                lowStockThreshold: row.low_stock_threshold != null ? row.low_stock_threshold : 5
            };
        })
    });
});

/* =========================
   ADMIN — ORDERS
========================= */

app.get("/api/admin/orders", requireAdmin, function (request, response) {

    const status = String(request.query.status || "").trim();

    const rows = status
        ? db.prepare("SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC").all(status)
        : db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();

    response.json({ orders: rows.map(publicOrder) });
});

app.get("/api/admin/orders/:id", requireAdmin, function (request, response) {

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(request.params.id);

    if (!order) {
        return response.status(404).json({ message: "Order not found." });
    }

    const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(order.id);

    response.json({
        order: Object.assign(publicOrder(order), {
            items: items.map(function (item) {
                return {
                    id: item.id,
                    productId: item.product_id,
                    sellerId: item.seller_id,
                    name: item.name,
                    image: item.image,
                    price: item.price,
                    quantity: item.quantity
                };
            })
        })
    });
});

app.post("/api/admin/orders/:id/status", requireAdmin, function (request, response) {

    const status = String((request.body || {}).status || "").trim();
    const allowed = ["pending", "paid", "processing", "shipped", "delivered", "cancelled"];

    if (!allowed.includes(status)) {
        return response.status(400).json({ message: "Invalid order status." });
    }

    const result = db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Order not found." });
    }

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(request.params.id);
    logActivity("order_status_updated", "Order " + order.order_number + " marked as " + status + ".");

    response.json({ ok: true });
});

/* =========================
   ADMIN — SELLERS
========================= */

app.get("/api/admin/sellers", requireAdmin, function (request, response) {

    const status = String(request.query.status || "").trim();

    const rows = status
        ? db.prepare("SELECT * FROM sellers WHERE status = ? AND email != 'admin@phynex.internal' ORDER BY created_at DESC").all(status)
        : db.prepare("SELECT * FROM sellers WHERE email != 'admin@phynex.internal' ORDER BY created_at DESC").all();

    const orderCountStmt = db.prepare(
        `SELECT COUNT(DISTINCT order_items.order_id) AS c
         FROM order_items JOIN products ON products.id = order_items.product_id
         WHERE products.seller_id = ?`
    );

    response.json({
        sellers: rows.map(function (seller) {
            return {
                id: seller.id,
                name: seller.business_name,
                email: seller.email,
                phone: seller.phone,
                whatsapp: seller.whatsapp || seller.phone || "",
                loggedIn: Boolean(seller.token),
                status: seller.status || "approved",
                orderCount: orderCountStmt.get(seller.id).c
            };
        })
    });
});

app.post("/api/admin/sellers/:id/status", requireAdmin, function (request, response) {

    const status = String((request.body || {}).status || "").trim();
    const allowed = ["pending", "approved", "suspended"];

    if (!allowed.includes(status)) {
        return response.status(400).json({ message: "Invalid seller status." });
    }

    const result = db.prepare("UPDATE sellers SET status = ? WHERE id = ?").run(status, request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Seller not found." });
    }

    const seller = db.prepare("SELECT * FROM sellers WHERE id = ?").get(request.params.id);
    logActivity("seller_status_updated", seller.business_name + " marked as " + status + ".");

    response.json({ ok: true });
});

/* =========================
   ADMIN — CUSTOMERS
========================= */

app.get("/api/admin/customers", requireAdmin, function (request, response) {

    const rows = db.prepare("SELECT * FROM customers ORDER BY created_at DESC").all();

    const orderCountStmt = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE customer_id = ?");

    response.json({
        customers: rows.map(function (customer) {
            return {
                id: customer.id,
                name: customer.name,
                email: customer.email,
                phone: customer.phone,
                loggedIn: Boolean(customer.token) || Boolean(customer.session_token_hash && customer.session_expires > Date.now()),
                status: "approved",
                orderCount: orderCountStmt.get(customer.id).c
            };
        })
    });
});

/* =========================
   ADMIN — CATEGORIES
========================= */

app.get("/api/admin/categories", requireAdmin, function (request, response) {

    const rows = db.prepare("SELECT * FROM categories ORDER BY name ASC").all();

    const countStmt = db.prepare("SELECT COUNT(*) AS c FROM products WHERE category = ?");

    response.json({
        categories: rows.map(function (category) {
            return {
                id: category.id,
                name: category.name,
                slug: category.slug,
                description: category.description,
                productCount: countStmt.get(category.name).c
            };
        })
    });
});

app.post("/api/admin/categories", requireAdmin, function (request, response) {

    const body = request.body || {};
    const name = String(body.name || "").trim();

    if (!name) {
        return response.status(400).json({ message: "Category name is required." });
    }

    const slug = String(body.slug || name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

    try {
        db.prepare(
            "INSERT INTO categories (name, slug, description, created_at) VALUES (?, ?, ?, ?)"
        ).run(name, slug, String(body.description || "").trim(), Date.now());
    } catch (error) {
        return response.status(409).json({ message: "A category with that name already exists." });
    }

    logActivity("category_added", "Added category \"" + name + "\".");

    response.json({ ok: true });
});

/* =========================
   ADMIN — PROMOTIONS
========================= */

app.get("/api/admin/promotions", requireAdmin, function (request, response) {

    const rows = db.prepare("SELECT * FROM promotions ORDER BY created_at DESC").all();

    response.json({
        promotions: rows.map(function (promo) {
            return {
                id: promo.id,
                name: promo.name,
                type: promo.type,
                value: promo.value,
                active: Boolean(promo.active)
            };
        })
    });
});

app.post("/api/admin/promotions", requireAdmin, function (request, response) {

    const body = request.body || {};
    const name = String(body.name || "").trim();

    if (!name) {
        return response.status(400).json({ message: "Promotion name is required." });
    }

    db.prepare(
        "INSERT INTO promotions (name, type, value, active, created_at) VALUES (?, ?, ?, 1, ?)"
    ).run(name, String(body.type || "").trim(), String(body.value || "").trim(), Date.now());

    logActivity("promotion_added", "Added promotion \"" + name + "\".");

    response.json({ ok: true });
});

app.post("/api/admin/promotions/:id/toggle", requireAdmin, function (request, response) {

    const promo = db.prepare("SELECT * FROM promotions WHERE id = ?").get(request.params.id);

    if (!promo) {
        return response.status(404).json({ message: "Promotion not found." });
    }

    const active = promo.active ? 0 : 1;
    db.prepare("UPDATE promotions SET active = ? WHERE id = ?").run(active, promo.id);

    logActivity("promotion_toggled", (active ? "Activated " : "Deactivated ") + "\"" + promo.name + "\".");

    response.json({ ok: true });
});

/* =========================
   ADMIN — REVIEWS
========================= */

app.get("/api/admin/reviews", requireAdmin, function (request, response) {

    const status = String(request.query.status || "").trim();

    const rows = status
        ? db.prepare("SELECT * FROM reviews WHERE status = ? ORDER BY created_at DESC").all(status)
        : db.prepare("SELECT * FROM reviews ORDER BY created_at DESC").all();

    response.json({
        reviews: rows.map(function (review) {
            return {
                id: review.id,
                productId: review.product_id,
                productName: review.product_name,
                customerName: review.customer_name,
                rating: review.rating,
                comment: review.comment,
                status: review.status
            };
        })
    });
});

app.post("/api/admin/reviews/:id/approve", requireAdmin, function (request, response) {

    const result = db.prepare("UPDATE reviews SET status = 'approved' WHERE id = ?").run(request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Review not found." });
    }

    logActivity("review_approved", "Approved review #" + request.params.id + ".");

    response.json({ ok: true });
});

app.delete("/api/admin/reviews/:id", requireAdmin, function (request, response) {

    db.prepare("DELETE FROM reviews WHERE id = ?").run(request.params.id);

    logActivity("review_deleted", "Deleted review #" + request.params.id + ".");

    response.json({ ok: true });
});

/* =========================
   ADMIN — SETTINGS
========================= */

app.get("/api/admin/settings", requireAdmin, function (request, response) {
    response.json({ settings: getSettings() });
});

app.put("/api/admin/settings", requireAdmin, function (request, response) {

    const saved = saveSettings(request.body || {});

    logActivity("settings_saved", "Store settings updated.");

    response.json({ ok: true, settings: saved });
});

/* =========================
   ADMIN — ACTIVITY LOG
========================= */

app.get("/api/admin/activity", requireAdmin, function (request, response) {

    const rows = db.prepare("SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 50").all();

    response.json({
        activity: rows.map(function (row) {
            return {
                action: row.action,
                description: row.description,
                createdAt: new Date(row.created_at).toLocaleString("en-KE")
            };
        })
    });
});

/* =========================
   ADMIN — USER LOGIN / LOGOUT ACTIVITY
========================= */

app.get("/api/admin/login-log", requireAdmin, function (request, response) {

    const userType = String(request.query.userType || "").trim();

    const rows = userType
        ? db.prepare("SELECT * FROM login_log WHERE user_type = ? ORDER BY created_at DESC LIMIT 200").all(userType)
        : db.prepare("SELECT * FROM login_log ORDER BY created_at DESC LIMIT 200").all();

    response.json({
        entries: rows.map(function (row) {
            return {
                userType: row.user_type,
                userId: row.user_id,
                name: row.name,
                email: row.email,
                action: row.action,
                createdAt: new Date(row.created_at).toLocaleString("en-KE")
            };
        })
    });
});

// Who is currently logged in right now (has an active token), for both
// customers and sellers, so the admin can see who's online at a glance.
app.get("/api/admin/online-users", requireAdmin, function (request, response) {

    const sellers = db
        .prepare("SELECT id, business_name AS name, email, phone, whatsapp FROM sellers WHERE token IS NOT NULL AND email != 'admin@phynex.internal'")
        .all()
        .map(function (row) { return Object.assign({ userType: "seller" }, row); });

    const customers = db
        .prepare("SELECT id, name, email, phone FROM customers WHERE token IS NOT NULL")
        .all()
        .map(function (row) { return Object.assign({ userType: "customer" }, row); });

    response.json({ online: sellers.concat(customers) });
});

/* =========================
   M-PESA CONFIGURATION
========================= */

const DELIVERY_FEE = 300; // must match DELIVERY_FEE in script.js

function mpesaConfigured() {
    return Boolean(
        process.env.MPESA_CONSUMER_KEY &&
        process.env.MPESA_CONSUMER_SECRET &&
        process.env.MPESA_PASSKEY &&
        process.env.MPESA_SHORTCODE &&
        process.env.MPESA_CALLBACK_URL
    );
}

function normalizePhone(value) {
    const normalized = normalizeKenyanPhone(value);
    return normalized ? normalized.slice(1) : null;
}

function darajaBaseUrl() {
    return process.env.MPESA_ENV === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";
}

function timestamp() {
    const date = new Date();

    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
        String(date.getHours()).padStart(2, "0"),
        String(date.getMinutes()).padStart(2, "0"),
        String(date.getSeconds()).padStart(2, "0")
    ].join("");
}

async function getAccessToken() {
    const credentials = Buffer.from(
        process.env.MPESA_CONSUMER_KEY + ":" + process.env.MPESA_CONSUMER_SECRET
    ).toString("base64");

    const response = await fetch(
        darajaBaseUrl() + "/oauth/v1/generate?grant_type=client_credentials",
        { headers: { Authorization: "Basic " + credentials } }
    );

    const body = await response.json();

    if (!response.ok || !body.access_token) {
        throw new Error(body.errorMessage || "Unable to authenticate with M-PESA.");
    }

    return body.access_token;
}

/* =========================
   M-PESA STK PUSH
   Creates a real "orders" row (status pending) plus one
   "order_items" row per cart line, then attempts payment.
========================= */

app.post("/api/mpesa/stkpush", requireCustomer, asyncHandler(async function (request, response) {

    if (!mpesaConfigured()) {
        return response.status(503).json({
            message: "M-PESA is not configured yet. Add your Daraja credentials to .env."
        });
    }

    const payload = request.body || {};

    const phone = normalizePhone(payload.mpesaPhone);

    if (!phone) {
        return response.status(400).json({ message: "Enter a valid Kenyan M-PESA number." });
    }

    if (!Array.isArray(payload.items) || payload.items.length === 0) {
        return response.status(400).json({ message: "Your cart is empty." });
    }

    if (payload.items.length > 50) {
        return response.status(400).json({ message: "Too many items in one order." });
    }

    // SECURITY / ACCURACY: never trust prices, names, images or totals sent
    // by the browser. Re-resolve every cart line against the current
    // approved product row so a tampered client can't pay less than the
    // real price (or "buy" a product that no longer exists/was rejected).
    const resolvedItems = [];
    for (const rawItem of payload.items) {
        const productId = Number(rawItem.id);
        const quantity = Math.max(1, Math.min(50, Math.round(Number(rawItem.quantity) || 1)));

        if (!Number.isFinite(productId)) {
            return response.status(400).json({ message: "One of the items in your cart is invalid." });
        }

        const product = db
            .prepare("SELECT * FROM products WHERE id = ? AND status = 'approved'")
            .get(productId);

        if (!product) {
            return response.status(409).json({ message: "An item in your cart is no longer available. Please refresh your cart." });
        }

        resolvedItems.push({
            productId: product.id,
            sellerId: product.seller_id,
            name: product.name,
            image: product.image || "",
            price: product.price,
            quantity: quantity
        });
    }

    const subtotal = resolvedItems.reduce(function (sum, item) {
        return sum + item.price * item.quantity;
    }, 0);
    const amount = subtotal + DELIVERY_FEE;

    if (!Number.isFinite(amount) || amount < 1) {
        return response.status(400).json({ message: "The order total must be at least KSh 1." });
    }

    // ACCURACY: reserve stock atomically (single conditional UPDATE per
    // item — safe even under concurrent checkouts) before we ever contact
    // M-PESA, so two customers can't both "successfully" pay for the same
    // last unit. Anything reserved here is released again if the STK push
    // fails to send or if the payment is later declined/expires.
    const reservation = reserveStock(resolvedItems);
    if (!reservation.ok) {
        const outOfStockItem = resolvedItems.find(function (item) { return item.productId === reservation.productId; });
        return response.status(409).json({
            message: (outOfStockItem ? outOfStockItem.name : "An item") + " doesn't have enough stock for that quantity."
        });
    }

    const customer = request.customer;
    const customerInfo = {
        name: customer.name,
        email: customer.email,
        phone: customer.phone
    };
    const delivery = payload.delivery || {};

    try {

        const accessToken = await getAccessToken();
        const requestTimestamp = timestamp();

        const password = Buffer.from(
            process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + requestTimestamp
        ).toString("base64");

        const darajaResponse = await fetch(
            darajaBaseUrl() + "/mpesa/stkpush/v1/processrequest",
            {
                method: "POST",
                headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
                body: JSON.stringify({
                    BusinessShortCode: process.env.MPESA_SHORTCODE,
                    Password: password,
                    Timestamp: requestTimestamp,
                    TransactionType: "CustomerPayBillOnline",
                    Amount: amount,
                    PartyA: phone,
                    PartyB: process.env.MPESA_SHORTCODE,
                    PhoneNumber: phone,
                    CallBackURL: process.env.MPESA_CALLBACK_URL,
                    AccountReference: "PHYNEX",
                    TransactionDesc: "PHYNEX order payment"
                })
            }
        );

        const result = await darajaResponse.json();

        if (!darajaResponse.ok || !result.CheckoutRequestID) {
            releaseStock(resolvedItems);
            return response.status(502).json({
                message: result.errorMessage || result.ResponseDescription || "M-PESA rejected the STK Push request."
            });
        }

        const orderNumber = generateOrderNumber();

        const orderResult = db
            .prepare(
                `INSERT INTO orders
                    (order_number, customer_id, customer_name, customer_email, customer_phone,
                     county, location, address, instructions, subtotal, delivery_fee, total,
                     payment_method, payment_status, status, checkout_request_id, stock_deducted, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mpesa', 'pending', 'pending', ?, 1, ?)`
            )
            .run(
                orderNumber,
                customer ? customer.id : null,
                String(customerInfo.name || (customer && customer.name) || "").trim(),
                String(customerInfo.email || (customer && customer.email) || "").trim(),
                String(customerInfo.phone || payload.mpesaPhone || "").trim(),
                String(delivery.county || "").trim(),
                String(delivery.location || "").trim(),
                String(delivery.address || "").trim(),
                String(delivery.instructions || "").trim(),
                subtotal,
                DELIVERY_FEE,
                amount,
                result.CheckoutRequestID,
                Date.now()
            );

        const orderId = orderResult.lastInsertRowid;

        const insertItem = db.prepare(
            "INSERT INTO order_items (order_id, product_id, seller_id, name, image, price, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)"
        );

        resolvedItems.forEach(function (item) {
            insertItem.run(
                orderId,
                item.productId,
                item.sellerId,
                item.name,
                item.image,
                item.price,
                item.quantity
            );
        });

        payments.set(result.CheckoutRequestID, {
            status: "pending",
            orderNumber: orderNumber,
            orderId: orderId,
            amount: amount,
            phone: phone,
            createdAt: Date.now()
        });

        logActivity("order_created", "Order " + orderNumber + " created (awaiting payment).");

        return response.json({
            checkoutRequestId: result.CheckoutRequestID,
            orderNumber: orderNumber,
            customerMessage: result.CustomerMessage || "M-PESA payment request sent."
        });

    } catch (error) {
        releaseStock(resolvedItems);
        return response.status(502).json({ message: error.message || "Unable to reach M-PESA." });
    }
}));

/* =========================
   M-PESA CALLBACK
========================= */

/* =========================
   STOCK — deduct once an order is actually paid
========================= */

function deductStockForOrder(orderId) {

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);

    if (!order || order.stock_deducted) {
        return; // already reserved/deducted before, or order missing — never deduct twice
    }

    const items = db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?").all(orderId);

    const updateStock = db.prepare(
        "UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?"
    );

    items.forEach(function (item) {
        if (item.product_id) {
            updateStock.run(item.quantity, item.product_id);
        }
    });

    db.prepare("UPDATE orders SET stock_deducted = 1 WHERE id = ?").run(orderId);
}

// ACCURACY: atomic stock reservation so two concurrent checkouts can never
// both "win" the last unit of a product. better-sqlite3 runs each
// statement synchronously/to completion, so a single conditional UPDATE
// (stock >= requested quantity) is a safe compare-and-swap even under
// concurrent requests — there's no window for another request to read a
// stale stock value between the check and the write.
function reserveStock(items) {
    const reserved = [];
    const reserveStmt = db.prepare(
        "UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?"
    );

    for (const item of items) {
        const result = reserveStmt.run(item.quantity, item.productId, item.quantity);
        if (result.changes !== 1) {
            releaseStock(reserved);
            return { ok: false, productId: item.productId };
        }
        reserved.push(item);
    }

    return { ok: true };
}

function releaseStock(items) {
    const releaseStmt = db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?");
    (items || []).forEach(function (item) {
        if (item.productId) releaseStmt.run(item.quantity, item.productId);
    });
}

// Undo a reservation made at STK-push time for an order whose payment
// ultimately failed or was never completed (declined, cancelled, or the
// customer simply never entered their M-PESA PIN so no callback arrives).
function releaseStockForOrder(orderId) {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!order || !order.stock_deducted) return;

    const items = db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?").all(orderId);
    releaseStock(
        items
            .filter(function (item) { return item.product_id; })
            .map(function (item) { return { productId: item.product_id, quantity: item.quantity }; })
    );

    db.prepare("UPDATE orders SET stock_deducted = 0 WHERE id = ?").run(orderId);
}

app.post("/api/mpesa/callback", function (request, response) {

    const callback = request.body && request.body.Body && request.body.Body.stkCallback;

    if (callback && callback.CheckoutRequestID) {

        const payment = payments.get(callback.CheckoutRequestID) || {
            status: "pending",
            createdAt: Date.now()
        };

        const paid = Number(callback.ResultCode) === 0;

        payment.status = paid ? "paid" : "failed";
        payment.message = callback.ResultDesc || "M-PESA callback received.";

        payments.set(callback.CheckoutRequestID, payment);

        if (payment.orderId) {
            db.prepare(
                "UPDATE orders SET payment_status = ?, status = ? WHERE id = ?"
            ).run(paid ? "paid" : "failed", paid ? "paid" : "cancelled", payment.orderId);

            if (paid) {
                deductStockForOrder(payment.orderId); // no-op safety net; stock was already reserved at checkout
            } else {
                releaseStockForOrder(payment.orderId); // payment declined/cancelled — give the stock back
            }

            logActivity(
                paid ? "order_paid" : "order_payment_failed",
                "Order " + (payment.orderNumber || payment.orderId) + (paid ? " was paid." : " payment failed.")
            );
        }
    }

    response.json({ ResultCode: 0, ResultDesc: "Callback received" });
});

/* =========================
   CHECK PAYMENT STATUS
========================= */

app.get("/api/mpesa/status/:checkoutRequestId", requireCustomer, function (request, response) {

    const payment = payments.get(request.params.checkoutRequestId);

    if (!payment) {
        return response.status(404).json({ status: "unknown", message: "Payment request not found." });
    }

    const order = db.prepare("SELECT customer_id FROM orders WHERE id = ?").get(payment.orderId);
    if (!order || order.customer_id !== request.customer.id) {
        return response.status(404).json({ status: "unknown", message: "Payment request not found." });
    }

    return response.json(payment);
});

/* =========================
   CONTACT FORM
========================= */

function contactMailConfigured() {
    return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD);
}

const mailTransporter = contactMailConfigured()
    ? nodemailer.createTransport({
        host: process.env.EMAIL_HOST || "smtp.gmail.com",
        port: Number(process.env.EMAIL_PORT) || 587,
        secure: Number(process.env.EMAIL_PORT) === 465,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
    })
    : null;

const contactRateLimit = new Map();
const CONTACT_WINDOW_MS = 10 * 60 * 1000;
const CONTACT_MAX_PER_WINDOW = 5;

function isRateLimited(ip) {
    const now = Date.now();
    const entry = contactRateLimit.get(ip);

    if (!entry || now - entry.windowStart > CONTACT_WINDOW_MS) {
        contactRateLimit.set(ip, { windowStart: now, count: 1 });
        return false;
    }

    entry.count += 1;

    return entry.count > CONTACT_MAX_PER_WINDOW;
}

app.post("/api/contact", asyncHandler(async function (request, response) {

    if (!contactMailConfigured()) {
        return response.status(503).json({
            message: "Contact form is not configured yet. Add EMAIL_USER and EMAIL_PASSWORD to .env."
        });
    }

    if (isRateLimited(request.ip)) {
        return response.status(429).json({ message: "Too many messages sent. Please try again later." });
    }

    const body = request.body || {};

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    const message = String(body.message || "").trim();

    if (!name || !email || !message) {
        return response.status(400).json({ message: "Please fill in all fields." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return response.status(400).json({ message: "Enter a valid email address." });
    }

    if (name.length > 200) {
        return response.status(400).json({ message: "Name is too long." });
    }

    if (message.length > 5000) {
        return response.status(400).json({ message: "Message is too long." });
    }

    try {

        await mailTransporter.sendMail({
            from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
            to: process.env.CONTACT_TO || process.env.EMAIL_USER,
            replyTo: email,
            subject: "New PHYNEX contact form message from " + name,
            text: "From: " + name + " <" + email + ">\n\n" + message
        });

        return response.json({ ok: true });

    } catch (error) {
        console.error("Contact form email failed:", error.message);
        return response.status(502).json({ message: "Could not send message. Please try again later." });
    }
}));

/* =========================
   SERVER HEALTH
========================= */

app.get("/api/health", function (_request, response) {
    response.json({
        ok: true,
        mpesaConfigured: mpesaConfigured(),
        contactMailConfigured: contactMailConfigured(),
        emailVerificationConfigured: emailVerificationConfigured(),
        googleConfigured: googleConfigured(),
        phoneVerificationConfigured: smsVerificationConfigured(),
        adminConfigured: Boolean(process.env.ADMIN_PASSWORD)
    });
});

/* =========================
   PUBLIC CONFIG
   Non-secret values the front-end needs (e.g. the Google Sign-In
   client ID, which is public by design — never the client secret).
========================= */

app.get("/api/config", function (_request, response) {
    response.json({
        googleClientId: googleConfigured() ? process.env.GOOGLE_CLIENT_ID : null
    });
});

/* =========================
   STALE RESERVATION SWEEP
   If a customer abandons the M-PESA prompt (never enters their PIN, or
   the callback simply never arrives), stock reserved for that order would
   otherwise stay locked forever and show as falsely out of stock. Every
   few minutes, release the reservation on any mpesa order that has sat
   "pending" too long.
========================= */

const STALE_ORDER_MS = 20 * 60 * 1000; // 20 minutes with no callback

function releaseStaleReservations() {
    const cutoff = Date.now() - STALE_ORDER_MS;
    const stale = db
        .prepare(
            `SELECT id, order_number FROM orders
             WHERE payment_method = 'mpesa' AND status = 'pending'
               AND stock_deducted = 1 AND created_at < ?`
        )
        .all(cutoff);

    stale.forEach(function (order) {
        releaseStockForOrder(order.id);
        db.prepare("UPDATE orders SET status = 'cancelled', payment_status = 'failed' WHERE id = ?").run(order.id);
        logActivity("order_expired", "Order " + order.order_number + " expired with no payment confirmation; stock released.");
    });
}

setInterval(releaseStaleReservations, 5 * 60 * 1000);

/* =========================
   JSON 404 + ERROR HANDLERS
   Must be registered after every route above. Without these, an unknown
   path or an uncaught exception falls through to Express's default HTML
   error page — which breaks every frontend `await response.json()` call
   and shows a misleading "Network error" even though the request did
   reach the server.
========================= */

app.use(function (request, response) {
    response.status(404).json({ message: "Not found." });
});

app.use(function (error, request, response, next) {
    console.error("Unhandled request error:", error);
    if (response.headersSent) return next(error);
    response.status(500).json({ message: "Something went wrong on our end. Please try again." });
});

/* =========================
   START SERVER
========================= */

app.listen(port, function () {
    console.log("PHYNEX server running at http://localhost:" + port);
    releaseStaleReservations();
});
