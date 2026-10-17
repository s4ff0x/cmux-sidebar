// cmux-sidebar: nested workspace groups, working/finished agent dots, a
// recently-finished clock, title colors and important (red) workspaces,
// collapse that keeps active work visible, and Active/Favorites filters.
//
// Forked from manaflow-ai/cmux Examples/CustomSidebars/workspaces.js. The
// whole sidebar is ONE flat drag surface: group headers and workspace rows
// live in a single Reorderable, and every row drags on its own. A workspace
// can be dragged between groups, into a group, or out to the ungrouped area
// in one gesture; a header drag re-parents and reorders its whole subtree.
// The drop resolves to (container, reorder anchor) from the flat index and
// the boundary side, and dispatches the group edits plus the reorder.
//
// Group collapse is optimistic (a local signal flips instantly) and syncs via
// workspace.group.collapse/expand so the built-in sidebar agrees.
//
// Install: https://github.com/s4ff0x/cmux-sidebar#install
// SPDX-License-Identifier: GPL-3.0-or-later (derived from cmux's
// Examples/CustomSidebars/workspaces.js, Copyright Manaflow, Inc.)

// --- change-only data ------------------------------------------------------------
// The runtime never dedupes: a binding re-runs and re-sends its prop whenever
// anything it read notifies, and every data key arrives as a freshly parsed
// object, so a naive sidebar re-sends the whole tree each tick. Everything
// below reads host data through these memos, which notify only on a real
// change, and every reactive prop goes through memo() so it emits an op only
// when its value differs.

// A signal fed by `fn` that notifies only when the value changes (`Object.is`).
function memo(fn) {
  const [read, write] = signal(undefined);
  computed(() => {
    write(fn());
  });
  return read;
}

// Same, compared by JSON content: for arrays and objects rebuilt per run.
function memoJSON(fn) {
  const [read, write] = signal(undefined);
  let last = null;
  computed(() => {
    const value = fn();
    const json = JSON.stringify(value) ?? "";
    if (json === last) return;
    last = json;
    write(value);
  });
  return read;
}

const wsList = memoJSON(() => data.workspaces() ?? []);
// Optimistic group names: a path edit (rename, re-parent) reshapes the tree
// the same frame; each override clears once the data agrees.
const nameOverride = new Map();
const [nameTick, setNameTick] = signal(0);
const groupsList = memoJSON(() => {
  nameTick();
  return (data.groups() ?? []).map((g) => {
    if (!nameOverride.has(g.id)) return g;
    const name = nameOverride.get(g.id);
    if (name === g.name) {
      nameOverride.delete(g.id); // caught up
      return g;
    }
    return { ...g, name };
  });
});
const selectedId = memo(() => data.selectedId() ?? "");
const groupsById = computed(() => new Map(groupsList().map((g) => [g.id, g])));
const groupById = (id) => groupsById().get(id);

// One signal per workspace, written only when THAT workspace's data changes,
// so a row re-runs for its own changes and never scans the list. Entries are
// kept for ids that went away (reading undefined), so a reader captured
// before a workspace appears or after it closes never goes stale.
const wsSignals = new Map(); // id -> { read, write, json }

function wsEntryFor(id) {
  let s = wsSignals.get(id);
  if (!s) {
    const [read, write] = signal(undefined);
    s = { read, write, json: undefined };
    wsSignals.set(id, s);
  }
  return s;
}

const wsSig = (id) => wsEntryFor(id).read;

computed(() => {
  const seen = new Set();
  for (const w of wsList()) {
    seen.add(w.id);
    const s = wsEntryFor(w.id);
    const json = JSON.stringify(w);
    if (s.json !== json) {
      s.json = json;
      s.write(w);
    }
  }
  for (const [id, s] of wsSignals) {
    if (seen.has(id) || s.json === undefined) continue;
    s.json = undefined;
    s.write(undefined);
  }
});

// --- agent activity ------------------------------------------------------------
// Orange = an agent is really working: a coding agent mid-turn, or one of its
// subagents still running. Waiting on the user (needs_input), idle, and ended
// are all "not working".
const WORKING_ORANGE = "#FF8A00";
// Green = finished and not yet looked at: the workspace was working, its turn
// ended while another workspace was open, and it has not been opened since.
const FINISHED_GREEN = "#30D158";
// Favorites are cmux's native pin, marked with a red bookmark.
const FAVORITE_RED = "#FF453A";
// The title is drawn in the native cmux workspace color (Title Color in the
// row menu), so it persists and the built-in sidebar shows it as a border.
// Important is that color set to red: the row keeps its place, unlike a
// favorite's pin. Either red counts: this sidebar's, and cmux's named Red.
const IMPORTANT_RED = "#FF453A";
const IMPORTANT_COLORS = new Set([IMPORTANT_RED, "#C0392B"]);

// Optimistic color: a pick shows the same frame; clears once the data agrees.
const colorOverride = new Map(); // id -> "#RRGGBB", or "" for none
const [colorTick, setColorTick] = signal(0);

function colorOf(w) {
  colorTick();
  if (!w) return "";
  const color = String(w.color ?? "").toUpperCase();
  if (colorOverride.has(w.id)) {
    if (colorOverride.get(w.id) === color) colorOverride.delete(w.id); // caught up
    else return colorOverride.get(w.id);
  }
  return color;
}

const isImportant = (w) => IMPORTANT_COLORS.has(colorOf(w));
// null: the default title color.
const titleColor = (w) => (isImportant(w) ? IMPORTANT_RED : colorOf(w) || null);

// A finished turn keeps its clock this long, and opening the workspace
// restarts the hour. Nothing else clears it: a new turn or marking it
// important never do.
const RECENT_SECONDS = 60 * 60;

const isWorking = (w) =>
  !!w && (w.agents || []).some((a) => a.status === "working" || (a.children || []).some((c) => c.running));

// A 14pt dot slot. `state` is a change-only signal; the dot hides while it
// is null. One node: every rendered node costs the host work on every scroll
// frame (see README, Performance), so the color is a prop rather than a
// second circle. `gap` adds trailing space inside the frame (padding sits
// inside a node's frame), leaving the circle where it was.
function activityDot(state, gap = 0) {
  const dot = Circle({ size: 8 })
    .fill(memo(() => (state() === "finished" ? FINISHED_GREEN : WORKING_ORANGE)))
    .opacity(memo(() => (state() ? 1 : 0)));
  if (gap) dot.paddingTrailing(gap);
  return dot.frame({ width: 14 + gap, height: 14 });
}

// The recently-finished clock. `CLOCK_SLOT` is its width plus the gap after
// it; the gap clears a favorite's bookmark, which overhangs its own frame.
// An outline glyph, so it never reads as the solid green dot.
const CLOCK_SLOT = 18;
const recentClock = () => Image("clock").font(10).weight("semibold").color(FINISHED_GREEN);

// --- optimistic UI -------------------------------------------------------------
// Every user action flips local state the same frame; the cmux command runs
// behind it and the authoritative data context (which refreshes about once a
// second) reconciles: each override clears itself as soon as the data agrees.
let selectOverride = null;
const [selectTick, setSelectTick] = signal(0);

function isSelected(w) {
  selectTick();
  if (!w) return false;
  if (selectOverride) {
    if (selectedId() === selectOverride) selectOverride = null; // caught up
    else return w.id === selectOverride;
  }
  return !!w.selected;
}

// Opens a workspace; the row shows selected the same frame.
function focusWorkspace(id) {
  selectOverride = id;
  setSelectTick(selectTick() + 1);
  cmux("workspace.select", { workspace_id: id });
}

function selectWorkspace(id) {
  if (!id) return;
  restartClock(id); // also when the row was already open
  focusWorkspace(id);
  // cmux expands the selected workspace's collapsed group (anchors excepted).
  // A row listed under a collapsed header is opened in place, so collapse the
  // group straight back; the override keeps the expand echo from flashing.
  const w = wsSig(id)();
  const g = w && groupById(w.group);
  if (g && g.anchorId !== id && isCollapsed(g)) {
    collapseOverride.set(g.id, true);
    collapseHold.set(g.id, id);
    setCollapseTick(collapseTick() + 1);
    cmux("workspace.group.collapse", { group_id: g.id });
  }
}

// Finished tracking. cmux exposes no "last opened" or "turn ended" time, so
// the sidebar watches each workspace go from working to not working itself,
// in memory. That memory is lost whenever the sidebar mounts (cmux launch, a
// reload, a source edit, a sidebar switch): the green dot starts empty then,
// and the clock falls back to what the data can tell (see answeredAt).
const finished = new Set(); // finished, not opened since: the green dot
const finishedAt = new Map(); // id -> wall time of its last observed finish
const recent = new Set(); // finished under RECENT_SECONDS ago: the clock
let wasWorking = new Set();
let openId; // the open workspace at the tracker's last pass

