const express = require("express");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT) || 3000;
const payments = new Map();

app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

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
