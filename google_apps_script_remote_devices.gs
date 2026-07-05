const REMOTE_SPREADSHEET_ID = "1KhSkAv148r65vPeQv3lRIMCdQIKHyagiMyejTCE3p5U";
const REMOTE_USER_DEVICE_SHEET_NAME = "RemoteUserDevices";

function doGet(e) {
  e = e || { parameter: {} };
  const action = String(e.parameter.action || "").trim();

  try {
    if (action === "getRemoteUserDevices") {
      return jsonResponse(getRemoteUserDevices(e.parameter.firebaseUid || e.parameter.uid, e.parameter.email, e.parameter.userId));
    }

    return jsonResponse({ success: false, message: "Unknown action" });
  } catch (error) {
    return jsonResponse({ success: false, message: error.message });
  }
}

function doPost(e) {
  e = e || { postData: { contents: "{}" } };
  try {
    const body = JSON.parse(e.postData.contents || "{}");
    const action = String(body.action || "").trim();

    if (action === "getRemoteUserDevices") {
      return jsonResponse(getRemoteUserDevices(body.firebaseUid || body.uid, body.email, body.userId));
    }

    if (action === "saveRemoteUserDevice") {
      return jsonResponse(saveRemoteUserDevice(body));
    }

    if (action === "updateRemoteDeviceState") {
      return jsonResponse(updateRemoteDeviceState(body));
    }

    return jsonResponse({ success: false, message: "Unknown action" });
  } catch (error) {
    return jsonResponse({ success: false, message: error.message });
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getRemoteUserDeviceSheet() {
  const ss = SpreadsheetApp.openById(REMOTE_SPREADSHEET_ID);
  let sheet = ss.getSheetByName(REMOTE_USER_DEVICE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(REMOTE_USER_DEVICE_SHEET_NAME);
  }
  ensureRemoteUserDeviceHeaders(sheet);
  return sheet;
}

function ensureRemoteUserDeviceHeaders(sheet) {
  const headers = [
    "userId",
    "firebaseUid",
    "email",
    "deviceId",
    "deviceName",
    "model",
    "deviceIp",
    "httpToken",
    "relayState",
    "pendingCommand",
    "pendingCommandId",
    "pendingCommandAt",
    "lastSeen",
    "lastReportAt",
    "wifiConnected",
    "setupMode",
    "ssid",
    "createdAt",
    "updatedAt"
  ];
  const currentLastColumn = Math.max(sheet.getLastColumn(), headers.length);
  const firstRow = sheet.getRange(1, 1, 1, currentLastColumn).getValues()[0];
  const hasHeader = firstRow.some(value => String(value || "").trim() !== "");
  if (!hasHeader) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, headers.length);
    return;
  }
  const currentHeaders = firstRow.map(value => String(value || "").trim()).filter(Boolean);
  const missingHeaders = headers.filter(header => currentHeaders.indexOf(header) === -1);
  if (missingHeaders.length) {
    sheet.getRange(1, currentHeaders.length + 1, 1, missingHeaders.length).setValues([missingHeaders]);
    sheet.autoResizeColumns(1, currentHeaders.length + missingHeaders.length);
  }
}

function rowToObject(headers, row) {
  const out = {};
  headers.forEach((header, index) => {
    out[header] = row[index];
  });
  return out;
}

function getRemoteUserDevices(firebaseUid, email, userId) {
  const sheet = getRemoteUserDeviceSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return { success: true, devices: [] };

  const headers = values[0].map(header => String(header || "").trim());
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const uidText = String(firebaseUid || "").trim();
  const userIdText = String(userId || "").trim();
  const devices = values.slice(1)
    .filter(row => row.some(cell => String(cell || "").trim() !== ""))
    .map(row => rowToObject(headers, row))
    .filter(device => {
      const rowUid = String(device.firebaseUid || "").trim();
      const rowUserId = String(device.userId || "").trim();
      const rowEmail = String(device.email || "").trim().toLowerCase();
      return (uidText && rowUid === uidText) || (userIdText && rowUserId === userIdText) || (normalizedEmail && rowEmail === normalizedEmail);
    });

  return { success: true, devices };
}

