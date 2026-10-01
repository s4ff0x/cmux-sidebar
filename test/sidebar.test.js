import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agent, group, mountSidebar, workspaces } from "./harness.js";

describe("workspace list", () => {
  test("ungrouped workspaces render in tab order", () => {
    const sb = mountSidebar({
      workspaces: workspaces({ id: "w1", title: "alpha" }, { id: "w2", title: "beta" }),
    });
    assert.deepEqual(sb.outline(), ["alpha", "beta"]);
  });
});

describe("activity indicator", () => {
  const one = (agents, extra = {}) => ({ workspaces: workspaces({ id: "w1", title: "job", agents, ...extra }) });

  test("only a working agent or a running subagent shows the orange dot", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "w1", title: "working", agents: [agent("working")] },
        { id: "w2", title: "asking", agents: [agent("needs_input")] },
        { id: "w3", title: "subagent", agents: [agent("idle", { children: [{ id: "c", running: true, startedEpoch: 0 }] })] },
        { id: "w4", title: "idle", agents: [agent("idle"), agent("ended")] },
        { id: "w5", title: "plain" },
      ),
    });
    assert.deepEqual(
      ["working", "asking", "subagent", "idle", "plain"].map((t) => sb.row(t).indicator()),
      ["working", null, "working", null, null],
    );
  });

  test("sessions already finished when the sidebar loads show no dot", () => {
    const sb = mountSidebar(one([agent("idle")]));
    assert.equal(sb.row("job").indicator(), null);
  });

  for (const end of ["idle", "needs_input", "ended"]) {
    test(`a turn that ends (${end}) while you are elsewhere turns the dot green`, () => {
      const sb = mountSidebar(one([agent("working")]));
      assert.equal(sb.row("job").indicator(), "working");
      sb.setData(one([agent(end)]));
      assert.equal(sb.row("job").indicator(), "finished");
    });
  }

  test("a turn that ends while the workspace is open never turns green", () => {
    const sb = mountSidebar(one([agent("working")], { selected: true }));
    sb.setData(one([agent("idle")], { selected: true }));
    assert.equal(sb.row("job").indicator(), null);
  });

  test("opening a green workspace clears it at once", () => {
    const sb = mountSidebar(one([agent("working")]));
    sb.setData(one([agent("idle")]));
    sb.row("job").tap();
    assert.equal(sb.row("job").indicator(), null);
    assert.deepEqual(sb.take(), [{ method: "workspace.select", params: { workspace_id: "w1" } }]);
  });

  test("green also clears when the workspace is opened elsewhere, and stays cleared after", () => {
    const sb = mountSidebar(one([agent("working")]));
    sb.setData(one([agent("idle")]));
    sb.setData(one([agent("idle")], { selected: true }));
    sb.setData(one([agent("idle")]));
    assert.equal(sb.row("job").indicator(), null);
  });

  test("a new turn turns green back to orange", () => {
    const sb = mountSidebar(one([agent("working")]));
    sb.setData(one([agent("idle")]));
    sb.setData(one([agent("working")]));
    assert.equal(sb.row("job").indicator(), "working");
  });
});

// A 3-level tree: A, A/B, A/B/C, each with an anchor (the header) and one
// member, plus an ungrouped workspace at the end.
function tree3(over = {}) {
  const ws = workspaces(
    { id: "a", title: "A", group: "gA" },
    { id: "a1", title: "a-one", group: "gA" },
    { id: "b", title: "A/B", group: "gB" },
    { id: "b1", title: "b-one", group: "gB" },
    { id: "c", title: "A/B/C", group: "gC" },
    { id: "c1", title: "c-one", group: "gC" },
    { id: "x", title: "loose" },
  ).map((w) => ({ ...w, ...(over[w.id] ?? {}) }));
  const groups = [
    group("gA", "A", "a", over.gA),
    group("gB", "A/B", "b", over.gB),
    group("gC", "A/B/C", "c", over.gC),
  ];
  return { workspaces: ws, groups };
}

