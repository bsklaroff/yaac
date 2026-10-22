// Barrel for `#runtime/usage`: the server health overlay's hour of history
// (docs/server-health.md). The composition root starts and stops the
// sampler with the driver; the domain's usage report reads the series.

export { startUsageSampler, stopUsageSampler, usageHistory } from './history'
