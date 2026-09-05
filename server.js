const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT) || 3000;
const payments = new Map();
const db = new Database(path.join(__dirname, "phynex.db"));
db.pragma("journal_mode = WAL");
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        phone TEXT NOT NULL,
        password_hash TEXT,
        google_id TEXT UNIQUE,
        email_verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS email_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        purpose TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );
`);

app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

function hashToken(token) {
    return crypto.createHash("sha256").update(String(process.env.SESSION_SECRET || "development-only-secret") + token).digest("hex");
}

function cookieOptions(maxAge) {
    return `Path=/; HttpOnly; SameSite=Lax; ${process.env.NODE_ENV === "production" ? "Secure; " : ""}Max-Age=${maxAge}`;
}

function getCookies(request) {
    return Object.fromEntries(String(request.headers.cookie || "").split(";").filter(Boolean).map(function (part) {
        const index = part.indexOf("=");
        return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    }));
}

function currentUser(request) {
    const token = getCookies(request).phynex_session;
    if (!token) return null;
    const session = db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(hashToken(token));
    if (!session || session.expires_at < Date.now()) return null;
    return db.prepare("SELECT id, name, email, phone, email_verified FROM users WHERE id = ?").get(session.user_id);
}

function createSession(response, userId) {
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hashToken(token), userId, Date.now() + 7 * 24 * 60 * 60 * 1000);
    response.setHeader("Set-Cookie", `phynex_session=${encodeURIComponent(token)}; ${cookieOptions(7 * 24 * 60 * 60)}`);
}

function emailConfigured() {
    return Boolean(process.env.EMAIL_API_KEY && process.env.EMAIL_FROM);
}

function googleConfigured() {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

async function sendEmail(to, subject, text) {
    const emailResponse = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: "Bearer " + process.env.EMAIL_API_KEY,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text })
    });
    const result = await emailResponse.json();
    if (!emailResponse.ok) throw new Error(result.message || "Email service rejected the message.");
}

async function sendVerificationEmail(user, token) {
    if (!emailConfigured()) throw new Error("Email verification is not configured yet.");
    const link = `${process.env.APP_URL || "http://localhost:" + port}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    await sendEmail(user.email, "Verify your PHYNEX account", `Hello ${user.name}, verify your PHYNEX account here: ${link}`);
}

async function sendPasswordResetEmail(user, token) {
    if (!emailConfigured()) throw new Error("Email verification is not configured yet.");
    const link = `${process.env.APP_URL || "http://localhost:" + port}/account.html?reset=${encodeURIComponent(token)}`;
    await sendEmail(user.email, "Reset your PHYNEX password", `Hello ${user.name}, reset your PHYNEX password here: ${link}`);
}

function issueEmailToken(userId, purpose) {
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)").run(hashToken(token), userId, purpose, Date.now() + 60 * 60 * 1000);
    return token;
}

app.get("/api/auth/me", function (request, response) {
    const user = currentUser(request);
    response.json({ authenticated: Boolean(user), user: user || null });
});

app.post("/api/auth/register", async function (request, response) {
    const input = request.body || {};
    const name = String(input.name || "").trim();
    const email = String(input.email || "").trim().toLowerCase();
    const phone = String(input.phone || "").trim();
    const password = String(input.password || "");
    if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || phone.length < 7 || password.length < 8) return response.status(400).json({ message: "Enter valid details and a password of at least 8 characters." });
    if (!emailConfigured()) return response.status(503).json({ message: "Email verification setup required: configure EMAIL_API_KEY and EMAIL_FROM." });
    try {
        const result = db.prepare("INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)").run(name, email, phone, await bcrypt.hash(password, 12));
        const user = db.prepare("SELECT id, name, email, phone FROM users WHERE id = ?").get(result.lastInsertRowid);
        await sendVerificationEmail(user, issueEmailToken(user.id, "verify"));
        response.status(201).json({ message: "Account created. Check your email to verify your account before signing in." });
    } catch (error) {
        response.status(409).json({ message: error.code === "SQLITE_CONSTRAINT_UNIQUE" ? "An account with that email already exists." : "Unable to create account." });
    }
});