// Wall time in epoch seconds. Stamps and expiry use it, never the host's
// clock key, which is only as fresh as the last data push.
const wallNow = () => Date.now() / 1000;

// A recent finish as the data records it, so a clock survives a mount: a
// prompt submitted under an hour ago that a stopped agent (idle, or asking
// for input) was active after. Ended agents don't count, and neither does an
// older prompt: a session that starts or quits bumps its activity without
// answering anything. Null when the data can't tell. The tracker adopts it
// as a stamp, because the next prompt hides it from the data again.
function answeredAt(w, now) {
  if (!w.latestAt || now - w.latestAt >= RECENT_SECONDS) return null;
  let at = null;
  for (const a of w.agents || []) {
    if (a.status !== "idle" && a.status !== "needs_input") continue;
    if (a.lastActivityAt > w.latestAt && (at === null || a.lastActivityAt > at)) at = a.lastActivityAt;
  }
  return at;
}

// The host's clock key changes about once a second; this notifies once a
// minute, so a clock outlives its hour by under a minute and the ticks in
// between cost nothing.
const minute = memo(() => Math.floor((data.clock()?.epoch ?? 0) / 60));
const [finishedVersion, setFinishedVersion] = signal("");
const [recentVersion, setRecentVersion] = signal("");
computed(() => {
  const ws = wsList();
  minute();
  const now = wallNow();
  const working = new Set();
  const present = new Set();
  let nowOpen = null;
  recent.clear();
  for (const w of ws) {
    present.add(w.id);
    if (isWorking(w)) {
      working.add(w.id);
      finished.delete(w.id);
    } else if (wasWorking.has(w.id)) {
      finishedAt.set(w.id, now);
      if (!isSelected(w)) finished.add(w.id);
    }
    // The later of the observed and the recorded finish wins.
    const told = answeredAt(w, now);
    let at = finishedAt.get(w.id) ?? null;
    if (told !== null && (at === null || told > at)) finishedAt.set(w.id, (at = told));
    if (isSelected(w)) {
      finished.delete(w.id); // opened: seen
      nowOpen = w.id;
      // Opened since the last pass (outside the sidebar too): a new hour.
      // The first pass after a mount opens nothing.
      if (openId !== undefined && openId !== w.id && at !== null && now - at < RECENT_SECONDS) finishedAt.set(w.id, (at = now));
    }
    if (at !== null && now - at < RECENT_SECONDS) recent.add(w.id);
  }
  openId = nowOpen;
  for (const id of finished) if (!present.has(id)) finished.delete(id);
  // Only time drops a stamp: a workspace missing from one data push keeps it.
  for (const [id, at] of finishedAt) if (now - at >= RECENT_SECONDS) finishedAt.delete(id);
  wasWorking = working;
  setFinishedVersion(Array.from(finished).sort().join(","));
  setRecentVersion(Array.from(recent).sort().join(","));
});

// Restarts a shown clock's hour.
function restartClock(id) {
  if (recent.has(id)) finishedAt.set(id, wallNow());
}

// "working" | "finished" | null
function activity(w) {
  if (!w) return null;
  if (isWorking(w)) return "working";
  return finishedVersion() && finished.has(w.id) ? "finished" : null;
}
const isActive = (w) => activity(w) !== null;
// Finished under an hour ago (or opened since); unlike the green dot,
// opening keeps it.
const isRecent = (w) => !!w && !!recentVersion() && recent.has(w.id);

// Closed rows hide at once. cmux refuses a plain workspace.close for a pinned
// (favorite) workspace or one with a live process, so the sidebar unpins and
// forces: closing from here never asks. A row cmux still lists CLOSE_GRACE
// seconds after its close shows again, rather than staying hidden until the
// sidebar remounts and then "coming back".
const CLOSE_GRACE = 5;
const closedOverride = new Map(); // id -> clock epoch of the close
const [closeTick, setCloseTick] = signal(0);

// Optimistic tabs order: a bulk drop rearranges rows locally the same frame
// (reorder_many echoes ~1s later); clears itself once the data agrees.
let orderOverride = null;
const [orderTick, setOrderTick] = signal(0);

function setOrderOverride(ids) {
  orderOverride = ids;
  setOrderTick(orderTick() + 1);
}

function visibleWorkspaces() {
  closeTick();
  orderTick();
  // A bulk close freezes the list it started from (see closeMany).
  let ws = bulkClose()?.ws ?? wsList();
  const present = new Set(ws.map((w) => w.id));
  if (closedOverride.size) {
    // Subscribes to the clock only while a close is pending, so the grace
    // ends without waiting for other data to change.
    data.clock();
    const t = wallNow();
    for (const [id, at] of closedOverride) {
      if (!present.has(id) || t - at >= CLOSE_GRACE) closedOverride.delete(id); // caught up, or refused
    }
    ws = ws.filter((w) => !closedOverride.has(w.id));
  }
  if (orderOverride) {
    const actual = ws.map((w) => w.id).join(",");
    const wanted = orderOverride.filter((id) => present.has(id) && !closedOverride.has(id)).join(",");
    if (actual === wanted) {
      orderOverride = null; // caught up
    } else {
      const rank = new Map(orderOverride.map((id, i) => [id, i]));
      ws = [...ws].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
    }
  }
  return ws;
}

function closeWorkspace(id) {
  if (bulkClose()) return;
  closedOverride.set(id, wallNow());
  setCloseTick(closeTick() + 1);
  sendClose(id);
}

function sendClose(id) {
  if (wsSig(id)()?.pinned) cmux("workspace.action", { action: "unpin", workspace_id: id });
  cmux("workspace.close", { workspace_id: id, force: true });
}

// Bulk close is one loading state, not rows closing one by one: the closing
// rows hide at once, and the tree's inputs (workspace and group lists)
// freeze as they will be after, so nothing moves while cmux works through
// the closes and moves its selection. The top bar shows a spinner, and
// the list dims and ignores clicks and drags. It ends when every workspace
// is gone from the data, or after BULK_CLOSE_TIMEOUT seconds; any cmux kept
// then shows again.
const BULK_CLOSE_TIMEOUT = 30;
const [bulkClose, setBulkClose] = signal(null); // { ids, until, ws, groups }

function closeMany(ids) {
  if (bulkClose()) return;
  if (ids.length < 2) {
    for (const id of ids) closeWorkspace(id);
    return;
  }
  const closing = new Set(ids);
  // Open the nearest surviving row first, so cmux has nothing to pick (and
  // no collapsed group to expand) when the open workspace closes.
  const open = selectOverride || selectedId();
  if (closing.has(open)) {
    const order = visibleRowIds();
    const at = order.indexOf(open);
    const next = order.slice(at + 1).find((id) => !closing.has(id))
      ?? order.slice(0, Math.max(at, 0)).reverse().find((id) => !closing.has(id));
    if (next) selectWorkspace(next);
  }
  setBulkClose({
    ids: closing,
    until: wallNow() + BULK_CLOSE_TIMEOUT,
    ws: visibleWorkspaces().filter((w) => !closing.has(w.id)),
    groups: groupsList(),
  });
  for (const id of ids) sendClose(id);
}

computed(() => {
  const b = bulkClose();
  if (!b) return;
  data.clock(); // re-check the timeout every tick
  if (!wsList().some((w) => b.ids.has(w.id)) || wallNow() >= b.until) setBulkClose(null);
});

// Multi-select: Cmd-click toggles, Shift-click selects a range over the
// visible row order, plain click clears. The range starts at the last click
// while a multi-selection is open, else at the open workspace (so it works
// right after a reload or a switch made outside the sidebar). The selection
// drives the context menu's bulk actions (group together, move, close).
const multiSelected = new Set();
const [multiTick, setMultiTick] = signal(0);
let lastClickedId = null;

function isMultiSelected(w) {
  multiTick();
  return !!w && multiSelected.has(w.id);
}

function clearMultiSelect() {
  if (multiSelected.size === 0) return;
  multiSelected.clear();
  setMultiTick(multiTick() + 1);
}

// The rows currently on screen, in order.
function visibleRowIds() {
  return flatEntries().filter((e) => e.kind === "ws").map((e) => e.wsId);
}