function saveRemoteUserDevice(body) {
  const device = body.device || {};
  const firebaseUid = String(body.firebaseUid || body.uid || "").trim();
  const userId = String(body.userId || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const deviceId = String(device.deviceId || body.deviceId || "").trim().toUpperCase();

  if (!deviceId) return { success: false, message: "Missing deviceId" };
  if (!firebaseUid && !userId && !email) return { success: false, message: "Missing user identity" };

  const sheet = getRemoteUserDeviceSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(header => String(header || "").trim());
  const values = sheet.getDataRange().getValues();
  const now = new Date();
  let rowNumber = -1;

  for (let i = 1; i < values.length; i++) {
    const row = rowToObject(headers, values[i]);
    const sameUser = (firebaseUid && String(row.firebaseUid || "") === firebaseUid) ||
      (userId && String(row.userId || "") === userId) ||
      (email && String(row.email || "").toLowerCase() === email);
    if (sameUser && String(row.deviceId || "").toUpperCase() === deviceId) {
      rowNumber = i + 1;
      break;
    }
  }

  const current = rowNumber > 0 ? rowToObject(headers, sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0]) : {};
  const next = {
    userId: userId || current.userId || "",
    firebaseUid: firebaseUid || current.firebaseUid || "",
    email: email || current.email || "",
    deviceId,
    deviceName: device.deviceName || current.deviceName || deviceId,
    model: device.model || current.model || "",
    deviceIp: device.deviceIp || current.deviceIp || "",
    httpToken: device.httpToken || current.httpToken || "",
    relayState: device.relayState || current.relayState || "OFF",
    pendingCommand: device.pendingCommand || current.pendingCommand || "",
    pendingCommandId: device.pendingCommandId || current.pendingCommandId || "",
    pendingCommandAt: device.pendingCommandAt || current.pendingCommandAt || "",
    lastSeen: device.lastSeen || current.lastSeen || "",
    lastReportAt: device.lastReportAt || current.lastReportAt || "",
    wifiConnected: device.wifiConnected === undefined ? (current.wifiConnected || false) : Boolean(device.wifiConnected),
    setupMode: device.setupMode === undefined ? (current.setupMode || false) : Boolean(device.setupMode),
    ssid: device.ssid || current.ssid || "",
    createdAt: current.createdAt || device.createdAt || now,
    updatedAt: now
  };

  if (rowNumber > 0) {
    sheet.getRange(rowNumber, 1, 1, headers.length).setValues([headers.map(header => next[header] ?? "")]);
  } else {
    sheet.appendRow(headers.map(header => next[header] ?? ""));
  }

  return { success: true, device: next };
}

function updateRemoteDeviceState(body) {
  const device = body.device || body || {};
  const deviceId = String(device.deviceId || "").trim().toUpperCase();
  if (!deviceId) return { success: false, message: "Missing deviceId" };

  const sheet = getRemoteUserDeviceSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return { success: true, updated: 0 };

  const headers = values[0].map(header => String(header || "").trim());
  const deviceIdIndex = headers.indexOf("deviceId");
  if (deviceIdIndex === -1) return { success: false, message: "Missing deviceId header" };

  const now = new Date();
  let updated = 0;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][deviceIdIndex] || "").toUpperCase() !== deviceId) continue;
    const current = rowToObject(headers, values[i]);
    const next = {
      ...current,
      deviceIp: device.deviceIp || current.deviceIp || "",
      relayState: device.relayState || current.relayState || "OFF",
      lastSeen: device.lastSeen || current.lastSeen || now,
      lastReportAt: device.lastReportAt || current.lastReportAt || "",
      wifiConnected: device.wifiConnected === undefined ? current.wifiConnected : Boolean(device.wifiConnected),
      setupMode: device.setupMode === undefined ? current.setupMode : Boolean(device.setupMode),
      ssid: device.ssid || current.ssid || "",
      updatedAt: now
    };
    sheet.getRange(i + 1, 1, 1, headers.length).setValues([headers.map(header => next[header] ?? "")]);
    updated++;
  }

  return { success: true, updated };
}
