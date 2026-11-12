/** The map file format. It matches PLAN.md, section "Map format". */

export interface MapFile {
  name: string;
  layers: [name: string, note: string][];
  boxes: MapBox[];
  pipes: MapPipe[];
  flows: Record<string, MapFlow>;
  order: string[];
}

/** layer: index into `layers`. row: which line of boxes, from the top. left, right: the box's edges, from 0 to 1 across the map. */
export interface MapBox {
  id: string;
  layer: number;
  row: number;
  left: number;
  right: number;
  name: string;
  what: string;
  dir: string;
  /** The code inside the box. A chip that starts with `~` is a shared package, with `#` a store. */
  chips: string[];
  store?: boolean;
  off?: boolean;
  tag?: string;
}

/** x: a straight line at that position. toX: it bends to enter the target there. side and lane: it runs down the left or right margin. across: it joins two boxes of one row. */
export interface MapPipe {
  id: string;
  from: string;
  to: string;
  kind: "call" | "lookup" | "event";
  label: string;
  route: { x?: number; toX?: number; side?: "L" | "R"; lane?: number; across?: boolean };
}

/** lit: the chips a flow uses, by box id. marks: a word on a chip, such as "changed", keyed "<box>|<chip>". */
export interface MapFlow {
  name: string;
  story?: string;
  paths?: MapPath[];
  steps?: MapStep[];
  lit?: Record<string, string[]>;
  marks?: Record<string, string>;
}

export interface MapPath {
  n: number;
  name: string;
  who: "person" | "clock" | "auto";
  trigger: string;
  entry: string;
  after: string;
}

export interface MapStep {
  n: string;
  pipe: string;
  dir?: "rev" | "both";
  label: string;
  text: string;
  where: string;
}