describe("nested groups", () => {
  test("a name path renders as an indented tree of leaf names", () => {
    const sb = mountSidebar(tree3());
    assert.deepEqual(sb.outline(), [
      "A",
      "  a-one",
      "  B",
      "    b-one",
      "    C",
      "      c-one",
      "loose",
    ]);
  });

  test("a missing parent path renders as a virtual header", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "b", title: "Work/Backend", group: "gB" },
        { id: "b1", title: "api", group: "gB" },
      ),
      groups: [group("gB", "Work/Backend", "b")],
    });
    assert.deepEqual(sb.outline(), ["Work", "  Backend", "    api"]);
  });

  test("collapsing a virtual header is local: it hides the subtree without a cmux call", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "b", title: "Work/Backend", group: "gB" },
        { id: "b1", title: "api", group: "gB" },
      ),
      groups: [group("gB", "Work/Backend", "b")],
    });
    sb.row("Work").tapImage("chevron.right");
    assert.deepEqual(sb.outline(), ["Work"]);
    assert.deepEqual(sb.take(), []);
  });

  test("each subgroup collapses on its own and persists through cmux", () => {
    const sb = mountSidebar(tree3());
    sb.row("B").tapImage("chevron.right");
    assert.deepEqual(sb.outline(), ["A", "  a-one", "  B", "loose"]);
    assert.deepEqual(sb.take(), [{ method: "workspace.group.collapse", params: { group_id: "gB" } }]);
    sb.row("B").tapImage("chevron.right");
    assert.deepEqual(sb.take(), [{ method: "workspace.group.expand", params: { group_id: "gB" } }]);
    assert.equal(sb.outline().length, 7);
  });
});

describe("group header activity", () => {
  const busy = () => tree3({
    a: { agents: [agent("working")] },
    b: { agents: [agent("needs_input")] },
    b1: { agents: [agent("working")] },
    c1: { agents: [agent("working")] },
  });

  test("a header shows its own anchor's dot", () => {
    const sb = mountSidebar(busy());
    assert.deepEqual(["A", "B", "C"].map((h) => sb.row(h).indicator()), ["working", null, null]);
  });

  test("headers show no activity counts, expanded or collapsed", () => {
    const sb = mountSidebar(busy());
    const before = sb.row("A").text;
    sb.row("A").tapImage("chevron.right");
    assert.deepEqual([before, sb.row("A").text], ["A", "A"]);
  });

  test("tapping a header whose anchor workspace is gone selects nothing and keeps the highlight", () => {
    const sb = mountSidebar({
      workspaces: workspaces({ id: "m1", title: "member", group: "g", selected: true }),
      groups: [group("g", "G", "gone")],
    });
    sb.row("G").tap();
    assert.deepEqual(sb.take(), []);
    assert.equal(sb.row("member").highlighted, true);
  });
});

