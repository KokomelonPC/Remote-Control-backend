// Latest sample only: separate from sensor history and relay state.
function validateSample(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (body.sourceId !== undefined && body.sourceId !== 1 && body.sourceId !== 2) return null;
  const integer = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
  if (!integer(body.session) || !integer(body.sequence) ||
      typeof body.value !== "number" || !Number.isFinite(body.value) || Math.abs(body.value) > 1000000 ||
      !Number.isInteger(body.rssi) || body.rssi < -200 || body.rssi > 20 ||
      typeof body.snr !== "number" || !Number.isFinite(body.snr) || Math.abs(body.snr) > 100 ||
      !integer(body.ageMs) || body.ageMs > 300000) return null;
  const result = { session: body.session, sequence: body.sequence, value: body.value,
    rssi: body.rssi, snr: body.snr, ageMs: body.ageMs,
    tankLevel: Number.isFinite(body.tankLevel) ? body.tankLevel : body.value,
    tankMax: Number.isFinite(body.tankMax) ? body.tankMax : 10000,
    pumpMask: Number.isInteger(body.pumpMask) && body.pumpMask >= 0 && body.pumpMask <= 15 ? body.pumpMask : null,
    pumpKnownMask: Object.prototype.hasOwnProperty.call(body, 'pumpKnownMask')
      ? (Number.isInteger(body.pumpKnownMask) && body.pumpKnownMask >= 0 && body.pumpKnownMask <= 15 ? body.pumpKnownMask : 0)
      : (Number.isInteger(body.pumpMask) && body.pumpMask >= 0 && body.pumpMask <= 15 ? 15 : 0) };
  if (Object.prototype.hasOwnProperty.call(body, 'tankKnown')) result.tankKnown = body.tankKnown === true;
  if (Object.prototype.hasOwnProperty.call(body, 'highPumpMask')) {
    const validMask = v => Number.isInteger(v) && v >= 0 && v <= 127;
    result.highPumpMask = validMask(body.highPumpMask) ? body.highPumpMask : null;
    result.highPumpKnownMask = validMask(body.highPumpKnownMask) && result.highPumpMask !== null && !(result.highPumpMask & ~body.highPumpKnownMask) ? body.highPumpKnownMask : 0;
  }
  for (const key of ['cityPressure', 'banLaemFlow', 'cityFlow', 'hatChaoFlow']) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      result[key] = typeof body[key] === 'number' && Number.isFinite(body[key]) && body[key] >= 0 && body[key] <= (key === 'cityPressure' ? 100 : 1000000) ? body[key] : null;
    }
  }
  if (body.sourceId !== undefined) result.sourceId = body.sourceId;
  if (body.sourceId === 2) {
    result.tankKnown = false;
    const mask = v => Number.isInteger(v) && v >= 0 && v <= 3;
    result.pumpMask = mask(body.pumpMask) ? body.pumpMask : null;
    result.maintenanceMask = mask(body.maintenanceMask) ? body.maintenanceMask : 0;
    result.pumpKnownMask = mask(body.pumpKnownMask) && mask(body.maintenanceMask) && result.pumpMask !== null &&
      !(result.pumpMask & ~body.pumpKnownMask) && !(result.maintenanceMask & ~body.pumpKnownMask) && !(result.pumpMask & result.maintenanceMask) ? body.pumpKnownMask : 0;
    for (const key of ['rawLevel', 'banLat1Pressure', 'banLat1Flow']) {
      result[key] = typeof body[key] === 'number' && Number.isFinite(body[key]) && body[key] >= 0 && body[key] <= (key === 'banLat1Flow' ? 1000000 : 100) ? body[key] : null;
    }
  }
  return result;
}

function recordSample(db, deviceId, sample, now = Date.now()) {
  db.loraReadings ||= {};
  const storageKey = sample.sourceId === 2 ? `${deviceId}:2` : deviceId;
  const previous = db.loraReadings[storageKey];
  if (previous && previous.session === sample.session) {
    const delta = (sample.sequence - previous.sequence) >>> 0;
    if (delta === 0 || delta >= 0x80000000) return false;
  }
  db.loraReadings[storageKey] = { ...sample, deviceId,
    receivedAt: new Date(now - sample.ageMs).toISOString(),
    uploadedAt: new Date(now).toISOString() };
  return true;
}
module.exports = { validateSample, recordSample };
