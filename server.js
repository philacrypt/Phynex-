const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const { OAuth2Client } = require("google-auth-library");
const { suggestCategory } = require("./lib/categorizer");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT) || 3000;

const payments = new Map();

function escapeEmailHtml(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function moneyKsh(amount) {
    return "KSh " + Number(amount || 0).toLocaleString("en-KE");
}

// Sends the "your order is confirmed / paid" email. Called once, right
// after an M-PESA callback marks an order as paid. Never throws — a
// failed email must not affect payment processing or the customer's
// order status, so failures are only logged server-side.
async function sendOrderConfirmationEmail(order, items) {
    if (!mailTransporter || !order || !order.customer_email) return;

    const itemsText = (items || [])
        .map(function (item) {
            return "- " + item.name + " x " + item.quantity + " (" + moneyKsh(item.price * item.quantity) + ")";
        })
        .join("\n");

    const itemsHtml = (items || [])
        .map(function (item) {
            return "<tr>" +
                "<td style=\"padding:6px 10px;border-bottom:1px solid #eee;\">" + escapeEmailHtml(item.name) + "</td>" +
                "<td style=\"padding:6px 10px;border-bottom:1px solid #eee;text-align:center;\">" + Number(item.quantity) + "</td>" +
                "<td style=\"padding:6px 10px;border-bottom:1px solid #eee;text-align:right;\">" + moneyKsh(item.price * item.quantity) + "</td>" +
                "</tr>";
        })
        .join("");

    try {
        await mailTransporter.sendMail({
            from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
            to: order.customer_email,
            subject: "PHYNEX order " + order.order_number + " confirmed",
            text:
                "Hi " + (order.customer_name || "there") + ",\n\n" +
                "We've received your M-PESA payment and your order is confirmed.\n\n" +
                "Order number: " + order.order_number + "\n" +
                "Items:\n" + itemsText + "\n\n" +
                "Subtotal: " + moneyKsh(order.subtotal) + "\n" +
                "Delivery fee: " + moneyKsh(order.delivery_fee) + "\n" +
                "Total paid: " + moneyKsh(order.total) + "\n\n" +
                "Delivery address: " + [order.address, order.location, order.county].filter(Boolean).join(", ") + "\n\n" +
                "We'll email you again as your order is dispatched and delivered.\n\n" +
                "Thank you for shopping with PHYNEX!\nThe PHYNEX Team",
            html:
                "<p>Hi " + escapeEmailHtml(order.customer_name || "there") + ",</p>" +
                "<p>We've received your M-PESA payment and your order is <strong>confirmed</strong>.</p>" +
                "<p><strong>Order number:</strong> " + escapeEmailHtml(order.order_number) + "</p>" +
                "<table style=\"border-collapse:collapse;width:100%;max-width:480px;\">" +
                "<thead><tr>" +
                "<th style=\"text-align:left;padding:6px 10px;border-bottom:2px solid #071a49;\">Item</th>" +
                "<th style=\"padding:6px 10px;border-bottom:2px solid #071a49;\">Qty</th>" +
                "<th style=\"text-align:right;padding:6px 10px;border-bottom:2px solid #071a49;\">Amount</th>" +
                "</tr></thead><tbody>" + itemsHtml + "</tbody></table>" +
                "<p><strong>Subtotal:</strong> " + moneyKsh(order.subtotal) + "<br>" +
                "<strong>Delivery fee:</strong> " + moneyKsh(order.delivery_fee) + "<br>" +
                "<strong>Total paid:</strong> " + moneyKsh(order.total) + "</p>" +
                "<p><strong>Delivery address:</strong> " + escapeEmailHtml([order.address, order.location, order.county].filter(Boolean).join(", ")) + "</p>" +
                "<p>We'll email you again as your order is dispatched and delivered.</p>" +
                "<p>Thank you for shopping with PHYNEX!<br>The PHYNEX Team</p>"
        });
    } catch (error) {
        console.error("Order confirmation email failed for order " + order.order_number + ":", error.message);
    }
}

// Lightweight status-change email for later stages (dispatched/delivered).
// Same never-throw guarantee as sendOrderConfirmationEmail above.
async function sendOrderStatusEmail(order, status) {
    if (!mailTransporter || !order || !order.customer_email) return;

    const labels = {
        processing: "is now being processed",
        shipped: "has been dispatched for delivery",
        delivered: "has been delivered",
        cancelled: "has been cancelled"
    };

    const label = labels[status];
    if (!label) return; // no email for statuses we don't have copy for (e.g. "pending", "paid")

    try {
        await mailTransporter.sendMail({
            from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
            to: order.customer_email,
            subject: "PHYNEX order " + order.order_number + " update",
            text: "Hi " + (order.customer_name || "there") + ",\n\nYour order " + order.order_number + " " + label + ".\n\nThe PHYNEX Team",
            html: "<p>Hi " + escapeEmailHtml(order.customer_name || "there") + ",</p>" +
                "<p>Your order <strong>" + escapeEmailHtml(order.order_number) + "</strong> " + label + ".</p>" +
                "<p>The PHYNEX Team</p>"
        });
    } catch (error) {
        console.error("Order status email failed for order " + order.order_number + ":", error.message);
    }
}

async function sendWelcomeEmail(toEmail, toName) {
    if (!mailTransporter || !toEmail) return;

    try {
        await mailTransporter.sendMail({
            from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
            to: toEmail,
            subject: "Welcome to PHYNEX!",
            text: "Hi " + (toName || "there") + ",\n\n" +
                "Welcome to PHYNEX! Your account has been created and you're all set to start shopping " +
                "for great deals from trusted sellers.\n\n" +
                "Happy shopping!\nThe PHYNEX Team",
            html: "<p>Hi " + escapeEmailHtml(toName || "there") + ",</p>" +
                "<p>Welcome to <strong>PHYNEX</strong>! Your account has been created and you're all set to start " +
                "shopping for great deals from trusted sellers.</p>" +
                "<p>Happy shopping!<br>The PHYNEX Team</p>"
        });
    } catch (error) {
        // Don't fail signup if the welcome email can't be sent — just log it.
        console.error("Welcome email failed:", error.message);
    }
}

app.use(express.json({ limit: "100kb" }));

// If the request body isn't valid JSON (or is too large), express.json()
// throws before any route handler runs. Without this, Express's default
// error page (HTML) would be sent back to a fetch() call expecting JSON,
// causing the browser-side "Unexpected token '<' ... is not valid JSON"
// error. Catch it here and always answer API-style requests in JSON.
app.use(function (error, request, response, next) {
    if (error && error.type === "entity.parse.failed") {
        return response.status(400).json({ message: "Malformed request body." });
    }
    if (error && error.type === "entity.too.large") {
        return response.status(413).json({ message: "Request body is too large." });
    }
    next(error);
});

app.use(express.static(__dirname));

/* =========================
   DATABASE
========================= */

const DATA_DIR = process.env.PHYNEX_DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!process.env.PHYNEX_DATA_DIR) {
    console.warn(
        "\n*** PHYNEX WARNING ***\n" +
        "PHYNEX_DATA_DIR is not set, so the database and uploaded images are\n" +
        "being stored inside the app's own code folder. On Render (and most\n" +
        "hosts) this folder is WIPED on every redeploy/restart, which means\n" +
        "every product, order, seller and image will be permanently lost the\n" +
        "next time this service redeploys or restarts.\n" +
        "Fix: attach a Persistent Disk to this service in the Render\n" +
        "dashboard (Settings -> Disks), mount it at e.g. /data, and set the\n" +
        "environment variable PHYNEX_DATA_DIR=/data. See README-FIXES.md.\n" +
        "***********************\n"
    );
}

