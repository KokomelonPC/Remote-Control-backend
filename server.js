const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");
let mqtt = null;

try {
  mqtt = require("mqtt");
} catch (error) {
  console.warn("MQTT package is not installed. Run npm install before using MQTT features.");
}

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const WEB_ROOT = path.join(__dirname, "public");
const DATA_FILE = path.join(__dirname, "data", "db.json");
const SHEET_CACHE_FILE = path.join(__dirname, "data", "registry.json");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const REMOTE_SHEET_API_URL = process.env.REMOTE_SHEET_API_URL || "";
const DEVICE_ONLINE_WINDOW_MS = 45000;
const MQTT_HOST = process.env.MQTT_HOST || "3342e4fb3c864571b97185e91ef66377.s1.eu.hivemq.cloud";
const MQTT_PORT = Number(process.env.MQTT_PORT || 8883);
const MQTT_USERNAME = process.env.MQTT_USERNAME || "";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "";
const MQTT_ENABLED = Boolean(mqtt && MQTT_HOST && MQTT_USERNAME && MQTT_PASSWORD);
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "myshop-c3983";
const FIREBASE_CERT_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
let firebaseCertCache = { expiresAt: 0, certs: {} };
let mqttClient = null;

function ensureFile(filePath, fallbackContent) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallbackContent, null, 2));
  }
}

ensureFile(DATA_FILE, {
  users: [],
  sessions: [],
  userDevices: [],
  commandLogs: [],
});

ensureFile(SHEET_CACHE_FILE, {
  rows: [
    {
      no: "1",
      device_id: "ESP32-0001",
      device_secret: "alpha-001",
      model: "relay-1ch",
      status: "available",
      assigned_to: "",
      device_name: "Gate Relay",
      device_ip: "172.20.10.7",
      http_token: "token-esp32-001",
      relay_state: "OFF",
      last_seen: "",
      registered_at: "2026-04-28",
    },
  ],
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function createSessionToken() {
  return `session_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function createCommandId() {
  return `cmd_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hashed = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hashed}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) {
    return false;
  }

  const [salt, originalHash] = storedHash.split(":");
  const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(originalHash, "hex"), Buffer.from(passwordHash, "hex"));
}

function base64UrlToBuffer(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

function base64UrlToJson(value) {
  return JSON.parse(base64UrlToBuffer(value).toString("utf8"));
}

async function getFirebaseCerts() {
  if (firebaseCertCache.expiresAt > Date.now()) {
    return firebaseCertCache.certs;
  }

  const response = await fetch(FIREBASE_CERT_URL);
  if (!response.ok) {
    throw new Error(`Firebase cert fetch failed with status ${response.status}`);
  }

  const cacheControl = response.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAgeMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 60 * 60 * 1000;
  const certs = await response.json();
  firebaseCertCache = {
    certs,
    expiresAt: Date.now() + maxAgeMs - 60000,
  };
  return certs;
}

async function verifyFirebaseIdToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = base64UrlToJson(encodedHeader);
  const payload = base64UrlToJson(encodedPayload);

  if (header.alg !== "RS256" || !header.kid) {
    return null;
  }

  const certs = await getFirebaseCerts();
  const cert = certs[header.kid];
  if (!cert) {
    return null;
  }

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();
  const validSignature = verifier.verify(cert, base64UrlToBuffer(encodedSignature));
  if (!validSignature) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== FIREBASE_PROJECT_ID || payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) {
    return null;
  }
  if (!payload.sub || payload.exp <= now || payload.iat > now + 300) {
    return null;
  }

  return payload;
}

