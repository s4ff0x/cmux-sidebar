// cmux-sidebar: nested workspace groups, working/finished agent dots, collapse
// that keeps active work visible, and per-workspace border colors.
//
// Forked from manaflow-ai/cmux Examples/CustomSidebars/workspaces.js. The
// whole sidebar is ONE flat drag surface: group headers and workspace rows
// live in a single Reorderable. Headers are `fixed` (not grabbable, but they
// shift to open gaps like any row), so a workspace can be dragged between
// groups, into a group, or out to the ungrouped area in one gesture. The drop
// resolves to (container group, reorder anchor) from the flat index and
// dispatches workspace.group.add/remove + workspace.reorder.
//
// Group collapse is optimistic (a local signal flips instantly) and syncs via
// workspace.group.collapse/expand so the built-in sidebar agrees.
//
// Install: ./install.sh (symlinks into ~/.config/cmux/sidebars/).

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
const groupsList = memoJSON(() => data.groups() ?? []);
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

const isWorking = (w) =>
  !!w && (w.agents || []).some((a) => a.status === "working" || (a.children || []).some((c) => c.running));

// Fixed-width leading dot slot; rows without activity keep the empty slot so
// titles stay aligned. `state` is a change-only signal.
function activityDot(state) {
  return ZStack({}, [
    Circle({ size: 8 }).fill(WORKING_ORANGE).opacity(memo(() => (state() === "working" ? 1 : 0))),
    Circle({ size: 8 }).fill(FINISHED_GREEN).opacity(memo(() => (state() === "finished" ? 1 : 0))),
  ]).frame({ width: 14, height: 14 });
}

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

function selectWorkspace(id) {
  if (!id) return;
  selectOverride = id;
  setSelectTick(selectTick() + 1);
  cmux("workspace.select", { workspace_id: id });
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

// Finished-and-unseen tracking. cmux exposes no "last opened" time, so the
// sidebar watches each workspace go from working to not working itself. The
// set lives in memory: it starts empty whenever the sidebar mounts (sessions
// that finished before then show no dot).
const finished = new Set();
let wasWorking = new Set();
const finishedVersion = computed(() => {
  const ws = wsList();
  const working = new Set();
  const present = new Set();
  for (const w of ws) {
    present.add(w.id);
    if (isWorking(w)) {
      working.add(w.id);
      finished.delete(w.id);
    } else if (wasWorking.has(w.id) && !isSelected(w)) {
      finished.add(w.id);
    }
    if (isSelected(w)) finished.delete(w.id); // opened: seen
  }
  for (const id of finished) if (!present.has(id)) finished.delete(id);
  wasWorking = working;
  return Array.from(finished).sort().join(",");
});

// "working" | "finished" | null
function activity(w) {
  if (!w) return null;
  if (isWorking(w)) return "working";
  return finishedVersion() && finished.has(w.id) ? "finished" : null;
}
const isActive = (w) => activity(w) !== null;

const closedOverride = new Set();
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
  let ws = wsList();
  const present = new Set(ws.map((w) => w.id));
  for (const id of closedOverride) if (!present.has(id)) closedOverride.delete(id); // caught up
  if (closedOverride.size) ws = ws.filter((w) => !closedOverride.has(w.id));
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
  closedOverride.add(id);
  setCloseTick(closeTick() + 1);
  cmux("workspace.close", { workspace_id: id });
}

// Multi-select: Cmd-click toggles, Shift-click extends from the last click
// over the visible row order, plain click clears. The selection drives the
// context menu's bulk actions (group together, move, close).
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

// The rows currently on screen, in order: the filtered list or the tree.
function visibleRowIds() {
  const entries = filtering() ? filteredEntries() : flatEntries();
  return entries.filter((e) => e.kind === "ws").map((e) => e.wsId);
}

