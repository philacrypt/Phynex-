const express = require("express");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT) || 3000;

const payments = new Map();

app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

/* =========================
   DATABASE (sellers + products)
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
`);

// Migration: older databases won't have the "media" column yet
// (it stores a JSON array of {url, type} for multi-image/video
// listings). Add it if missing, without touching existing rows.
const productColumns = db.prepare("PRAGMA table_info(products)").all();
const hasMediaColumn = productColumns.some(function (col) { return col.name === "media"; });

if (!hasMediaColumn) {
    db.exec("ALTER TABLE products ADD COLUMN media TEXT");
}

// Migration: older databases won't have the "tracking_code" column
// yet (a 4-digit code given to sellers so they and customers can
// look up a product's status in "Track my product"). Add it if
// missing, without touching existing rows.
const hasTrackingColumn = productColumns.some(function (col) { return col.name === "tracking_code"; });

if (!hasTrackingColumn) {
    db.exec("ALTER TABLE products ADD COLUMN tracking_code TEXT");
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

function publicSeller(seller) {
    return {
        id: seller.id,
        businessName: seller.business_name,
        email: seller.email,
        phone: seller.phone
    };
}

function publicCustomer(customer) {
    return {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone
    };
}

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
        name: product.name,
        description: product.description || "",
        specifications: product.specifications || "",
        price: product.price,
        oldPrice: product.old_price || null,
        category: product.category || "",
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

    request.seller = seller;
    next();
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
   Used to gate checkout — browsing, cart and search stay open to
   everyone; only placing an order requires a logged-in customer.
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

    response.json({ token: token, customer: publicCustomer(customer) });
});

app.get("/api/customers/me", requireCustomer, function (request, response) {
    response.json({ customer: publicCustomer(request.customer) });
});

/* =========================
   SELLER REGISTER / LOGIN
========================= */