describe("collapse keeps active work visible", () => {
  const sim = (over) => mountSidebar(tree3(over));

  test("a collapsed group shows only working descendants, with a breadcrumb from subgroups", () => {
    const sb = sim({ gA: { collapsed: true }, c1: { agents: [agent("working")] }, a1: { agents: [agent("working")] }, b1: { agents: [agent("needs_input")] } });
    assert.deepEqual(sb.outline(), ["A", "  a-one", "  B › C › c-one", "loose"]);
  });

  test("a working subgroup anchor surfaces as a row when its header is hidden", () => {
    const sb = sim({ gA: { collapsed: true }, b: { agents: [agent("working")] } });
    assert.deepEqual(sb.outline(), ["A", "  B › A/B", "loose"]);
  });

  test("a collapsed subgroup inside an expanded group flattens only its own subtree", () => {
    const sb = sim({ gB: { collapsed: true }, c1: { agents: [agent("working")] } });
    assert.deepEqual(sb.outline(), ["A", "  a-one", "  B", "    C › c-one", "loose"]);
  });

  test("a finished row stays under its collapsed header until it is opened", () => {
    const sb = sim({ gA: { collapsed: true } });
    assert.deepEqual(sb.outline(), ["A", "loose"]);
    sb.setData(tree3({ gA: { collapsed: true }, c1: { agents: [agent("working")] } }));
    assert.deepEqual(sb.outline(), ["A", "  B › C › c-one", "loose"]);
    sb.setData(tree3({ gA: { collapsed: true }, c1: { agents: [agent("ended")] } }));
    assert.equal(sb.row("c-one").indicator(), "finished");
    sb.row("c-one").tap();
    assert.deepEqual(sb.outline(), ["A", "loose"]);
  });

  test("opening a row listed under a collapsed group keeps the group collapsed", () => {
    const state = (gA = {}, a1 = {}) =>
      tree3({ gA: { collapsed: true, ...gA }, a1: { agents: [agent("working")], ...a1 } });
    const sb = mountSidebar(state());
    sb.row("a-one").tap();
    // cmux expands the selected workspace's group on select; re-collapse it.
    assert.deepEqual(sb.take(), [
      { method: "workspace.select", params: { workspace_id: "a1" } },
      { method: "workspace.group.collapse", params: { group_id: "gA" } },
    ]);
    const collapsedView = ["A", "  a-one", "loose"];
    sb.setData(state()); // a tick from before the select landed
    assert.deepEqual(sb.outline(), collapsedView);
    sb.setData(state({ collapsed: false }, { selected: true })); // the select echo with cmux's auto-expand
    assert.deepEqual(sb.outline(), collapsedView);
    sb.setData(state({}, { selected: true })); // our collapse lands
    assert.deepEqual(sb.outline(), collapsedView);
  });

  test("opening a row in an expanded group sends only the select", () => {
    const sb = mountSidebar(tree3());
    sb.row("a-one").tap();
    assert.deepEqual(sb.take(), [{ method: "workspace.select", params: { workspace_id: "a1" } }]);
  });
});

describe("group menu", () => {
  const renames = (actions) =>
    actions.filter((a) => a.method === "workspace.group.rename").map((a) => [a.params.group_id, a.params.name]);
  // tree3 plus a second top-level group Z.
  const withZ = () => {
    const t = tree3();
    const ws = workspaces(...t.workspaces, { id: "z", title: "Z", group: "gZ" });
    return { workspaces: ws, groups: [...t.groups, group("gZ", "Z", "z")] };
  };

  test("renaming a group edits its leaf and carries every descendant along", () => {
    const sb = mountSidebar(tree3());
    sb.row("A").doubleTap();
    assert.equal(sb.row("A").editing, "A");
    sb.row("A").submit("X");
    assert.deepEqual(renames(sb.take()), [["gA", "X"], ["gB", "X/B"], ["gC", "X/B/C"]]);
  });

  test("renaming a subgroup keeps its parent path", () => {
    const sb = mountSidebar(tree3());
    sb.row("B").menu("Rename Group");
    sb.row("B").submit("Core");
    assert.deepEqual(renames(sb.take()), [["gB", "A/Core"], ["gC", "A/Core/C"]]);
  });

  test("renaming a virtual header renames the real groups beneath it", () => {
    const sb = mountSidebar({
      workspaces: workspaces({ id: "b", title: "Work/Backend", group: "gB" }),
      groups: [group("gB", "Work/Backend", "b")],
    });
    sb.row("Work").menu("Rename Group");
    sb.row("Work").submit("Job");
    assert.deepEqual(renames(sb.take()), [["gB", "Job/Backend"]]);
  });

  test("Move Group Into lists the tree minus the group's own subtree", () => {
    const sb = mountSidebar(withZ());
    assert.deepEqual(sb.row("B").menuLabels("Move Group Into"), ["A", "Z"]);
    assert.deepEqual(sb.row("C").menuLabels("Move Group Into"), ["A", "A › B", "Z"]);
  });

  test("Move Group Into re-parents the group with its descendants", () => {
    const sb = mountSidebar(withZ());
    sb.row("B").menu("Move Group Into", "Z");
    assert.deepEqual(renames(sb.take()), [["gB", "Z/B"], ["gC", "Z/B/C"]]);
  });

  test("Move to Top Level strips the parent path", () => {
    const sb = mountSidebar(tree3());
    sb.row("B").menu("Move to Top Level");
    assert.deepEqual(renames(sb.take()), [["gB", "B"], ["gC", "B/C"]]);
  });

  test("Ungroup dissolves the group and promotes its subgroups one level", () => {
    const sb = mountSidebar(tree3());
    sb.row("B").menu("Ungroup");
    const actions = sb.take();
    assert.deepEqual(actions[0], { method: "workspace.group.ungroup", params: { group_id: "gB" } });
    assert.deepEqual(renames(actions), [["gC", "A/C"]]);
  });

  test("Delete Group deletes through cmux and promotes its subgroups one level", () => {
    const sb = mountSidebar(tree3());
    sb.row("A").menu("Delete Group");
    const actions = sb.take();
    assert.deepEqual(actions[0], { method: "workspace.group.delete", params: { group_id: "gA" } });
    assert.deepEqual(renames(actions), [["gB", "B"], ["gC", "B/C"]]);
  });

  test("New Subgroup creates <path>/New Group and opens it for rename once it exists", () => {
    const sb = mountSidebar(tree3());
    sb.row("B").menu("New Subgroup");
    assert.deepEqual(sb.take(), [{ method: "workspace.group.create", params: { name: "A/B/New Group" } }]);
    const t = tree3();
    sb.setData({
      workspaces: workspaces(...t.workspaces, { id: "n", title: "A/B/New Group", group: "gN" }),
      groups: [...t.groups, group("gN", "A/B/New Group", "n")],
    });
    assert.ok(sb.outline().includes("    [New Group]"), sb.outline().join("\n"));
    sb.row("New Group").submit("Tests");
    assert.deepEqual(renames(sb.take()), [["gN", "A/B/Tests"]]);
  });
});