function handleRowClick(w, payload) {
  if (bulkClose()) return;
  const id = w.id;
  if (payload && payload.cmd) {
    if (multiSelected.has(id)) multiSelected.delete(id);
    else multiSelected.add(id);
    setMultiTick(multiTick() + 1);
  } else if (payload && payload.shift) {
    const from = multiSelected.size && lastClickedId ? lastClickedId : selectOverride || selectedId();
    const order = visibleRowIds();
    const a = order.indexOf(from);
    const b = order.indexOf(id);
    // An anchor that is not a visible row (a header, or filtered out) starts
    // the range at the clicked row.
    for (const rid of order.slice(Math.min(a < 0 ? b : a, b), Math.max(a, b) + 1)) multiSelected.add(rid);
    setMultiTick(multiTick() + 1);
  } else {
    clearMultiSelect();
    selectWorkspace(id);
  }
  lastClickedId = id;
}

// The set of workspaces a bulk menu action applies to: the multi-selection
// when the clicked row is part of it, else just the clicked row.
function bulkIds(w) {
  multiTick();
  if (w && multiSelected.has(w.id)) return Array.from(multiSelected);
  return w ? [w.id] : [];
}

// ⌘W can't close the multi-selection: a custom sidebar gets no key events,
// and ⌘W is cmux's Close Tab. The top bar shows a Close N chip instead.
const multiCount = memo(() => {
  multiTick();
  return multiSelected.size;
});

function closeSelected() {
  closeMany(Array.from(multiSelected));
  clearMultiSelect();
}

// Sets (or, for null, clears) the native workspace color: the title color.
function setColor(id, color) {
  colorOverride.set(id, color ?? "");
  setColorTick(colorTick() + 1);
  if (color) cmux("workspace.action", { action: "set_color", workspace_id: id, color });
  else cmux("workspace.action", { action: "clear_color", workspace_id: id });
}

// Bright enough to read as text on light and dark sidebars.
const TITLE_COLORS = [
  ["Red", "#FF453A"],
  ["Orange", "#FF9F0A"],
  ["Yellow", "#FFD60A"],
  ["Green", "#30D158"],
  ["Teal", "#40C8E0"],
  ["Blue", "#0A84FF"],
  ["Purple", "#BF5AF2"],
  ["Pink", "#FF375F"],
];

const titleOverride = new Map();
const [titleTick, setTitleTick] = signal(0);

function displayTitle(w) {
  titleTick();
  if (!w) return "";
  if (titleOverride.has(w.id)) {
    const t = titleOverride.get(w.id);
    if (w.title === t) titleOverride.delete(w.id); // caught up
    else return t;
  }
  return w.title;
}

// --- inline rename -----------------------------------------------------------
// Double-click a row/header (or its Rename menu item) to edit in place.
// Editing swaps the entry's key, so the keyed reconciler remounts the row as
// an editor; Return commits through workspace(.group).rename, Escape cancels.
const [editingId, setEditingId] = signal(null);

// --- optimistic collapse -----------------------------------------------------
const collapseOverride = new Map();
// group id -> workspace id: an override set while selecting into a collapsed
// group must outlive data that predates the select (it still says
// "collapsed", so it would look caught up) until cmux echoes the selection,
// the point where its auto-expand has happened.
const collapseHold = new Map();
const [collapseTick, setCollapseTick] = signal(0);

function isCollapsed(g) {
  collapseTick();
  if (collapseOverride.has(g.id)) {
    const v = collapseOverride.get(g.id);
    if (collapseHold.has(g.id) && selectedId() !== collapseHold.get(g.id)) return v;
    collapseHold.delete(g.id);
    if (v === g.collapsed) collapseOverride.delete(g.id); // host caught up
    else return v;
  }
  return g.collapsed;
}

function toggleCollapse(g) {
  const next = !isCollapsed(g);
  collapseOverride.set(g.id, next);
  setCollapseTick(collapseTick() + 1);
  cmux(next ? "workspace.group.collapse" : "workspace.group.expand", { group_id: g.id });
}

// Virtual headers (a parent path with no real group) have no host state, so
// their collapse lives here only and resets when the sidebar reloads.
const [virtualCollapsed, setVirtualCollapsed] = signal({});

function nodeCollapsed(node) {
  return node.group ? isCollapsed(node.group) : !!virtualCollapsed()[node.path];
}

function toggleNode(node) {
  if (node.group) toggleCollapse(node.group);
  else setVirtualCollapsed({ ...virtualCollapsed(), [node.path]: !nodeCollapsed(node) });
}

// --- group tree --------------------------------------------------------------
// cmux groups are flat; the hierarchy lives in the group NAME as a "/" path
// ("Work/Backend/API"). Only the leaf segment is shown, indented per level.
// A parent path with no real group gets a virtual header.
const SEP = "/";
const INDENT = 14;
// A group's end slot (see flatEntries): with the list spacing, each one is a
// 6pt drop slot, enough to aim for while barely opening a gap.
const GROUP_END_HEIGHT = 4;
// The group a dragged row would drop into: its header, and its rows lighter.
const DROP_HEADER_TINT = "#4C9EEB4D";
const DROP_ROW_TINT = "#4C9EEB1F";
const splitPath = (name) => String(name ?? "").split(SEP).map((s) => s.trim()).filter(Boolean);
const joinPath = (segs) => segs.join(SEP);

// The part of the workspace list the tree's shape depends on, in visible tab
// order. An agent heartbeat or a title edit leaves it unchanged, so the tree
// is not rebuilt for them.
const structure = memoJSON(() =>
  visibleWorkspaces().map((w) => ({ id: w.id, group: w.group ?? null, pinned: !!w.pinned })),
);

// Tree node: { key, group (null = virtual), segs, path, leaf, parent, depth,
// anchor, members (non-anchor rows), children (subgroup nodes), items
// (members + children in tabs order), pos (tabs position), refId }.
// A real group sits at its ANCHOR's tabs position (the app's canonical block
// position); a virtual one at its earliest descendant's. Siblings sort by it.
const groupTree = computed(() => {
  const ws = structure();
  const pos = new Map(ws.map((w, i) => [w.id, i]));
  const byKey = new Map();
  const byGroupId = new Map();
  const byPath = new Map();
  const root = { key: "", group: null, segs: [], path: "", children: [], members: [], depth: -1 };

  const byGroup = new Map();
  for (const w of ws) {
    if (!w.group) continue;
    if (!byGroup.has(w.group)) byGroup.set(w.group, []);
    byGroup.get(w.group).push(w);
  }
  const real = [];
  for (const g of bulkClose()?.groups ?? groupsList()) {
    const members = byGroup.get(g.id) ?? [];
    if (members.length === 0) continue;
    const anchor = members.find((w) => w.id === g.anchorId) ?? null;
    const segs = splitPath(g.name);
    real.push({
      key: "g:" + g.id,
      group: g,
      segs,
      path: joinPath(segs),
      leaf: segs.length ? segs[segs.length - 1] : g.name,
      anchor,
      members: members.filter((w) => w !== anchor),
      children: [],
      pos: pos.get((anchor ?? members[0]).id),
    });
  }
  // Earliest wins a duplicated path; later duplicates render as siblings.
  real.sort((a, b) => a.pos - b.pos);
  for (const n of real) {
    byKey.set(n.key, n);
    byGroupId.set(n.group.id, n);
    if (n.segs.length && !byPath.has(n.path)) byPath.set(n.path, n);
  }
  const ensure = (segs) => {
    if (segs.length === 0) return root;
    const path = joinPath(segs);
    let n = byPath.get(path);
    if (!n) {
      n = { key: "v:" + path, group: null, segs, path, leaf: segs[segs.length - 1], anchor: null, members: [], children: [] };
      byPath.set(path, n);
      byKey.set(n.key, n);
      n.parent = ensure(segs.slice(0, -1));
      n.parent.children.push(n);
    }
    return n;
  };
  for (const n of real) {
    n.parent = ensure(n.segs.slice(0, -1));
    n.parent.children.push(n);
  }

  const ungrouped = ws.filter((w) => !byGroupId.has(w.group));
  const settle = (node, depth) => {
    node.depth = depth;
    for (const c of node.children) settle(c, depth + 1);
    if (!node.group && node !== root) node.pos = Math.min(...node.children.map((c) => c.pos));
    const rows = node === root ? ungrouped : node.members;
    node.items = [
      ...rows.map((w) => ({ ws: w, pos: pos.get(w.id) })),
      ...node.children.map((c) => ({ node: c, pos: c.pos })),
    ].sort((a, b) => a.pos - b.pos);
    if (node !== root) node.refId = ws[node.pos].id;
  };
  settle(root, -1);
  return { root, byKey, byGroupId };
});

