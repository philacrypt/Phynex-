# PHYNEX Production Customer Authentication

## What changed

- Customer email/password registration now requires:
  - full name
  - valid Kenyan phone
  - syntactically valid/plausible email
  - password + confirmation
- Registration sends a real email-verification link.
- Email verification tokens are random, single-use, expiring and stored hashed.
- Customer sessions use an HttpOnly, SameSite cookie instead of exposing customer session tokens to browser JavaScript.
- Login accepts email or normalized Kenyan phone.
- Login is rate limited and uses bcrypt password verification.
- Unverified email accounts cannot log in.
- Optional real SMS OTP verification is enabled automatically when the Africa's Talking variables are configured.
- Password reset tokens are random, expiring, single-use and stored hashed.
- Password reset no longer automatically authenticates the browser.
- Checkout now requires an authenticated verified customer and associates the order with `request.customer.id`, not client-supplied customer IDs/details.
- M-PESA payment status is restricted to the customer who owns the order.
- Customer review submissions use the HttpOnly session.
- Customer account page uses the authenticated `/api/customers/me` endpoint.
- Basic security headers and optional strict CORS allow-list were added.
- Existing seller authentication remains separate and was not replaced.

## Files changed

- `server.js`
  - database migrations for verification/session fields
  - customer registration/login/verification/reset flows
  - HttpOnly session handling
  - Kenyan phone normalization
  - SMS OTP integration
  - checkout/customer ownership enforcement
  - M-PESA status ownership enforcement
  - rate limiting/security headers/CORS allow-list
- `customer-register.html`
  - confirmation password
  - required Kenyan phone
  - verification messaging
  - cookie-based authentication flow
- `customer-login.html`
  - email-or-phone login
  - email verification status messaging
  - resend-verification action
  - phone OTP redirect
  - cookie-based session flow
- `customer-forgot-password.html`
  - cookie-aware request
- `customer-reset-password.html`
  - confirmation password
  - no token/session stored in localStorage
- `customer-verify-phone.html`
  - new real OTP entry/resend page
- `account.html`
  - reads authenticated account from `/api/customers/me`
  - logout clears the server session cookie
- `script.js`
  - checkout authentication gate
  - checkout requests use the HttpOnly cookie
  - review requests use the authenticated session
- `.env.example`
  - documents the required/optional authentication configuration
- `AUTHENTICATION_IMPLEMENTATION.md`
  - deployment and test notes

## Database changes

No separate authentication database was created. PHYNEX's existing SQLite `customers` table is extended with:

- `email_verified_at`
- `email_verification_token_hash`
- `email_verification_expires`
- `phone_verified_at`
- `phone_verification_code_hash`
- `phone_verification_expires`
- `phone_verification_attempts`
- `session_token_hash`
- `session_expires`

Existing `reset_token` and `reset_token_expires` columns are reused, but reset tokens are now stored as SHA-256 hashes.

The migrations are applied automatically by `server.js` on startup.

## Required environment variables

The existing PHYNEX SMTP settings remain the email transport:

```text
APP_URL=https://your-real-phynex-domain.example
EMAIL_HOST=smtp.example.com
EMAIL_PORT=587
EMAIL_USER=your-smtp-user
EMAIL_PASSWORD=your-smtp-password-or-app-password
EMAIL_FROM=PHYNEX <no-reply@your-domain.example>
```

`EMAIL_HOST`, `EMAIL_PORT`, and `EMAIL_FROM` have defaults/optional behavior in the code, but a real production email account is required for verification/reset delivery.

For Gmail, use an App Password with 2-Step Verification rather than the normal Google account password.

## Optional real SMS OTP

The implementation uses Africa's Talking when these are all configured:

```text
AT_USERNAME=
AT_API_KEY=
AT_SENDER_ID=
```

If they are configured, customer phone verification becomes required before protected customer functionality is available.

If they are not configured, PHYNEX still performs strict Kenyan phone-format validation, but does not claim that phone ownership has been proven.

## Deployment

1. Put real production values in the deployment platform's environment-variable settings. Do not commit `.env`.
2. Set `APP_URL` to the exact public HTTPS PHYNEX URL.
3. Configure SMTP and verify that the server can deliver mail.
4. For SMS OTP, configure the Africa's Talking production application, API key and approved sender ID.
5. Restart the Node server so database migrations run.
6. Ensure the deployed server and frontend are same-origin, or configure `ALLOWED_ORIGINS` with exact trusted origins.
7. Do not use `*` for credentialed CORS.

## Test checklist

### Registration

Use a real inbox and a real Kenyan number.

Expected:
- valid registration returns success and does not create a browser login session
- invalid email is rejected
- obvious placeholder emails such as `test@test.com`, `fake@email.com`, and `abc@abc.com` are rejected
- non-Kenyan phone is rejected
- malformed Kenyan phone is rejected
- duplicate email is rejected
- duplicate phone is rejected
- weak password is rejected
- mismatched password confirmation is rejected

### Email verification

1. Register using a real inbox.
2. Open the verification email.
3. Click the verification link.
4. Confirm the login page says the account has been verified.
5. Attempt login before verification in a separate test account; it must be rejected.
6. Reuse the verification link; it must be rejected.
7. Test a verification link older than 24 hours; it must be rejected.

### Phone OTP

Only when `AT_USERNAME`, `AT_API_KEY` and `AT_SENDER_ID` are configured:

1. Register with a phone you control.
2. Confirm the SMS OTP arrives.
3. Verify the six-digit code.
4. Confirm protected account/checkout access works.
5. Enter an incorrect code; it must be rejected.
6. Exceed the OTP attempt limit; it must be rate limited.
7. Test an expired OTP; it must be rejected.
8. Request a new code and verify the new code.

### Login

- email + correct password -> works after required verification
- phone + correct password -> works after required verification
- wrong password -> rejected
- unknown identifier -> generic incorrect-credentials response
- repeated failures -> rate limited
- browser JavaScript must not receive a customer session token
- session is stored in an HttpOnly cookie

### Password reset

1. Submit a registered email.
2. Confirm the response does not disclose whether the account exists.
3. Open the real reset email.
4. Set a new password with confirmation.
5. Confirm the old password no longer works.
6. Confirm the reset link cannot be reused.
7. Test an expired reset link; it must be rejected.
8. Confirm no reset token or password is returned to the browser.

### Authorization

- `/api/customers/me` without authentication -> 401
- `/api/customers/me` with another customer's session -> only that session's customer is returned
- checkout without authentication -> redirected to login
- after login, checkout resumes
- order `customer_id` comes from the authenticated server-side customer
- M-PESA status is only visible to the order owner
- customer reviews require the authenticated customer

## Local verification commands

```bash
npm install
node --check server.js
node --check script.js
npm start
```

Then open the PHYNEX site through the Node server, not by opening HTML files directly from disk.