describe("workspaces inside groups", () => {
  test("the header + creates a workspace in that group at any depth", () => {
    const sb = mountSidebar(tree3());
    sb.row("C").tapImage("plus");
    sb.row("B").menu("New Workspace in Group");
    assert.deepEqual(sb.take(), [
      { method: "workspace.group.new_workspace", params: { group_id: "gC" } },
      { method: "workspace.group.new_workspace", params: { group_id: "gB" } },
    ]);
  });

  test("a virtual header offers no workspace creation", () => {
    const sb = mountSidebar({
      workspaces: workspaces({ id: "b", title: "Work/Backend", group: "gB" }),
      groups: [group("gB", "Work/Backend", "b")],
    });
    assert.ok(!sb.row("Work").menuLabels().includes("New Workspace in Group"));
    sb.row("Work").tapImage("plus");
    assert.deepEqual(sb.take(), []);
  });

  test("Move to Group lists every real group as a path and adds the workspace there", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "b", title: "Work/Backend", group: "gB" },
        { id: "x", title: "loose" },
      ),
      groups: [group("gB", "Work/Backend", "b")],
    });
    assert.deepEqual(sb.row("loose").menuLabels("Move to Group"), ["Work › Backend"]);
    sb.row("loose").menu("Move to Group", "Work › Backend");
    assert.deepEqual(sb.take(), [{ method: "workspace.group.add", params: { group_id: "gB", workspace_id: "x" } }]);
  });

  test("Move to Group follows groups created after the row mounted", () => {
    const sb = mountSidebar(tree3());
    const t = tree3();
    sb.setData({
      workspaces: workspaces(...t.workspaces, { id: "e", title: "A/Extra", group: "gX" }),
      groups: [...t.groups, group("gX", "A/Extra", "e")],
    });
    assert.deepEqual(sb.row("loose").menuLabels("Move to Group"), ["A", "A › B", "A › B › C", "A › Extra"]);
  });
});