const nodeByKey = (key) => groupTree().byKey.get(key);

// Every workspace under a node in display order, subgroup anchors included,
// the node's own anchor excluded (its header stands for it).
function descendantsOf(node) {
  const out = [];
  for (const item of node.items) {
    if (item.ws) out.push(item.ws);
    else {
      if (item.node.anchor) out.push(item.node.anchor);
      out.push(...descendantsOf(item.node));
    }
  }
  return out;
}

// The innermost real group at or above a node: where a row dropped at this
// level lands. Virtual headers defer to their nearest real ancestor.
function realContainer(node) {
  for (let n = node; n && n.depth >= 0; n = n.parent) if (n.group) return n.group.id;
  return null;
}

// "B › C › " for a row of A/B/C shown under a collapsed A.
function breadcrumb(w, top) {
  const names = [];
  for (let n = groupTree().byGroupId.get(w.group); n && n !== top; n = n.parent) names.unshift(n.leaf);
  return names.map((s) => s + " ›").join(" ");
}

// --- group path edits ----------------------------------------------------------
// Every structural edit is a rename: a node's path changes, and each real
// group displayed under it follows. The subtree comes from the tree itself,
// not a name-prefix scan, so a duplicate-path group never drags along
// subgroups that are shown under a different header.

const isWithin = (n, ancestor) => {
  for (let p = n; p; p = p.parent) if (p === ancestor) return true;
  return false;
};

// Real groups strictly below a node, with their path relative to it.
function groupsBelow(node) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c.group) out.push({ g: c.group, rest: c.segs.slice(node.segs.length) });
      walk(c);
    }
  };
  walk(node);
  return out;
}

function renameGroup(g, segs) {
  const name = joinPath(segs);
  if (!name || name === g.name) return;
  nameOverride.set(g.id, name);
  setNameTick(nameTick() + 1);
  cmux("workspace.group.rename", { group_id: g.id, name });
}

// `segs` if no other group/header already uses that path, else the leaf gets
// " 2", " 3", ... Two groups on one path would merge their subtrees for good.
// The moving node's own subtree doesn't count as taken.
function freePath(segs, moving) {
  const taken = new Set(treeNodes().filter((n) => !moving || !isWithin(n, moving)).map((n) => n.path));
  const parent = segs.slice(0, -1);
  const leaf = segs[segs.length - 1];
  let candidate = segs;
  for (let i = 2; taken.has(joinPath(candidate)); i += 1) candidate = [...parent, leaf + " " + i];
  return candidate;
}

// Moves a node (and its subtree) to the path `next`.
function repath(node, next) {
  const to = freePath(next, node);
  if (node.group) renameGroup(node.group, to);
  for (const { g, rest } of groupsBelow(node)) renameGroup(g, [...to, ...rest]);
}

const leafSegs = (node) => (node.segs.length ? node.segs.slice(-1) : [node.leaf || "Group"]);

// Ungroup/Delete keep cmux semantics for the group itself; its subgroups
// are promoted one level (they take the dissolved group's place), each onto
// a free path so a promoted subtree never merges into an existing sibling.
function dissolve(node, method) {
  cmux(method, { group_id: node.group.id });
  const parent = node.segs.slice(0, -1);
  for (const c of node.children) repath(c, [...parent, ...c.segs.slice(node.segs.length)]);
}

// Every group node in display order (ForEach items must be plain data: the
// runtime serializes them, and nodes link back to their parents).
function treeNodes() {
  const out = [];
  const walk = (n) => {
    for (const item of n.items) {
      if (!item.node) continue;
      out.push(item.node);
      walk(item.node);
    }
  };
  walk(groupTree().root);
  return out;
}

const pathLabel = (n) => (n.segs.length ? n.segs.join(" › ") : n.leaf);
const choice = (n) => ({ key: n.key, label: pathLabel(n), groupId: n.group ? n.group.id : null });

// "Move Group Into" targets: the whole tree minus the node and its own
// subtree (a group can't move inside itself).
const moveTargets = (node) => treeNodes().filter((n) => !isWithin(n, node)).map(choice);
// "Move to Group" targets: real groups only (a virtual header has no cmux
// group to join). One shared list for every row's submenu.
const groupChoices = memoJSON(() => treeNodes().filter((n) => n.group).map(choice));

// New Subgroup: the group (and its generated anchor workspace) arrives with
// a later data tick; flatEntries opens it for rename once it shows up. The
// parent chain is expanded first so that editor is actually visible.
let pendingSubgroup = null;

function newSubgroup(node) {
  for (let n = node; n && n.depth >= 0; n = n.parent) if (nodeCollapsed(n)) toggleNode(n);
  const name = joinPath(freePath([...node.segs, "New Group"], null));
  pendingSubgroup = { name, known: new Set(groupsList().map((g) => g.id)) };
  cmux("workspace.group.create", { name });
}

function claimPendingSubgroup() {
  if (!pendingSubgroup) return;
  const { name, known } = pendingSubgroup;
  const g = groupsList().find((x) => x.name === name && !known.has(x.id));
  if (!g) return;
  pendingSubgroup = null;
  setEditingId("h:g:" + g.id);
}

const isActiveId = (id) => isActive(wsSig(id)());

// --- filters -------------------------------------------------------------------
// Two toggles at the top: Active (orange or green dot) and Favorites (pinned).
// They filter the tree in place: every group header stays (so its + and menu
// still work) and only workspace rows hide. A row shows if it matches ANY
// enabled filter, or is the open workspace, so a workspace you just created
// or opened stays until you open another. Filter state is local and resets
// when the sidebar mounts.
const [filterActive, setFilterActive] = signal(false);
const [filterFavorites, setFilterFavorites] = signal(false);
const filtering = () => filterActive() || filterFavorites();

function passesFilters(id) {
  const w = wsSig(id)();
  return isSelected(w) || (filterActive() && isActive(w)) || (filterFavorites() && !!w?.pinned);
}

// List entries by key. A row template reads its entry here instead of from
// its item signal: reading the signal while the list mounts the row would
// subscribe the whole list to that row's changes.
const entryByKey = new Map();

function keyed(entries) {
  for (const e of entries) entryByKey.set(e.id, e);
  return entries;
}

function wsEntry(id, editing, depth, container, crumb, collapsedUnder = null) {
  return {
    kind: "ws",
    id: id + (editing === id ? ":edit" : ""),
    wsId: id,
    editing: editing === id,
    container,
    depth,
    crumb,
    collapsedUnder,
  };
}

// One flat entry list (headers + rows) for the single Reorderable, each
// subtree contiguous after its header and deeper than it. Pinned top-level
// groups and pinned ungrouped workspaces float to the top.
const flatEntries = memoJSON(() => {
  const t = groupTree();
  claimPendingSubgroup();
  const editing = editingId();
  const hidden = (id) => filtering() && !passesFilters(id);
  const emit = (node, out) => {
    const hid = "h:" + node.key;
    const collapsed = nodeCollapsed(node);
    out.push({
      kind: "header",
      id: hid + (editing === hid ? ":edit" : ""),
      nodeKey: node.key,
      groupId: node.group ? node.group.id : null,
      editing: editing === hid,
      leaf: node.leaf,
      depth: node.depth,
      collapsed,
      container: realContainer(node),
      outer: realContainer(node.parent),
      refId: node.refId,
    });
    if (collapsed) {
      // Collapsed: only working and finished-unseen descendants stay,
      // flattened under the header (and only those the filters let through).
      for (const w of descendantsOf(node)) {
        if (isActiveId(w.id) && !hidden(w.id)) {
          out.push(wsEntry(w.id, editing, node.depth + 1, w.group, breadcrumb(w, node), node.key));
        }
      }
      return;
    }
    const start = out.length;
    for (const item of node.items) {
      if (!item.ws) emit(item.node, out);
      else if (!hidden(item.ws.id)) out.push(wsEntry(item.ws.id, editing, node.depth + 1, node.group.id, ""));
    }
    // The group's end: a thin slot at its parent's level, so a row dragged
    // just below the group's last row leaves it. A run of ends steps out one
    // level each.
    if (out.length > start) {
      out.push({ kind: "end", id: "end:" + node.key, nodeKey: node.key, depth: node.depth, container: realContainer(node.parent) });
    }
  };

  const pinned = [];
  const rest = [];
  for (const item of t.root.items) {
    if (item.ws) {
      if (hidden(item.ws.id)) continue;
      (item.ws.pinned ? pinned : rest).push(wsEntry(item.ws.id, editing, 0, null, ""));
    } else {
      emit(item.node, item.node.group && item.node.group.pinned ? pinned : rest);
    }
  }
  return keyed([...pinned, ...rest]);
});

