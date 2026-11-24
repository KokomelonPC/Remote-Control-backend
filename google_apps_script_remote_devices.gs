const REMOTE_SPREADSHEET_ID = "1KhSkAv148r65vPeQv3lRIMCdQIKHyagiMyejTCE3p5U";
const REMOTE_USER_DEVICE_SHEET_NAME = "RemoteUserDevices";
const SENSOR_HISTORY_SHEET_NAME = "SensorHistory";
const SENSOR_HISTORY_INTERVAL_MS = 10 * 60 * 1000;
const PUBLIC_SENSOR_DEVICE_IDS = ["ESP32-0004"];
const REMOTE_DEVICE_REGISTRY = [
{
  "deviceId": "LORA-0001",
  "deviceSecret": "0a60fd2a79db395f27e8ea6aaf8a3026f70be93e1a065821",
  "deviceName": "LoRa Test Gateway",
  "model": "lora-gateway",
  "deviceType": "lora-gateway",
  "deviceIp": "",
  "httpToken": "",
  "relayState": "OFF"
},
  {
    deviceId: "ESP32-0001",
    deviceSecret: "alpha-001",
    deviceName: "Gate Relay",
    model: "relay-1ch",
    deviceIp: "172.20.10.7",
    httpToken: "token-esp32-001",
    relayState: "OFF",
    deviceType: "switch"
  },
  {
    deviceId: "ESP32-0002",
    deviceSecret: "alpha-002",
    deviceName: "Relay 2",
    model: "relay-1ch",
    deviceIp: "",
    httpToken: "token-esp32-002",
    relayState: "OFF",
    deviceType: "switch"
  },
  {
    deviceId: "ESP32-0003",
    deviceSecret: "alpha-003",
    deviceName: "Relay 3",
    model: "relay-1ch",
    deviceIp: "",
    httpToken: "token-esp32-003",
    relayState: "OFF",
    deviceType: "switch"
  },
  {
    deviceId: "ESP32-0004",
    deviceSecret: "alpha-004",
    deviceName: "Temperature Sensor",
    model: "temperature-humidity-sensor",
    deviceIp: "",
    httpToken: "token-esp32-004",
    relayState: "OFF",
    deviceType: "temperature-sensor"
  }
];

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

    if (action === "getSensorHistory") {
      return jsonResponse(getSensorHistory(body));
    }
    if (action === "getPublicSensorHistory") {
      return jsonResponse(getPublicSensorHistory(body));
    }

    if (action === "appendSensorHistory") {
      return jsonResponse(appendSensorHistory(body));
    }

    if (action === "saveRemoteUserDevice") {
      return jsonResponse(saveRemoteUserDevice(body));
    }

    if (action === "addRemoteUserDevice") {
      return jsonResponse(addRemoteUserDevice(body));
    }

    if (action === "deleteRemoteUserDevice") {
      return jsonResponse(deleteRemoteUserDevice(body));
    }

    if (action === "updateRemoteDeviceState") {
      return jsonResponse(updateRemoteDeviceState(body));
    }

    if (action === "saveRemoteDeviceSchedule") {
      return jsonResponse(saveRemoteDeviceSchedule(body));
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
    "sensorLocation",
    "model",
    "deviceType",
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
    "temperatureC",
    "humidityPercent",
    "turbidityNtu",
    "turbidityVoltage",
    "turbidityFactor",
    "sensorReadAt",
    "schedule",
    "scheduleEnabled",
    "scheduleOnTime",
    "scheduleOffTime",
    "scheduleDays",
    "scheduleTimezone",
    "scheduleLastRunKey",
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

function getSensorHistorySheet() {
  const ss = SpreadsheetApp.openById(REMOTE_SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SENSOR_HISTORY_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SENSOR_HISTORY_SHEET_NAME);
  const headers = [
    "recordedAt", "sampleBucket", "userId", "firebaseUid", "email",
    "deviceId", "deviceName", "temperatureC", "humidityPercent",
    "turbidityNtu", "turbidityVoltage", "pH", "batteryVoltage",
    "solarVoltage", "calibrationVersion"
  ];
  const currentLastColumn = Math.max(sheet.getLastColumn(), headers.length);
  const firstRow = sheet.getRange(1, 1, 1, currentLastColumn).getValues()[0];
  const currentHeaders = firstRow.map(value => String(value || "").trim()).filter(Boolean);
  if (!currentHeaders.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  } else {
    const missing = headers.filter(header => currentHeaders.indexOf(header) === -1);
    if (missing.length) sheet.getRange(1, currentHeaders.length + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}

function findRemoteDeviceOwner(deviceId) {
  const sheet = getRemoteUserDeviceSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return null;
  const headers = values[0].map(value => String(value || "").trim());
  const normalizedId = String(deviceId || "").trim().toUpperCase();
  for (let index = 1; index < values.length; index++) {
    const row = rowToObject(headers, values[index]);
    if (String(row.deviceId || "").trim().toUpperCase() === normalizedId) return row;
  }
  return null;
}

function finiteOrBlank(value) {
  if (value === "" || value === null || value === undefined) return "";
  const number = Number(value);
  return Number.isFinite(number) ? number : "";
}

function appendSensorHistory(body) {
  const measurement = body.measurement || body.device || body || {};
  const deviceId = String(measurement.deviceId || "").trim().toUpperCase();
  if (!deviceId) return { success: false, message: "Missing deviceId" };
  const owner = findRemoteDeviceOwner(deviceId);
  if (!owner) return { success: false, message: "Device owner not found" };

  const recordedAt = measurement.recordedAt ? new Date(measurement.recordedAt) : new Date();
  if (isNaN(recordedAt.getTime())) return { success: false, message: "Invalid recordedAt" };
  const bucket = new Date(Math.floor(recordedAt.getTime() / SENSOR_HISTORY_INTERVAL_MS) * SENSOR_HISTORY_INTERVAL_MS).toISOString();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSensorHistorySheet();
    const values = sheet.getDataRange().getValues();
    const headers = values[0].map(value => String(value || "").trim());
    const deviceIndex = headers.indexOf("deviceId");
    const bucketIndex = headers.indexOf("sampleBucket");
    for (let index = values.length - 1; index >= 1; index--) {
      if (String(values[index][deviceIndex] || "").toUpperCase() === deviceId &&
          String(values[index][bucketIndex] || "") === bucket) {
        return { success: true, appended: false, sampleBucket: bucket };
      }
    }
    const row = {
      recordedAt,
      sampleBucket: bucket,
      userId: owner.userId || "",
      firebaseUid: owner.firebaseUid || "",
      email: owner.email || "",
      deviceId,
      deviceName: owner.deviceName || deviceId,
      temperatureC: finiteOrBlank(measurement.temperatureC),
      humidityPercent: finiteOrBlank(measurement.humidityPercent),
      turbidityNtu: finiteOrBlank(measurement.turbidityNtu),
      turbidityVoltage: finiteOrBlank(measurement.turbidityVoltage),
      pH: finiteOrBlank(measurement.pH),
      batteryVoltage: finiteOrBlank(measurement.batteryVoltage),
      solarVoltage: finiteOrBlank(measurement.solarVoltage),
      calibrationVersion: measurement.calibrationVersion || "uncalibrated"
    };
    sheet.appendRow(headers.map(header => row[header] === undefined ? "" : row[header]));
    return { success: true, appended: true, sampleBucket: bucket };
  } finally {
    lock.releaseLock();
  }
}

function getSensorHistory(body) {
  const firebaseUid = String(body.firebaseUid || body.uid || "").trim();
  const userId = String(body.userId || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const deviceId = String(body.deviceId || "").trim().toUpperCase();
  if (!firebaseUid && !userId && !email) return { success: false, message: "Missing user identity" };
  if (!deviceId) return { success: false, message: "Missing deviceId" };

  const startMs = body.startAt ? new Date(body.startAt).getTime() : 0;
  const endMs = body.endAt ? new Date(body.endAt).getTime() : Date.now();
  const sheet = getSensorHistorySheet();
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return { success: true, measurements: [] };
  const headers = values[0].map(value => String(value || "").trim());
  const measurements = values.slice(1).map(row => rowToObject(headers, row)).filter(row => {
    const recordedMs = new Date(row.recordedAt).getTime();
    return String(row.deviceId || "").toUpperCase() === deviceId &&
      matchesUser(row, firebaseUid, email, userId) &&
      Number.isFinite(recordedMs) && recordedMs >= startMs && recordedMs <= endMs;
  }).map(row => ({
    recordedAt: new Date(row.recordedAt).toISOString(),
    temperatureC: finiteOrBlank(row.temperatureC),
    humidityPercent: finiteOrBlank(row.humidityPercent),
    turbidityNtu: finiteOrBlank(row.turbidityNtu),
    turbidityVoltage: finiteOrBlank(row.turbidityVoltage),
    pH: finiteOrBlank(row.pH),
    batteryVoltage: finiteOrBlank(row.batteryVoltage),
    solarVoltage: finiteOrBlank(row.solarVoltage),
    calibrationVersion: row.calibrationVersion || ""
  }));
  return { success: true, measurements };
}

function getPublicSensorHistory(body) {
  const deviceId = String(body.deviceId || "").trim().toUpperCase();
  if (PUBLIC_SENSOR_DEVICE_IDS.indexOf(deviceId) === -1) {
    return { success: false, message: "Device is not public" };
  }

  const startMs = body.startAt ? new Date(body.startAt).getTime() : Date.now() - 86400000;
  const endMs = body.endAt ? new Date(body.endAt).getTime() : Date.now();
  const owner = findRemoteDeviceOwner(deviceId) || {};
  const sheet = getSensorHistorySheet();
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return {
    success: true,
    deviceName: owner.deviceName || deviceId,
    sensorLocation: owner.sensorLocation || "",
    turbidityFactor: Number(owner.turbidityFactor) >= 0.0001 && Number(owner.turbidityFactor) <= 100 ? Number(owner.turbidityFactor) : 1,
    measurements: []
  };
  const headers = values[0].map(value => String(value || "").trim());
  const measurements = values.slice(1).map(row => rowToObject(headers, row)).filter(row => {
    const recordedMs = new Date(row.recordedAt).getTime();
    return String(row.deviceId || "").toUpperCase() === deviceId &&
      Number.isFinite(recordedMs) && recordedMs >= startMs && recordedMs <= endMs;
  }).map(row => ({
    recordedAt: new Date(row.recordedAt).toISOString(),
    temperatureC: finiteOrBlank(row.temperatureC),
    humidityPercent: finiteOrBlank(row.humidityPercent),
    turbidityNtu: finiteOrBlank(row.turbidityNtu),
    turbidityVoltage: finiteOrBlank(row.turbidityVoltage),
    pH: finiteOrBlank(row.pH),
    batteryVoltage: finiteOrBlank(row.batteryVoltage),
    solarVoltage: finiteOrBlank(row.solarVoltage),
    calibrationVersion: row.calibrationVersion || ""
  }));
  return {
    success: true,
    deviceName: owner.deviceName || deviceId,
    sensorLocation: owner.sensorLocation || "",
    turbidityFactor: Number(owner.turbidityFactor) >= 0.0001 && Number(owner.turbidityFactor) <= 100 ? Number(owner.turbidityFactor) : 1,
    measurements
  };
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
    sensorLocation: device.sensorLocation === undefined ? (current.sensorLocation || "") : String(device.sensorLocation || "").trim(),
    model: device.model || current.model || "",
    deviceType: device.deviceType || current.deviceType || "switch",
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
    temperatureC: device.temperatureC === undefined ? (current.temperatureC || "") : device.temperatureC,
    humidityPercent: device.humidityPercent === undefined ? (current.humidityPercent || "") : device.humidityPercent,
    turbidityNtu: device.turbidityNtu === undefined ? (current.turbidityNtu || "") : device.turbidityNtu,
    turbidityVoltage: device.turbidityVoltage === undefined ? (current.turbidityVoltage || "") : device.turbidityVoltage,
    turbidityFactor: device.turbidityFactor === undefined ? (current.turbidityFactor || 1) : Math.max(0.0001, Math.min(100, Number(device.turbidityFactor) || 1)),
    sensorReadAt: device.sensorReadAt || current.sensorReadAt || "",
    schedule: device.schedule === undefined ? (current.schedule || "") : JSON.stringify(device.schedule || {}),
    scheduleEnabled: device.scheduleEnabled === undefined ? (current.scheduleEnabled || false) : Boolean(device.scheduleEnabled),
    scheduleOnTime: device.scheduleOnTime || current.scheduleOnTime || "",
    scheduleOffTime: device.scheduleOffTime || current.scheduleOffTime || "",
    scheduleDays: device.scheduleDays || current.scheduleDays || "daily",
    scheduleTimezone: device.scheduleTimezone || current.scheduleTimezone || "Asia/Bangkok",
    scheduleLastRunKey: device.scheduleLastRunKey || current.scheduleLastRunKey || "",
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

function findRegistryDevice(deviceId, deviceSecret) {
  const normalizedId = String(deviceId || "").trim().toUpperCase();
  const secret = String(deviceSecret || "").trim();
  return REMOTE_DEVICE_REGISTRY.find(item => item.deviceId === normalizedId && item.deviceSecret === secret);
}

function addRemoteUserDevice(body) {
  const requestedDevice = body.device || {};
  const registryDevice = findRegistryDevice(requestedDevice.deviceId || body.deviceId, requestedDevice.deviceSecret || body.deviceSecret);
  if (!registryDevice) {
    return { success: false, message: "Device not found or secret does not match" };
  }

  return saveRemoteUserDevice({
    ...body,
    device: {
      deviceId: registryDevice.deviceId,
      deviceName: requestedDevice.deviceName || registryDevice.deviceName || registryDevice.deviceId,
      model: registryDevice.model || "",
      deviceType: requestedDevice.deviceType || registryDevice.deviceType || "switch",
      deviceIp: registryDevice.deviceIp || "",
      httpToken: registryDevice.httpToken || "",
      relayState: registryDevice.relayState || "OFF",
      wifiConnected: false,
      setupMode: false
    }
  });
}

function matchesUser(row, firebaseUid, email, userId) {
  const rowUid = String(row.firebaseUid || "").trim();
  const rowUserId = String(row.userId || "").trim();
  const rowEmail = String(row.email || "").trim().toLowerCase();
  return (firebaseUid && rowUid === firebaseUid) ||
    (userId && rowUserId === userId) ||
    (email && rowEmail === email);
}

function deleteRemoteUserDevice(body) {
  const firebaseUid = String(body.firebaseUid || body.uid || "").trim();
  const userId = String(body.userId || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const deviceId = String(body.deviceId || (body.device && body.device.deviceId) || "").trim().toUpperCase();

  if (!deviceId) return { success: false, message: "Missing deviceId" };
  if (!firebaseUid && !userId && !email) return { success: false, message: "Missing user identity" };

  const sheet = getRemoteUserDeviceSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return { success: true, deleted: 0 };

  const headers = values[0].map(header => String(header || "").trim());
  let deleted = 0;
  for (let i = values.length - 1; i >= 1; i--) {
    const row = rowToObject(headers, values[i]);
    if (String(row.deviceId || "").toUpperCase() === deviceId && matchesUser(row, firebaseUid, email, userId)) {
      sheet.deleteRow(i + 1);
      deleted++;
    }
  }

  return { success: true, deleted };
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
      pendingCommand: device.pendingCommand === undefined ? current.pendingCommand : device.pendingCommand,
      pendingCommandId: device.pendingCommandId === undefined ? current.pendingCommandId : device.pendingCommandId,
      pendingCommandAt: device.pendingCommandAt === undefined ? current.pendingCommandAt : device.pendingCommandAt,
      lastSeen: device.lastSeen || current.lastSeen || now,
      lastReportAt: device.lastReportAt || current.lastReportAt || "",
      wifiConnected: device.wifiConnected === undefined ? current.wifiConnected : Boolean(device.wifiConnected),
      setupMode: device.setupMode === undefined ? current.setupMode : Boolean(device.setupMode),
      ssid: device.ssid || current.ssid || "",
      temperatureC: device.temperatureC === undefined ? current.temperatureC : device.temperatureC,
      humidityPercent: device.humidityPercent === undefined ? current.humidityPercent : device.humidityPercent,
      turbidityNtu: device.turbidityNtu === undefined ? current.turbidityNtu : device.turbidityNtu,
      turbidityVoltage: device.turbidityVoltage === undefined ? current.turbidityVoltage : device.turbidityVoltage,
      turbidityFactor: device.turbidityFactor === undefined ? (current.turbidityFactor || 1) : Math.max(0.0001, Math.min(100, Number(device.turbidityFactor) || 1)),
      sensorReadAt: device.sensorReadAt || current.sensorReadAt || "",
      schedule: device.schedule === undefined ? current.schedule : JSON.stringify(device.schedule || {}),
      scheduleEnabled: device.scheduleEnabled === undefined ? current.scheduleEnabled : Boolean(device.scheduleEnabled),
      scheduleOnTime: device.scheduleOnTime || current.scheduleOnTime || "",
      scheduleOffTime: device.scheduleOffTime || current.scheduleOffTime || "",
      scheduleDays: device.scheduleDays || current.scheduleDays || "daily",
      scheduleTimezone: device.scheduleTimezone || current.scheduleTimezone || "Asia/Bangkok",
      scheduleLastRunKey: device.scheduleLastRunKey || current.scheduleLastRunKey || "",
      updatedAt: now
    };
    sheet.getRange(i + 1, 1, 1, headers.length).setValues([headers.map(header => next[header] ?? "")]);
    updated++;
  }

  return { success: true, updated };
}


function saveRemoteDeviceSchedule(body) {
  const schedule = body.schedule || {};
  return updateRemoteDeviceState({
    device: {
      deviceId: body.deviceId || (body.device && body.device.deviceId) || "",
      schedule,
      scheduleEnabled: Boolean(schedule.enabled),
      scheduleOnTime: String(schedule.onTime || "").slice(0, 5),
      scheduleOffTime: String(schedule.offTime || "").slice(0, 5),
      scheduleDays: schedule.days || "daily",
      scheduleTimezone: schedule.timezone || "Asia/Bangkok",
      scheduleLastRunKey: schedule.lastRunKey || ""
    }
  });
}