const db = new Database(path.join(DATA_DIR, "phynex.db"));
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

    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
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
    }
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
ensureColumn("customers", "token_expires", "INTEGER");
ensureColumn("sellers", "token_expires", "INTEGER");
ensureColumn("products", "deleted_at", "INTEGER");
ensureColumn("orders", "updated_at", "INTEGER");
ensureColumn("orders", "reservation_expires", "INTEGER");
ensureColumn("products", "reserved_stock", "INTEGER DEFAULT 0");
ensureColumn("products", "dispatch_location", "TEXT");
ensureColumn("products", "return_policy", "TEXT");

const DEFAULT_CATEGORIES = [
    ["Phones & Tablets","phones-tablets","Mobile phones, tablets and accessories"],
    ["Computers & Laptops","computers-laptops","Laptops, desktops, monitors and computer accessories"],
    ["Electronics","electronics","TVs, audio, smart devices and electronics"],
    ["Gaming","gaming","Consoles, games, controllers and gaming accessories"],
    ["Clothing & Fashion","clothing-fashion","Clothing, fashion wear and style accessories"],
    ["Shoes & Bags","shoes-bags","Shoes, handbags, backpacks and travel bags"],
    ["Beauty & Personal Care","beauty-personal-care","Beauty, cosmetics and personal-care products"],
    ["Home & Garden","home-garden","Home improvement, decor, garden and outdoor home items"],
    ["Furniture","furniture","Beds, sofas, tables, chairs and storage"],
    ["Appliances","appliances","Kitchen, laundry, cooling and household appliances"],
    ["Accessories","accessories","General accessories that don't belong to one specific department"],
    ["Home & Office","home-office","Home organization, office supplies and small home/office essentials"],
    ["Grocery","grocery","Food, beverages and everyday household consumables"],
    ["Health & Wellness","health-wellness","Wellness and non-prescription health products"],
    ["Baby & Kids","baby-kids","Baby products, toys, kids clothing and essentials"],
    ["Sports & Outdoors","sports-outdoors","Sports equipment, fitness and outdoor gear"],
    ["Automotive","automotive","Car, motorcycle and vehicle parts and accessories"],
    ["Books & Stationery","books-stationery","Books, school, office and stationery supplies"],
    ["Jewelry & Watches","jewelry-watches","Jewelry, watches and accessories"],
    ["Cameras & Photography","cameras-photography","Cameras, lenses and photography equipment"],
    ["Pet Supplies","pet-supplies","Pet food, accessories and supplies"],
    ["Industrial & Tools","industrial-tools","Tools, hardware, machinery and business equipment"],
    ["Services","services","Local and professional services"],
    ["Vehicles","vehicles","Cars, motorbikes, trucks and other vehicles for sale"],
    ["Musical Instruments","musical-instruments","Guitars, keyboards, drums and other musical instruments"],
    ["Solar & Power Equipment","solar-power","Solar panels, inverters, solar batteries and backup power equipment"],
    ["Agriculture & Farm Supplies","agriculture-farm-supplies","Farm equipment, animal feed, fertilizer and agricultural supplies"],
    ["Building & Construction Materials","building-construction","Cement, roofing, tiles, timber and other construction materials"],
    ["Party & Event Supplies","party-event-supplies","Decorations, tents and supplies for parties, weddings and events"],
    ["Security & Safety Equipment","security-safety","CCTV, alarms, fire safety and personal safety equipment"],
    ["Lighting & Electrical","lighting-electrical","Bulbs, fittings, cables and electrical accessories"],
    ["Kitchenware & Dining","kitchenware-dining","Cookware, cutlery, dinner sets and kitchen essentials"],
    ["Bedding & Linen","bedding-linen","Bed sheets, mosquito nets, towels and household linen"],
    ["Wedding & Bridal","wedding-bridal","Wedding gowns, bridal wear and bridal party attire"],
    ["Underwear & Lingerie","underwear-lingerie","Underwear, lingerie and intimate apparel"],
    ["Maternity & Nursing","maternity-nursing","Maternity wear and nursing essentials for expecting and new mothers"],
    ["Digital Products & Gift Cards","digital-gift-cards","Gift cards, airtime vouchers, software licenses and digital codes"],
    ["Other","other","Other products that do not fit another category"]
];

const seedCategory = db.prepare(
    "INSERT OR IGNORE INTO categories (name, slug, description, created_at) VALUES (?, ?, ?, ?)"
);
for (const category of DEFAULT_CATEGORIES) {
    seedCategory.run(category[0], category[1], category[2], Date.now());
}

/* One-time rename: the "Fashion" category was renamed to "Clothing &
   Fashion" so it clearly matches what sellers/customers actually call
   it ("clothing"). This updates any already-seeded category row and
   any products already saved under the old name, so nothing already
   listed as "Fashion" silently disappears from its category page. */
db.prepare(
    "UPDATE categories SET name = 'Clothing & Fashion', slug = 'clothing-fashion', description = 'Clothing, fashion wear and style accessories' WHERE name = 'Fashion'"
).run();
db.prepare(
    "UPDATE products SET category = 'Clothing & Fashion' WHERE category = 'Fashion'"
).run();

