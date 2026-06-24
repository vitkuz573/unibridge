const counters = new Map();
const histograms = new Map();
const gauges = new Map();

export function inc(name, labels = {}) {
  const key = `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`;
  counters.set(key, (counters.get(key) || 0) + 1);
}

export function observe(name, value, labels = {}) {
  const key = `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`;
  const bucket = Math.pow(10, Math.floor(Math.log10(Math.max(value, 1))));
  const bucketKey = `${key},le="${bucket}"`;
  histograms.set(bucketKey, (histograms.get(bucketKey) || 0) + 1);
}

export function gauge(name, value, labels = {}) {
  const key = `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`;
  gauges.set(key, value);
}

export function metrics() {
  const lines = [];
  for (const [key, value] of counters) {
    const name = key.split('{')[0];
    lines.push(`# HELP ${name} Total count`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${key} ${value}`);
  }
  for (const [key, value] of histograms) {
    const name = key.split('{')[0];
    lines.push(`# HELP ${name} Request duration histogram`);
    lines.push(`# TYPE ${name} histogram`);
    lines.push(`${key} ${value}`);
  }
  for (const [key, value] of gauges) {
    const name = key.split('{')[0];
    lines.push(`# HELP ${name} Current value`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${key} ${value}`);
  }
  return lines.join('\n') + '\n';
}
