// Test host for the sidebar: loads cmux's real SidebarRuntime.js and the
// sidebar source into one VM context and plays the Swift host's part of the
// bridge. Scene ops build an inspectable node tree; cmux(...) calls are
// recorded; UI events go back in through __dispatch, exactly as the app does.
import fs from "node:fs";
import vm from "node:vm";

const RUNTIME_PATH =
  process.env.CMUX_SIDEBAR_RUNTIME ??
  "/Applications/cmux.app/Contents/Resources/CmuxSwiftRenderUI_CmuxSwiftRenderUI.bundle/Contents/Resources/SidebarRuntime.js";
const SOURCE_PATH = new URL("../src/cmux-sidebar.js", import.meta.url);

// --- fixtures ----------------------------------------------------------------

// The activity colors the spec names: orange = working, green = finished.
const ORANGE = "#FF8A00";
const GREEN = "#30D158";

// Workspaces in tab order; `index` follows array position like the host's.
export function workspaces(...list) {
  return list.map((w, index) => ({
    selected: false,
    pinned: false,
    unread: 0,
    directory: "/tmp",
    ports: [],
    portCount: 0,
    tabs: [],
    tabCount: 0,
    ...w,
    index,
  }));
}

export function group(id, name, anchorId, extra = {}) {
  return { id, name, collapsed: false, pinned: false, anchorId, ...extra };
}

export const agent = (status, extra = {}) => ({
  id: "s-" + Math.random().toString(36).slice(2),
  kind: "claude",
  name: "Claude Code",
  status,
  lastActivityAt: 0,
  ...extra,
});

// --- host ----------------------------------------------------------------------

