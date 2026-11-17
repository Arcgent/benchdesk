import test from "node:test";
import assert from "node:assert/strict";
import {
  splitLeaf,
  leafIds,
  removeLeaf,
  setRatio,
  restoreCanvas,
  equalize,
  canvasLayout,
  canSplit,
  leafRect,
  splitMin,
} from "../src/shared/canvas";

test("mixed canvas splits cover the viewport; closing a pane preserves its siblings", () => {
  let tree = splitLeaf(null, "", "a");
  tree = splitLeaf(tree, "a", "b", "row");
  tree = splitLeaf(tree, "b", "c", "col");
  tree = splitLeaf(tree, "a", "d", "col");
  assert.deepEqual(leafIds(tree), ["a", "d", "b", "c"]);
  assert.deepEqual(splitLeaf(tree, "a", "b"), tree);
  const layout = canvasLayout(tree);
  assert.equal(layout.dividers.length, 3);
  assert.equal(
    layout.panes.reduce((n, p) => n + p.rect.w * p.rect.h, 0),
    1,
  );
  assert.deepEqual(
    layout.panes.map((p) => p.rect),
    [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  );
  const closed = removeLeaf(tree, "b");
  assert.deepEqual(leafIds(closed), ["a", "d", "c"]);
  assert.deepEqual(canvasLayout(closed).panes.find((p) => p.id === "c")?.rect, {
    x: 0.5,
    y: 0,
    w: 0.5,
    h: 1,
  });
  assert.deepEqual(restoreCanvas(JSON.parse(JSON.stringify(closed))), closed);
});

test("canvas restore removes missing and duplicate conversations; resize stays usable", () => {
  const tree = splitLeaf(splitLeaf(null, "", "a"), "a", "b");
  assert.equal((setRatio(tree, [], 2) as any).ratio, 0.85);
  assert.equal((setRatio(tree, [], -2) as any).ratio, 0.15);
  assert.equal((equalize(setRatio(tree, [], 0.2)) as any).ratio, 0.5);
  assert.deepEqual(restoreCanvas(tree, new Set(["b"])), {
    type: "leaf",
    id: "b",
  });
  assert.deepEqual(restoreCanvas({ ...tree, b: { type: "leaf", id: "a" } }), {
    type: "leaf",
    id: "a",
  });
  assert.equal(restoreCanvas({ type: "unexpected" }), null);
  assert.equal(removeLeaf({ type: "leaf", id: "a" }, "a"), null);
});

test("canvas retains more than twelve nested conversations", () => {
  let tree = splitLeaf(null, "", "0");
  for (let i = 1; i < 30; i++)
    tree = splitLeaf(tree, String(i - 1), String(i), i % 2 ? "row" : "col");
  assert.equal(leafIds(restoreCanvas(tree)).length, 30);
});

test("a pane is only split while it is wide or high enough", () => {
  assert.deepEqual(splitMin, { row: 560, col: 360 });
  assert.equal(canSplit({ w: 560, h: 10 }, "row"), true);
  assert.equal(canSplit({ w: 559.9, h: 2000 }, "row"), false);
  assert.equal(canSplit({ w: 10, h: 360 }, "col"), true);
  assert.equal(canSplit({ w: 2000, h: 359.9 }, "col"), false);
  // Width and height are judged separately: a wide, low pane still takes a neighbour but nothing below it.
  assert.equal(canSplit({ w: 900, h: 300 }, "row"), true);
  assert.equal(canSplit({ w: 900, h: 300 }, "col"), false);
});

test("split room is measured on the focused pane in real pixels", () => {
  // 1440px window minus the 260px sidebar, 56px top bar: the canvas of the four-pane smoke.
  const box = { w: 1180, h: 944 };
  let tree = splitLeaf(null, "", "a");
  assert.deepEqual(leafRect(tree, "a", box), { x: 0, y: 0, ...box });
  assert.equal(canSplit(leafRect(tree, "a", box)!, "row"), true);
  tree = splitLeaf(tree, "a", "b", "row");
  assert.deepEqual(leafRect(tree, "b", box), { x: 590, y: 0, w: 590, h: 944 });
  assert.equal(canSplit(leafRect(tree, "b", box)!, "col"), true);
  tree = splitLeaf(tree, "b", "c", "col");
  assert.deepEqual(leafRect(tree, "c", box), {
    x: 590,
    y: 472,
    w: 590,
    h: 472,
  });
  assert.equal(canSplit(leafRect(tree, "c", box)!, "row"), true);
  tree = splitLeaf(tree, "c", "d", "row");
  const d = leafRect(tree, "d", box)!;
  assert.deepEqual(d, { x: 885, y: 472, w: 295, h: 472 });
  assert.equal(canSplit(d, "row"), false);
  assert.equal(canSplit(d, "col"), true);
  // The app's default 1280px window: the second pane next to each other is refused, below is fine.
  const narrow = leafRect(tree, "a", { w: 1020, h: 744 })!;
  assert.equal(narrow.w, 510);
  assert.equal(canSplit(narrow, "row"), false);
  assert.equal(canSplit(narrow, "col"), true);
  // A dragged divider counts: the measure follows the ratio, not the number of panes.
  const dragged = setRatio(
    splitLeaf(splitLeaf(null, "", "a"), "a", "b"),
    [],
    0.3,
  );
  assert.equal(canSplit(leafRect(dragged, "a", box)!, "row"), false);
  assert.equal(canSplit(leafRect(dragged, "b", box)!, "row"), true);
  assert.equal(leafRect(tree, "missing", box), null);
  assert.equal(leafRect(null, "a", box), null);
});