const activeCount = memo(() => structure().filter((w) => isActiveId(w.id)).length);
const favoriteCount = memo(() => structure().filter((w) => w.pinned).length);

// Filters that leave no workspace rows say so, below the group headers.
const emptyMessage = memo(() => {
  if (!filtering() || flatEntries().some((e) => e.kind === "ws")) return null;
  if (filterActive() && filterFavorites()) return "No active or favorite workspaces";
  return filterActive() ? "No active workspaces" : "No favorite workspaces";
});

// Priority 1 keeps a chip's label whole: without it the bar's Spacer wins
// and the label truncates even when the bar has room.
function barChip(label, isOn, toggle, icon) {
  return HStack({ spacing: 4 }, [
    icon,
    Text(label).font(11).weight("medium").lineLimit(1)
      .color(memo(() => (isOn() ? "primary" : "secondary"))),
  ])
    .paddingHorizontal(8)
    .paddingVertical(3)
    .cornerRadius(9)
    .background(memo(() => (isOn() ? "#7f7f7f3d" : null)))
    .hoverBackground(memo(() => (isOn() ? "#7f7f7f3d" : "#7f7f7f24")))
    .layoutPriority(1)
    .onTap(toggle);
}

function filterBar() {
  return HStack({ spacing: 6 }, [
    barChip(
      memo(() => "Active · " + activeCount()),
      filterActive,
      () => setFilterActive(!filterActive()),
      Circle({ size: 7 }).fill(WORKING_ORANGE),
    ),
    barChip(
      memo(() => "Favorites · " + favoriteCount()),
      filterFavorites,
      () => setFilterFavorites(!filterFavorites()),
      Image("bookmark.fill").font(9).color(FAVORITE_RED),
    ),
    Spacer(),
    // Close N while 2+ rows are selected; a spinner while a bulk close runs.
    ForEach({ items: memo(() => (bulkClose() ? ["closing"] : multiCount() > 1 ? ["close"] : [])), key: (k) => k }, (_, k) =>
      k === "closing"
        // The host draws the regular 32pt spinner; a 16pt-tall frame keeps
        // the bar's height, so the list below doesn't shift.
        ? ProgressView().frame({ width: 32, height: 16 })
        : barChip(
          memo(() => "Close " + multiCount()),
          () => false,
          closeSelected,
          Image("xmark").font(8).weight("bold").color("secondary"),
        )),
    Image("questionmark.circle")
      .font(12).color(memo(() => (guideOpen() ? "primary" : "tertiary")))
      .padding(3)
      .cornerRadius(8)
      .background(memo(() => (guideOpen() ? "#7f7f7f3d" : null)))
      .hoverBackground(memo(() => (guideOpen() ? "#7f7f7f3d" : "#7f7f7f24")))
      .help("Sidebar Guide")
      .onTap(() => setGuideOpen(!guideOpen())),
  ])
    .paddingLeading(4)
    .paddingTrailing(4)
    .paddingBottom(2);
}

// --- guide -------------------------------------------------------------------
// What every icon means and how the mouse works, opened from the top bar's ?
// or any right-click menu. It takes the list's place rather than sitting on
// top of it: the sidebar scrolls as a whole, so only a short page brings it
// into view from a menu opened far down the list.
const [guideOpen, setGuideOpen] = signal(false);
const openGuide = () => setGuideOpen(true);
const guideMenuItems = () => [Divider(), Button("Sidebar Guide", openGuide)];

const guideSection = (title) => Text(title).font(10).weight("semibold").color("tertiary").paddingTop(4);
// An icon (or a sample), then what it means. The icon's slot is one text
// line tall, so it stays beside the first line when the text wraps.
const guideLine = (icon, text) =>
  HStack({ spacing: 6, alignment: "top" }, [
    HStack({ spacing: 0 }, [icon]).frame({ width: 30, height: 14 }),
    Text(text).font(11).color("secondary"),
  ]);
const guideNote = (text) => Text(text).font(11).color("secondary");

function guideCard() {
  return VStack({ spacing: 5 }, [
    HStack({ spacing: 6 }, [
      Text("Sidebar Guide").font(13).weight("semibold"),
      Spacer(),
      Text("click to close").font(10).color("tertiary"),
    ]),
    guideSection("ROWS"),
    guideLine(Circle({ size: 8 }).fill(WORKING_ORANGE), "An agent is working"),
    guideLine(Circle({ size: 8 }).fill(FINISHED_GREEN), "Finished while you were elsewhere; opening clears it"),
    guideLine(recentClock(), "Finished under an hour ago; opening restarts the hour"),
    guideLine(Image("bookmark.fill").font(10).color(FAVORITE_RED), "Favorite (pinned in cmux), listed first"),
    guideLine(Text("Title").font(11).weight("semibold").color(IMPORTANT_RED), "Important: Title Color → Red; the row keeps its place"),
    guideLine(
      Text("2").font("caption2").bold().color("white").paddingHorizontal(5).paddingVertical(1).background("#E4573D").cornerRadius(7),
      "Unread notifications",
    ),
    guideLine(Text("B ›").font(11).color("tertiary"), "Group path of a row listed under a folded group"),
    guideSection("GROUPS"),
    guideLine(Image("chevron.down").font(10).weight("semibold").color("tertiary"), "Fold; a folded group still lists working and finished rows"),
    guideLine(Text("A/B").font(11).color("tertiary"), "A group named A/B shows as B inside A"),
    guideNote("Clicking a group header opens its first workspace."),
    guideSection("TOP BAR"),
    guideLine(Circle({ size: 7 }).fill(WORKING_ORANGE), "Active: show only working and finished rows"),
    guideLine(Image("bookmark.fill").font(9).color(FAVORITE_RED), "Favorites: show only favorites"),
    guideLine(Image("xmark").font(8).weight("bold").color("secondary"), "Close N: close the selected rows; a spinner shows until they are gone"),
    guideSection("MOUSE"),
    guideNote("Click opens. ⌘-click adds or removes a row from the selection; ⇧-click selects a range."),
    guideNote("Right-click acts on the row, or on the selection. Double-click renames."),
    guideNote("The ✕ on hover closes at once, without asking."),
    guideNote("Drag to reorder: the group the row will land in lights up blue. Drop just below a group's last row to leave it; each step lower leaves one more level."),
  ])
    .padding(10)
    .cornerRadius(10)
    .background("#7f7f7f1f")
    .frame({ maxWidth: "infinity" })
    .onTap(() => setGuideOpen(false));
}

// --- drop resolution ---------------------------------------------------------
// `index` is the dragged row's slot in the flat list (headers included).
// `side` resolves the ambiguous boundary slots: "above" nests with the row
// above (e.g. last item of a group), "below" with the row below (right after
// the group, outside it) - chosen by the pointer's X position mid-drag.

// Dragging a row that is part of the multi-selection moves the WHOLE
// selection: the visible selected rows gather contiguously at the drop slot
// (visual order preserved) and all take the slot's container. This is the
// platform-standard resolution for non-contiguous selections and for
// selections mixing in-group and ungrouped rows. Hidden rows (inside a
// collapsed group) never move - what you see is what you drag.
function isBulkDrag(id) {
  multiTick();
  return multiSelected.has(id) && multiSelected.size > 1;
}

function movingRows(id) {
  return isBulkDrag(id) ? visibleRowIds().filter((rid) => multiSelected.has(rid) || rid === id) : [id];
}

// Where a row drop lands: the slot's container (the deepest real group it
// sits in, null for the top level), the collapsed group whose list it is in,
// and the next entry that stays put. Shared by the drop and the drag
// highlight.
function rowDrop(id, index, side, moving) {
  const entries = flatEntries().filter((e) => e.id !== id);
  // Rows moving with the drag can't define the container or anchor.
  const stays = (e) => !(e.kind === "ws" && moving.has(e.wsId ?? e.id));
  let prev = null;
  for (let i = index - 1; i >= 0 && !prev; i -= 1) if (stays(entries[i])) prev = entries[i];
  // The drop's tabs-order anchor. A header resolves to its group's first
  // tab: dropping above a group means "before the whole block", never
  // "between its anchor and members" (which would break contiguity and get
  // normalized somewhere else).
  const nextEntry = entries.slice(index).find((e) => {
    if (e.kind === "header") return !moving.has(e.refId);
    return e.kind === "ws" && stays(e);
  }) ?? null;
  const nextAny = entries.slice(index).find(stays) ?? null;

  let container;
  // A slot inside a collapsed group's flattened list (right under its header,
  // or next to one of its listed rows): its rows come from many subgroups, so
  // the neighbor says nothing about membership. Rows from that subtree keep
  // their group; anything else lands beside the collapsed group.
  let collapsedScope = null;
  if (side === "below") {
    // Nest with what's below: a header below means "beside that group", i.e.
    // in its parent; a row or a group's end means its level.
    if (!nextAny) container = null;
    else container = nextAny.kind === "header" ? nextAny.outer : nextAny.container;
    if (nextAny && nextAny.collapsedUnder) collapsedScope = nodeByKey(nextAny.collapsedUnder);
  } else {
    container = prev ? prev.container : null;
    if (prev && prev.kind === "header" && prev.collapsed) collapsedScope = nodeByKey(prev.nodeKey);
    if (prev && prev.collapsedUnder) collapsedScope = nodeByKey(prev.collapsedUnder);
  }
  if (collapsedScope) container = realContainer(collapsedScope.parent);
  return { container, collapsedScope, nextEntry };
}

