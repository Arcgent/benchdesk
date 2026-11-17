export type CanvasTree =
  | { type: "leaf"; id: string }
  | {
      type: "split";
      dir: "row" | "col";
      ratio: number;
      a: CanvasTree;
      b: CanvasTree;
    };
export const leafIds = (tree: CanvasTree | null | undefined): string[] =>
  !tree
    ? []
    : tree.type === "leaf"
      ? [tree.id]
      : [...leafIds(tree.a), ...leafIds(tree.b)];
export function removeLeaf(
  tree: CanvasTree | null | undefined,
  id: string,
): CanvasTree | null {
  if (!tree) return null;
  if (tree.type === "leaf") return tree.id === id ? null : tree;
  const a = removeLeaf(tree.a, id),
    b = removeLeaf(tree.b, id);
  return a && b ? { ...tree, a, b } : a || b;
}
export function splitLeaf(
  tree: CanvasTree | null | undefined,
  focus: string,
  id: string,
  dir: "row" | "col" = "row",
): CanvasTree {
  const leaf: CanvasTree = { type: "leaf", id };
  if (!tree) return leaf;
  if (leafIds(tree).includes(id)) return tree;
  if (!leafIds(tree).includes(focus)) focus = leafIds(tree)[0];
  if (tree.type === "leaf")
    return tree.id === focus
      ? { type: "split", dir, ratio: 0.5, a: tree, b: leaf }
      : tree;
  return {
    ...tree,
    a: leafIds(tree.a).includes(focus)
      ? splitLeaf(tree.a, focus, id, dir)
      : tree.a,
    b: leafIds(tree.b).includes(focus)
      ? splitLeaf(tree.b, focus, id, dir)
      : tree.b,
  };
}
export function equalize(
  tree: CanvasTree | null | undefined,
): CanvasTree | null {
  return !tree
    ? null
    : tree.type === "leaf"
      ? tree
      : { ...tree, ratio: 0.5, a: equalize(tree.a)!, b: equalize(tree.b)! };
}
export function setRatio(
  tree: CanvasTree,
  path: ("a" | "b")[],
  ratio: number,
): CanvasTree {
  if (tree.type === "leaf") return tree;
  if (!path.length)
    return { ...tree, ratio: Math.max(0.15, Math.min(0.85, ratio)) };
  const [head, ...rest] = path;
  return { ...tree, [head]: setRatio(tree[head], rest, ratio) };
}
export function restoreCanvas(
  value: unknown,
  valid?: Set<string>,
  seen = new Set<string>(),
  depth = 0,
): CanvasTree | null {
  if (!value || typeof value !== "object" || depth > 128) return null;
  const n = value as any;
  if (n.type === "leaf") {
    if (
      typeof n.id !== "string" ||
      seen.has(n.id) ||
      (valid && !valid.has(n.id))
    )
      return null;
    seen.add(n.id);
    return { type: "leaf", id: n.id };
  }
  if (n.type !== "split" || !["row", "col"].includes(n.dir)) return null;
  const a = restoreCanvas(n.a, valid, seen, depth + 1),
    b = restoreCanvas(n.b, valid, seen, depth + 1);
  return a && b
    ? {
        type: "split",
        dir: n.dir,
        ratio: Math.max(0.15, Math.min(0.85, Number(n.ratio) || 0.5)),
        a,
        b,
      }
    : a || b;
}
export type Rect = { x: number; y: number; w: number; h: number };
export function canvasLayout(
  tree: CanvasTree | null | undefined,
  rect: Rect = { x: 0, y: 0, w: 1, h: 1 },
  path: ("a" | "b")[] = [],
  panes: { id: string; rect: Rect }[] = [],
  dividers: {
    path: ("a" | "b")[];
    rect: Rect;
    parent: Rect;
    dir: "row" | "col";
  }[] = [],
) {
  if (tree?.type === "leaf") panes.push({ id: tree.id, rect });
  else if (tree) {
    const { x, y, w, h } = rect;
    const r = tree.ratio;
    canvasLayout(
      tree.a,
      tree.dir === "row" ? { x, y, w: w * r, h } : { x, y, w, h: h * r },
      [...path, "a"],
      panes,
      dividers,
    );
    canvasLayout(
      tree.b,
      tree.dir === "row"
        ? { x: x + w * r, y, w: w * (1 - r), h }
        : { x, y: y + h * r, w, h: h * (1 - r) },
      [...path, "b"],
      panes,
      dividers,
    );
    dividers.push({
      path,
      parent: rect,
      dir: tree.dir,
      rect:
        tree.dir === "row"
          ? { x: x + w * r, y, w: 0, h }
          : { x, y: y + h * r, w, h: 0 },
    });
  }
  return { panes, dividers };
}
// README "Splitsboom": a pane is only split while it is wide (next to each other) or high (below each other)
// enough, measured on the pane as it is now, in real pixels.
export const splitMin = { row: 560, col: 360 } as const;
export const canSplit = (
  rect: Pick<Rect, "w" | "h">,
  dir: "row" | "col",
): boolean => (dir === "row" ? rect.w >= splitMin.row : rect.h >= splitMin.col);
// The pane of one conversation in pixels, for a canvas of `box` pixels.
export function leafRect(
  tree: CanvasTree | null | undefined,
  id: string,
  box: Pick<Rect, "w" | "h">,
): Rect | null {
  const rect = canvasLayout(tree).panes.find((p) => p.id === id)?.rect;
  return rect
    ? {
        x: rect.x * box.w,
        y: rect.y * box.h,
        w: rect.w * box.w,
        h: rect.h * box.h,
      }
    : null;
}
