const express = require("express");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT) || 3000;

const payments = new Map();

app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

/* =========================
   M-PESA CONFIGURATION
========================= */

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

    if (amount !== Math.round(calculatedAmount)) {
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
                contactMailConfigured()
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