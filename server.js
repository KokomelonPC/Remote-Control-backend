const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const WEB_ROOT = path.join(__dirname, "public");
const DATA_FILE = path.join(__dirname, "data", "db.json");
const SHEET_CACHE_FILE = path.join(__dirname, "data", "registry.json");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";

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

function getAuthUser(req, db) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    return null;
  }

  const session = db.sessions.find((entry) => entry.token === token);
  if (!session) {
    return null;
  }

  return db.users.find((user) => user.id === session.userId) || null;
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

async function forwardDeviceCommand(device, action) {
  const response = await fetch(`http://${device.deviceIp}/api/${action}?token=${device.httpToken}`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`ESP32 responded with status ${response.status}`);
  }

  return response.json();
}

async function fetchDeviceStatus(device) {
  const response = await fetch(`http://${device.deviceIp}/api/status?token=${device.httpToken}`);
  if (!response.ok) {
    throw new Error(`ESP32 status failed with ${response.status}`);
  }
  return response.json();
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    sendText(res, 204, "");
    return;
  }

  try {
    if (req.method === "GET" && requestUrl.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, service: "remote-control-backend" });
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
      const user = getAuthUser(req, db);
      if (!user) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const devices = db.userDevices.filter((entry) => entry.userId === user.id);
      sendJson(res, 200, { devices });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/devices/add") {
      const body = await parseBody(req);
      const db = readJson(DATA_FILE);
      const user = getAuthUser(req, db);
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
        sendJson(res, 409, { error: "Device is already assigned in backend storage" });
        return;
      }

      const userDevice = {
        id: `user_device_${Date.now()}`,
        userId: user.id,
        deviceId: registryRow.device_id,
        deviceName: body.deviceName || registryRow.device_name || registryRow.device_id,
        model: registryRow.model || "",
        deviceIp: registryRow.device_ip || "",
        httpToken: registryRow.http_token || "",
        relayState: registryRow.relay_state || "OFF",
        createdAt: new Date().toISOString(),
      };

      db.userDevices.push(userDevice);
      writeJson(DATA_FILE, db);
      sendJson(res, 201, { device: userDevice });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname.match(/^\/api\/devices\/[^/]+\/command$/)) {
      const db = readJson(DATA_FILE);
      const user = getAuthUser(req, db);
      if (!user) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const body = await parseBody(req);
      const deviceId = decodeURIComponent(requestUrl.pathname.split("/")[3]);
      const device = db.userDevices.find((entry) => entry.userId === user.id && entry.deviceId === deviceId);

      if (!device) {
        sendJson(res, 404, { error: "Device not found in this account" });
        return;
      }

      if (!device.deviceIp || !device.httpToken) {
        sendJson(res, 400, { error: "Device IP or HTTP token is missing" });
        return;
      }

      const action = String(body.action || "").toLowerCase();
      if (!["on", "off", "toggle"].includes(action)) {
        sendJson(res, 400, { error: "Action must be on, off, or toggle" });
        return;
      }

      const result = await forwardDeviceCommand(device, action);
      device.relayState = result.relay ? "ON" : "OFF";
      db.commandLogs.push({
        id: `log_${Date.now()}`,
        userId: user.id,
        deviceId: device.deviceId,
        action,
        result,
        createdAt: new Date().toISOString(),
      });
      writeJson(DATA_FILE, db);
      sendJson(res, 200, { ok: true, result, device });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname.match(/^\/api\/devices\/[^/]+\/status$/)) {
      const db = readJson(DATA_FILE);
      const user = getAuthUser(req, db);
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

      const status = await fetchDeviceStatus(device);
      device.relayState = status.relay ? "ON" : "OFF";
      writeJson(DATA_FILE, db);
      sendJson(res, 200, { ok: true, status, device });
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