app.post("/api/sellers/register", async function (request, response) {

    const body = request.body || {};

    const businessName = String(body.businessName || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const password = String(body.password || "");

    if (!businessName || !email || !password) {
        return response.status(400).json({ message: "Business name, email and password are required." });
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
            `INSERT INTO sellers (business_name, email, phone, password_hash, token, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(businessName, email, phone, passwordHash, token, Date.now());

    const seller = db.prepare("SELECT * FROM sellers WHERE id = ?").get(result.lastInsertRowid);

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

    const token = newToken();

    db.prepare("UPDATE sellers SET token = ? WHERE id = ?").run(token, seller.id);

    response.json({ token: token, seller: publicSeller(seller) });
});

app.get("/api/sellers/me", requireSeller, function (request, response) {
    response.json({ seller: publicSeller(request.seller) });
});

/* =========================
   MEDIA UPLOAD (images + short videos)
   Files are saved to /uploads on disk and served statically.
   NOTE: on most hosts (including Render's free web service tier)
   local disk is EPHEMERAL — files can be wiped on redeploy or
   restart. For production, swap the multer diskStorage below for
   an upload to Cloudinary/S3/Supabase Storage instead, and store
   the returned URL the same way.
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

const uploadMedia = multer({
    storage: mediaStorage,
    limits: {
        fileSize: 25 * 1024 * 1024, // 25MB per file
        files: 6
    },
    fileFilter: function (request, file, callback) {
        if (/^image\/|^video\//.test(file.mimetype)) {
            callback(null, true);
        } else {
            callback(new Error("Only image and video files are allowed."));
        }
    }
});

/* =========================
   SELLER — SUBMIT / VIEW OWN PRODUCTS
   New submissions always start as "pending" and need
   admin approval before they appear on the store. Each
   submission is also given a random 4-digit tracking code
   so the seller (and their customers) can look the product
   up later in "Track my product".
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
                (seller_id, name, description, specifications, price, old_price, category, image, media, status, sponsored, tracking_code, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
        )
        .run(
            request.seller.id,
            name,
            description,
            specifications,
            price,
            oldPrice,
            category,
            firstImage,
            mediaJson,
            trackingCode,
            Date.now()
        );

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(result.lastInsertRowid);

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
   Used by the storefront to load seller products
   (and the sponsored-products rail) into the page.
========================= */

app.get("/api/products", function (request, response) {

    const sponsoredOnly = request.query.sponsored === "1";

    const rows = sponsoredOnly
        ? db.prepare(
            `SELECT products.*, sellers.business_name FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.status = 'approved' AND products.sponsored = 1
             ORDER BY products.created_at DESC`
        ).all()
        : db.prepare(
            `SELECT products.*, sellers.business_name FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.status = 'approved'
             ORDER BY products.created_at DESC`
        ).all();

    response.json({ products: rows.map(publicProduct) });
});

/* =========================
   PUBLIC — TRACK MY PRODUCT
   Anyone (seller or customer) can look up a product's current
   review/approval status using its 4-digit tracking code.
========================= */

app.get("/api/track/:code", function (request, response) {

    const code = String(request.params.code || "").trim();

    if (!/^\d{4}$/.test(code)) {
        return response.status(400).json({ message: "Enter the 4-digit tracking number." });
    }

    const product = db
        .prepare(
            `SELECT products.*, sellers.business_name FROM products
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
   ADMIN — REVIEW / APPROVE / SPONSOR PRODUCTS
========================= */

app.get("/api/admin/products", requireAdmin, function (request, response) {

    const status = String(request.query.status || "").trim();

    const rows = status
        ? db.prepare(
            `SELECT products.*, sellers.business_name, sellers.email FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.status = ?
             ORDER BY products.created_at DESC`
        ).all(status)
        : db.prepare(
            `SELECT products.*, sellers.business_name, sellers.email FROM products
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

    response.json({ ok: true });
});

app.delete("/api/admin/products/:id", requireAdmin, function (request, response) {

    db.prepare("DELETE FROM products WHERE id = ?").run(request.params.id);

    response.json({ ok: true });
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

    if (/^07\d{8}$/.test(digits)) {
        return "254" + digits.slice(1);
    }

    if (/^01\d{8}$/.test(digits)) {
        return "254" + digits.slice(1);
    }

    if (/^2547\d{8}$/.test(digits)) {
        return digits;
    }

    if (/^2541\d{8}$/.test(digits)) {
        return digits;
    }

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

/* =========================
   GET M-PESA ACCESS TOKEN
========================= */

async function getAccessToken() {
    const credentials = Buffer.from(
        process.env.MPESA_CONSUMER_KEY +
        ":" +
        process.env.MPESA_CONSUMER_SECRET
    ).toString("base64");

    const response = await fetch(
        darajaBaseUrl() +
        "/oauth/v1/generate?grant_type=client_credentials",
        {
            headers: {
                Authorization: "Basic " + credentials
            }
        }
    );

    const body = await response.json();

    if (!response.ok || !body.access_token) {
        throw new Error(
            body.errorMessage ||
            "Unable to authenticate with M-PESA."
        );
    }

    return body.access_token;
}

/* =========================
   M-PESA STK PUSH
   NO CUSTOMER LOGIN REQUIRED
========================= */

app.post("/api/mpesa/stkpush", async function (request, response) {

    if (!mpesaConfigured()) {
        return response.status(503).json({
            message:
                "M-PESA is not configured yet. Add your Daraja credentials to .env."
        });
    }

    const payload = request.body || {};

    const phone = normalizePhone(payload.mpesaPhone);

    const amount = Math.round(Number(payload.total));

    const calculatedAmount = Array.isArray(payload.items)
        ? payload.items.reduce(function (sum, item) {
            return sum +
                Number(item.price) *
                Number(item.quantity);
        }, 0)
        : 0;

    if (!phone) {
        return response.status(400).json({
            message: "Enter a valid Kenyan M-PESA number."
        });
    }

    if (!Number.isFinite(amount) || amount < 1) {
        return response.status(400).json({
            message: "The order total must be at least KSh 1."
        });
    }

    if (!Array.isArray(payload.items) || payload.items.length === 0) {
        return response.status(400).json({
            message: "Your cart is empty."
        });
    }

    // The total sent by the client includes the flat delivery fee on
    // top of the item subtotal, so the verified amount must too.
    if (amount !== Math.round(calculatedAmount) + DELIVERY_FEE) {
        return response.status(400).json({
            message: "The order total could not be verified."
        });
    }

    try {

        const accessToken = await getAccessToken();

        const requestTimestamp = timestamp();

        const password = Buffer.from(
            process.env.MPESA_SHORTCODE +
            process.env.MPESA_PASSKEY +
            requestTimestamp
        ).toString("base64");

        const darajaResponse = await fetch(
            darajaBaseUrl() +
            "/mpesa/stkpush/v1/processrequest",
            {
                method: "POST",

                headers: {
                    Authorization: "Bearer " + accessToken,
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({

                    BusinessShortCode:
                        process.env.MPESA_SHORTCODE,

                    Password:
                        password,

                    Timestamp:
                        requestTimestamp,

                    TransactionType:
                        "CustomerPayBillOnline",

                    Amount:
                        amount,

                    PartyA:
                        phone,

                    PartyB:
                        process.env.MPESA_SHORTCODE,

                    PhoneNumber:
                        phone,

                    CallBackURL:
                        process.env.MPESA_CALLBACK_URL,

                    AccountReference:
                        "PHYNEX",

                    TransactionDesc:
                        "PHYNEX order payment"
                })
            }
        );

        const result = await darajaResponse.json();

        if (
            !darajaResponse.ok ||
            !result.CheckoutRequestID
        ) {
            return response.status(502).json({
                message:
                    result.errorMessage ||
                    result.ResponseDescription ||
                    "M-PESA rejected the STK Push request."
            });
        }

        const orderNumber =
            "PHX-" +
            crypto
                .randomBytes(4)
                .toString("hex")
                .toUpperCase();

        payments.set(
            result.CheckoutRequestID,
            {
                status: "pending",
                orderNumber: orderNumber,
                amount: amount,
                phone: phone,
                createdAt: Date.now()
            }
        );

        return response.json({

            checkoutRequestId:
                result.CheckoutRequestID,

            orderNumber:
                orderNumber,

            customerMessage:
                result.CustomerMessage ||
                "M-PESA payment request sent."
        });

    } catch (error) {

        return response.status(502).json({
            message:
                error.message ||
                "Unable to reach M-PESA."
        });
    }
});

/* =========================
   M-PESA CALLBACK
========================= */

app.post(
    "/api/mpesa/callback",
    function (request, response) {

        const callback =
            request.body &&
            request.body.Body &&
            request.body.Body.stkCallback;

        if (
            callback &&
            callback.CheckoutRequestID
        ) {

            const payment =
                payments.get(
                    callback.CheckoutRequestID
                ) || {
                    status: "pending",
                    createdAt: Date.now()
                };

            payment.status =
                Number(callback.ResultCode) === 0
                    ? "paid"
                    : "failed";

            payment.message =
                callback.ResultDesc ||
                "M-PESA callback received.";

            payments.set(
                callback.CheckoutRequestID,
                payment
            );
        }

        response.json({
            ResultCode: 0,
            ResultDesc: "Callback received"
        });
    }
);

/* =========================
   CHECK PAYMENT STATUS
========================= */

app.get(
    "/api/mpesa/status/:checkoutRequestId",
    function (request, response) {

        const payment =
            payments.get(
                request.params.checkoutRequestId
            );

        if (!payment) {
            return response.status(404).json({
                status: "unknown",
                message:
                    "Payment request not found."
            });
        }

        return response.json(payment);
    }
);

/* =========================
   CONTACT FORM
========================= */

function contactMailConfigured() {
    return Boolean(
        process.env.EMAIL_USER &&
        process.env.EMAIL_PASSWORD
    );
}

const mailTransporter = contactMailConfigured()
    ? nodemailer.createTransport({
        host: process.env.EMAIL_HOST || "smtp.gmail.com",
        port: Number(process.env.EMAIL_PORT) || 587,
        secure: Number(process.env.EMAIL_PORT) === 465,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD
        }
    })
    : null;

// Simple in-memory rate limiter: max 5 contact submissions
// per IP per 10 minutes.
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

    if (entry.count > CONTACT_MAX_PER_WINDOW) {
        return true;
    }

    return false;
}

app.post("/api/contact", async function (request, response) {

    if (!contactMailConfigured()) {
        return response.status(503).json({
            message:
                "Contact form is not configured yet. Add EMAIL_USER and EMAIL_PASS to .env."
        });
    }

    if (isRateLimited(request.ip)) {
        return response.status(429).json({
            message:
                "Too many messages sent. Please try again later."
        });
    }

    const body = request.body || {};

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    const message = String(body.message || "").trim();

    if (!name || !email || !message) {
        return response.status(400).json({
            message: "Please fill in all fields."
        });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return response.status(400).json({
            message: "Enter a valid email address."
        });
    }

    if (name.length > 200) {
        return response.status(400).json({
            message: "Name is too long."
        });
    }

    if (message.length > 5000) {
        return response.status(400).json({
            message: "Message is too long."
        });
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

        return response.status(502).json({
            message:
                "Could not send message. Please try again later."
        });
    }
});

/* =========================
   SERVER HEALTH
========================= */

app.get(
    "/api/health",
    function (_request, response) {

        response.json({
            ok: true,
            mpesaConfigured:
                mpesaConfigured(),
            contactMailConfigured:
                contactMailConfigured(),
            adminConfigured:
                Boolean(process.env.ADMIN_PASSWORD)
        });
    }
);

/* =========================
   START SERVER
========================= */

app.listen(
    port,
    function () {

        console.log(
            "PHYNEX server running at http://localhost:" +
            port
        );

    }
);