export function mountSidebar(state) {
  const nodes = new Map();
  const actions = [];
  let rootId = null;

  const apply = (op) => {
    switch (op.op) {
      case "create":
        nodes.set(op.id, { id: op.id, type: op.type, props: {}, children: [] });
        break;
      case "update":
        nodes.get(op.id).props[op.key] = op.value;
        break;
      case "children":
        nodes.get(op.id).children = op.children;
        break;
      case "append":
        nodes.get(op.id).children.push(op.child);
        break;
      case "remove":
        nodes.delete(op.id);
        break;
      case "root":
        rootId = op.id;
        break;
      default:
        throw new Error("unknown scene op " + op.op);
    }
  };

  const ctx = vm.createContext({
    __host_applyOps: (json) => JSON.parse(json).forEach(apply),
    __host_action: (json) => {
      const a = JSON.parse(json);
      if (a.kind === "cmux") actions.push({ method: a.method, params: a.params });
    },
    __host_log: () => {},
  });
  vm.runInContext(fs.readFileSync(RUNTIME_PATH, "utf8"), ctx, { filename: "SidebarRuntime.js" });

  const setData = ({ workspaces: ws = [], groups = [] }) => {
    const selected = ws.find((w) => w.selected);
    ctx.__setData("workspaces", JSON.stringify(ws));
    ctx.__setData("groups", JSON.stringify(groups));
    ctx.__setData("selectedId", JSON.stringify(selected ? selected.id : ""));
  };
  setData(state);
  vm.runInContext(fs.readFileSync(SOURCE_PATH, "utf8"), ctx, { filename: "cmux-sidebar.js" });

  const node = (id) => nodes.get(id);
  const dispatch = (id, event, payload) =>
    ctx.__dispatch(id, event, payload === undefined ? "" : JSON.stringify(payload));

  const findDeep = (id, pred, { skipMenus = true, skipHidden = false } = {}) => {
    const out = [];
    const walk = (nid) => {
      const n = node(nid);
      if (!n) return;
      if (skipMenus && n.type === "contextMenu") return;
      if (skipHidden && n.props.opacity === 0) return;
      if (pred(n)) out.push(n);
      for (const c of n.children) walk(c);
    };
    walk(id);
    return out;
  };

  const list = () => findDeep(rootId, (n) => n.type === "reorderable")[0];

  // Menu items, with ForEach ("group") wrappers flattened like the host does.
  const menuChildren = (n) =>
    n.children.map(node).filter(Boolean).flatMap((c) => (c.type === "group" ? menuChildren(c) : [c]));

  // Walks a context menu by item labels: menu(row, "Move Group Into", "Work").
  const menuItem = (rowNode, labels) => {
    const menu = findDeep(rowNode.id, (n) => n.type === "contextMenu", { skipMenus: false })[0];
    if (!menu) throw new Error("row has no context menu");
    let items = menuChildren(menu);
    let found = null;
    for (const label of labels) {
      found = items.find((n) => n.props.text === label);
      if (!found) {
        const have = items.map((n) => n.props.text).filter(Boolean);
        throw new Error(`menu item "${label}" not found; have ${JSON.stringify(have)}`);
      }
      items = menuChildren(found);
    }
    return found;
  };

  const makeRow = (n, key) => {
    const visibleTexts = findDeep(n.id, (x) => x.type === "text" && x.props.text, { skipHidden: true })
      .map((x) => x.props.text);
    const field = findDeep(n.id, (x) => x.type === "textfield")[0];
    return {
      key,
      header: n.props.fixed === true,
      texts: visibleTexts,
      text: visibleTexts.join(" "),
      indent: n.props.marginLeading ?? 0,
      editing: field ? field.props.text : null,
      // The activity dot: orange = working, green = finished and not yet
      // opened; null when the row shows neither.
      indicator() {
        const shown = findDeep(n.id, (x) => x.type === "circle", { skipHidden: true });
        if (shown.some((x) => x.props.fill === ORANGE)) return "working";
        if (shown.some((x) => x.props.fill === GREEN)) return "finished";
        return null;
      },
      // Header "● N" counts by color: { working, finished }.
      counts() {
        const out = { working: 0, finished: 0 };
        for (const t of findDeep(n.id, (x) => x.type === "text" && x.props.text, { skipHidden: true })) {
          const num = Number(String(t.props.text).replace(/\D/g, ""));
          if (t.props.color === ORANGE) out.working = num;
          if (t.props.color === GREEN) out.finished = num;
        }
        return out;
      },
      // The leading border bar: a visible rectangle with a fill.
      barColor() {
        const bar = findDeep(n.id, (x) => x.type === "rectangle" && x.props.fill, { skipHidden: true })[0];
        return bar ? bar.props.fill : null;
      },
      tap(payload = {}) {
        dispatch(n.id, "tap", payload);
      },
      doubleTap() {
        dispatch(n.id, "doubletap", {});
      },
      tapImage(systemName) {
        const img = findDeep(n.id, (x) => x.type === "image" && x.props.systemName === systemName)[0];
        if (!img) throw new Error("no image " + systemName);
        dispatch(img.id, "tap", {});
      },
      menu(...labels) {
        dispatch(menuItem(n, labels).id, "tap", {});
      },
      menuLabels(...labels) {
        const m = labels.length
          ? menuItem(n, labels)
          : findDeep(n.id, (x) => x.type === "contextMenu", { skipMenus: false })[0];
        return menuChildren(m).map((x) => x.props.text).filter(Boolean);
      },
      submit(text) {
        if (!field) throw new Error("row is not editing");
        dispatch(field.id, "submit", { text });
      },
    };
  };

  const rows = () => {
    const l = list();
    const keys = JSON.parse(l.props.itemKeys ?? "[]");
    return l.children.map((id, i) => makeRow(node(id), keys[i]));
  };

  const row = (text) => {
    const all = rows();
    const r = all.find((x) => x.texts.includes(text) || x.editing === text);
    if (!r) throw new Error(`no row "${text}"; rows: ${JSON.stringify(all.map((x) => x.text))}`);
    return r;
  };

  return {
    setData,
    rows,
    row,
    // Visible rows as "label" strings, indented two spaces per 14pt level.
    outline: () => rows().map((r) => " ".repeat((r.indent / 14) * 2) + (r.editing !== null ? `[${r.editing}]` : r.text)),
    actions,
    take() {
      return actions.splice(0, actions.length);
    },
    // A Reorderable drop exactly as the host reports it.
    drop(key, index, extra = {}) {
      dispatch(list().id, "move", { id: key, index, side: "above", block: false, ...extra });
    },
  };
}
