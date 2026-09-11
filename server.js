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

const payments = new Map();

app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

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
        .prepare("SELECT * FROM customers WHERE token = ?")
        .get(token);

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

    if (password.length < 6) {
        return response.status(400).json({ message: "Password must be at least 6 characters." });
    }

    const existing = db.prepare("SELECT id FROM customers WHERE email = ?").get(email);

    if (existing) {
        return response.status(409).json({ message: "An account with that email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const token = newToken();

    const result = db
        .prepare(
            `INSERT INTO customers (name, email, phone, password_hash, token, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(name, email, phone, passwordHash, token, Date.now());

    const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(result.lastInsertRowid);

    logLogin("customer", customer, "register");

    response.json({ token: token, customer: publicCustomer(customer) });
});

app.post("/api/customers/login", async function (request, response) {

    const body = request.body || {};

    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    const customer = db.prepare("SELECT * FROM customers WHERE email = ?").get(email);

    if (!customer) {
        return response.status(401).json({ message: "Incorrect email or password." });
    }

    const valid = await bcrypt.compare(password, customer.password_hash);

    if (!valid) {
        return response.status(401).json({ message: "Incorrect email or password." });
    }

    const token = newToken();

    db.prepare("UPDATE customers SET token = ? WHERE id = ?").run(token, customer.id);

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
    }

    const token = newToken();

    db.prepare("UPDATE customers SET token = ? WHERE id = ?").run(token, customer.id);

    customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(customer.id);

    logLogin("customer", customer, "google");

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

    if (password.length < 6) {
        return response.status(400).json({ message: "Password must be at least 6 characters." });
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
});

app.post("/api/sellers/login", async function (request, response) {

    const body = request.body || {};

    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

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

    db.prepare("UPDATE sellers SET token = ? WHERE id = ?").run(token, seller.id);

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

app.post("/api/mpesa/stkpush", async function (request, response) {

    if (!mpesaConfigured()) {
        return response.status(503).json({
            message: "M-PESA is not configured yet. Add your Daraja credentials to .env."
        });
    }

    const payload = request.body || {};

    const phone = normalizePhone(payload.mpesaPhone);
    const amount = Math.round(Number(payload.total));

    const calculatedAmount = Array.isArray(payload.items)
        ? payload.items.reduce(function (sum, item) {
            return sum + Number(item.price) * Number(item.quantity);
        }, 0)
        : 0;

    if (!phone) {
        return response.status(400).json({ message: "Enter a valid Kenyan M-PESA number." });
    }

    if (!Number.isFinite(amount) || amount < 1) {
        return response.status(400).json({ message: "The order total must be at least KSh 1." });
    }

    if (!Array.isArray(payload.items) || payload.items.length === 0) {
        return response.status(400).json({ message: "Your cart is empty." });
    }

    if (amount !== Math.round(calculatedAmount) + DELIVERY_FEE) {
        return response.status(400).json({ message: "The order total could not be verified." });
    }

    const customer = optionalCustomer(request);
    const customerInfo = payload.customer || {};
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
            return response.status(502).json({
                message: result.errorMessage || result.ResponseDescription || "M-PESA rejected the STK Push request."
            });
        }

        const orderNumber = generateOrderNumber();
        const subtotal = Math.round(calculatedAmount);

        const orderResult = db
            .prepare(
                `INSERT INTO orders
                    (order_number, customer_id, customer_name, customer_email, customer_phone,
                     county, location, address, instructions, subtotal, delivery_fee, total,
                     payment_method, payment_status, status, checkout_request_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mpesa', 'pending', 'pending', ?, ?)`
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

        payload.items.forEach(function (item) {

            const numericId = Number(item.id);
            const productId = Number.isFinite(numericId) ? numericId : null;

            let sellerId = null;

            if (productId) {
                const productRow = db.prepare("SELECT seller_id FROM products WHERE id = ?").get(productId);
                if (productRow) sellerId = productRow.seller_id;
            }

            insertItem.run(
                orderId,
                productId,
                sellerId,
                String(item.name || "").trim(),
                String(item.image || "").trim(),
                Math.round(Number(item.price) || 0),
                Math.max(1, Math.round(Number(item.quantity) || 1))
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
        return response.status(502).json({ message: error.message || "Unable to reach M-PESA." });
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
        "UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?"
    );

    items.forEach(function (item) {
        if (item.product_id) {
            updateStock.run(item.quantity, item.product_id);
        }
    });

    db.prepare("UPDATE orders SET stock_deducted = 1 WHERE id = ?").run(orderId);
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
                deductStockForOrder(payment.orderId);
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
   START SERVER
========================= */

app.listen(port, function () {
    console.log("PHYNEX server running at http://localhost:" + port);
});