function handleRowClick(w, payload) {
  const id = w.id;
  if (payload && payload.cmd) {
    if (multiSelected.has(id)) multiSelected.delete(id);
    else multiSelected.add(id);
    setMultiTick(multiTick() + 1);
  } else if (payload && payload.shift && lastClickedId) {
    const order = visibleRowIds();
    const a = order.indexOf(lastClickedId);
    const b = order.indexOf(id);
    if (a >= 0 && b >= 0) {
      for (const rid of order.slice(Math.min(a, b), Math.max(a, b) + 1)) multiSelected.add(rid);
      setMultiTick(multiTick() + 1);
    }
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

// Border Color sets the native cmux workspace color (shown by the built-in
// sidebar); this sidebar does not draw it.
function setBorderColor(id, color) {
  if (color) cmux("workspace.action", { action: "set_color", workspace_id: id, color });
  else cmux("workspace.action", { action: "clear_color", workspace_id: id });
}

const BORDER_COLORS = [
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
  for (const g of groupsList()) {
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
  if (name && name !== g.name) cmux("workspace.group.rename", { group_id: g.id, name });
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

// List entries by key. A row template reads its entry here instead of from
// its item signal: reading the signal while the list mounts the row would
// subscribe the whole list to that row's changes.
const entryByKey = new Map();

function keyed(entries) {
  for (const e of entries) entryByKey.set(e.id, e);
  return entries;
}

function wsEntry(id, editing, depth, container, block, crumb, collapsedUnder = null) {
  return {
    kind: "ws",
    id: id + (editing === id ? ":edit" : ""),
    wsId: id,
    editing: editing === id,
    container,
    depth,
    block,
    crumb,
    collapsedUnder,
  };
}

// One flat entry list (headers + rows) for the single Reorderable. Pinned
// top-level groups and pinned ungrouped workspaces float to the top. Every
// entry of a top-level tree shares one drag `block`, so a header drag moves
// the whole tree (the host keeps blocks at the top level).
const flatEntries = memoJSON(() => {
  const t = groupTree();
  claimPendingSubgroup();
  const editing = editingId();
  const emit = (node, out, block) => {
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
      block,
      collapsed,
      container: realContainer(node),
      outer: realContainer(node.parent),
      refId: node.refId,
    });
    if (collapsed) {
      // Collapsed: only working and finished-unseen descendants stay,
      // flattened under the header.
      for (const w of descendantsOf(node)) {
        if (isActiveId(w.id)) {
          out.push(wsEntry(w.id, editing, node.depth + 1, w.group, block, breadcrumb(w, node), node.key));
        }
      }
      return;
    }
    for (const item of node.items) {
      if (item.ws) out.push(wsEntry(item.ws.id, editing, node.depth + 1, node.group.id, block, ""));
      else emit(item.node, out, block);
    }
  };

  const pinned = [];
  const rest = [];
  for (const item of t.root.items) {
    if (item.ws) {
      (item.ws.pinned ? pinned : rest).push(wsEntry(item.ws.id, editing, 0, null, null, ""));
    } else {
      emit(item.node, item.node.group && item.node.group.pinned ? pinned : rest, "h:" + item.node.key);
    }
  }
  return keyed([...pinned, ...rest]);
});

// --- filters -------------------------------------------------------------------
// Two toggles at the top: Active (orange or green dot) and Favorites (pinned).
// While either is on, the tree gives way to one flat list, in tab order, of
// the workspaces matching ANY enabled filter, each with its group path as a
// dim breadcrumb. Filter state is local and resets when the sidebar mounts.
const [filterActive, setFilterActive] = signal(false);
const [filterFavorites, setFilterFavorites] = signal(false);
const filtering = () => filterActive() || filterFavorites();

const filteredEntries = memoJSON(() => {
  if (!filtering()) return [];
  const t = groupTree();
  const editing = editingId();
  const out = [];
  for (const w of structure()) {
    if ((filterActive() && isActiveId(w.id)) || (filterFavorites() && w.pinned)) {
      out.push(wsEntry(w.id, editing, 0, w.group, null, breadcrumb(w, t.root)));
    }
  }
  return keyed(out);
});

const activeCount = memo(() => structure().filter((w) => isActiveId(w.id)).length);
const favoriteCount = memo(() => structure().filter((w) => w.pinned).length);

// The empty filtered list says which filters came up empty.
const emptyMessage = memo(() => {
  if (!filtering() || filteredEntries().length > 0) return null;
  if (filterActive() && filterFavorites()) return "No active or favorite workspaces";
  return filterActive() ? "No active workspaces" : "No favorite workspaces";
});

function filterChip(label, isOn, toggle, icon) {
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
    .onTap(toggle);
}

function filterBar() {
  return HStack({ spacing: 6 }, [
    filterChip(
      memo(() => "Active · " + activeCount()),
      filterActive,
      () => setFilterActive(!filterActive()),
      Circle({ size: 7 }).fill(WORKING_ORANGE),
    ),
    filterChip(
      memo(() => "Favorites · " + favoriteCount()),
      filterFavorites,
      () => setFilterFavorites(!filterFavorites()),
      Image("bookmark.fill").font(9).color(FAVORITE_RED),
    ),
    Spacer(),
  ])
    .paddingLeading(4)
    .paddingBottom(2);
}

// --- drop resolution ---------------------------------------------------------
// `index` is the dragged row's slot in the flat list (headers included).
// `extra.side` resolves the ambiguous boundary slots: "above" nests with the
// row above (e.g. last item of a group), "below" with the row below (right
// after the group, outside it) - chosen by the pointer's X position mid-drag.
// Dragging a group HEADER moves its whole top-level tree (extra.block).
function handleMove(id, index, extra) {
  const ws = wsList();

  if (extra && extra.block && id.startsWith("h:")) {
    // Whole-tree move. workspace.group.move is NOT usable here: its
    // to_index is a group-slot index (position among groups, clamped to the
    // pin tier), so a tabs index overshoots to "last group" and a drop
    // between ungrouped rows is unreachable. Instead send the full tabs
    // order with the tree extracted and re-inserted contiguously (top anchor
    // first, then display order) at the drop slot - the app's contiguity
    // normalization keeps it.
    const block = flatEntries().find((e) => e.id === id)?.block;
    const top = block && nodeByKey(block.slice(2));
    if (!top) return;
    // One contiguous run per real group (anchor, members, then each subgroup):
    // display order would interleave groups, and the host re-normalizes a
    // split run, leaving the optimistic order unable to match its echo.
    const run = (n) => [n.anchor, ...n.members, ...n.items.filter((i) => i.node).flatMap((i) => run(i.node))];
    const blockIds = run(top).filter(Boolean).map((w) => w.id);
    const moving = new Set(blockIds);
    const entries = flatEntries().filter((e) => e.block !== block);
    // `index` is the GRABBED header's slot; a subgroup header sits `offset`
    // rows into its block. The next entry that stays put anchors the drop. A
    // header counts too: dropping right above a (possibly collapsed) group
    // means "before its first tab", not "after its hidden members".
    const offset = flatEntries().filter((e) => e.block === block).findIndex((e) => e.id === id);
    const nextEntry = entries[index - Math.max(offset, 0)];
    const nextId = nextEntry ? (nextEntry.kind === "header" ? nextEntry.refId : nextEntry.wsId) : null;
    const rest = ws.map((x) => x.id).filter((x) => !moving.has(x));
    let insertAt = nextId ? rest.indexOf(nextId) : rest.length;
    if (insertAt < 0) insertAt = rest.length;
    const full = [...rest.slice(0, insertAt), ...blockIds, ...rest.slice(insertAt)];
    setOrderOverride(full); // paint the new order now; reorder_many echoes behind it
    cmux("workspace.reorder_many", { workspace_ids: JSON.stringify(full) });
    return;
  }

  const dragged = ws.find((w) => w.id === id);
  if (!dragged) return;

  // Dragging a row that is part of the multi-selection moves the WHOLE
  // selection: the visible selected rows gather contiguously at the drop
  // slot (visual order preserved) and all take the slot's container. This is
  // the platform-standard resolution for non-contiguous selections and for
  // selections mixing in-group and ungrouped rows. Hidden rows (inside a
  // collapsed group) never move - what you see is what you drag.
  multiTick();
  const bulk = multiSelected.has(id) && multiSelected.size > 1;
  const movingIds = bulk
    ? visibleRowIds().filter((rid) => multiSelected.has(rid) || rid === id)
    : [id];
  const moving = new Set(movingIds);

  const entries = flatEntries().filter((e) => e.id !== id);
  // Neighbors that will NOT move: rows moving with the drag can't define the
  // drop's container or anchor.
  let prev = null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e.kind === "ws" && moving.has(e.wsId ?? e.id)) continue;
    prev = e;
    break;
  }
  const stays = (e) => !(e.kind === "ws" && moving.has(e.wsId ?? e.id));
  // The drop's tabs-order anchor is the next entry that stays put. A header
  // resolves to its group's first tab: dropping above a group means "before
  // the whole block", never "between its anchor and members" (which would
  // break contiguity and get normalized somewhere else).
  const nextEntry = entries.slice(index).find((e) => {
    if (e.kind === "header") return !moving.has(e.refId);
    return e.kind === "ws" && stays(e);
  });
  const nextAny = entries.slice(index).find(stays) ?? null;
  const nextRefId = nextEntry ? (nextEntry.kind === "header" ? nextEntry.refId : nextEntry.wsId) : null;
  const nextWorkspace = nextRefId ? ws.find((w) => w.id === nextRefId) : null;

  // The container is the deepest real group the slot sits in.
  let container;
  // A slot inside a collapsed group's flattened list (right under its header,
  // or next to one of its listed rows): its rows come from many subgroups, so
  // the neighbor says nothing about membership. Rows from that subtree keep
  // their group; anything else lands beside the collapsed group.
  let collapsedScope = null;
  if (extra && extra.side === "below") {
    // Nest with what's below: a header below means "beside that group", i.e.
    // in its parent; a row below means that row's group.
    if (!nextAny) container = null;
    else container = nextAny.kind === "ws" ? nextAny.container : nextAny.outer;
    if (nextAny && nextAny.collapsedUnder) collapsedScope = nodeByKey(nextAny.collapsedUnder);
  } else {
    container = prev ? prev.container : null;
    if (prev && prev.kind === "header" && prev.collapsed) collapsedScope = nodeByKey(prev.nodeKey);
    if (prev && prev.collapsedUnder) collapsedScope = nodeByKey(prev.collapsedUnder);
  }
  if (collapsedScope) container = realContainer(collapsedScope.parent);

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
    Menu("Border Color", [
      ...BORDER_COLORS.map(([label, hex]) => Button(label, () => setBorderColor(w().id, hex))),
      Divider(),
      Button("None", () => setBorderColor(w().id, null)),
    ]),
    Divider(),
    Button("Close Others", act("close_others")).destructive(),
    Button(memo(() => (count() > 1 ? "Close " + count() + " Workspaces" : "Close")), () => {
      for (const id of bulkIds(w())) closeWorkspace(id);
      clearMultiSelect();
    }).destructive(),
  ];
}