// The group a row drag in flight would drop into, so it lights up: a group
// id, null for the top level (nothing lit), undefined with no drag. The host
// reports each slot and side change, never pointer motion.
const [dropGroup, setDropGroup] = signal(undefined);

function handleDragChange(drag) {
  if (!drag || drag.id.startsWith("h:") || !wsList().some((w) => w.id === drag.id)) {
    setDropGroup(undefined);
    return;
  }
  setDropGroup(rowDrop(drag.id, drag.index, drag.side, new Set(movingRows(drag.id))).container);
}

function handleMove(id, index, extra) {
  if (bulkClose()) return; // the list is frozen; its slots map to nothing
  if (id.startsWith("h:")) {
    moveGroup(id, index, extra && extra.side);
    return;
  }
  const ws = wsList();
  const dragged = ws.find((w) => w.id === id);
  if (!dragged) return; // gone, or a group's end slot
  const bulk = isBulkDrag(id);
  const movingIds = movingRows(id);
  const { container, collapsedScope, nextEntry } = rowDrop(id, index, extra && extra.side, new Set(movingIds));
  const nextRefId = nextEntry ? (nextEntry.kind === "header" ? nextEntry.refId : nextEntry.wsId) : null;
  const nextWorkspace = nextRefId ? ws.find((w) => w.id === nextRefId) : null;

  const { byGroupId } = groupTree();
  const inScope = (row) => !!collapsedScope && isWithin(byGroupId.get(row.group), collapsedScope);
  // Rows that stay in the collapsed list also stay put in the tabs: that list
  // mixes groups, so its order maps to no tab order (and a gathered run would
  // split their groups' contiguous runs).
  const placed = [];
  for (const rid of movingIds) {
    const row = ws.find((w) => w.id === rid);
    if (!row || inScope(row)) continue;
    placed.push(rid);
    if ((row.group ?? null) !== container) {
      if (container) {
        cmux("workspace.group.add", { group_id: container, workspace_id: rid });
      } else {
        cmux("workspace.group.remove", { workspace_id: rid });
      }
    }
  }
  // Dragging with a selection active clears it (platform convention).
  clearMultiSelect();
  if (placed.length === 0) return;

  if (bulk) {
    // Atomic block placement: send the full tabs order with the moving rows
    // inserted contiguously before the anchor.
    const placing = new Set(placed);
    const rest = ws.map((x) => x.id).filter((x) => !placing.has(x));
    let insertAt = nextWorkspace ? rest.indexOf(nextWorkspace.id) : rest.length;
    if (insertAt < 0) insertAt = rest.length;
    const full = [...rest.slice(0, insertAt), ...placed, ...rest.slice(insertAt)];
    setOrderOverride(full); // gather instantly; reorder_many echoes behind it
    cmux("workspace.reorder_many", { workspace_ids: JSON.stringify(full) });
    return;
  }

  if (nextWorkspace) {
    const before = nextWorkspace.index;
    const target = dragged.index < before ? before - 1 : before;
    cmux("workspace.reorder", { workspace_id: id, index: target });
  } else {
    cmux("workspace.reorder", { workspace_id: id, index: ws.length - 1 });
  }
}

// A header drags as a single row; on drop its whole subtree follows. The slot
// picks the new parent the way a row drop picks its group: right under an
// expanded header nests into it, next to a row or a collapsed header lands at
// that level, and at a group's end the boundary side decides (drag left to
// move out). A slot inside the dragged subtree itself is no move.
function moveGroup(id, index, side) {
  const all = flatEntries();
  const at = all.findIndex((e) => e.id === id);
  const node = at >= 0 ? nodeByKey(all[at].nodeKey) : null;
  if (!node) return;
  let end = at + 1;
  while (end < all.length && all[end].depth > node.depth) end += 1;
  if (all[end]?.kind === "end" && all[end].nodeKey === node.key) end += 1; // its own end slot
  const own = new Set(all.slice(at, end).map((e) => e.id));
  const entries = all.filter((e) => e.id !== id);
  const { root, byGroupId } = groupTree();
  // A row listed under a collapsed header stands beside that header; any
  // other row is in its group.
  const rowLevel = (e) =>
    e.collapsedUnder ? nodeByKey(e.collapsedUnder).parent : byGroupId.get(e.container) ?? root;

  let parent;
  if (side === "below") {
    const next = entries[index];
    if (next && own.has(next.id)) return;
    if (!next) parent = root;
    else parent = next.kind === "ws" ? rowLevel(next) : nodeByKey(next.nodeKey).parent;
  } else {
    const prev = entries[index - 1];
    if (prev && own.has(prev.id)) return;
    if (!prev) parent = root;
    else if (prev.kind === "header") parent = prev.collapsed ? nodeByKey(prev.nodeKey).parent : nodeByKey(prev.nodeKey);
    else if (prev.kind === "end") parent = nodeByKey(prev.nodeKey).parent;
    else parent = rowLevel(prev);
  }
  // Released in its own slot under the same parent: nothing moved.
  if (index === at && parent === node.parent) return;

  // Tabs: the subtree is extracted and re-inserted as one contiguous run per
  // real group (anchor, members, then each subgroup); the host re-normalizes
  // a split run, leaving the optimistic order unable to match its echo.
  // workspace.group.move is NOT usable: its to_index is a group-slot index
  // (position among groups, clamped to the pin tier), so a drop between
  // ungrouped rows is unreachable.
  const run = (n) => [n.anchor, ...n.members, ...n.items.filter((i) => i.node).flatMap((i) => run(i.node))];
  const ids = run(node).filter(Boolean).map((w) => w.id);
  const moving = new Set(ids);
  const ws = wsList();
  const rest = ws.filter((w) => !moving.has(w.id));
  // The next entry that stays put anchors the drop; a header stands for its
  // first tab. Rows listed under a collapsed header, and group ends, map to
  // no tab position. A header whose first tab is in the moving subtree (a
  // virtual ancestor of the dragged group) can't anchor it.
  const next = entries.slice(index).find((e) =>
    e.kind !== "end" && !own.has(e.id) && !e.collapsedUnder && !(e.kind === "header" && moving.has(e.refId)));
  const nextId = next ? (next.kind === "header" ? next.refId : next.wsId) : null;
  let insertAt = nextId ? rest.findIndex((w) => w.id === nextId) : rest.length;
  if (insertAt < 0) insertAt = rest.length;
  // A slot among a group's own tabs moves past them: never split a run.
  while (insertAt > 0 && insertAt < rest.length && rest[insertAt].group && rest[insertAt].group === rest[insertAt - 1].group) {
    insertAt += 1;
  }
  const order = [...rest.slice(0, insertAt).map((w) => w.id), ...ids, ...rest.slice(insertAt).map((w) => w.id)];

  if (parent !== node.parent) repath(node, [...parent.segs, ...leafSegs(node)]);
  // An earlier drop still awaiting its echo means the host order is not the
  // one on screen, so send even when this order matches the stale data.
  if (orderOverride || order.join(",") !== ws.map((w) => w.id).join(",")) {
    setOrderOverride(order); // paint the new order now; reorder_many echoes behind it
    cmux("workspace.reorder_many", { workspace_ids: JSON.stringify(order) });
  }
}

