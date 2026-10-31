// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: pink; icon-glyph: cogs;

const TOKEN_KEY = "clickup_api_token";
const API = "https://api.clickup.com/api/v2/";
const STATUS_ORDER = ["in progress", "open", "in review", "need review", "need to be test"];
const PRIORITY_ORDER = ["urgent", "high", "normal", "low"];
const ROWS_ALL = { small: 0, medium: 4, large: 11, extraLarge: 11 };
const ROWS_STATUS = { small: 4, medium: 5, large: 13, extraLarge: 13 };
const REFRESH_MINUTES = 15;
const CACHE_MINUTES = 5;

const WHITE = new Color("#ffffff");
const DIM = new Color("#ffffff", 0.4);
const RED = new Color("#ff6b6b");
const FONT = new Font("Menlo", 11);
const FONT_BOLD = new Font("Menlo-Bold", 12);

const fm = FileManager.local();
const cachePath = fm.joinPath(fm.libraryDirectory(), "clickup-tasks.json");

function formatDate(date, format) {
  const df = new DateFormatter();
  df.dateFormat = format;
  return df.string(date);
}

async function getToken() {
  if (Keychain.contains(TOKEN_KEY)) return Keychain.get(TOKEN_KEY);
  if (config.runsInWidget) throw new Error("Open Scriptable, run this script once to input the token");
  const alert = new Alert();
  alert.title = "ClickUp API token";
  alert.message = "Paste token pk_...";
  alert.addSecureTextField("pk_...");
  alert.addAction("Save");
  alert.addCancelAction("Cancel");
  if ((await alert.presentAlert()) === -1) throw new Error("Token is empty");
  const token = alert.textFieldValue(0).trim();
  if (!token) throw new Error("Token is empty");
  Keychain.set(TOKEN_KEY, token);
  return token;
}

async function api(path, token) {
  const req = new Request(API + path);
  req.headers = { Authorization: token };
  const json = await req.loadJSON();
  const code = req.response.statusCode;
  if (code === 401 && !config.runsInWidget) Keychain.remove(TOKEN_KEY); // run agin = re-input token
  if (code !== 200) throw new Error(`ClickUp HTTP ${code}`);
  return json;
}

async function fetchTasks(token) {
  const { user } = await api("user", token);
  const { teams } = await api("team", token);
  const team = teams[0].id;
  const tasks = [];
  for (let page = 0; ; page++) {
    const r = await api(
      `team/${team}/task?archived=false&include_closed=false&subtasks=true` +
        `&assignees%5B%5D=${user.id}&page=${page}`,
      token
    );
    tasks.push(...r.tasks);
    if (r.last_page || r.tasks.length === 0) break;
  }
  return tasks;
}

// API task -> row widget: delete finished, sort by status > priority > due date.
function prepare(tasks) {
  const rank = (list, value) => {
    const i = list.indexOf(value);
    return i === -1 ? list.length : i;
  };
  return tasks
    .filter((t) => !["closed", "done"].includes(t.status.type))
    .map((t) => ({
      name: t.name,
      url: t.url,
      status: t.status.status.toLowerCase(),
      color: t.status.color || "#888888",
      priority: t.priority ? t.priority.priority : null,
      due: t.due_date ? Number(t.due_date) : null,
    }))
    .sort(
      (a, b) =>
        rank(STATUS_ORDER, a.status) - rank(STATUS_ORDER, b.status) ||
        rank(PRIORITY_ORDER, a.priority) - rank(PRIORITY_ORDER, b.priority) ||
        (a.due ?? Infinity) - (b.due ?? Infinity)
    );
}

// Task + footer . Fetch fail = use last data, if any.
async function load(forceFresh) {
  const cached = fm.fileExists(cachePath);
  const readCache = (label) => ({
    tasks: JSON.parse(fm.readString(cachePath)),
    note: `${label} ${formatDate(fm.modificationDate(cachePath), "HH:mm")}`,
  });
  const age = cached ? Date.now() - fm.modificationDate(cachePath).getTime() : Infinity;
  if (!forceFresh && age < CACHE_MINUTES * 60000) return readCache("update");
  try {
    const tasks = prepare(await fetchTasks(await getToken()));
    fm.writeString(cachePath, JSON.stringify(tasks));
    return { tasks, note: `update ${formatDate(new Date(), "HH:mm")}` };
  } catch (e) {
    if (!cached) throw e;
    return readCache("failed to fetch, data");
  }
}

function addText(stack, value, font, color) {
  const t = stack.addText(String(value));
  t.font = font;
  t.textColor = color;
  t.lineLimit = 1;
  return t;
}