describe("border color", () => {
  const two = () =>
    workspaces({ id: "w1", title: "red", color: "#FF453A" }, { id: "w2", title: "plain" });

  test("Border Color still sets and clears the native color", () => {
    const sb = mountSidebar({ workspaces: two() });
    sb.row("plain").menu("Border Color", "Blue");
    sb.row("red").menu("Border Color", "None");
    assert.deepEqual(sb.take(), [
      { method: "workspace.action", params: { action: "set_color", workspace_id: "w2", color: "#0A84FF" } },
      { method: "workspace.action", params: { action: "clear_color", workspace_id: "w1" } },
    ]);
  });
});

describe("drag and drop", () => {
  const adds = (actions) => actions.filter((a) => a.method.startsWith("workspace.group."));

  test("a row dropped right under a subgroup header joins that subgroup", () => {
    const sb = mountSidebar(tree3());
    // Without the dragged row: [A, a-one, B, b-one, C, c-one]; slot 3 sits under B.
    sb.drop("x", 3);
    assert.deepEqual(adds(sb.take()), [{ method: "workspace.group.add", params: { group_id: "gB", workspace_id: "x" } }]);
  });

  test("a row dropped under a virtual header joins the nearest real ancestor", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "a", title: "A", group: "gA" },
        { id: "w", title: "A/V/W", group: "gW" },
        { id: "w1", title: "deep", group: "gW" },
        { id: "x", title: "loose" },
      ),
      groups: [group("gA", "A", "a"), group("gW", "A/V/W", "w")],
    });
    assert.deepEqual(sb.outline(), ["A", "  V", "    W", "      deep", "loose"]);
    sb.drop("x", 2); // right under the virtual V header
    assert.deepEqual(adds(sb.take()), [{ method: "workspace.group.add", params: { group_id: "gA", workspace_id: "x" } }]);
  });

  test("a top-level group dropped under another group's header nests into it with its subtree", () => {
    const t = tree3();
    const sb = mountSidebar({
      workspaces: workspaces(
        ...t.workspaces,
        { id: "z", title: "Z", group: "gZ" },
        { id: "z1", title: "zed", group: "gZ" },
        { id: "y", title: "Z/Y", group: "gY" },
        { id: "y1", title: "y-one", group: "gY" },
      ),
      groups: [...t.groups, group("gZ", "Z", "z"), group("gY", "Z/Y", "y")],
    });
    // Without Z's header: [A, a-one, B, ...]; slot 1 sits right under A.
    sb.drop("h:g:gZ", 1);
    assert.deepEqual(sb.take(), [
      { method: "workspace.group.rename", params: { group_id: "gZ", name: "A/Z" } },
      { method: "workspace.group.rename", params: { group_id: "gY", name: "A/Z/Y" } },
      // Z's tabs land after A's own run, never splitting it.
      { method: "workspace.reorder_many", params: { workspace_ids: JSON.stringify(["a", "a1", "z", "z1", "y", "y1", "b", "b1", "c", "c1", "x"]) } },
    ]);
    // Painted at once, before the host echoes.
    assert.deepEqual(sb.outline(), [
      "A", "  a-one", "  Z", "    zed", "    Y", "      y-one", "  B", "    b-one", "    C", "      c-one", "loose",
    ]);
  });

  test("a subgroup dragged to the top leaves its parent and takes its subtree along", () => {
    const sb = mountSidebar(tree3());
    sb.drop("h:g:gB", 0);
    assert.deepEqual(sb.take(), [
      { method: "workspace.group.rename", params: { group_id: "gB", name: "B" } },
      { method: "workspace.group.rename", params: { group_id: "gC", name: "B/C" } },
      { method: "workspace.reorder_many", params: { workspace_ids: JSON.stringify(["b", "b1", "c", "c1", "a", "a1", "x"]) } },
    ]);
    assert.deepEqual(sb.outline(), ["B", "  b-one", "  C", "    c-one", "A", "  a-one", "loose"]);
  });

  test("at a group's end the pointer side decides between staying in and moving out", () => {
    // Without C's header: [A, a-one, B, b-one, c-one, loose]; slot 5 follows C's own row.
    const out = mountSidebar(tree3());
    out.drop("h:g:gC", 5, { side: "below" });
    assert.deepEqual(out.take(), [{ method: "workspace.group.rename", params: { group_id: "gC", name: "C" } }]);
    const stay = mountSidebar(tree3());
    stay.drop("h:g:gC", 5, { side: "above" });
    assert.deepEqual(stay.take(), []);
  });

  test("a group dropped inside its own subtree stays put", () => {
    const sb = mountSidebar(tree3());
    sb.drop("h:g:gA", 2); // right under B, A's own subgroup
    assert.deepEqual(sb.take(), []);
  });

  test("a group dragged above its own virtual parent lands there, not at the end of the tabs", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "x", title: "loose" },
        { id: "b", title: "Work/Backend", group: "gB" },
        { id: "b1", title: "api", group: "gB" },
        { id: "f", title: "Work/Frontend", group: "gF" },
        { id: "f1", title: "web", group: "gF" },
        { id: "y", title: "tail" },
      ),
      groups: [group("gB", "Work/Backend", "b"), group("gF", "Work/Frontend", "f")],
    });
    assert.deepEqual(sb.outline(), ["loose", "Work", "  Backend", "    api", "  Frontend", "    web", "tail"]);
    sb.drop("h:g:gB", 1); // between loose and Work
    // Backend's tabs already come first, so only the un-nesting rename is sent.
    assert.deepEqual(sb.take(), [{ method: "workspace.group.rename", params: { group_id: "gB", name: "Backend" } }]);
    assert.deepEqual(sb.outline(), ["loose", "Backend", "  api", "Work", "  Frontend", "    web", "tail"]);
  });

  test("dragging a group back before cmux echoes the first move still sends the second", () => {
    const state = {
      workspaces: workspaces(
        { id: "a", title: "A", group: "gA" },
        { id: "a1", title: "a-one", group: "gA" },
        { id: "x", title: "loose" },
        { id: "d", title: "D", group: "gD" },
        { id: "d1", title: "d-one", group: "gD" },
        { id: "y", title: "loose2" },
      ),
      groups: [group("gA", "A", "a"), group("gD", "D", "d")],
    };
    const sb = mountSidebar(state);
    const original = sb.outline();
    sb.drop("h:g:gD", 0); // to the top
    sb.take();
    sb.drop("h:g:gD", 4); // back between loose and loose2, before any echo
    assert.deepEqual(sb.take(), [
      { method: "workspace.reorder_many", params: { workspace_ids: JSON.stringify(["a", "a1", "x", "d", "d1", "y"]) } },
    ]);
    assert.deepEqual(sb.outline(), original);
  });

  test("releasing a header in its own slot changes nothing", () => {
    // A/Z's tabs come before A's anchor, so Z displays first under A.
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "z", title: "A/Z", group: "gZ" },
        { id: "z1", title: "zed", group: "gZ" },
        { id: "a", title: "A", group: "gA" },
        { id: "a1", title: "a-one", group: "gA" },
        { id: "x", title: "loose" },
      ),
      groups: [group("gZ", "A/Z", "z"), group("gA", "A", "a")],
    });
    sb.drop("h:g:gZ", 1);
    assert.deepEqual(sb.take(), []);
  });

  test("a group drag keeps every group's tabs contiguous", () => {
    // A/Z sits before A in the tabs, so it displays above A's own member.
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "z", title: "A/Z", group: "gZ" },
        { id: "z1", title: "zed", group: "gZ" },
        { id: "a", title: "A", group: "gA" },
        { id: "a1", title: "a-one", group: "gA" },
        { id: "x", title: "loose" },
      ),
      groups: [group("gZ", "A/Z", "z"), group("gA", "A", "a")],
    });
    assert.deepEqual(sb.outline(), ["A", "  Z", "    zed", "  a-one", "loose"]);
    sb.drop("h:g:gA", 4); // below loose
    assert.deepEqual(sb.take(), [{
      method: "workspace.reorder_many",
      params: { workspace_ids: JSON.stringify(["x", "a", "a1", "z", "z1"]) },
    }]);
  });

  test("rows listed under a collapsed group keep their group and tab position when reordered", () => {
    const state = tree3({ gA: { collapsed: true }, a1: { agents: [agent("working")] }, c1: { agents: [agent("working")] } });
    const sb = mountSidebar(state);
    assert.deepEqual(sb.outline(), ["A", "  a-one", "  B › C › c-one", "loose"]);
    sb.drop("c1", 1); // c-one above a-one
    sb.drop("a1", 2); // a-one below c-one
    sb.row("a-one").tap({ cmd: true });
    sb.row("c-one").tap({ cmd: true });
    sb.drop("a1", 2); // both, as a multi-selection
    // The list mixes groups, so its order maps to no tab order: nothing is sent.
    assert.deepEqual(sb.take(), []);
  });

  test("an outside row dropped into a collapsed group's list lands beside the group", () => {
    const sb = mountSidebar(tree3({ gA: { collapsed: true }, a1: { agents: [agent("working")] } }));
    sb.drop("x", 2); // under a-one, inside collapsed A's list
    assert.deepEqual(adds(sb.take()), []); // stays ungrouped instead of vanishing into A
  });
});

