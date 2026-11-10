// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-green; icon-glyph: server;

// Needs Grafana + Prometheus datasource scraping node_exporter.
// Edit the queries if your mountpoint / labels differ.
const QUERIES = {
  CPU: '100 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100',
  RAM: "(1 - avg(node_memory_MemAvailable_bytes) / avg(node_memory_MemTotal_bytes)) * 100",
  DISK: '(1 - sum(node_filesystem_avail_bytes{mountpoint="/"}) / sum(node_filesystem_size_bytes{mountpoint="/"})) * 100',
  DATA: '(1 - sum(node_filesystem_avail_bytes{mountpoint="/data"}) / sum(node_filesystem_size_bytes{mountpoint="/data"})) * 100',
  BATT: "avg(node_power_supply_capacity)",
};
const KEY = "grafana_server_stats"; // keychain: {url, token, uid}
const REFRESH_MINUTES = 5;

const WHITE = new Color("#ffffff");
const DIM = new Color("#ffffff", 0.4);
const GREEN = new Color("#51cf66");
const YELLOW = new Color("#fcc419");
const RED = new Color("#ff6b6b");
const FONT = new Font("Menlo", 11);
const FONT_BOLD = new Font("Menlo-Bold", 12);

async function getConfig() {
  if (Keychain.contains(KEY)) return JSON.parse(Keychain.get(KEY));
  if (config.runsInWidget) throw new Error("Open Scriptable, run this script once to set up Grafana");
  const alert = new Alert();
  alert.title = "Grafana";
  alert.message = "URL, service account token (Viewer), Prometheus datasource UID";
  alert.addTextField("http://100.x.x.x:3000");
  alert.addSecureTextField("glsa_...");
  alert.addTextField("datasource uid");
  alert.addAction("Save");
  alert.addCancelAction("Cancel");
  if ((await alert.presentAlert()) === -1) throw new Error("Setup cancelled");
  const [url, token, uid] = [0, 1, 2].map((i) => alert.textFieldValue(i).trim());
  if (!url || !token || !uid) throw new Error("All fields are required");
  const cfg = { url: url.replace(/\/+$/, ""), token, uid };
  Keychain.set(KEY, JSON.stringify(cfg));
  return cfg;
}

// One request, all queries. Returns { CPU: 12.3, ..., BATT: null if no data }.
async function fetchStats(cfg) {
  const req = new Request(`${cfg.url}/api/ds/query`);
  req.method = "POST";
  req.timeoutInterval = 10;
  req.headers = { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" };
  req.body = JSON.stringify({
    from: "now-5m",
    to: "now",
    queries: Object.entries(QUERIES).map(([refId, expr]) => ({
      refId,
      expr,
      datasource: { uid: cfg.uid },
      instant: true,
      range: false,
    })),
  });
  const json = await req.loadJSON();
  const code = req.response.statusCode;
  if (code === 401 && !config.runsInWidget) Keychain.remove(KEY); // run again = re-input
  if (code !== 200) throw new Error(`Grafana HTTP ${code}`);
  const stats = {};
  for (const refId of Object.keys(QUERIES)) {
    const values = json.results?.[refId]?.frames?.[0]?.data?.values?.[1];
    const v = values?.length ? Number(values[values.length - 1]) : NaN;
    stats[refId] = Number.isFinite(v) ? v : null;
  }
  return stats;
}

function addText(stack, value, font, color) {
  const t = stack.addText(String(value));
  t.font = font;
  t.textColor = color;
  t.lineLimit = 1;
  return t;
}

function levelColor(label, v) {
  const high = label === "BATT" ? v < 20 : v > 85;
  const mid = label === "BATT" ? v < 50 : v > 60;
  return high ? RED : mid ? YELLOW : GREEN;
}

function addStatRow(widget, label, v, barWidth) {
  const row = widget.addStack();
  addText(row, label.padEnd(5), FONT, DIM);
  if (v === null) {
    addText(row, "—", FONT, DIM);
    return;
  }
  const color = levelColor(label, v);
  if (barWidth) {
    const filled = Math.round((v / 100) * barWidth);
    addText(row, "█".repeat(filled), FONT, color);
    addText(row, "░".repeat(barWidth - filled), FONT, DIM);
  }
  row.addSpacer();
  addText(row, `${Math.round(v)}%`, FONT, color);
}

function render(stats, family) {
  const widget = new ListWidget();
  const gradient = new LinearGradient();
  gradient.colors = [new Color("#000000", 0.4), new Color("#000000", 0.6)];
  gradient.locations = [0, 1];
  widget.backgroundGradient = gradient;
  widget.setPadding(14, 14, 12, 14);
  widget.spacing = 6;
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60000);

  addText(widget, "Server", FONT_BOLD, WHITE);
  widget.addSpacer(2);
  const barWidth = family === "small" ? 0 : 16;
  for (const label of Object.keys(QUERIES)) addStatRow(widget, label, stats[label], barWidth);
  widget.addSpacer();
  const df = new DateFormatter();
  df.dateFormat = "HH:mm";
  addText(widget, `update ${df.string(new Date())}`, new Font("Menlo", 9), DIM);
  return widget;
}

function errorWidget(message) {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#000000", 0.6);
  addText(widget, "Server", FONT_BOLD, WHITE);
  widget.addSpacer(4);
  addText(widget, message, FONT, RED).lineLimit = 0;
  return widget;
}

let widget;
try {
  widget = render(await fetchStats(await getConfig()), config.widgetFamily || "medium");
} catch (e) {
  widget = errorWidget(e.message);
}
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