function groupByStatus(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    const g = groups.get(t.status) || { status: t.status, color: t.color, count: 0 };
    g.count++;
    groups.set(t.status, g);
  }
  return [...groups.values()]; // sort by STATUS_ORDER
}

function addHeader(widget, title, count, color) {
  const row = widget.addStack();
  row.centerAlignContent();
  if (color) addText(row, "● ", FONT_BOLD, new Color(color));
  addText(row, title, FONT_BOLD, WHITE);
  row.addSpacer();
  addText(row, ` ${count}`, FONT_BOLD, WHITE);
}

function addStatusCounts(widget, tasks) {
  const row = widget.addStack();
  row.spacing = 8;
  for (const g of groupByStatus(tasks)) {
    addText(row, `● ${g.count}`, FONT, new Color(g.color));
  }
}

function addStatusList(widget, tasks) {
  for (const g of groupByStatus(tasks)) {
    const row = widget.addStack();
    addText(row, "● ", FONT, new Color(g.color));
    addText(row, g.status, FONT, WHITE);
    row.addSpacer();
    addText(row, g.count, FONT, WHITE);
  }
}

function addTaskRow(widget, task, showDue) {
  const row = widget.addStack();
  row.url = task.url;
  addText(row, task.name, FONT, WHITE);
  row.addSpacer();
  if (showDue && task.due) {
    addText(row, ` ${formatDate(new Date(task.due), "dd/MM")}`, FONT, task.due < Date.now() ? RED : DIM);
  }
}

// status null = all status
function render(tasks, status, family, note, scriptName) {
  const widget = new ListWidget();
  const gradient = new LinearGradient();
  gradient.colors = [new Color("#000000", 0.4), new Color("#000000", 0.6)];
  gradient.locations = [0, 1];
  widget.backgroundGradient = gradient;
  widget.setPadding(14, 14, 12, 14);
  widget.spacing = 5;
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60000);
  widget.url = `scriptable:///run?scriptName=${encodeURIComponent(scriptName)}`;

  const limit = (status ? ROWS_STATUS : ROWS_ALL)[family];
  if (status) {
    addHeader(widget, status.toUpperCase(), tasks.length, tasks[0] && tasks[0].color);
  } else {
    addHeader(widget, "ClickUp", tasks.length);
    if (family === "small") addStatusList(widget, tasks);
    else addStatusCounts(widget, tasks);
  }
  widget.addSpacer(2);
  for (const t of tasks.slice(0, limit)) addTaskRow(widget, t, family !== "small");
  if (status && tasks.length === 0) addText(widget, "Empty", FONT, DIM);
  widget.addSpacer();
  const more = tasks.length - limit;
  addText(widget, (limit && more > 0 ? `+${more} left · ` : "") + note, new Font("Menlo", 9), DIM);
  return widget;
}

function errorWidget(message) {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#000000", 0.6);
  addText(widget, "ClickUp", FONT_BOLD, WHITE);
  widget.addSpacer(4);
  const t = addText(widget, message, FONT, RED);
  t.lineLimit = 0;
  return widget;
}

// list of all tasks
async function showList(tasks, title, note) {
  const table = new UITable();
  table.showSeparators = true;
  const head = new UITableRow();
  head.isHeader = true;
  head.addText(`${title} (${tasks.length})`, note);
  table.addRow(head);
  for (const t of tasks) {
    const row = new UITableRow();
    row.height = 64;
    row.dismissOnSelect = false;
    row.onSelect = () => Safari.open(t.url);
    const dot = row.addText("●");
    dot.titleColor = new Color(t.color);
    dot.widthWeight = 1;
    const due = t.due ? ` · ${formatDate(new Date(t.due), "dd/MM")}` : "";
    const cell = row.addText(t.name, `${t.status}${due}`);
    cell.widthWeight = 11;
    cell.titleFont = Font.systemFont(14);
    cell.subtitleFont = Font.systemFont(12);
    if (t.due && t.due < Date.now()) cell.subtitleColor = RED;
    table.addRow(row);
  }
  await table.present();
}

// called by widget or scriptable run. If widget, show widget. If scriptable, show list.
async function run(status, scriptName) {
  const inWidget = config.runsInWidget;
  try {
    const { tasks, note } = await load(!inWidget);
    const shown = status ? tasks.filter((t) => t.status === status) : tasks;
    if (inWidget) {
      Script.setWidget(render(shown, status, config.widgetFamily || "large", note, scriptName));
    } else {
      await showList(shown, status ? status.toUpperCase() : "All task", note);
    }
  } catch (e) {
    const widget = errorWidget(e.message);
    if (inWidget) Script.setWidget(widget);
    else await widget.presentMedium();
  }
  Script.complete();
}

module.exports = { run };