/* =========================
   AI AUTO-CATEGORIZATION
   Suggests a category (and subcategory, where relevant) for a
   product from its name/description/specifications so listings
   land in the right place automatically - e.g. any laptop ends
   up under "Computers & Laptops" even if the seller picked the
   wrong category or left it blank. It only overrides a clear,
   high-confidence match (like "laptop"); for everything else it
   only fills in a category the seller left empty, so it never
   fights a seller's deliberate choice for products that don't
   have to live in a specific category.
========================= */

function getCategoryNames() {
    return db.prepare("SELECT name FROM categories").all().map(function (row) { return row.name; });
}

function applyAutoCategory(input) {

    const chosenCategory = String(input.category || "").trim();
    const chosenSubcategory = String(input.subcategory || "").trim();

    let suggestion = null;

    try {
        suggestion = suggestCategory(
            {
                name: input.name,
                description: input.description,
                specifications: input.specifications,
                brand: input.brand,
                tags: input.tags
            },
            getCategoryNames()
        );
    } catch (error) {
        suggestion = null;
    }

    if (!suggestion) {
        return { category: chosenCategory, subcategory: chosenSubcategory };
    }

    if (suggestion.confidence === "high") {
        // Confident match (e.g. "laptop") - always route it correctly.
        return {
            category: suggestion.category,
            subcategory: suggestion.subcategory || chosenSubcategory
        };
    }

    // Lower-confidence match - only use it if the seller/admin didn't
    // already choose a category themselves.
    if (!chosenCategory) {
        return {
            category: suggestion.category,
            subcategory: chosenSubcategory || suggestion.subcategory || ""
        };
    }

    return { category: chosenCategory, subcategory: chosenSubcategory };
}

/* =========================
   SMALL HELPERS
========================= */

function newToken() {
    return crypto.randomBytes(24).toString("hex");
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
    deliveryFee: 0,
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
        hasGoogle: Boolean(customer.google_id)
    };
}

function googleConfigured() {
    return Boolean(process.env.GOOGLE_CLIENT_ID);
}

const googleClient = googleConfigured() ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

