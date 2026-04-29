# Remote Control Backend V1

Simple backend prototype for the ESP32 remote control project.

## What It Does

- register user
- login user
- store session token
- add device by validating `device_id` and `device_secret`
- send HTTP `on/off/toggle` commands to ESP32
- fetch current ESP32 status

## Password Storage

Passwords are not stored as plain text.

This backend uses:

- `crypto.scryptSync(...)` for password hashing
- random salt per user
- stored format: `salt:hash`

That is much safer than saving raw passwords directly in `db.json`.

## Files

- `server.js`: backend server
- `public/`: small status page
- `data/db.json`: local app storage
- `data/registry.json`: local device registry cache
- `.gitignore`: excludes runtime, zip, and local user data

## Endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/devices`
- `POST /api/devices/add`
- `POST /api/devices/:deviceId/command`
- `GET /api/devices/:deviceId/status`
- `GET /api/registry`
- `GET /api/health`

## Request Examples

### Register

```json
POST /api/auth/register
{
  "displayName": "Kogo",
  "email": "demo@example.com",
  "password": "password123"
}
```

### Login

```json
POST /api/auth/login
{
  "email": "demo@example.com",
  "password": "password123"
}
```

### Add Device

```json
POST /api/devices/add
Authorization: Bearer <session-token>
{
  "deviceId": "ESP32-0001",
  "deviceSecret": "alpha-001",
  "deviceName": "Gate Relay"
}
```

### Send ON Command

```json
POST /api/devices/ESP32-0001/command
Authorization: Bearer <session-token>
{
  "action": "on"
}
```

## Google Sheet Later

To use the real Google Sheet later, publish the sheet as CSV and set:

```powershell
$env:SHEET_CSV_URL="https://..."
node server.js
```

## GitHub Upload Notes

Upload these backend files:

- `server.js`
- `README.md`
- `.gitignore`
- `public/index.html`
- `public/styles.css`
- `public/app.js`
- `data/registry.json`

Do not upload:

- `runtime/`
- `node-v24.11.0-win-x64.zip`
- `data/db.json` if it already contains real users