app.get("/api/auth/verify-email", function (request, response) {
    const record = db.prepare("SELECT user_id FROM email_tokens WHERE token_hash = ? AND purpose = 'verify' AND expires_at > ?").get(hashToken(String(request.query.token || "")), Date.now());
    if (!record) return response.status(400).send("This verification link is invalid or expired.");
    db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(record.user_id);
    db.prepare("DELETE FROM email_tokens WHERE token_hash = ?").run(hashToken(String(request.query.token || "")));
    response.redirect("/account.html?verified=1");
});

app.post("/api/auth/login", async function (request, response) {
    const email = String(request.body && request.body.email || "").trim().toLowerCase();
    const password = String(request.body && request.body.password || "");
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) return response.status(401).json({ message: "Email or password is incorrect." });
    if (!user.email_verified) return response.status(403).json({ message: "Verify your email before signing in." });
    createSession(response, user.id);
    response.json({ user: { name: user.name, email: user.email, phone: user.phone } });
});

app.post("/api/auth/forgot-password", async function (request, response) {
    const email = String(request.body && request.body.email || "").trim().toLowerCase();
    const user = db.prepare("SELECT id, name, email FROM users WHERE email = ?").get(email);
    if (user) {
        try {
            await sendPasswordResetEmail(user, issueEmailToken(user.id, "reset"));
        } catch (error) {
            return response.status(503).json({ message: error.message });
        }
    }
    response.json({ message: "If an account exists for that email, a reset link has been sent." });
});

app.post("/api/auth/reset-password", async function (request, response) {
    const token = String(request.body && request.body.token || "");
    const password = String(request.body && request.body.password || "");
    if (password.length < 8) return response.status(400).json({ message: "Password must be at least 8 characters." });
    const record = db.prepare("SELECT user_id FROM email_tokens WHERE token_hash = ? AND purpose = 'reset' AND expires_at > ?").get(hashToken(token), Date.now());
    if (!record) return response.status(400).json({ message: "This reset link is invalid or expired." });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await bcrypt.hash(password, 12), record.user_id);
    db.prepare("DELETE FROM email_tokens WHERE token_hash = ?").run(hashToken(token));
    response.json({ message: "Password reset complete. You can now sign in." });
});

app.post("/api/auth/logout", function (request, response) {
    const token = getCookies(request).phynex_session;
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    response.setHeader("Set-Cookie", `phynex_session=; ${cookieOptions(0)}`);
    response.json({ ok: true });
});

app.get("/api/auth/google", function (request, response) {
    if (!googleConfigured()) return response.status(503).send("Google OAuth setup required: configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.");
    const state = crypto.randomBytes(24).toString("hex");
    response.setHeader("Set-Cookie", `phynex_oauth_state=${encodeURIComponent(state)}; ${cookieOptions(600)}`);
    const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: process.env.GOOGLE_REDIRECT_URI, response_type: "code", scope: "openid email profile", state, access_type: "offline", prompt: "select_account" });
    response.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + params);
});

app.get("/api/auth/google/callback", async function (request, response) {
    if (!googleConfigured()) return response.status(503).send("Google OAuth setup required: configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.");
    const cookies = getCookies(request);
    if (!request.query.code || !request.query.state || request.query.state !== cookies.phynex_oauth_state) return response.status(400).send("Google sign-in could not be verified. Please try again.");
    try {
        const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: request.query.code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: process.env.GOOGLE_REDIRECT_URI, grant_type: "authorization_code" }) });
        const tokens = await tokenResponse.json();
        if (!tokenResponse.ok || !tokens.access_token) throw new Error("Google authorization failed.");
        const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + tokens.access_token } });
        const profile = await profileResponse.json();
        if (!profile.email || profile.email_verified !== true) throw new Error("Google did not provide a verified email address.");
        let user = db.prepare("SELECT * FROM users WHERE google_id = ? OR email = ?").get(profile.sub, String(profile.email || "").toLowerCase());
        if (!user) {
            const result = db.prepare("INSERT INTO users (name, email, phone, google_id, email_verified) VALUES (?, ?, ?, ?, 1)").run(profile.name || "PHYNEX Customer", String(profile.email).toLowerCase(), "Google account", profile.sub);
            user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
        } else if (!user.google_id) {
            db.prepare("UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ?").run(profile.sub, user.id);
        }
        createSession(response, user.id);
        response.redirect("/account.html?google=1");
    } catch (error) { response.status(502).send(error.message); }
});

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
    const parts = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
        String(date.getHours()).padStart(2, "0"),
        String(date.getMinutes()).padStart(2, "0"),
        String(date.getSeconds()).padStart(2, "0")
    ];
    return parts.join("");
}