function publicProduct(product) {

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

    return {
        id: product.id,
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
        dispatchLocation: product.dispatch_location || "",
        returnPolicy: product.return_policy || "",
        tags: product.tags || "",
        featured: Boolean(product.featured),
        sku: product.sku || "",
        stock: product.stock != null ? Math.max(0, Number(product.stock) - Number(product.reserved_stock || 0)) : 0,
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
        .prepare("SELECT * FROM sellers WHERE token = ? AND (token_expires IS NULL OR token_expires > ?)")
        .get(token, Date.now());

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

const authAttempts = new Map();
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 8;
function authRateLimited(request, identity) {
    const key = String(request.ip || "unknown") + ":" + String(identity || "").toLowerCase();
    const now = Date.now();
    const row = authAttempts.get(key);
    if (!row || now - row.startedAt > AUTH_WINDOW_MS) {
        authAttempts.set(key, { startedAt: now, count: 1 });
        return false;
    }
    row.count += 1;
    return row.count > AUTH_MAX_ATTEMPTS;
}

app.post("/api/admin/login", function (request, response) {

    const password = String((request.body || {}).password || "");

    if (authRateLimited(request, "admin")) {
        return response.status(429).json({ message: "Too many login attempts. Please try again in 15 minutes." });
    }

    if (!process.env.ADMIN_PASSWORD) {
        return response.status(503).json({
            message: "Admin login is not configured yet. Set ADMIN_PASSWORD in .env."
        });
    }

    if (password !== process.env.ADMIN_PASSWORD) {
        return response.status(401).json({ message: "Incorrect admin password." });
    }

    const token = newToken();
    adminTokens.add(token);

    response.json({ token: token });
});

/* =========================
   CUSTOMER AUTH MIDDLEWARE
========================= */

function requireCustomer(request, response, next) {

    const header = request.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!token) {
        return response.status(401).json({ message: "Please log in to continue." });
    }

    const customer = db
        .prepare("SELECT * FROM customers WHERE token = ? AND (token_expires IS NULL OR token_expires > ?)")
        .get(token, Date.now());

    if (!customer) {
        return response.status(401).json({ message: "Your session has expired. Please log in again." });
    }

    request.customer = customer;
    next();
}

/* =========================
   CUSTOMER REGISTER / LOGIN
========================= */

app.post("/api/customers/register", async function (request, response) {

    const body = request.body || {};

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const password = String(body.password || "");

    if (!name || !email || !password) {
        return response.status(400).json({ message: "Name, email and password are required." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return response.status(400).json({ message: "Enter a valid email address." });
    }

    if (password.length < 8) {
        return response.status(400).json({ message: "Password must be at least 8 characters." });
    }

    const existing = db.prepare("SELECT id FROM customers WHERE email = ?").get(email);

    if (existing) {
        return response.status(409).json({ message: "An account with that email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const token = newToken();

    const result = db
        .prepare(
            `INSERT INTO customers (name, email, phone, password_hash, token, token_expires, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(name, email, phone, passwordHash, token, Date.now() + 7 * 24 * 60 * 60 * 1000, Date.now());

    const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(result.lastInsertRowid);

    logLogin("customer", customer, "register");

    sendWelcomeEmail(customer.email, customer.name);

    response.json({ token: token, customer: publicCustomer(customer) });
});

app.post("/api/customers/login", async function (request, response) {

    const body = request.body || {};

    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (authRateLimited(request, email)) {
        return response.status(429).json({ message: "Too many login attempts. Please try again in 15 minutes." });
    }

    const customer = db.prepare("SELECT * FROM customers WHERE email = ?").get(email);

    if (!customer) {
        return response.status(401).json({ message: "Incorrect email or password." });
    }

    const valid = await bcrypt.compare(password, customer.password_hash);

    if (!valid) {
        return response.status(401).json({ message: "Incorrect email or password." });
    }

    const token = newToken();

    db.prepare("UPDATE customers SET token = ?, token_expires = ? WHERE id = ?").run(token, Date.now() + 7 * 24 * 60 * 60 * 1000, customer.id);

    logLogin("customer", customer, "login");

    response.json({ token: token, customer: publicCustomer(customer) });
});

app.post("/api/customers/google", async function (request, response) {

    if (!googleConfigured() || !googleClient) {
        return response.status(503).json({ message: "Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID to .env." });
    }

    const credential = String((request.body || {}).credential || "");

    if (!credential) {
        return response.status(400).json({ message: "Missing Google credential." });
    }

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
    let isNewCustomer = false;

    if (customer) {
        if (!customer.google_id) {
            db.prepare("UPDATE customers SET google_id = ? WHERE id = ?").run(googleId, customer.id);
        }
    } else {
        const placeholderHash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);

        const result = db
            .prepare(
                `INSERT INTO customers (name, email, phone, password_hash, google_id, token, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(name, email, "", placeholderHash, googleId, "", Date.now());

        customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(result.lastInsertRowid);
        isNewCustomer = true;
    }

    const token = newToken();

    db.prepare("UPDATE customers SET token = ?, token_expires = ? WHERE id = ?").run(token, Date.now() + 7 * 24 * 60 * 60 * 1000, customer.id);

    customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(customer.id);

    logLogin("customer", customer, "google");

    if (isNewCustomer) {
        sendWelcomeEmail(customer.email, customer.name);
    }

    response.json({ token: token, customer: publicCustomer(customer) });
});

app.post("/api/customers/forgot-password", async function (request, response) {

    const email = String((request.body || {}).email || "").trim().toLowerCase();

    if (!email) {
        return response.status(400).json({ message: "Enter your account email." });
    }

    const customer = db.prepare("SELECT * FROM customers WHERE email = ?").get(email);

    // Always reply the same way whether or not the email exists,
    // so this endpoint can't be used to check who has an account.
    const genericReply = { ok: true, message: "If that email has an account, a reset link has been sent." };

    if (!customer) {
        return response.json(genericReply);
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const expires = Date.now() + 60 * 60 * 1000; // 1 hour

    db.prepare("UPDATE customers SET reset_token = ?, reset_token_expires = ? WHERE id = ?")
        .run(resetToken, expires, customer.id);

    const resetUrl = (process.env.APP_URL || "").replace(/\/$/, "") +
        "/customer-reset-password.html?token=" + resetToken;

    if (mailTransporter) {
        try {
            await mailTransporter.sendMail({
                from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
                to: customer.email,
                subject: "Reset your PHYNEX password",
                text: "Reset your password here: " + resetUrl + "\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.",
                html: "<p>Reset your PHYNEX password by clicking the link below:</p>" +
                    "<p><a href=\"" + resetUrl + "\">" + resetUrl + "</a></p>" +
                    "<p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>"
            });
        } catch (error) {
            // Don't leak email-sending failures to the client — log it server-side instead.
            console.error("Password reset email failed:", error.message);
        }
    } else {
        console.log("PHYNEX password reset link for " + customer.email + ": " + resetUrl);
    }

    response.json(genericReply);
});

app.post("/api/customers/reset-password", async function (request, response) {

    const body = request.body || {};
    const token = String(body.token || "").trim();
    const password = String(body.password || "");

    if (!token) {
        return response.status(400).json({ message: "Missing or invalid reset link." });
    }

    if (password.length < 8) {
        return response.status(400).json({ message: "Password must be at least 8 characters." });
    }

    const customer = db.prepare(
        "SELECT * FROM customers WHERE reset_token = ? AND reset_token_expires > ?"
    ).get(token, Date.now());

    if (!customer) {
        return response.status(400).json({ message: "This reset link is invalid or has expired." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const sessionToken = newToken();

    db.prepare(
        "UPDATE customers SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, token = ? WHERE id = ?"
    ).run(passwordHash, sessionToken, customer.id);

    const updated = db.prepare("SELECT * FROM customers WHERE id = ?").get(customer.id);

    logLogin("customer", updated, "password_reset");

    response.json({ token: sessionToken, customer: publicCustomer(updated) });
});

app.get("/api/customers/me", requireCustomer, function (request, response) {
    response.json({ customer: publicCustomer(request.customer) });
});

app.post("/api/customers/logout", requireCustomer, function (request, response) {
    db.prepare("UPDATE customers SET token = NULL WHERE id = ?").run(request.customer.id);
    logLogin("customer", request.customer, "logout");
    response.json({ ok: true });
});

app.get("/api/customers/orders", requireCustomer, function (request, response) {

    const rows = db
        .prepare("SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC")
        .all(request.customer.id);

    const orders = rows.map(function (order) {
        const items = db
            .prepare("SELECT id, product_id AS productId, name, image, price, quantity FROM order_items WHERE order_id = ?")
            .all(order.id);

        return Object.assign(publicOrder(order), { items: items });
    });

    response.json({ orders: orders });
});

/* =========================
   SELLER REGISTER / LOGIN
========================= */

app.post("/api/sellers/register", async function (request, response) {

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

    if (password.length < 8) {
        return response.status(400).json({ message: "Password must be at least 8 characters." });
    }

    const existing = db.prepare("SELECT id FROM sellers WHERE email = ?").get(email);

    if (existing) {
        return response.status(409).json({ message: "An account with that email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const token = newToken();

    const result = db
        .prepare(
            `INSERT INTO sellers (business_name, email, phone, whatsapp, password_hash, token, token_expires, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?)`
        )
        .run(businessName, email, phone, whatsapp, passwordHash, token, Date.now() + 7 * 24 * 60 * 60 * 1000, Date.now());

    const seller = db.prepare("SELECT * FROM sellers WHERE id = ?").get(result.lastInsertRowid);

    logActivity("seller_registered", businessName + " created a seller account.");
    logLogin("seller", seller, "register");

    sendWelcomeEmail(seller.email, seller.business_name);

    response.json({ token: token, seller: publicSeller(seller) });
});

app.post("/api/sellers/login", async function (request, response) {

    const body = request.body || {};

    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (authRateLimited(request, email)) {
        return response.status(429).json({ message: "Too many login attempts. Please try again in 15 minutes." });
    }

    const seller = db.prepare("SELECT * FROM sellers WHERE email = ?").get(email);

    if (!seller) {
        return response.status(401).json({ message: "Incorrect email or password." });
    }

    const valid = await bcrypt.compare(password, seller.password_hash);

    if (!valid) {
        return response.status(401).json({ message: "Incorrect email or password." });
    }

    if (seller.status === "suspended") {
        return response.status(403).json({ message: "Your seller account has been suspended. Contact PHYNEX support." });
    }

    const token = newToken();

    db.prepare("UPDATE sellers SET token = ?, token_expires = ? WHERE id = ?").run(token, Date.now() + 7 * 24 * 60 * 60 * 1000, seller.id);

    logLogin("seller", seller, "login");

    response.json({ token: token, seller: publicSeller(seller) });
});

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

const multer = require("multer");

// Product images/videos are uploaded to Cloudinary (a free external image
// host) so they survive server restarts/redeploys no matter what host this
// runs on or whether that host has a persistent disk. Set CLOUDINARY_CLOUD_NAME,
// CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET (free at cloudinary.com) to
// enable this. Without them, uploads fall back to local disk under DATA_DIR,
// which only survives restarts if DATA_DIR itself is on a persistent disk -
// see the PHYNEX_DATA_DIR warning above.
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const CLOUDINARY_ENABLED = !!(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);

const uploadsDir = path.join(DATA_DIR, "uploads");

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use("/uploads", express.static(uploadsDir));

if (!CLOUDINARY_ENABLED) {
    console.warn(
        "\n*** PHYNEX WARNING ***\n" +
        "CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET are not\n" +
        "set, so uploaded product images/videos are being saved to local disk\n" +
        "(" + uploadsDir + ") instead of Cloudinary. Unless DATA_DIR is on a\n" +
        "persistent disk, this folder is wiped on every restart/redeploy and\n" +
        "uploaded images will disappear again. Sign up free at cloudinary.com and\n" +
        "set those three environment variables to fix this permanently.\n" +
        "***********************\n"
    );
}

// Signs and uploads one file's buffer to Cloudinary, returns its permanent
// secure URL. Uses Cloudinary's plain HTTP upload API via fetch, so no
// extra npm dependency is needed.
async function uploadBufferToCloudinary(buffer, originalName, resourceType) {
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = "phynex";
    const paramsToSign = "folder=" + folder + "&timestamp=" + timestamp;
    const signature = crypto
        .createHash("sha1")
        .update(paramsToSign + CLOUDINARY_API_SECRET)
        .digest("hex");

    const form = new FormData();
    form.append("file", new Blob([buffer]), originalName || "upload");
    form.append("api_key", CLOUDINARY_API_KEY);
    form.append("timestamp", String(timestamp));
    form.append("signature", signature);
    form.append("folder", folder);

    const uploadUrl =
        "https://api.cloudinary.com/v1_1/" + CLOUDINARY_CLOUD_NAME + "/" +
        (resourceType === "video" ? "video" : "image") + "/upload";

    const uploadResponse = await fetch(uploadUrl, { method: "POST", body: form });
    const data = await uploadResponse.json();

    if (!uploadResponse.ok) {
        throw new Error((data && data.error && data.error.message) || "Cloudinary upload failed.");
    }

    return data.secure_url;
}

// Stores a list of multer files (Cloudinary if configured, else local disk
// as a fallback) and returns [{ url, type }] in the same order given.
async function storeMediaFiles(files) {
    const results = [];

    for (const file of files) {
        const type = file.mimetype.indexOf("video/") === 0 ? "video" : "image";

        if (CLOUDINARY_ENABLED) {
            const url = await uploadBufferToCloudinary(file.buffer, file.originalname, type);
            results.push({ url: url, type: type });
        } else {
            const ext = path.extname(file.originalname || "");
            const unique = Date.now() + "-" + crypto.randomBytes(6).toString("hex");
            const filename = unique + ext;
            fs.writeFileSync(path.join(uploadsDir, filename), file.buffer);
            results.push({ url: "/uploads/" + filename, type: type });
        }
    }

    return results;
}

// Files are held in memory just long enough to upload to Cloudinary (or
// write to local disk as a fallback) - never written to disk by multer
// itself, so no temp files are left behind.
const mediaStorage = multer.memoryStorage();

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

}, async function (request, response) {

    const body = request.body || {};

    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();
    const specifications = String(body.specifications || "").trim();
    const price = Math.round(Number(body.price));
    const oldPrice = body.oldPrice ? Math.round(Number(body.oldPrice)) : null;
    const stock = body.stock != null && body.stock !== "" ? Math.max(0, Math.round(Number(body.stock))) : 0;

    if (!name || !Number.isFinite(price) || price < 1) {
        return response.status(400).json({ message: "Product name and a valid price are required." });
    }

    const autoCategory = applyAutoCategory({
        name: name,
        description: description,
        specifications: specifications,
        category: body.category,
        subcategory: body.subcategory
    });

    const category = autoCategory.category;
    const warranty = String(body.warranty || "").trim();
    const dispatchLocation = String(body.dispatchLocation || "").trim();
    const returnPolicy = String(body.returnPolicy || "").trim();

    const files = request.files || [];

    let media;
    try {
        media = await storeMediaFiles(files);
    } catch (error) {
        return response.status(502).json({ message: error.message || "Could not upload images." });
    }

    const mediaJson = JSON.stringify(media);
    const firstImage = (media.find(function (m) { return m.type === "image"; }) || media[0] || {}).url || "";
    const trackingCode = generateTrackingCode();

    const result = db
        .prepare(
            `INSERT INTO products
                (seller_id, name, description, specifications, price, old_price, category, subcategory, image, media, status, sponsored, tracking_code, stock, warranty, dispatch_location, return_policy, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            request.seller.id, name, description, specifications, price,
            oldPrice, category, autoCategory.subcategory || "", firstImage, mediaJson, trackingCode, stock,
            warranty, dispatchLocation, returnPolicy, Date.now()
        );

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(result.lastInsertRowid);

    logActivity("product_submitted", request.seller.business_name + " submitted \"" + name + "\" for review.");

    response.json({ product: publicProduct(product) });
});

app.get("/api/seller/products", requireSeller, function (request, response) {

    const products = db
        .prepare("SELECT * FROM products WHERE seller_id = ? ORDER BY created_at DESC")
        .all(request.seller.id);

    response.json({ products: products.map(publicProduct) });
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

    response.json({ products: rows.map(publicProduct) });
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
   PUBLIC — PRODUCT REVIEWS
   Returns the approved reviews for one product, plus a rounded
   average rating, so the product popup's Reviews tab can show real
   customer feedback instead of a permanently-empty placeholder.
========================= */

app.get("/api/products/:id/reviews", function (request, response) {

    const rows = db
        .prepare(
            "SELECT customer_name, rating, comment, created_at FROM reviews WHERE product_id = ? AND status = 'approved' ORDER BY created_at DESC"
        )
        .all(request.params.id);

    const count = rows.length;
    const average = count
        ? Math.round((rows.reduce(function (sum, row) { return sum + Number(row.rating || 0); }, 0) / count) * 10) / 10
        : 0;

    response.json({
        reviews: rows.map(function (row) {
            return {
                customerName: row.customer_name || "Anonymous",
                rating: Number(row.rating || 0),
                comment: row.comment || "",
                createdAt: row.created_at
            };
        }),
        averageRating: average,
        count: count
    });
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

    const pendingProductsList = db
        .prepare(
            `SELECT products.*, sellers.business_name, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.status = 'pending'
             ORDER BY products.created_at DESC LIMIT 6`
        )
        .all()
        .map(publicProduct);

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
        products: rows.map(function (row) {
            return Object.assign(publicProduct(row), { sellerEmail: row.email });
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
app.post("/api/admin/products", requireAdmin, handleAdminUpload, async function (request, response) {

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

    const filesToUpload = mainImageFile ? [mainImageFile].concat(galleryFiles) : galleryFiles;

    let media;
    try {
        media = await storeMediaFiles(filesToUpload);
    } catch (error) {
        return response.status(502).json({ message: error.message || "Could not upload images." });
    }

    const mediaJson = JSON.stringify(media);
    const firstImage = (media[0] && media[0].url) || "";
    const trackingCode = generateTrackingCode();

    const autoCategory = applyAutoCategory({
        name: name,
        description: String(body.description || "").trim(),
        specifications: String(body.specifications || "").trim(),
        brand: String(body.brand || "").trim(),
        tags: String(body.tags || "").trim(),
        category: body.category,
        subcategory: body.subcategory
    });

    const result = db
        .prepare(
            `INSERT INTO products
                (seller_id, name, description, specifications, price, old_price, category, image, media,
                 status, sponsored, tracking_code, stock, low_stock_threshold, sku, brand, subcategory,
                 condition_label, warranty, dispatch_location, return_policy, tags, featured, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            systemSeller.id,
            name,
            String(body.description || "").trim(),
            String(body.specifications || "").trim(),
            price,
            body.oldPrice ? Math.round(Number(body.oldPrice)) : null,
            autoCategory.category,
            firstImage,
            mediaJson,
            trackingCode,
            body.stock != null && body.stock !== "" ? Math.max(0, Math.round(Number(body.stock))) : 0,
            5,
            String(body.sku || "").trim(),
            String(body.brand || "").trim(),
            autoCategory.subcategory,
            String(body.condition || "").trim(),
            String(body.warranty || "").trim(),
            String(body.dispatchLocation || "").trim(),
            String(body.returnPolicy || "").trim(),
            String(body.tags || "").trim(),
            body.featured === "true" ? 1 : 0,
            Date.now()
        );

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(result.lastInsertRowid);

    logActivity("product_created", "Admin added \"" + name + "\" directly.");

    response.json({ message: "Product created.", product: publicProduct(product) });
});

app.put("/api/admin/products/:id", requireAdmin, handleAdminUpload, async function (request, response) {

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

    try {
        if (mainImageFile) {
            const uploadedMain = (await storeMediaFiles([mainImageFile]))[0];
            const rest = media.filter(function (m, index) { return index !== 0; });
            media = [uploadedMain].concat(rest);
        }

        if (galleryFiles.length) {
            const mainOnly = media.length ? [media[0]] : [];
            const newGallery = await storeMediaFiles(galleryFiles);
            media = mainOnly.concat(newGallery);
        }
    } catch (error) {
        return response.status(502).json({ message: error.message || "Could not upload images." });
    }

    const mediaJson = JSON.stringify(media);
    const firstImage = (media[0] && media[0].url) || existing.image || "";

    const finalDescription = body.description != null ? String(body.description).trim() : existing.description;
    const finalSpecifications = body.specifications != null ? String(body.specifications).trim() : existing.specifications;
    const finalBrand = body.brand != null ? String(body.brand).trim() : existing.brand;
    const finalTags = body.tags != null ? String(body.tags).trim() : existing.tags;

    const autoCategory = applyAutoCategory({
        name: name,
        description: finalDescription,
        specifications: finalSpecifications,
        brand: finalBrand,
        tags: finalTags,
        category: body.category != null ? String(body.category).trim() : existing.category,
        subcategory: body.subcategory != null ? String(body.subcategory).trim() : existing.subcategory
    });

    db.prepare(
        `UPDATE products SET
            name = ?, description = ?, specifications = ?, price = ?, old_price = ?, category = ?,
            image = ?, media = ?, stock = ?, sku = ?, brand = ?, subcategory = ?, condition_label = ?,
            warranty = ?, dispatch_location = ?, return_policy = ?, tags = ?, featured = ?
         WHERE id = ?`
    ).run(
        name,
        finalDescription,
        finalSpecifications,
        price,
        body.oldPrice ? Math.round(Number(body.oldPrice)) : existing.old_price,
        autoCategory.category,
        firstImage,
        mediaJson,
        body.stock != null && body.stock !== "" ? Math.max(0, Math.round(Number(body.stock))) : existing.stock,
        body.sku != null ? String(body.sku).trim() : existing.sku,
        finalBrand,
        autoCategory.subcategory,
        body.condition != null ? String(body.condition).trim() : existing.condition_label,
        body.warranty != null ? String(body.warranty).trim() : existing.warranty,
        body.dispatchLocation != null ? String(body.dispatchLocation).trim() : existing.dispatch_location,
        body.returnPolicy != null ? String(body.returnPolicy).trim() : existing.return_policy,
        finalTags,
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
    sendOrderStatusEmail(order, status);

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
                loggedIn: Boolean(customer.token),
                status: "approved",
                orderCount: orderCountStmt.get(customer.id).c
            };
        })
    });
});

/* =========================
   ADMIN — CATEGORIES
========================= */

app.get("/api/categories", function (request, response) {
    const rows = db.prepare("SELECT id, name, slug, description FROM categories ORDER BY name ASC").all();
    const countStmt = db.prepare("SELECT COUNT(*) AS c FROM products WHERE category = ? AND status = 'approved'");
    response.json({
        categories: rows.map(function (category) {
            return {
                id: category.id,
                name: category.name,
                slug: category.slug,
                description: category.description || "",
                productCount: countStmt.get(category.name).c
            };
        })
    });
});

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

const DELIVERY_FEE = 0; // must match DELIVERY_FEE in script.js — customer is charged the exact item total, no flat add-on

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
    const digits = String(value || "").replace(/\D/g, "");

    if (/^07\d{8}$/.test(digits)) return "254" + digits.slice(1);
    if (/^01\d{8}$/.test(digits)) return "254" + digits.slice(1);
    if (/^2547\d{8}$/.test(digits)) return digits;
    if (/^2541\d{8}$/.test(digits)) return digits;

    return null;
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

function releaseExpiredReservations() {
    const now = Date.now();
    const expired = db.prepare(
        "SELECT id FROM orders WHERE payment_status = 'pending' AND status = 'pending' AND reservation_expires IS NOT NULL AND reservation_expires < ?"
    ).all(now);
    if (!expired.length) return;

    const release = db.prepare(
        "UPDATE products SET reserved_stock = MAX(0, reserved_stock - ?) WHERE id = ?"
    );
    const items = db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?").all;
    const tx = db.transaction(function () {
        for (const order of expired) {
            const rows = items(order.id);
            for (const item of rows) {
                if (item.product_id) release.run(item.quantity, item.product_id);
            }
            db.prepare("UPDATE orders SET payment_status = 'expired', status = 'cancelled', reservation_expires = NULL, updated_at = ? WHERE id = ?")
                .run(now, order.id);
        }
    });
    tx();
}

app.post("/api/mpesa/stkpush", async function (request, response) {

    if (!mpesaConfigured()) {
        return response.status(503).json({ message: "M-PESA is not configured yet. Add your Daraja credentials to .env." });
    }

    releaseExpiredReservations();

    const payload = request.body || {};
    const customer = optionalCustomer(request);
    const customerInfo = payload.customer || {};
    const delivery = payload.delivery || {};
    const requestedItems = Array.isArray(payload.items) ? payload.items : [];

    if (!requestedItems.length) {
        return response.status(400).json({ message: "Your cart is empty." });
    }

    const phone = normalizePhone(payload.mpesaPhone);
    if (!phone) return response.status(400).json({ message: "Enter a valid Kenyan M-PESA number." });

    const productIds = requestedItems.map(item => Number(item.id)).filter(Number.isInteger);
    if (productIds.length !== requestedItems.length) {
        return response.status(400).json({ message: "Your cart contains an invalid product." });
    }

    const placeholders = productIds.map(() => "?").join(",");
    const rows = db.prepare(
        `SELECT products.*, sellers.business_name, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp
         FROM products JOIN sellers ON sellers.id = products.seller_id
         WHERE products.id IN (${placeholders}) AND products.status = 'approved'`
    ).all(...productIds);

    const byId = new Map(rows.map(row => [row.id, row]));
    const authoritativeItems = [];
    let subtotal = 0;

    for (const item of requestedItems) {
        const id = Number(item.id);
        const product = byId.get(id);
        const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));

        if (!product) {
            return response.status(400).json({ message: "One of the products is no longer available." });
        }

        const available = Math.max(0, Number(product.stock || 0) - Number(product.reserved_stock || 0));
        if (available < quantity) {
            return response.status(409).json({ message: product.name + " has only " + available + " available." });
        }

        subtotal += Number(product.price) * quantity;
        authoritativeItems.push({
            product,
            quantity
        });
    }

    const total = Math.round(subtotal + DELIVERY_FEE);
    const orderNumber = generateOrderNumber();
    const reservationExpires = Date.now() + 30 * 60 * 1000;

    let orderId;

    try {
        const createOrder = db.transaction(function () {
            const result = db.prepare(
                `INSERT INTO orders
                    (order_number, customer_id, customer_name, customer_email, customer_phone,
                     county, location, address, instructions, subtotal, delivery_fee, total,
                     payment_method, payment_status, status, reservation_expires, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mpesa', 'pending', 'pending', ?, ?, ?)`
            ).run(
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
                total,
                reservationExpires,
                Date.now(),
                Date.now()
            );

            const id = result.lastInsertRowid;
            const insertItem = db.prepare(
                "INSERT INTO order_items (order_id, product_id, seller_id, name, image, price, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)"
            );
            const reserve = db.prepare(
                "UPDATE products SET reserved_stock = COALESCE(reserved_stock, 0) + ? WHERE id = ? AND (stock - COALESCE(reserved_stock, 0)) >= ?"
            );

            for (const item of authoritativeItems) {
                const changed = reserve.run(item.quantity, item.product.id, item.quantity);
                if (changed.changes !== 1) throw new Error("Stock changed while your order was being prepared. Please try again.");
                insertItem.run(id, item.product.id, item.product.seller_id, item.product.name, item.product.image || "", item.product.price, item.quantity);
            }
            return id;
        });

        orderId = createOrder();

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
                    Amount: total,
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
            db.prepare("UPDATE orders SET payment_status = 'failed', status = 'cancelled', reservation_expires = NULL, updated_at = ? WHERE id = ?")
                .run(Date.now(), orderId);
            const items = db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?").all(orderId);
            const release = db.prepare("UPDATE products SET reserved_stock = MAX(0, reserved_stock - ?) WHERE id = ?");
            items.forEach(item => { if (item.product_id) release.run(item.quantity, item.product_id); });
            return response.status(502).json({ message: result.errorMessage || result.ResponseDescription || "M-PESA rejected the STK Push request." });
        }

        db.prepare("UPDATE orders SET checkout_request_id = ?, updated_at = ? WHERE id = ?")
            .run(result.CheckoutRequestID, Date.now(), orderId);

        payments.set(result.CheckoutRequestID, {
            status: "pending",
            orderNumber,
            orderId,
            amount: total,
            phone,
            createdAt: Date.now()
        });

        logActivity("order_created", "Order " + orderNumber + " created (awaiting payment).");

        return response.json({
            checkoutRequestId: result.CheckoutRequestID,
            orderNumber,
            customerMessage: result.CustomerMessage || "M-PESA payment request sent."
        });

    } catch (error) {
        if (orderId) {
            const items = db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?").all(orderId);
            const release = db.prepare("UPDATE products SET reserved_stock = MAX(0, reserved_stock - ?) WHERE id = ?");
            items.forEach(item => { if (item.product_id) release.run(item.quantity, item.product_id); });
            db.prepare("UPDATE orders SET payment_status = 'failed', status = 'cancelled', reservation_expires = NULL, updated_at = ? WHERE id = ?")
                .run(Date.now(), orderId);
        }
        return response.status(502).json({ message: error.message || "Unable to process your order." });
    }
});

/* =========================
   M-PESA CALLBACK
========================= */

/* =========================
   STOCK — deduct once an order is actually paid
========================= */

function deductStockForOrder(orderId) {

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);

    if (!order || order.stock_deducted) {
        return; // already paid+deducted before, or order missing — never deduct twice
    }

    const items = db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?").all(orderId);

    const updateStock = db.prepare(
        "UPDATE products SET stock = MAX(0, stock - ?), reserved_stock = MAX(0, COALESCE(reserved_stock, 0) - ?) WHERE id = ?"
    );

    items.forEach(function (item) {
        if (item.product_id) {
            updateStock.run(item.quantity, item.quantity, item.product_id);
        }
    });

    db.prepare("UPDATE orders SET stock_deducted = 1 WHERE id = ?").run(orderId);
}

app.post("/api/mpesa/callback", function (request, response) {

    const callback = request.body && request.body.Body && request.body.Body.stkCallback;

    if (callback && callback.CheckoutRequestID) {

        let payment = payments.get(callback.CheckoutRequestID);
        if (!payment) {
            const order = db.prepare("SELECT id, order_number AS orderNumber, total AS amount, customer_phone AS phone FROM orders WHERE checkout_request_id = ?").get(callback.CheckoutRequestID);
            if (order) {
                payment = Object.assign({}, order, { status: "pending", createdAt: Date.now() });
            } else {
                payment = { status: "pending", createdAt: Date.now() };
            }
        }

        const paid = Number(callback.ResultCode) === 0;

        payment.status = paid ? "paid" : "failed";
        payment.message = callback.ResultDesc || "M-PESA callback received.";

        payments.set(callback.CheckoutRequestID, payment);

        if (payment.orderId) {
            const existingOrder = db.prepare("SELECT payment_status FROM orders WHERE id = ?").get(payment.orderId);
            const alreadyPaid = existingOrder && existingOrder.payment_status === "paid";

            db.prepare(
                "UPDATE orders SET payment_status = ?, status = ?, reservation_expires = NULL, updated_at = ? WHERE id = ?"
            ).run(paid ? "paid" : "failed", paid ? "paid" : "cancelled", Date.now(), payment.orderId);

            if (paid) {
                deductStockForOrder(payment.orderId);

                // Guard against Safaricom retrying the callback and us
                // emailing the customer twice for the same order.
                if (!alreadyPaid) {
                    const paidOrder = db.prepare("SELECT * FROM orders WHERE id = ?").get(payment.orderId);
                    const paidItems = db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(payment.orderId);
                    sendOrderConfirmationEmail(paidOrder, paidItems);
                }
            } else {
                const failedItems = db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?").all(payment.orderId);
                const release = db.prepare("UPDATE products SET reserved_stock = MAX(0, COALESCE(reserved_stock, 0) - ?) WHERE id = ?");
                failedItems.forEach(function (item) {
                    if (item.product_id) release.run(item.quantity, item.product_id);
                });
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

app.get("/api/mpesa/status/:checkoutRequestId", function (request, response) {

    const payment = payments.get(request.params.checkoutRequestId);

    if (!payment) {
        return response.status(404).json({ status: "unknown", message: "Payment request not found." });
    }

    return response.json(payment);
});

/* =========================
   NEWSLETTER SIGNUP
========================= */

const newsletterRateLimit = new Map();
const NEWSLETTER_WINDOW_MS = 10 * 60 * 1000;
const NEWSLETTER_MAX_PER_WINDOW = 5;

function isNewsletterRateLimited(ip) {
    const now = Date.now();
    const entry = newsletterRateLimit.get(ip);

    if (!entry || now - entry.windowStart > NEWSLETTER_WINDOW_MS) {
        newsletterRateLimit.set(ip, { windowStart: now, count: 1 });
        return false;
    }

    entry.count += 1;

    return entry.count > NEWSLETTER_MAX_PER_WINDOW;
}

app.post("/api/newsletter", function (request, response) {

    if (isNewsletterRateLimited(request.ip)) {
        return response.status(429).json({ message: "Too many attempts. Please try again later." });
    }

    const body = request.body || {};
    const email = String(body.email || "").trim().toLowerCase();

    if (!email) {
        return response.status(400).json({ message: "Please enter your email address." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return response.status(400).json({ message: "Enter a valid email address." });
    }

    if (email.length > 200) {
        return response.status(400).json({ message: "Email is too long." });
    }

    try {

        const existing = db.prepare("SELECT id FROM newsletter_subscribers WHERE email = ?").get(email);

        if (existing) {
            return response.json({ ok: true, message: "You're already subscribed. Thanks for sticking around!" });
        }

        db.prepare("INSERT INTO newsletter_subscribers (email, created_at) VALUES (?, ?)")
            .run(email, Date.now());

        return response.json({ ok: true, message: "You're subscribed! Watch your inbox for deals." });

    } catch (error) {
        console.error("Newsletter signup failed:", error.message);
        return response.status(500).json({ message: "Could not subscribe right now. Please try again later." });
    }
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

app.post("/api/contact", async function (request, response) {

    if (!contactMailConfigured()) {
        return response.status(503).json({
            message: "Contact form is not configured yet. Add EMAIL_USER and EMAIL_PASS to .env."
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
});

/* =========================
   SERVER HEALTH
========================= */

app.get("/api/health", function (_request, response) {
    response.json({
        ok: true,
        mpesaConfigured: mpesaConfigured(),
        contactMailConfigured: contactMailConfigured(),
        googleConfigured: googleConfigured(),
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
   404 + ERROR HANDLING
   Everything below must stay JSON for /api/* routes so the
   front-end's fetch(...).json() calls never receive an HTML
   error page (the cause of "Unexpected token '<' ... is not
   valid JSON" errors in the browser console).
========================= */

app.use("/api", function (request, response) {
    response.status(404).json({ message: "This endpoint does not exist." });
});

// Final safety net: any error thrown or passed to next(error) by a route
// above (including ones we didn't wrap in try/catch) is answered as JSON
// instead of Express's default HTML error page.
app.use(function (error, request, response, next) {
    console.error("Unhandled server error:", error);

    if (response.headersSent) {
        return next(error);
    }

    response.status(500).json({ message: "Something went wrong on our end. Please try again." });
});

/* =========================
   START SERVER
========================= */

app.listen(port, function () {
    console.log("PHYNEX server running at http://localhost:" + port);
});