function upsertFirebaseUser(db, firebaseUser) {
  const email = String(firebaseUser.email || "").toLowerCase();
  let user = db.users.find((entry) => entry.firebaseUid === firebaseUser.sub);

  if (!user && email) {
    user = db.users.find((entry) => String(entry.email || "").toLowerCase() === email);
  }

  if (user) {
    let changed = false;
    if (user.firebaseUid !== firebaseUser.sub) {
      user.firebaseUid = firebaseUser.sub;
      changed = true;
    }
    if (!user.authProvider) {
      user.authProvider = "firebase";
      changed = true;
    }
    if (firebaseUser.name && user.displayName !== firebaseUser.name) {
      user.displayName = firebaseUser.name;
      changed = true;
    }
    if (changed) {
      writeJson(DATA_FILE, db);
    }
    return user;
  }

  user = {
    id: `firebase_${firebaseUser.sub}`,
    firebaseUid: firebaseUser.sub,
    authProvider: "firebase",
    displayName: firebaseUser.name || email || "Firebase User",
    email,
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  writeJson(DATA_FILE, db);
  return user;
}

async function getAuthUser(req, db) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    return null;
  }

  const session = db.sessions.find((entry) => entry.token === token);
  if (session) {
    return db.users.find((user) => user.id === session.userId) || null;
  }

  try {
    const firebaseUser = await verifyFirebaseIdToken(token);
    return firebaseUser ? upsertFirebaseUser(db, firebaseUser) : null;
  } catch (error) {
    console.warn("Firebase auth failed:", error.message);
    return null;
  }
}

function parseCsv(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(",").map((item) => item.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const row = {};
    headers.forEach((header, index) => {
      row[header] = (values[index] || "").trim();
    });
    return row;
  });
}

async function loadRegistryRows() {
  if (!SHEET_CSV_URL) {
    return readJson(SHEET_CACHE_FILE).rows;
  }

  const response = await fetch(SHEET_CSV_URL);
  if (!response.ok) {
    throw new Error(`Sheet fetch failed with status ${response.status}`);
  }

  const csvText = await response.text();
  const rows = parseCsv(csvText);
  writeJson(SHEET_CACHE_FILE, { rows });
  return rows;
}

function findRegistryRow(rows, deviceId, deviceSecret) {
  return rows.find(
    (row) =>
      row.device_id === deviceId &&
      row.device_secret === deviceSecret &&
      row.status !== "blocked"
  );
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
  };
}