// --- rows ----------------------------------------------------------------------
// Every reactive prop below goes through memo(), so a row re-sends a prop only
// when its value changes. `w` is the row's own workspace signal; `e` its entry.
function workspaceMenu(w) {
  const act = (action) => () =>
    cmux("workspace.action", { action, workspace_id: w().id });
  // ForEach keeps the submenu current as groups come and go.
  const groupItems = ForEach(
    { items: groupChoices, key: (c) => c.key },
    (c) => Button(memo(() => c().label), () => {
      for (const id of bulkIds(w())) cmux("workspace.group.add", { group_id: c().groupId, workspace_id: id });
      clearMultiSelect();
    }),
  );
  const count = memo(() => bulkIds(w()).length);
  const pinned = memo(() => !!w()?.pinned);
  const unread = memo(() => w()?.unread > 0);
  const important = memo(() => isImportant(w()));
  return [
    Button(memo(() => (count() > 1 ? "New Group from " + count() + " Workspaces" : "New Group with This")), () => {
      cmux("workspace.group.create", {
        name: "New Group",
        child_workspace_ids: JSON.stringify(bulkIds(w())),
      });
      clearMultiSelect();
    }),
    Divider(),
    Button("Rename", () => setEditingId(w().id)),
    // Favorite is cmux's native pin, so it persists and the built-in
    // sidebar agrees.
    Button(memo(() => (pinned() ? "Unfavorite" : "Favorite")), () =>
      cmux("workspace.action", { action: w()?.pinned ? "unpin" : "pin", workspace_id: w().id })),
    // Important is Title Color red: it persists and never reorders.
    Button(memo(() => (important() ? "Unmark Important" : "Mark as Important")), () =>
      setColor(w().id, isImportant(w()) ? null : IMPORTANT_RED)),
    Button(memo(() => (unread() ? "Mark as Read" : "Mark as Unread")), () =>
      cmux("workspace.action", { action: w()?.unread > 0 ? "mark_read" : "mark_unread", workspace_id: w().id })),
    Divider(),
    Menu("Move", [
      Button("Move Up", act("move_up")),
      Button("Move Down", act("move_down")),
      Button("Move to Top", act("move_top")),
    ]),
    Menu("Move to Group", [groupItems]),
    Button("Remove from Group", () => cmux("workspace.group.remove", { workspace_id: w().id })),
    // Applies to the whole multi-selection when this row is part of it.
    Menu("Title Color", [
      ...[...TITLE_COLORS, ["None", null]].flatMap(([label, hex]) => [
        ...(hex ? [] : [Divider()]),
        Button(label, () => {
          for (const id of bulkIds(w())) setColor(id, hex);
          clearMultiSelect();
        }),
      ]),
    ]),
    Divider(),
    Button("Close Others", act("close_others")).destructive(),
    Button(memo(() => (count() > 1 ? "Close " + count() + " Workspaces" : "Close")), () => {
      closeMany(bulkIds(w()));
      clearMultiSelect();
    }).destructive(),
    ...guideMenuItems(),
  ];
}

// The dot leads the row with a 4pt gap after its 14pt slot. Padding sits
// inside a node's frame, so the gap is trailing padding in an 18pt frame:
// the circle lands where it does in a header's 14pt slot.
const ROW_DOT_SLOT = 18;

function workspaceRow(w, e) {
  const selected = memo(() => isSelected(w()));
  const multi = memo(() => isMultiSelected(w()));
  const dropHere = memo(() => !!dropGroup() && dropGroup() === e().container);
  const unread = memo(() => w()?.unread ?? 0);
  const pinned = memo(() => !!w()?.pinned);
  const crumb = memo(() => e().crumb);
  const state = memo(() => activity(w()));
  const recentShown = memo(() => isRecent(w()));
  const color = memo(() => titleColor(w()));
  // Dot, clock, favorite bookmark, and breadcrumb mount only while shown:
  // every mounted node costs the host work on each scroll frame, and most
  // rows show none of them. A row without a dot keeps its slot as leading
  // padding, so titles and clocks stay aligned.
  const leading = memoJSON(() =>
    [state() && "dot", recentShown() && "clock", pinned() && "pin", crumb() && "crumb"].filter(Boolean),
  );
  const badge = memoJSON(() => (unread() > 0 ? ["badge"] : []));
  // The title owns the FULL row width; badge and close button FLOAT over its
  // trailing edge (ZStack trailing) instead of reserving layout. No fades
  // anywhere (they read as glitches when they appear); overflow truncates
  // with a plain ellipsis.
  return ZStack({ alignment: "trailing" }, [
    // Its frame leads, so no trailing Spacer is needed to left-align it.
    HStack({ spacing: 0 }, [
      // Priority 1, like the title (the host's default for a lineLimit
      // Text), so a long breadcrumb and title still share truncation.
      ForEach({ items: leading, key: (k) => k, layoutPriority: 1 }, (_, k) => {
        if (k === "dot") return activityDot(state, ROW_DOT_SLOT - 14);
        // Green clock: the turn finished under an hour ago.
        if (k === "clock") return recentClock().frame({ width: CLOCK_SLOT }).paddingTrailing(CLOCK_SLOT - 12);
        // Red bookmark on favorites.
        if (k === "pin") return Image("bookmark.fill").font(10).color(FAVORITE_RED).frame({ width: 9 }).paddingTrailing(5);
        // Dim "B › C ›" path for a row shown away from its group.
        return Text(crumb).font(13).color("tertiary").lineLimit(1).paddingTrailing(4);
      }),
      Text(memo(() => displayTitle(w())))
        .font(13)
        .lineLimit(1)
        .truncation("tail")
        .color(memo(() => color() ?? (selected() ? "primary" : "secondary"))),
    ])
      .frame({ maxWidth: "infinity" }),
    ZStack({}, [
      // Unread badge at rest; on hover it yields to the close button.
      ForEach({ items: badge, key: (k) => k }, () =>
        Text(memo(() => String(unread())))
          .font("caption2").bold().color("white")
          .paddingHorizontal(5)
          .paddingVertical(1)
          .background("#E4573D")
          .cornerRadius(7)
          .hideOnHover()),
      // Circular close: uniform padding around the glyph + full-round corner
      // (the background hugs content+padding, so padding IS the circle size).
      // The circle only paints while the X ITSELF is hovered (hoverBackground
      // with no resting background tracks the node's own pointer).
      Image("xmark")
        .font(9).weight("semibold").color("secondary")
        .padding(4)
        .cornerRadius(9)
        .hoverBackground("#7f7f7f4a")
        .showOnHover()
        .onTap(() => closeWorkspace(w().id)),
    ]),
  ])
    .paddingLeading(memo(() => (state() ? 2 : 2 + ROW_DOT_SLOT)))
    .paddingTrailing(10)
    .paddingVertical(6)
    .marginLeading(memo(() => e().depth * INDENT))
    .cornerRadius(8)
    .background(memo(() => (multi() ? "#4C9EEB33" : dropHere() ? DROP_ROW_TINT : selected() ? "#7f7f7f3d" : null)))
    .hoverBackground(memo(() => (multi() ? "#4C9EEB33" : (selected() ? "#7f7f7f3d" : "#7f7f7f24"))))
    .frame({ maxWidth: "infinity" })
    .dragSet(memo(() => (multi() ? "multi" : null)))
    .onTap((payload) => handleRowClick(w(), payload))
    .onDoubleTap(() => bulkClose() || setEditingId(w().id))
    .contextMenu(workspaceMenu(w));
}

// In-place editor row (same box as a workspace row).
function workspaceEditRow(w, e) {
  return HStack({ spacing: 8 }, [
    TextField(memo(() => w()?.title ?? ""), {
      placeholder: "Workspace name",
      onSubmit: (t) => {
        const title = (t ?? "").trim();
        if (title) {
          titleOverride.set(w().id, title);
          setTitleTick(titleTick() + 1);
          cmux("workspace.action", { action: "rename", workspace_id: w().id, title });
        } else {
          cmux("workspace.action", { action: "clear_name", workspace_id: w().id });
        }
        setEditingId(null);
      },
      onCancel: () => setEditingId(null),
    }).font(13),
  ])
    .paddingHorizontal(10)
    .paddingVertical(6)
    .cornerRadius(8)
    .background("#7f7f7f3d")
    .marginLeading(memo(() => e().depth * INDENT))
    .frame({ maxWidth: "infinity" });
}

