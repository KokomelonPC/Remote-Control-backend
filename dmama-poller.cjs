// Transport-independent polling core. Not enabled until the authenticated
// DMAMA adapter and selected station/field mapping have been verified.
function createPoller({ collect, persist, intervalMs = 60000, timeoutMs = 20000, onStatus = () => {} }) {
  if (typeof collect !== 'function' || typeof persist !== 'function') throw new TypeError('collect and persist are required');
  if (!Number.isFinite(intervalMs) || intervalMs < 60000 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs >= intervalMs) throw new RangeError('Invalid polling interval');
  let stopped = true, timer, controller, inFlight = null;
  function report(state) { try { onStatus({ state }); } catch {} }
  async function tick() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      controller = new AbortController();
      const active = controller;
      const deadline = setTimeout(() => active.abort(), timeoutMs);
      try {
        const sample = await collect({ signal: active.signal });
        if (active.signal.aborted) { report('timeout'); return; }
        // No fabricated zeroes or refreshed source timestamps on failure.
        if (!sample || typeof sample.stationId !== 'string' || !sample.stationId.trim() || !Number.isFinite(Date.parse(sample.observedAt)) || !sample.readings || typeof sample.readings !== 'object' || Array.isArray(sample.readings)) throw Error('Invalid sample');
        const readings = Object.fromEntries(Object.entries(sample.readings).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
        if (!Object.keys(readings).length) throw Error('No numeric readings');
        await persist({ source: 'dmama', stationId: sample.stationId, observedAt: sample.observedAt, fetchedAt: new Date().toISOString(), readings });
        report('ok');
      } catch {
        // Never expose upstream errors, which can contain credentials or tokens.
        report(active.signal.aborted ? 'timeout' : 'error');
      } finally { clearTimeout(deadline); controller = null; }
    })();
    try { await inFlight; } finally { inFlight = null; }
  }
  async function loop() {
    const started = Date.now();
    await tick();
    if (!stopped) timer = setTimeout(loop, Math.max(0, intervalMs - (Date.now() - started)));
  }
  return {
    tick,
    start() { if (!stopped) return; stopped = false; void loop(); },
    async stop() { stopped = true; clearTimeout(timer); controller?.abort(); await inFlight; },
  };
}
module.exports = { createPoller };