function workspaceRow(w, e) {
  const selected = memo(() => isSelected(w()));
  const multi = memo(() => isMultiSelected(w()));
  const unread = memo(() => w()?.unread ?? 0);
  const pinned = memo(() => !!w()?.pinned);
  const crumb = memo(() => e().crumb);
  // The title owns the FULL row width; badge and close button FLOAT over its
  // trailing edge (ZStack trailing) instead of reserving layout. No fades
  // anywhere (they read as glitches when they appear); overflow truncates
  // with a plain ellipsis.
  return ZStack({ alignment: "trailing" }, [
    HStack({ spacing: 0 }, [
      // The gap lives on this unframed wrapper: the host applies padding
      // INSIDE a node's own frame, so padding the framed dot would squeeze it.
      HStack({ spacing: 0 }, [activityDot(memo(() => activity(w())))]).paddingTrailing(4),
      // Red bookmark on favorites. It takes width only when shown, inside
      // this zero-spacing stack, so other rows' titles stay aligned.
      Image("bookmark.fill")
        .font(10).color(FAVORITE_RED)
        .opacity(memo(() => (pinned() ? 1 : 0)))
        .frame({ width: memo(() => (pinned() ? 9 : 0)) })
        .paddingTrailing(memo(() => (pinned() ? 5 : 0))),
      // Dim "B › C ›" path for a row shown away from its group.
      Text(crumb)
        .font(13).color("tertiary").lineLimit(1)
        .paddingTrailing(memo(() => (crumb() ? 4 : 0))),
      Text(memo(() => displayTitle(w())))
        .font(13)
        .lineLimit(1)
        .truncation("tail")
        .color(memo(() => (selected() ? "primary" : "secondary"))),
      Spacer({ minLength: 0 }),
    ])
      .frame({ maxWidth: "infinity" }),
    ZStack({}, [
      // Unread badge at rest; on hover it yields to the close button.
      Text(memo(() => (unread() > 0 ? String(unread()) : "")))
        .font("caption2").bold().color("white")
        .paddingHorizontal(memo(() => (unread() > 0 ? 5 : 0)))
        .paddingVertical(memo(() => (unread() > 0 ? 1 : 0)))
        .background(memo(() => (unread() > 0 ? "#E4573D" : null)))
        .cornerRadius(7)
        .hideOnHover(),
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
    .paddingLeading(2)
    .paddingTrailing(10)
    .paddingVertical(6)
    .marginLeading(memo(() => e().depth * INDENT))
    .cornerRadius(8)
    .background(memo(() => (multi() ? "#4C9EEB33" : (selected() ? "#7f7f7f3d" : null))))
    .hoverBackground(memo(() => (multi() ? "#4C9EEB33" : (selected() ? "#7f7f7f3d" : "#7f7f7f24"))))
    .frame({ maxWidth: "infinity" })
    .block(memo(() => e().block))
    .dragSet(memo(() => (multi() ? "multi" : null)))
    .onTap((payload) => handleRowClick(w(), payload))
    .onDoubleTap(() => setEditingId(w().id))
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
  const state = memo(() => activity(anchor()));
  // Menu actions resolve the node at click time (the tree rebuilds per tick).
  const withNode = (fn) => () => {
    const node = nodeByKey(nodeKey);
    if (node) fn(node);
  };
  const toggle = withNode(toggleNode);
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
    // The anchor's own glyph overlays a leading inset that only opens while
    // it runs. The host auto-boosts only a bare truncating Text over sibling
    // Spacers, so the wrapper needs the boost explicitly.
    ZStack({ alignment: "leading" }, [
      Text(memo(() => e().leaf)).font(12).weight("semibold").lineLimit(1).truncation("tail")
        .color(memo(() => (selected() ? "primary" : "secondary")))
        .paddingLeading(memo(() => (state() ? 18 : 0))),
      activityDot(state),
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
      .onTap(() => newWorkspaceIn(groupId)),
  ])
    .paddingLeading(8)
    .paddingTrailing(10)
    .paddingVertical(5)
    .marginLeading(memo(() => e().depth * INDENT))
    .cornerRadius(8)
    .background(memo(() => (selected() ? "#7f7f7f3d" : null)))
    .hoverBackground(memo(() => (selected() ? "#7f7f7f3d" : "#7f7f7f1c")))
    .frame({ maxWidth: "infinity" })
    .fixed()
    .block(memo(() => e().block))
    .onTap(() => selectWorkspace(anchor()?.id))
    .onDoubleTap(() => setEditingId(hid))
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
  if (!groupId) return items;
  return [
    Button("New Workspace in Group", () => newWorkspaceIn(groupId)),
    ...items,
    Divider(),
    Button(memo(() => (g().pinned ? "Unpin Group" : "Pin Group")), () =>
      cmux(g().pinned ? "workspace.group.unpin" : "workspace.group.pin", { group_id: groupId })),
    Button("Ungroup", withNode((node) => dissolve(node, "workspace.group.ungroup"))),
    Button("Delete Group", withNode((node) => dissolve(node, "workspace.group.delete"))).destructive(),
  ];
}

// Same as the built-in header's `+`: a new workspace in that group, placed
// by cmux (anchor cwd, configured placement).
function newWorkspaceIn(groupId) {
  if (groupId) cmux("workspace.group.new_workspace", { group_id: groupId });
}

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

// One template for both lists. The entry comes from entryByKey: kind, ids,
// and editing are stable per key, and reading `e()` here would subscribe the
// whole list to this row.
function entryRow(e, key) {
  const entry = entryByKey.get(key);
  if (entry.kind === "header") return entry.editing ? groupEditRow(entry, e) : groupHeader(entry, e);
  const w = wsSig(entry.wsId);
  return entry.editing ? workspaceEditRow(w, e) : workspaceRow(w, e);
}

// --- root ------------------------------------------------------------------------
sidebar(() =>
  VStack({ spacing: 4 }, [
    filterBar(),
    // The full tree; empty (no rows mounted) while a filter is on.
    Reorderable(
      {
        items: () => (filtering() ? [] : flatEntries()),
        key: (e) => e.id,
        spacing: 2,
        onMove: handleMove,
      },
      entryRow,
    ),
    // The filtered flat list; mounts rows only while a filter is on.
    VStack({ spacing: 2 }, [
      ForEach({ items: filteredEntries, key: (e) => e.id }, entryRow),
      ForEach(
        { items: memo(() => (emptyMessage() ? [emptyMessage()] : [])), key: (m) => m },
        (m) => Text(memo(() => m())).font(12).color("tertiary").paddingHorizontal(10).paddingVertical(6),
      ),
    ]),
  ]),
  { surface: "glass" },
);