describe("group edits stay scoped", () => {
  const renames = (actions) =>
    actions.filter((a) => a.method === "workspace.group.rename").map((a) => [a.params.group_id, a.params.name]);

  test("renaming a duplicate-path group leaves the other group's subgroups alone", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "a", title: "A", group: "gA1" },
        { id: "b", title: "A/B", group: "gB" },
        { id: "a2", title: "A again", group: "gA2" },
      ),
      groups: [group("gA1", "A", "a"), group("gB", "A/B", "b"), group("gA2", "A", "a2")],
    });
    assert.deepEqual(sb.outline(), ["A", "  B", "A"]);
    sb.rows()[2].menu("Rename Group");
    sb.rows().find((r) => r.editing !== null).submit("Y");
    sb.rows()[2].menu("Ungroup");
    assert.deepEqual(renames(sb.take()), [["gA2", "Y"]]);
  });

  test("renaming onto a taken sibling path picks a free name instead of merging", () => {
    const t = tree3();
    const sb = mountSidebar({
      workspaces: workspaces(...t.workspaces, { id: "d", title: "A/D", group: "gD" }),
      groups: [...t.groups, group("gD", "A/D", "d")],
    });
    sb.row("B").menu("Rename Group");
    sb.row("B").submit("D");
    assert.deepEqual(renames(sb.take()), [["gB", "A/D 2"], ["gC", "A/D 2/C"]]);
  });

  test("New Subgroup avoids a taken name and expands a collapsed parent so the editor shows", () => {
    const t = tree3({ gB: { collapsed: true } });
    const sb = mountSidebar({
      workspaces: workspaces(...t.workspaces, { id: "n", title: "A/B/New Group", group: "gN" }),
      groups: [...t.groups, group("gN", "A/B/New Group", "n", { collapsed: true })],
    });
    sb.row("B").menu("New Subgroup");
    assert.deepEqual(sb.take(), [
      { method: "workspace.group.expand", params: { group_id: "gB" } },
      { method: "workspace.group.create", params: { name: "A/B/New Group 2" } },
    ]);
  });

  test("Ungroup promotes subgroups onto free paths instead of merging into a sibling", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "a", title: "A", group: "gA" },
        { id: "b", title: "A/B", group: "gB" },
        { id: "c", title: "A/B/C", group: "gC" },
        { id: "d", title: "A/B/C/D", group: "gD" },
        { id: "c2", title: "A/C", group: "gC2" },
      ),
      groups: [group("gA", "A", "a"), group("gB", "A/B", "b"), group("gC", "A/B/C", "c"), group("gD", "A/B/C/D", "d"), group("gC2", "A/C", "c2")],
    });
    sb.row("B").menu("Ungroup");
    assert.deepEqual(renames(sb.take()), [["gC", "A/C 2"], ["gD", "A/C 2/D"]]);
  });
});