async function getAccessToken() {
    const credentials = Buffer.from(
        process.env.MPESA_CONSUMER_KEY + ":" + process.env.MPESA_CONSUMER_SECRET
    ).toString("base64");
    const response = await fetch(darajaBaseUrl() + "/oauth/v1/generate?grant_type=client_credentials", {
        headers: { Authorization: "Basic " + credentials }
    });
    const body = await response.json();
    if (!response.ok || !body.access_token) {
        throw new Error(body.errorMessage || "Unable to authenticate with Daraja.");
    }
    return body.access_token;
}

app.post("/api/mpesa/stkpush", async function (request, response) {
    const user = currentUser(request);
    if (!user) return response.status(401).json({ message: "Sign in before paying for your order." });
    if (!user.email_verified) return response.status(403).json({ message: "Verify your email before paying for an order." });
    if (!mpesaConfigured()) {
        return response.status(503).json({
            message: "M-PESA is not configured yet. Add Daraja credentials to .env."
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

    if (!phone) return response.status(400).json({ message: "Enter a valid Kenyan M-PESA number." });
    if (!Number.isFinite(amount) || amount < 1) return response.status(400).json({ message: "The order total must be at least KSh 1." });
    if (!Array.isArray(payload.items) || payload.items.length === 0) return response.status(400).json({ message: "Your cart is empty." });
    if (amount !== Math.round(calculatedAmount)) return response.status(400).json({ message: "The order total could not be verified." });

    try {
        const accessToken = await getAccessToken();
        const requestTimestamp = timestamp();
        const password = Buffer.from(
            process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + requestTimestamp
        ).toString("base64");
        const darajaResponse = await fetch(darajaBaseUrl() + "/mpesa/stkpush/v1/processrequest", {
            method: "POST",
            headers: {
                Authorization: "Bearer " + accessToken,
                "Content-Type": "application/json"
            },
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
        });
        const result = await darajaResponse.json();
        if (!darajaResponse.ok || !result.CheckoutRequestID) {
            return response.status(502).json({ message: result.errorMessage || result.ResponseDescription || "Daraja rejected the STK Push request." });
        }

        payments.set(result.CheckoutRequestID, {
            status: "pending",
            orderNumber: "PHX-" + crypto.randomBytes(4).toString("hex").toUpperCase(),
            amount,
            phone,
            createdAt: Date.now()
        });
        return response.json({
            checkoutRequestId: result.CheckoutRequestID,
            customerMessage: result.CustomerMessage || "M-PESA payment request sent."
        });
    } catch (error) {
        return response.status(502).json({ message: error.message || "Unable to reach Daraja." });
    }
});

app.post("/api/mpesa/callback", function (request, response) {
    const callback = request.body && request.body.Body && request.body.Body.stkCallback;
    if (callback && callback.CheckoutRequestID) {
        const payment = payments.get(callback.CheckoutRequestID) || {
            status: "pending",
            createdAt: Date.now()
        };
        payment.status = Number(callback.ResultCode) === 0 ? "paid" : "failed";
        payment.message = callback.ResultDesc || "M-PESA callback received.";
        payments.set(callback.CheckoutRequestID, payment);
    }
    response.json({ ResultCode: 0, ResultDesc: "Callback received" });
});

app.get("/api/mpesa/status/:checkoutRequestId", function (request, response) {
    const payment = payments.get(request.params.checkoutRequestId);
    if (!payment) return response.status(404).json({ status: "unknown", message: "Payment request not found." });
    return response.json(payment);
});

app.get("/api/health", function (_request, response) {
    response.json({ ok: true, mpesaConfigured: mpesaConfigured() });
});

app.listen(port, function () {
    console.log("PHYNEX server running at http://localhost:" + port);
});