function serveStaticFile(reqUrl, res) {
  const safePath = reqUrl === "/" ? "/index.html" : reqUrl;
  const filePath = path.join(WEB_ROOT, safePath);

  if (!filePath.startsWith(WEB_ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, 404, "Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "application/javascript; charset=utf-8"
          : "text/plain; charset=utf-8";

  sendText(res, 200, fs.readFileSync(filePath), contentType);
}

function computeOnline(entry) {
  if (!entry.lastSeen) {
    return false;
  }

  const lastSeen = Date.parse(entry.lastSeen);
  if (Number.isNaN(lastSeen)) {
    return false;
  }

  return Date.now() - lastSeen <= DEVICE_ONLINE_WINDOW_MS;
}

function normalizeUserDevice(entry) {
  return {
    ...entry,
    deviceName: entry.deviceName || entry.deviceId,
    relayState: entry.relayState || "OFF",
    deviceIp: entry.deviceIp || "",
    httpToken: entry.httpToken || "",
    pendingCommand: entry.pendingCommand || "",
    pendingCommandId: entry.pendingCommandId || "",
    pendingCommandAt: entry.pendingCommandAt || "",
    lastSeen: entry.lastSeen || "",
    lastReportAt: entry.lastReportAt || "",
    wifiConnected: entry.wifiConnected !== false,
    setupMode: Boolean(entry.setupMode),
  };
}

function publicDevice(entry) {
  const device = normalizeUserDevice(entry);
  return {
    ...device,
    online: computeOnline(device),
  };
}

function userSheetIdentity(user) {
  return {
    userId: user.id || "",
    firebaseUid: user.firebaseUid || "",
    email: user.email || "",
  };
}

function normalizeSheetDevice(user, entry) {
  return normalizeUserDevice({
    id: entry.id || `sheet_device_${entry.deviceId || Date.now()}`,
    userId: user.id,
    deviceId: entry.deviceId || entry.device_id || "",
    deviceName: entry.deviceName || entry.device_name || entry.deviceId || entry.device_id || "",
    model: entry.model || "",
    deviceIp: entry.deviceIp || entry.device_ip || "",
    httpToken: entry.httpToken || entry.http_token || "",
    relayState: entry.relayState || entry.relay_state || "OFF",
    pendingCommand: entry.pendingCommand || "",
    pendingCommandId: entry.pendingCommandId || "",
    pendingCommandAt: entry.pendingCommandAt || "",
    lastSeen: entry.lastSeen || "",
    lastReportAt: entry.lastReportAt || "",
    wifiConnected: entry.wifiConnected !== false && String(entry.wifiConnected || "true") !== "false",
    setupMode: entry.setupMode === true || String(entry.setupMode || "").toLowerCase() === "true",
    ssid: entry.ssid || "",
    createdAt: entry.createdAt || new Date().toISOString(),
  });
}

function requestIdentityMatchesUser(body, user) {
  const requestEmail = String(body.ownerEmail || body.email || "").trim().toLowerCase();
  const requestUid = String(body.firebaseUid || body.uid || "").trim();
  const userEmail = String(user.email || "").trim().toLowerCase();
  const userUid = String(user.firebaseUid || "").trim();
  return (!requestEmail || requestEmail === userEmail) && (!requestUid || requestUid === userUid);
}

function syncUserDevicesToLocalDb(db, user, sheetDevices) {
  let changed = false;
  const nextDevices = sheetDevices.map((device) => normalizeSheetDevice(user, device)).filter((device) => device.deviceId);

  nextDevices.forEach((sheetDevice) => {
    const existingIndex = db.userDevices.findIndex(
      (entry) => entry.userId === user.id && entry.deviceId === sheetDevice.deviceId
    );
    if (existingIndex >= 0) {
      db.userDevices[existingIndex] = normalizeUserDevice({
        ...db.userDevices[existingIndex],
        ...sheetDevice,
        id: db.userDevices[existingIndex].id,
        userId: user.id,
      });
    } else {
      db.userDevices.push(sheetDevice);
    }
    changed = true;
  });

  return changed;
}

async function callRemoteSheet(payload) {
  if (!REMOTE_SHEET_API_URL) {
    return null;
  }

  const response = await fetch(REMOTE_SHEET_API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.message || `Remote sheet request failed: ${response.status}`);
  }
  return data;
}

async function loadUserDevicesFromRemoteSheet(user) {
  if (!REMOTE_SHEET_API_URL) {
    return null;
  }

  const data = await callRemoteSheet({
    action: "getRemoteUserDevices",
    ...userSheetIdentity(user),
  });
  return Array.isArray(data.devices) ? data.devices : [];
}

async function saveUserDeviceToRemoteSheet(user, device) {
  if (!REMOTE_SHEET_API_URL) {
    return;
  }

  await callRemoteSheet({
    action: "saveRemoteUserDevice",
    ...userSheetIdentity(user),
    device,
  });
}

async function updateRemoteSheetDeviceState(device) {
  if (!REMOTE_SHEET_API_URL) {
    return;
  }

  await callRemoteSheet({
    action: "updateRemoteDeviceState",
    device,
  });
}

function updateDeviceEntries(db, deviceId, updater) {
  let changed = false;
  db.userDevices = db.userDevices.map((entry) => {
    if (entry.deviceId !== deviceId) {
      return entry;
    }
    changed = true;
    return normalizeUserDevice(updater(normalizeUserDevice(entry)));
  });
  return changed;
}

function getDeviceStateForPolling(db, deviceId) {
  const device = db.userDevices.find((entry) => entry.deviceId === deviceId);
  if (!device) {
    return {
      relayState: "OFF",
      pendingCommand: "",
      pendingCommandId: "",
    };
  }

  const normalized = normalizeUserDevice(device);
  return {
    relayState: normalized.relayState,
    pendingCommand: normalized.pendingCommand,
    pendingCommandId: normalized.pendingCommandId,
  };
}

function applyDeviceHeartbeat(db, payload) {
  const nowIso = new Date().toISOString();
  const relayState = payload.relay ? "ON" : "OFF";
  const wifiConnected = payload.wifiConnected !== false;
  const setupMode = Boolean(payload.setupMode);
  const stationIp = payload.stationIp || "";
  const ssid = payload.ssid || "";
  const appliedCommandId = payload.appliedCommandId || "";
  const action = payload.action || "";

  updateDeviceEntries(db, payload.deviceId, (entry) => {
    const next = {
      ...entry,
      relayState,
      wifiConnected,
      setupMode,
      deviceIp: stationIp || entry.deviceIp || "",
      ssid,
      lastSeen: nowIso,
      lastReportAt: nowIso,
    };

    if (appliedCommandId && entry.pendingCommandId === appliedCommandId) {
      next.pendingCommand = "";
      next.pendingCommandId = "";
      next.pendingCommandAt = "";
    }

    return next;
  });

  db.commandLogs.push({
    id: `heartbeat_${Date.now()}`,
    type: "device-report",
    deviceId: payload.deviceId,
    action,
    relayState,
    wifiConnected,
    stationIp,
    createdAt: nowIso,
    appliedCommandId,
  });
}

function commandTopic(deviceId) {
  return `devices/${deviceId}/commands`;
}

function stateTopicFilter() {
  return "devices/+/state";
}

function availabilityTopicFilter() {
  return "devices/+/availability";
}

function publishMqttCommand(deviceId, commandId, action) {
  if (!mqttClient || !mqttClient.connected) {
    return false;
  }

  const payload = JSON.stringify({
    commandId,
    action,
    expiresAt: Date.now() + 30000,
  });

  mqttClient.publish(commandTopic(deviceId), payload, { qos: 1 }, (error) => {
    if (error) {
      console.error("MQTT command publish failed:", error.message);
    }
  });
  return true;
}

async function handleMqttStateMessage(topic, message) {
  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch (error) {
    console.warn("MQTT state ignored: invalid JSON");
    return;
  }

  const rows = await loadRegistryRows();
  const registryRow = findRegistryRow(rows, payload.deviceId, payload.deviceSecret);
  if (!registryRow) {
    console.warn(`MQTT state ignored: auth failed for ${payload.deviceId || "unknown device"}`);
    return;
  }

  const db = readJson(DATA_FILE);
  applyDeviceHeartbeat(db, payload);
  writeJson(DATA_FILE, db);
  try {
    await updateRemoteSheetDeviceState({
      deviceId: payload.deviceId,
      deviceIp: payload.stationIp || "",
      ssid: payload.ssid || "",
      relayState: payload.relay ? "ON" : "OFF",
      wifiConnected: payload.wifiConnected !== false,
      setupMode: Boolean(payload.setupMode),
      lastSeen: new Date().toISOString(),
      lastReportAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("Remote device sheet MQTT state update failed:", error.message);
  }
}

async function handleMqttAvailabilityMessage(topic, message) {
  const deviceId = topic.split("/")[1];
  let payload = {};
  try {
    payload = JSON.parse(message.toString());
  } catch (error) {
    payload = { online: message.toString() === "online" };
  }

  const db = readJson(DATA_FILE);
  const nowIso = new Date().toISOString();
  updateDeviceEntries(db, deviceId, (entry) => ({
    ...entry,
    wifiConnected: Boolean(payload.online),
    lastSeen: payload.online ? nowIso : entry.lastSeen,
  }));
  writeJson(DATA_FILE, db);
  try {
    await updateRemoteSheetDeviceState({
      deviceId,
      wifiConnected: Boolean(payload.online),
      lastSeen: payload.online ? nowIso : "",
    });
  } catch (error) {
    console.warn("Remote device sheet MQTT availability update failed:", error.message);
  }
}

function startMqttBridge() {
  if (!MQTT_ENABLED) {
    console.warn("MQTT bridge is disabled because configuration is incomplete.");
    return;
  }

  mqttClient = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    clientId: `remote-control-backend-${crypto.randomBytes(4).toString("hex")}`,
    clean: true,
    reconnectPeriod: 5000,
  });

  mqttClient.on("connect", () => {
    console.log(`MQTT bridge connected to ${MQTT_HOST}:${MQTT_PORT}`);
    mqttClient.subscribe([stateTopicFilter(), availabilityTopicFilter()], { qos: 1 }, (error) => {
      if (error) {
        console.error("MQTT subscribe failed:", error.message);
      }
    });
  });

  mqttClient.on("message", (topic, message) => {
    if (topic.endsWith("/state")) {
      handleMqttStateMessage(topic, message).catch((error) => {
        console.error("MQTT state handler failed:", error.message);
      });
      return;
    }

    if (topic.endsWith("/availability")) {
      handleMqttAvailabilityMessage(topic, message).catch((error) => {
        console.error("MQTT availability handler failed:", error.message);
      });
    }
  });

  mqttClient.on("error", (error) => {
    console.error("MQTT bridge error:", error.message);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    sendText(res, 204, "");
    return;
  }

  try {
    if (req.method === "GET" && requestUrl.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "remote-control-backend",
        mqttEnabled: MQTT_ENABLED,
        mqttConnected: Boolean(mqttClient && mqttClient.connected),
        remoteSheetConfigured: Boolean(REMOTE_SHEET_API_URL),
      });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/auth/register") {
      const body = await parseBody(req);
      const db = readJson(DATA_FILE);

      if (!body.email || !body.password || !body.displayName) {
        sendJson(res, 400, { error: "displayName, email, and password are required" });
        return;
      }

      if (db.users.find((user) => user.email === body.email.toLowerCase())) {
        sendJson(res, 409, { error: "This email is already registered" });
        return;
      }

      const user = {
        id: `user_${Date.now()}`,
        displayName: body.displayName,
        email: body.email.toLowerCase(),
        passwordHash: hashPassword(body.password),
        createdAt: new Date().toISOString(),
      };

      db.users.push(user);
      writeJson(DATA_FILE, db);
      sendJson(res, 201, { user: publicUser(user) });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/auth/login") {
      const body = await parseBody(req);
      const db = readJson(DATA_FILE);
      const user = db.users.find(
        (entry) => entry.email === String(body.email || "").toLowerCase()
      );

      if (!user || !verifyPassword(body.password || "", user.passwordHash)) {
        sendJson(res, 401, { error: "Invalid email or password" });
        return;
      }

      const token = createSessionToken();
      db.sessions.push({
        token,
        userId: user.id,
        createdAt: new Date().toISOString(),
      });
      writeJson(DATA_FILE, db);

      sendJson(res, 200, { token, user: publicUser(user) });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/devices") {
      const db = readJson(DATA_FILE);
      const user = await getAuthUser(req, db);
      if (!user) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      try {
        const sheetDevices = await loadUserDevicesFromRemoteSheet(user);
        if (sheetDevices) {
          const sheetUserDevices = sheetDevices
            .map((device) => normalizeSheetDevice(user, device))
            .filter((device) => device.deviceId);
          const changed = syncUserDevicesToLocalDb(db, user, sheetDevices);
          if (changed) {
            writeJson(DATA_FILE, db);
          }
          sendJson(res, 200, { devices: sheetUserDevices.map(publicDevice), source: "sheet" });
          return;
        }
      } catch (error) {
        console.warn("Remote device sheet load failed:", error.message);
      }

      const devices = db.userDevices
        .filter((entry) => entry.userId === user.id)
        .map(publicDevice);
      sendJson(res, 200, { devices });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/devices/add") {
      const body = await parseBody(req);
      const db = readJson(DATA_FILE);
      const user = await getAuthUser(req, db);
      if (!user) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const rows = await loadRegistryRows();
      const registryRow = findRegistryRow(rows, body.deviceId, body.deviceSecret);

      if (!registryRow) {
        sendJson(res, 404, { error: "Device not found or secret does not match" });
        return;
      }

      const exists = db.userDevices.find((entry) => entry.deviceId === body.deviceId);
      if (exists) {
        if (exists.userId === user.id) {
          try {
            await saveUserDeviceToRemoteSheet(user, normalizeUserDevice({
              ...exists,
              deviceName: body.deviceName || exists.deviceName || registryRow.device_name || registryRow.device_id,
            }));
          } catch (error) {
            console.warn("Remote device sheet save failed:", error.message);
          }
          sendJson(res, 200, { device: publicDevice(exists), alreadyAssigned: true });
          return;
        }
        sendJson(res, 409, { error: "Device is already assigned in backend storage" });
        return;
      }

      const userDevice = normalizeUserDevice({
        id: `user_device_${Date.now()}`,
        userId: user.id,
        deviceId: registryRow.device_id,
        deviceName: body.deviceName || registryRow.device_name || registryRow.device_id,
        model: registryRow.model || "",
        deviceIp: registryRow.device_ip || "",
        httpToken: registryRow.http_token || "",
        relayState: registryRow.relay_state || "OFF",
        pendingCommand: "",
        pendingCommandId: "",
        pendingCommandAt: "",
        lastSeen: "",
        lastReportAt: "",
        wifiConnected: false,
        setupMode: false,
        createdAt: new Date().toISOString(),
      });

      db.userDevices.push(userDevice);
      writeJson(DATA_FILE, db);
      try {
        await saveUserDeviceToRemoteSheet(user, userDevice);
      } catch (error) {
        console.warn("Remote device sheet save failed:", error.message);
      }
      sendJson(res, 201, { device: publicDevice(userDevice) });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname.match(/^\/api\/devices\/[^/]+\/command$/)) {
      const db = readJson(DATA_FILE);
      const user = await getAuthUser(req, db);
      if (!user) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const body = await parseBody(req);
      const deviceId = decodeURIComponent(requestUrl.pathname.split("/")[3]);
      let device = db.userDevices.find((entry) => entry.userId === user.id && entry.deviceId === deviceId);

      if (!device) {
        try {
          const lookupUser = {
            ...user,
            email: requestIdentityMatchesUser(body, user) ? (body.ownerEmail || user.email || "") : (user.email || ""),
            firebaseUid: requestIdentityMatchesUser(body, user) ? (body.firebaseUid || user.firebaseUid || "") : (user.firebaseUid || ""),
          };
          const sheetDevices = await loadUserDevicesFromRemoteSheet(lookupUser);
          if (sheetDevices) {
            syncUserDevicesToLocalDb(db, user, sheetDevices);
            device = db.userDevices.find((entry) => entry.userId === user.id && entry.deviceId === deviceId);
          }
        } catch (error) {
          console.warn("Remote device sheet command lookup failed:", error.message);
        }
      }

      if (!device && requestIdentityMatchesUser(body, user) && body.deviceSnapshot && body.deviceSnapshot.deviceId === deviceId) {
        device = normalizeSheetDevice(user, body.deviceSnapshot);
        db.userDevices.push(device);
      }

      if (!device) {
        sendJson(res, 404, { error: "Device not found in this account" });
        return;
      }

      const action = String(body.action || "").toLowerCase();
      if (!["on", "off", "toggle"].includes(action)) {
        sendJson(res, 400, { error: "Action must be on, off, or toggle" });
        return;
      }

      const commandId = createCommandId();
      const mqttPublished = publishMqttCommand(deviceId, commandId, action);
      const nowIso = new Date().toISOString();
      const previousRelayState = normalizeUserDevice(device).relayState;
      const optimisticRelayState =
        action === "on" ? "ON" : action === "off" ? "OFF" : previousRelayState === "ON" ? "OFF" : "ON";
      updateDeviceEntries(db, deviceId, (entry) => ({
        ...entry,
        relayState: mqttPublished ? optimisticRelayState : entry.relayState,
        wifiConnected: mqttPublished ? true : entry.wifiConnected,
        lastSeen: mqttPublished ? nowIso : entry.lastSeen,
        lastReportAt: mqttPublished ? nowIso : entry.lastReportAt,
        pendingCommand: action,
        pendingCommandId: commandId,
        pendingCommandAt: nowIso,
      }));

      db.commandLogs.push({
        id: `log_${Date.now()}`,
        type: "command-queued",
        userId: user.id,
        deviceId,
        action,
        commandId,
        mqttPublished,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        createdAt: nowIso,
      });

      writeJson(DATA_FILE, db);
      try {
        await updateRemoteSheetDeviceState({
          deviceId,
          relayState: mqttPublished ? optimisticRelayState : undefined,
          wifiConnected: mqttPublished ? true : undefined,
          lastSeen: mqttPublished ? nowIso : undefined,
          lastReportAt: mqttPublished ? nowIso : undefined,
          pendingCommand: action,
          pendingCommandId: commandId,
          pendingCommandAt: nowIso,
        });
      } catch (error) {
        console.warn("Remote device sheet command update failed:", error.message);
      }
      sendJson(res, 200, {
        ok: true,
        queued: true,
        mqttPublished,
        result: {
          commandId,
          action,
          relay: normalizeUserDevice(device).relayState === "ON",
          wifiConnected: computeOnline(device),
        },
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname.match(/^\/api\/devices\/[^/]+\/status$/)) {
      const db = readJson(DATA_FILE);
      const user = await getAuthUser(req, db);
      if (!user) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const deviceId = decodeURIComponent(requestUrl.pathname.split("/")[3]);
      const device = db.userDevices.find((entry) => entry.userId === user.id && entry.deviceId === deviceId);

      if (!device) {
        sendJson(res, 404, { error: "Device not found in this account" });
        return;
      }

      const normalized = publicDevice(device);
      sendJson(res, 200, {
        ok: true,
        status: {
          deviceId: normalized.deviceId,
          relay: normalized.relayState === "ON",
          wifiConnected: normalized.online,
          lastSeen: normalized.lastSeen,
          stationIp: normalized.deviceIp,
          pendingCommand: normalized.pendingCommand,
        },
        device: normalized,
      });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/device/poll") {
      const body = await parseBody(req);
      const rows = await loadRegistryRows();
      const registryRow = findRegistryRow(rows, body.deviceId, body.deviceSecret);
      if (!registryRow) {
        sendJson(res, 401, { error: "Device authentication failed" });
        return;
      }

      const db = readJson(DATA_FILE);
      updateDeviceEntries(db, body.deviceId, (entry) => ({
        ...entry,
        lastSeen: new Date().toISOString(),
        deviceIp: body.stationIp || entry.deviceIp || "",
        ssid: body.ssid || entry.ssid || "",
        wifiConnected: body.wifiConnected !== false,
        setupMode: Boolean(body.setupMode),
      }));
      writeJson(DATA_FILE, db);
      try {
        await updateRemoteSheetDeviceState({
          deviceId: body.deviceId,
          deviceIp: body.stationIp || "",
          ssid: body.ssid || "",
          wifiConnected: body.wifiConnected !== false,
          setupMode: Boolean(body.setupMode),
          lastSeen: new Date().toISOString(),
        });
      } catch (error) {
        console.warn("Remote device sheet poll update failed:", error.message);
      }

      const state = getDeviceStateForPolling(db, body.deviceId);
      sendJson(res, 200, {
        ok: true,
        deviceId: body.deviceId,
        commandId: state.pendingCommandId,
        action: state.pendingCommand,
        relay: state.relayState === "ON",
      });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/device/report") {
      const body = await parseBody(req);
      const rows = await loadRegistryRows();
      const registryRow = findRegistryRow(rows, body.deviceId, body.deviceSecret);
      if (!registryRow) {
        sendJson(res, 401, { error: "Device authentication failed" });
        return;
      }

      const db = readJson(DATA_FILE);
      applyDeviceHeartbeat(db, body);
      writeJson(DATA_FILE, db);
      try {
        await updateRemoteSheetDeviceState({
          deviceId: body.deviceId,
          deviceIp: body.stationIp || "",
          ssid: body.ssid || "",
          relayState: body.relay ? "ON" : "OFF",
          wifiConnected: body.wifiConnected !== false,
          setupMode: Boolean(body.setupMode),
          lastSeen: new Date().toISOString(),
          lastReportAt: new Date().toISOString(),
        });
      } catch (error) {
        console.warn("Remote device sheet report update failed:", error.message);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/registry") {
      const rows = await loadRegistryRows();
      sendJson(res, 200, { rows });
      return;
    }

    serveStaticFile(requestUrl.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Remote control backend listening on http://${HOST}:${PORT}`);
});

startMqttBridge();