describe("favorites", () => {
  test("Favorite pins the workspace through cmux; a pinned row shows the red bookmark", () => {
    const sb = mountSidebar({
      workspaces: workspaces({ id: "w1", title: "fav", pinned: true }, { id: "w2", title: "plain" }),
    });
    assert.deepEqual([sb.row("fav").favorite(), sb.row("plain").favorite()], [true, false]);
    sb.row("plain").menu("Favorite");
    sb.row("fav").menu("Unfavorite");
    assert.deepEqual(sb.take(), [
      { method: "workspace.action", params: { action: "pin", workspace_id: "w2" } },
      { method: "workspace.action", params: { action: "unpin", workspace_id: "w1" } },
    ]);
  });

  test("the bookmark follows a pin changed elsewhere", () => {
    const sb = mountSidebar({ workspaces: workspaces({ id: "w1", title: "job" }) });
    sb.setData({ workspaces: workspaces({ id: "w1", title: "job", pinned: true }) });
    assert.equal(sb.row("job").favorite(), true);
  });
});

describe("filters", () => {
  // tree3 with B collapsed, c1 working, b1 finished (working -> idle), and
  // a1 a favorite.
  const mixed = () => {
    const over = (b1) => tree3({ gB: { collapsed: true }, c1: { agents: [agent("working")] }, b1: { agents: [agent(b1)] }, a1: { pinned: true } });
    const sb = mountSidebar(over("working"));
    sb.setData(over("idle"));
    return sb;
  };

  test("Active shows only working and finished workspaces, flat, in tab order, with their group path", () => {
    const sb = mixed();
    sb.chip("Active").tap();
    assert.deepEqual(sb.outline(), ["A › B › b-one", "A › B › C › c-one"]);
    assert.deepEqual([sb.row("b-one").indicator(), sb.row("c-one").indicator()], ["finished", "working"]);
    assert.deepEqual([sb.chip("Active").text, sb.chip("Active").on], ["Active · 2", true]);
  });

  test("Favorites shows only pinned workspaces", () => {
    const sb = mixed();
    sb.chip("Favorites").tap();
    assert.deepEqual(sb.outline(), ["A › a-one"]);
    assert.equal(sb.row("a-one").favorite(), true);
  });

  test("with both on, a workspace shows if it matches either", () => {
    const sb = mixed();
    sb.chip("Active").tap();
    sb.chip("Favorites").tap();
    assert.deepEqual(sb.outline(), ["A › a-one", "A › B › b-one", "A › B › C › c-one"]);
  });

  test("turning the filter off restores the tree with collapse state untouched", () => {
    const sb = mixed();
    const tree = sb.outline();
    sb.chip("Active").tap();
    sb.chip("Active").tap();
    assert.deepEqual(sb.outline(), tree);
    assert.equal(sb.chip("Active").on, false);
    assert.deepEqual(sb.take(), []);
  });

  test("an empty filtered list says so", () => {
    const sb = mountSidebar(tree3());
    sb.chip("Active").tap();
    assert.deepEqual(sb.outline(), ["No active workspaces"]);
    sb.chip("Favorites").tap();
    assert.deepEqual(sb.outline(), ["No active or favorite workspaces"]);
    sb.chip("Active").tap();
    assert.deepEqual(sb.outline(), ["No favorite workspaces"]);
  });

  test("a workspace joins the Active list when work starts and leaves once its finished turn is opened", () => {
    const state = (x) => tree3({ x });
    const sb = mountSidebar(state({}));
    sb.chip("Active").tap();
    sb.setData(state({ agents: [agent("working")] }));
    assert.deepEqual(sb.outline(), ["loose"]);
    sb.setData(state({ agents: [agent("idle")] }));
    assert.equal(sb.row("loose").indicator(), "finished");
    sb.row("loose").tap();
    assert.deepEqual(sb.take(), [{ method: "workspace.select", params: { workspace_id: "x" } }]);
    assert.deepEqual(sb.outline(), ["No active workspaces"]);
  });

  test("green dots survive toggling the filter", () => {
    const sb = mixed();
    sb.chip("Active").tap();
    sb.chip("Active").tap();
    sb.chip("Active").tap();
    assert.equal(sb.row("b-one").indicator(), "finished");
  });
});
