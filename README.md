# Remote Control Backend V1

Backend prototype for the ESP32 remote control project.

## What It Does

- register user
- login user
- store session token
- add device by validating `device_id` and `device_secret`
- send MQTT `on/off/toggle` commands to ESP32 via HiveMQ Cloud
- receive ESP32 state and availability over MQTT
- keep HTTP poll/report compatibility for older firmware

## Password Storage

Passwords are not stored as plain text.

This backend uses:

- `crypto.scryptSync(...)` for password hashing
- random salt per user
- stored format: `salt:hash`

That is much safer than saving raw passwords directly in `db.json`.

## Files

- `server.js`: backend server
- `package.json`: Node dependencies and start script
- `public/`: small status page
- `data/db.json`: local app storage
- `data/registry.json`: local device registry cache
- `.gitignore`: excludes runtime, zip, and local user data

## Local Run

Install dependencies once:

```powershell
npm install
```

Run with MQTT credentials:

```powershell
$env:MQTT_HOST="3342e4fb3c864571b97185e91ef66377.s1.eu.hivemq.cloud"
$env:MQTT_PORT="8883"
$env:MQTT_USERNAME="backend_api"
$env:MQTT_PASSWORD="<backend mqtt password>"
npm start
```

If using the bundled portable Node runtime:

```powershell
$env:MQTT_USERNAME="backend_api"
$env:MQTT_PASSWORD="<backend mqtt password>"
.\runtime\node.exe server.js
```

## Cloud Deploy

Deploy the `backend/` folder to Render, Railway, or another Node host.

### Render Manual Setup

Use:

```text
Build command: npm install
Start command: npm start
```

Set environment variables:

```text
MQTT_HOST=3342e4fb3c864571b97185e91ef66377.s1.eu.hivemq.cloud
MQTT_PORT=8883
MQTT_USERNAME=backend_api
MQTT_PASSWORD=<backend mqtt password>
SHEET_CSV_URL=<optional published CSV URL>
```

### Render Blueprint Setup

This folder also includes `render.yaml`.

1. Push the backend folder to the GitHub backend repository.
2. In Render, choose `New` -> `Blueprint`.
3. Select the GitHub backend repository.
4. Fill the secret environment variables:
   - `MQTT_USERNAME`
   - `MQTT_PASSWORD`
   - optional `SHEET_CSV_URL`
5. Deploy.

After deploy, update the web `config.js`:

```js
window.REMOTE_CONTROL_API_BASE_URL = "https://your-backend-host.example.com/api";
```

## MQTT Topics

Backend publishes commands:

```text
devices/{deviceId}/commands
```

ESP32 publishes state and availability:

```text
devices/{deviceId}/state
devices/{deviceId}/availability
```

Commands include a 30 second expiry:

```json
{
  "commandId": "cmd_...",
  "action": "toggle",
  "expiresAt": 1770000000000
}
```

## MQTT Credentials

For development, HiveMQ can use broad permissions. Before production, create separate MQTT credentials:

- `backend_api`: publish `devices/+/commands`, subscribe `devices/+/state` and `devices/+/availability`
- `esp32_0001`: subscribe `devices/ESP32-0001/commands`, publish `devices/ESP32-0001/state` and `devices/ESP32-0001/availability`

Create one ESP32 credential per shipped device when possible.

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
- `package.json`
- `package-lock.json`
- `README.md`
- `.gitignore`
- `public/index.html`
- `public/styles.css`
- `public/app.js`
- `public/config.js`
- `data/registry.json`

Do not upload:

- `runtime/`
- `node-v24.11.0-win-x64.zip`
- `node_modules/`
- `data/db.json` if it already contains real users
