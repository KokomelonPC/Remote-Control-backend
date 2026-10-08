// Latest telemetry and a bounded 10-packet meter window, separate from relay state.
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

function selectMeterGroup(points, key, tolerance = 0.05) {
    const valid = points.filter(p => typeof p[key] === 'number' && Number.isFinite(p[key]) && p[key] >= 0 && p[key] <= 1000000).sort((a,b) => a[key]-b[key]);
    let best = null, bestSpread = Infinity;
    for (let start=0; start<valid.length; start++) {
      for (let end=start+2; end<=valid.length; end++) {
        const group=valid.slice(start,end), middle=Math.floor(group.length/2);
        const median=group.length%2 ? group[middle][key] : (group[middle-1][key]+group[middle][key])/2;
        if (!group.every(p=>Math.abs(p[key]-median)<=Math.abs(median)*tolerance+1e-9)) continue;
        const spread=(group[group.length-1][key]-group[0][key])/(Math.abs(median)||1);
        if (!best || group.length>best.length || (group.length===best.length && spread<bestSpread)) { best=group; bestSpread=spread; }
      }
    }
    return best;
  }

// Stored with the latest sample in lora.json, including across process restarts.
function filterMeters(previous, sample) {
  const prior = previous?.meterFilter;
  const window = [...(prior?.window || []), {
    tankLevel: sample.tankKnown === false ? null : sample.tankLevel,
    banLaemFlow: sample.banLaemFlow,
    receivedAt: sample.receivedAt
  }].slice(-10);
  const meters = {};
  for (const key of ['tankLevel', 'banLaemFlow']) {
    const best = selectMeterGroup(window, key);
    const latest = [...window].reverse().find(p => typeof p[key] === 'number' && Number.isFinite(p[key]) && p[key] >= 0 && p[key] <= 1000000);
    const old = prior?.meters?.[key];
    meters[key] = best ? {
      value: best.reduce((sum,p)=>sum+p[key],0)/best.length,
      acceptedAt: Math.max(...best.map(p=>Date.parse(p.receivedAt))),
      matched: true, averaged: true, groupCount: best.length
    } : old?.averaged ? { ...old, matched: false } : {
      value: latest?.[key] ?? old?.value ?? null,
      acceptedAt: latest ? Date.parse(latest.receivedAt) : old?.acceptedAt ?? null,
      matched: false, averaged: false
    };
  }
  return { version: 2, count: window.length, tolerance: 0.05, window, meters };
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
  if (sample.sourceId !== 2) {
    const stored = db.loraReadings[storageKey];
    stored.meterFilter = filterMeters(previous, stored);
  }
  return true;
}
module.exports = { validateSample, recordSample };
