# SmartPark Hub — backend-enabled version

## Project architecture

- Frontend: HTML, CSS and browser JavaScript in `public/`
- Backend: Node.js + Express (`server.js`)
- Database: SQLite (`data/smartpark.sqlite`, created automatically)
- Authentication: bcrypt password hashes and server-side sessions in SQLite
- Existing ESP32 firmware: `esp32_gate_firmware.ino`

## Requirements

Install Node.js 20 or newer. This project should be run through the Express server, not by double-clicking `index.html`.

## Setup (Windows PowerShell)

1. Extract the ZIP.
2. Open the extracted folder in VS Code.
3. Open the terminal in that folder.
4. Install packages:

   ```powershell
   npm install
   ```

5. Create a local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

6. Open `.env` and replace `SESSION_SECRET` with a random string of 32 or more characters. Never publish `.env`.
7. Start the application:

   ```powershell
   npm start
   ```

8. Open `http://localhost:8080`. Use **Login / Register** to create a real account.

On macOS/Linux, use `cp .env.example .env` instead of `Copy-Item`.

## Authentication API

- `POST /api/auth/register` — `{ "name": "Example User", "email": "user@example.com", "password": "a-long-password" }`
- `POST /api/auth/login` — `{ "email": "user@example.com", "password": "a-long-password" }`
- `GET /api/auth/me` — current session user (or `null`)
- `POST /api/auth/logout` — ends the session
- `GET /api/slots` — database-backed slot inventory
- `GET /api/bookings` — current user's bookings (requires login)
- `POST /api/bookings` — create a booking (requires login; validates availability and uses a transaction)
- `POST /api/bookings/:id/cancel` — cancel the current user's confirmed booking

Authentication cookies are HttpOnly and SameSite=Lax; production cookies are Secure. Login attempts are rate limited. Passwords are hashed with bcrypt. API writes reject a mismatched Origin when an Origin header is supplied.

## Manual test checklist

1. Register with a valid name, email, and password of at least 8 characters.
2. Try registering the same email again; expect a duplicate-account error.
3. Log out, then log in with the correct password.
4. Log in with a wrong password; expect an error.
5. Open `/api/auth/me` in the browser after login and confirm it returns the account, without password or password hash.
6. Restart the server and log in again; the account remains in SQLite.
7. Call `/api/bookings` while logged out; expect HTTP 401.
8. With a logged-in session, test booking the same slot twice for overlapping times; the second request should return HTTP 409.

Run a syntax check with `npm run check`.

## Important current limitations

- The original interface contains a large mock workflow in `app.js`. This update replaces simulated profile login with real server authentication, and adds database-backed slot and booking APIs. The legacy UI's booking, wallet, pricing simulation, telemetry and cancellation/refund display are not yet fully migrated to those APIs; some of those screens still use browser `localStorage` and simulated data. Do not present those screens as fully server-persistent until the migration is completed.
- The booking API currently marks non-wallet payments as `PENDING`; it does not integrate a real payment provider. Wallet debit is implemented, but wallet top-up/refund ledger and payment-provider verification need further work.
- The ESP32 sketch contains example network settings and has not been tested with actual hardware. Change credentials and API address before hardware use; never expose a real Wi-Fi password in a public repository.
- The initial database seeds 48 slots only when the slots table is empty. It does not import historical localStorage data automatically.
- For production deployment, use HTTPS, a strong secret, a production process manager, backups and an explicit CSRF strategy appropriate to the deployment.
