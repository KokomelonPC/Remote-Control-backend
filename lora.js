// Latest sample only: separate from sensor history and relay state.
function validateSample(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const integer = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
  if (!integer(body.session) || !integer(body.sequence) ||
      typeof body.value !== "number" || !Number.isFinite(body.value) || Math.abs(body.value) > 1000000 ||
      !Number.isInteger(body.rssi) || body.rssi < -200 || body.rssi > 20 ||
      typeof body.snr !== "number" || !Number.isFinite(body.snr) || Math.abs(body.snr) > 100 ||
      !integer(body.ageMs) || body.ageMs > 300000) return null;
  return { session: body.session, sequence: body.sequence, value: body.value,
    rssi: body.rssi, snr: body.snr, ageMs: body.ageMs,
    tankLevel: Number.isFinite(body.tankLevel) ? body.tankLevel : body.value,
    tankMax: Number.isFinite(body.tankMax) ? body.tankMax : 10000,
    pumpMask: Number.isInteger(body.pumpMask) && body.pumpMask >= 0 && body.pumpMask <= 15 ? body.pumpMask : null,
    pumpKnownMask: Object.prototype.hasOwnProperty.call(body, 'pumpKnownMask')
      ? (Number.isInteger(body.pumpKnownMask) && body.pumpKnownMask >= 0 && body.pumpKnownMask <= 15 ? body.pumpKnownMask : 0)
      : (Number.isInteger(body.pumpMask) && body.pumpMask >= 0 && body.pumpMask <= 15 ? 15 : 0) };
}

function recordSample(db, deviceId, sample, now = Date.now()) {
  db.loraReadings ||= {};
  const previous = db.loraReadings[deviceId];
  if (previous && previous.session === sample.session) {
    const delta = (sample.sequence - previous.sequence) >>> 0;
    if (delta === 0 || delta >= 0x80000000) return false;
  }
  db.loraReadings[deviceId] = { ...sample, deviceId,
    receivedAt: new Date(now - sample.ageMs).toISOString(),
    uploadedAt: new Date(now).toISOString() };
  return true;
}
module.exports = { validateSample, recordSample };