function groupHeader(entry, e) {
  const { nodeKey, groupId } = entry; // stable per key
  const hid = "h:" + nodeKey;
  const g = () => (groupId && groupById(groupId)) || { id: groupId, name: "", collapsed: false, pinned: false };
  const anchorId = memo(() => (groupId ? g().anchorId : null));
  const anchor = () => (anchorId() ? wsSig(anchorId())() : undefined);
  const selected = memo(() => isSelected(anchor()));
  const dropHere = memo(() => !!groupId && dropGroup() === groupId);
  const state = memo(() => activity(anchor()));
  const recentShown = memo(() => isRecent(anchor()));
  // The anchor's dot and clock mount only while shown, like a row's.
  const marks = memoJSON(() => [state() && "dot", recentShown() && "clock"].filter(Boolean));
  const dotInset = memo(() => (state() ? 18 : 0));
  // Menu actions resolve the node at click time (the tree rebuilds per tick).
  const withNode = (fn) => () => {
    const node = nodeByKey(nodeKey);
    if (node) fn(node);
  };
  // Folding mid bulk close would move the frozen list (see closeMany).
  const toggle = withNode((node) => bulkClose() || toggleNode(node));
  return HStack({ spacing: 6 }, [
    // The chevron toggles collapse; clicking anywhere else selects the
    // group's anchor workspace (built-in sidebar behavior). Chevron only,
    // no folder icon. One glyph that ROTATES (right -> down on expand):
    // rotation animates as one motion with the accordion, and the fixed box
    // keeps the header height constant.
    Image("chevron.right")
      .font(10).weight("semibold").color("tertiary")
      .rotation(memo(() => (e().collapsed ? 0 : 90)))
      .frame({ width: 14, height: 16 })
      .onTap(toggle),
    // The anchor's own dot and clock overlay a leading inset that only opens
    // while they show. The host auto-boosts only a bare truncating Text over
    // sibling Spacers, so the wrapper needs the boost explicitly.
    ZStack({ alignment: "leading" }, [
      Text(memo(() => e().leaf)).font(12).weight("semibold").lineLimit(1).truncation("tail")
        .color(memo(() => (selected() ? "primary" : "secondary")))
        .paddingLeading(memo(() => dotInset() + (recentShown() ? CLOCK_SLOT : 0))),
      ForEach({ items: marks, key: (k) => k }, (_, k) =>
        (k === "dot" ? activityDot(state) : recentClock().paddingLeading(dotInset))),
    ]).layoutPriority(1),
    Spacer(),
    // Hover-revealed `+`, styled like the row close button. Virtual headers
    // have no group to create into, so theirs stays hidden and inert.
    Image("plus")
      .font(10).weight("semibold").color("secondary")
      .padding(3)
      .cornerRadius(8)
      .hoverBackground("#7f7f7f4a")
      .showOnHover()
      .opacity(groupId ? 1 : 0)
      .help("New Workspace in Group")
      .onTap(() => bulkClose() || newWorkspaceIn(groupId)),
  ])
    .paddingLeading(8)
    .paddingTrailing(10)
    .paddingVertical(5)
    .marginLeading(memo(() => e().depth * INDENT))
    .cornerRadius(8)
    .background(memo(() => (dropHere() ? DROP_HEADER_TINT : selected() ? "#7f7f7f3d" : null)))
    .hoverBackground(memo(() => (selected() ? "#7f7f7f3d" : "#7f7f7f1c")))
    .frame({ maxWidth: "infinity" })
    .onTap(() => bulkClose() || selectWorkspace(anchor()?.id))
    .onDoubleTap(() => bulkClose() || setEditingId(hid))
    .contextMenu(groupMenu(entry, e, g, withNode, toggle));
}

function groupMenu(entry, e, g, withNode, toggle) {
  const { groupId, nodeKey } = entry;
  const hid = "h:" + nodeKey;
  const targets = memoJSON(() => moveTargets(nodeByKey(nodeKey) ?? {}));
  const items = [
    Button("New Subgroup", withNode(newSubgroup)),
    Divider(),
    Button("Rename Group", () => setEditingId(hid)),
    Button(memo(() => (e().collapsed ? "Expand" : "Collapse")), toggle),
    Divider(),
    Menu("Move Group Into", [
      ForEach(
        { items: targets, key: (t) => t.key },
        (t) => Button(memo(() => t().label), withNode((node) => {
          const target = nodeByKey(t().key);
          if (target) repath(node, [...target.segs, ...leafSegs(node)]);
        })),
      ),
    ]),
    Button("Move to Top Level", withNode((node) => repath(node, leafSegs(node)))),
  ];
  // A virtual header has no cmux group to pin, ungroup, or delete.
  if (!groupId) return [...items, ...guideMenuItems()];
  return [
    Button("New Workspace in Group", () => newWorkspaceIn(groupId)),
    ...items,
    Divider(),
    Button(memo(() => (g().pinned ? "Unpin Group" : "Pin Group")), () =>
      cmux(g().pinned ? "workspace.group.unpin" : "workspace.group.pin", { group_id: groupId })),
    Button("Ungroup", withNode((node) => dissolve(node, "workspace.group.ungroup"))),
    Button("Delete Group", withNode((node) => dissolve(node, "workspace.group.delete"))).destructive(),
    ...guideMenuItems(),
  ];
}

// Same as the built-in header's `+`: a new workspace in that group, placed
// by cmux (anchor cwd, configured placement). cmux creates it unselected and
// the command returns nothing, so the sidebar opens it once it shows up in
// the data. Opening it also keeps it visible under the Active filter.
let pendingNew = null; // { groupId, known: Set of workspace ids at the click }

function newWorkspaceIn(groupId) {
  if (!groupId) return;
  pendingNew = { groupId, known: new Set(wsList().map((w) => w.id)) };
  cmux("workspace.group.new_workspace", { group_id: groupId });
}

computed(() => {
  const ws = wsList();
  if (!pendingNew) return;
  const { groupId, known } = pendingNew;
  const created = ws.find((w) => w.group === groupId && !known.has(w.id));
  if (!created) return;
  pendingNew = null;
  // Plain focus, not selectWorkspace: cmux expands a collapsed group to show
  // the new workspace, and that expand should stick.
  focusWorkspace(created.id);
});

// Identical geometry to groupHeader (chevron box, paddings, semibold 12)
// so entering/leaving rename changes nothing but the text becoming editable.
function groupEditRow(entry, e) {
  const { nodeKey } = entry;
  return HStack({ spacing: 6 }, [
    Image("chevron.right")
      .font(10).weight("semibold").color("tertiary")
      .rotation(memo(() => (e().collapsed ? 0 : 90)))
      .frame({ width: 14, height: 16 }),
    TextField(memo(() => e().leaf), {
      placeholder: "Group name",
      onSubmit: (t) => {
        // The field edits the leaf; "/" in it nests further.
        const node = nodeByKey(nodeKey);
        const leaf = splitPath(t);
        if (node && leaf.length) repath(node, [...node.segs.slice(0, -1), ...leaf]);
        setEditingId(null);
      },
      onCancel: () => setEditingId(null),
    }).font(12).weight("semibold"),
  ])
    .paddingLeading(8)
    .paddingTrailing(10)
    .paddingVertical(5)
    .marginLeading(memo(() => e().depth * INDENT))
    .cornerRadius(8)
    .background("#7f7f7f3d")
    .frame({ maxWidth: "infinity" })
    .fixed();
}

// The row template. The entry comes from entryByKey: kind, ids,
// and editing are stable per key, and reading `e()` here would subscribe the
// whole list to this row.
function entryRow(e, key) {
  const entry = entryByKey.get(key);
  if (entry.kind === "header") return entry.editing ? groupEditRow(entry, e) : groupHeader(entry, e);
  // A group's end: empty, so nothing grabs it; its margin is the level a
  // row dropped there takes (the host reads nesting from marginLeading).
  if (entry.kind === "end") return Spacer().frame({ height: GROUP_END_HEIGHT }).marginLeading(memo(() => e().depth * INDENT));
  const w = wsSig(entry.wsId);
  return entry.editing ? workspaceEditRow(w, e) : workspaceRow(w, e);
}

// --- root ------------------------------------------------------------------------
sidebar(() =>
  VStack({ spacing: 4 }, [
    filterBar(),
    ForEach({ items: memo(() => (guideOpen() ? ["guide"] : [])), key: (k) => k }, guideCard),
    Reorderable(
      {
        // Empty while the guide is open: it takes the list's place.
        items: memo(() => (guideOpen() ? [] : flatEntries())),
        key: (e) => e.id,
        spacing: 2,
        onMove: handleMove,
        onDragChange: handleDragChange,
      },
      entryRow,
    ).opacity(memo(() => (bulkClose() ? 0.5 : 1))),
    // The empty-filter message.
    VStack({ spacing: 2 }, [
      ForEach(
        { items: memo(() => (emptyMessage() && !guideOpen() ? [emptyMessage()] : [])), key: (m) => m },
        (m) => Text(memo(() => m())).font(12).color("tertiary").paddingHorizontal(10).paddingVertical(6),
      ),
    ]),
  ]),
  { surface: "glass" },
);
