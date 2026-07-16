type Labels = Record<string, string | number>;

const counters = new Map<string, number>();
const histograms = new Map<string, number>();
const gauges = new Map<string, number>();

function buildKey(name: string, labels: Labels = {}): string {
  return `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`;
}

export function inc(name: string, labels: Labels = {}): void {
  const key = buildKey(name, labels);
  counters.set(key, (counters.get(key) || 0) + 1);
}

export function observe(name: string, value: number, labels: Labels = {}): void {
  const key = buildKey(name, labels);
  const bucket = Math.pow(10, Math.floor(Math.log10(Math.max(value, 1))));
  const bucketKey = `${key},le="${bucket}"`;
  histograms.set(bucketKey, (histograms.get(bucketKey) || 0) + 1);
}

export function gauge(name: string, value: number, labels: Labels = {}): void {
  const key = buildKey(name, labels);
  gauges.set(key, value);
}

export function metrics(): string {
  const lines: string[] = [];
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
