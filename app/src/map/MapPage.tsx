import { type CSSProperties, type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Anchor, boxShape, layout, SLOT } from "./layout.ts";
import "./map.css";
import type { MapBox, MapFile, MapFlow, MapPath, MapPipe, MapStep } from "./types.ts";

export interface MapPageProps {
  map: MapFile;
  /** The id of the open flow, a key of `map.flows`. */
  flow: string;
  onFlow: (id: string) => void;
}

/** The width of the map until the page has measured itself. Also the least width. */
const MIN_WIDTH = 1000;
const FIRST_WIDTH = 1100;

type IconKind = "call" | "event" | "lookup" | "person" | "clock" | "auto" | "store";

const svgIcon = (children: ReactNode) => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    {children}
  </svg>
);

function Icon({ kind }: { kind: IconKind }) {
  switch (kind) {
    case "call":
      return <span className="map-code-icon">‹›</span>;
    case "event":
      return svgIcon(
        <>
          <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
          <path d="M2 4.2l6 4.6 6-4.6" />
        </>,
      );
    case "lookup":
      return svgIcon(
        <>
          <circle cx="7" cy="7" r="4.2" />
          <path d="M10.2 10.2L14 14" />
        </>,
      );
    case "person":
      return svgIcon(
        <>
          <circle cx="8" cy="5.2" r="2.6" />
          <path d="M2.8 14c.6-3 2.6-4.4 5.2-4.4s4.6 1.4 5.2 4.4" />
        </>,
      );
    case "clock":
      return svgIcon(
        <>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.6V8l2.4 1.6" />
        </>,
      );
    case "auto":
      return svgIcon(
        <>
          <circle cx="8" cy="8" r="6" />
          <path d="M6.6 5.4L10.6 8l-4 2.6z" />
        </>,
      );
    case "store":
      return svgIcon(
        <>
          <ellipse cx="8" cy="4" rx="5" ry="2" />
          <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
        </>,
      );
  }
}

const KIND_WORD = { call: "Call", lookup: "Lookup", event: "Event" } as const;

function stripPrefix(chip: string): string {
  return chip.replace(/^[~#]/, "");
}

function Chip({ box, chip, flow }: { box: MapBox; chip: string; flow: MapFlow | null }) {
  const name = stripPrefix(chip);
  const lit = flow?.lit?.[box.id]?.includes(name) ?? false;
  const mark = flow?.marks?.[`${box.id}|${name}`];
  const cls = ["map-chip", chip.startsWith("~") && "shared", chip.startsWith("#") && "store", lit && "lit", flow && !lit && "dim"].filter(Boolean).join(" ");
  return (
    <span className={cls}>
      {chip.startsWith("#") ? <Icon kind="store" /> : null}
      {name}
      {mark ? <i>{mark}</i> : null}
    </span>
  );
}

function BoxView({
  box,
  style,
  dim,
  flow,
  setRef,
}: {
  box: MapBox;
  style: CSSProperties;
  dim: boolean;
  flow: MapFlow | null;
  setRef: (id: string, el: HTMLDivElement | null) => void;
}) {
  const cls = ["map-box", boxShape(box), box.off && "off", dim && "dim"].filter(Boolean).join(" ");
  return (
    <div className={cls} data-box={box.id} style={style} ref={(el) => setRef(box.id, el)}>
      <div className="map-box-l">
        <b>
          {box.store ? <Icon kind="store" /> : null}
          {box.name}
          {box.tag ? <i className="map-own">{box.tag}</i> : null}
        </b>
        <span>{box.what}</span>
        {box.dir ? <code>{box.dir}</code> : null}
      </div>
      {box.chips.length > 0 ? (
        <div className="map-box-r">
          {box.chips.map((c, i) => (
            <Chip key={`${i}:${c}`} box={box} chip={c} flow={flow} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function pillStyle(a: Anchor, i: number): CSSProperties {
  const style: CSSProperties = { left: a.x, top: a.y + a.dir * i * SLOT };
  if (a.align === "c") style.transform = "translateX(-50%)";
  if (a.align === "r") style.transform = "translateX(-100%)";
  return style;
}

function Key() {
  const line = (kind: MapPipe["kind"]) => (
    <svg className="ln" viewBox="0 0 30 8" aria-hidden="true">
      <path className={`ln-${kind}`} d="M0 4h30" />
    </svg>
  );
  return (
    <div className="map-key">
      <b>Key</b>
      {(["call", "lookup", "event"] as const).map((k) => (
        <span key={k}>
          {line(k)}
          <Icon kind={k} />
          {KIND_WORD[k]}
        </span>
      ))}
      <span className="map-chip">Code</span>
      <span className="map-chip shared">Shared package</span>
      <span className="map-chip store">
        <Icon kind="store" />
        Store
      </span>
      <span className="map-chip lit">In this flow</span>
    </div>
  );
}

function PathCard({ path }: { path: MapPath }) {
  return (
    <div className="map-path">
      <div className="map-path-head">
        <span className="map-num">{path.n}</span>
        <span className="map-path-name">{path.name}</span>
      </div>
      <div className="map-path-trigger">
        <Icon kind={path.who} />
        <span>{path.trigger}</span>
      </div>
      <code>{path.entry}</code>
      <small>Afterwards</small>
      <div>{path.after}</div>
    </div>
  );
}

function StepRow({ step, from, to }: { step: MapStep; from: string; to: string }) {
  const direction = step.dir === "both" ? `${from} ⇄ ${to}` : step.dir === "rev" ? `${to} → ${from}` : `${from} → ${to}`;
  return (
    <div className="map-step">
      <span>
        <span className="map-num">{step.n}</span>
      </span>
      <span className="map-step-ft">
        <b>{step.label}</b>
        <span>{direction}</span>
      </span>
      <span>
        {step.text}
        {step.where ? <code>{step.where}</code> : null}
      </span>
    </div>
  );
}

export function MapPage({ map, flow, onFlow }: MapPageProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const boxEls = useRef(new Map<string, HTMLDivElement>());
  const [width, setWidth] = useState(FIRST_WIDTH);
  const [heights, setHeights] = useState<Record<string, number>>({});

  const tabs = map.order.filter((id) => map.flows[id]);
  const activeId = map.flows[flow] ? flow : (tabs[0] ?? Object.keys(map.flows)[0] ?? "");
  const active: MapFlow | undefined = map.flows[activeId];
  const steps = active?.steps ?? [];
  const openFlow: MapFlow | null = steps.length > 0 && active ? active : null;
  const inFlow = openFlow !== null;

  const placed = useMemo(() => layout(map, { width, heights, flow: openFlow ?? undefined }), [map, width, heights, openFlow]);

  // The page's own width, so the map fills it. A narrow window scrolls the map sideways.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setWidth(Math.max(MIN_WIDTH, w));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The real height of each box. Its text and chips wrap, so only the browser knows it.
  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    let changed = false;
    for (const [id, el] of boxEls.current) {
      const keep = el.style.minHeight;
      el.style.minHeight = "0px";
      const h = el.offsetHeight;
      el.style.minHeight = keep;
      if (h > 0) {
        next[id] = h;
        if (Math.abs((heights[id] ?? -1) - h) > 0.5) changed = true;
      }
    }
    if (changed) setHeights(next);
  });

  // A band's label sits at the bottom of its band, in the middle. When a pill covers it, the label goes left, then right.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const pills = Array.from(stage.querySelectorAll<HTMLElement>(".map-pill")).map((p) => p.getBoundingClientRect());
    for (const label of stage.querySelectorAll<HTMLElement>(".map-band > span")) {
      const range = document.createRange();
      const hits = (): boolean => {
        range.selectNodeContents(label);
        const t = range.getBoundingClientRect();
        return pills.some((p) => t.left < p.right + 6 && p.left < t.right + 6 && t.top < p.bottom && p.top < t.bottom);
      };
      let chosen = "c";
      for (const align of ["c", "l", "r"]) {
        label.dataset.align = align;
        if (!hits()) {
          chosen = align;
          break;
        }
      }
      label.dataset.align = chosen;
    }
  });

  const setRef = (id: string, el: HTMLDivElement | null) => {
    if (el) boxEls.current.set(id, el);
    else boxEls.current.delete(id);
  };

  const boxById = new Map(map.boxes.map((b) => [b.id, b] as const));
  const pipeById = new Map(map.pipes.map((p) => [p.id, p] as const));
  const nameOf = (id: string) => boxById.get(id)?.name ?? id;
  const stepsByPipe = new Map<string, MapStep[]>();
  for (const s of steps) stepsByPipe.set(s.pipe, [...(stepsByPipe.get(s.pipe) ?? []), s]);

  const used = new Set<string>();
  if (openFlow) {
    for (const s of steps) {
      const p = pipeById.get(s.pipe);
      if (p) {
        used.add(p.from);
        used.add(p.to);
      }
    }
    for (const id of Object.keys(openFlow.lit ?? {})) used.add(id);
  }

  const markers = [
    { key: "", color: "--ink3" },
    { key: "On", color: "--ink" },
    { key: "Off", color: "--line" },
  ];

  const paths = active?.paths ?? [];
  const stepsOf = (p: MapPath) => steps.filter((s) => s.n.split(".")[0] === String(p.n));
  const strays = steps.filter((s) => !paths.some((p) => String(p.n) === s.n.split(".")[0]));
  const stepRow = (s: MapStep) => {
    const p = pipeById.get(s.pipe);
    return <StepRow key={s.n} step={s} from={p ? nameOf(p.from) : ""} to={p ? nameOf(p.to) : ""} />;
  };

  return (
    <div className="map-page">
      <h1>{map.name}</h1>
      <div className="map-flows" role="tablist">
        {tabs.map((id) => (
          <button key={id} type="button" role="tab" className="map-tab" aria-selected={id === activeId} onClick={() => onFlow(id)}>
            {map.flows[id]?.name}
          </button>
        ))}
      </div>
      {openFlow?.story ? <p className="map-story">{openFlow.story}</p> : null}
      {inFlow && paths.length > 0 ? (
        <div className="map-paths">
          {paths.map((p) => (
            <PathCard key={p.n} path={p} />
          ))}
        </div>
      ) : null}
      <div className="map-wrap" ref={wrapRef}>
        <div className="map-stage" ref={stageRef} style={{ width: placed.width, height: placed.height }}>
          {placed.bands.map((b) => (
            <div key={b.layer} className="map-band" style={{ top: b.y, height: b.h }}>
              <span>
                <b>{b.name}</b>
                {b.note}
              </span>
            </div>
          ))}
          <svg className="map-pipes" aria-hidden="true">
            <defs>
              {markers.map((m) => (
                <marker key={m.key} id={`${uid}ah${m.key}`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto-start-reverse">
                  <path d="M0,0 L9,4.5 L0,9 z" style={{ fill: `var(${m.color})` }} />
                </marker>
              ))}
            </defs>
            {placed.pipes.map((pp) => {
              const pipe = pipeById.get(pp.id);
              if (!pipe) return null;
              const mine = stepsByPipe.get(pp.id) ?? [];
              const on = inFlow && mine.length > 0;
              const rev = mine.some((s) => s.dir === "rev" || s.dir === "both");
              const fwd = !on || mine.some((s) => s.dir !== "rev");
              const mark = inFlow ? (on ? "On" : "Off") : "";
              const cls = ["pipe", `pipe-${pipe.kind}`, inFlow && (on ? "on" : "off")].filter(Boolean).join(" ");
              return (
                <path
                  key={pp.id}
                  className={cls}
                  data-pipe={pp.id}
                  d={pp.d}
                  fill="none"
                  markerEnd={fwd ? `url(#${uid}ah${mark})` : undefined}
                  markerStart={on && rev ? `url(#${uid}ah${mark})` : undefined}
                />
              );
            })}
          </svg>
          {placed.boxes.map((pb) => {
            const box = boxById.get(pb.id);
            if (!box) return null;
            return (
              <BoxView
                key={pb.id}
                box={box}
                flow={openFlow}
                dim={inFlow && !used.has(pb.id)}
                setRef={setRef}
                style={{ left: pb.x, top: pb.y, width: pb.w, minHeight: pb.h }}
              />
            );
          })}
          {placed.pipes.flatMap((pp) => {
            const pipe = pipeById.get(pp.id);
            if (!pipe) return [];
            if (inFlow) {
              return (stepsByPipe.get(pp.id) ?? []).map((s, i) => (
                <span key={`${pp.id}:${s.n}`} className="map-pill on" style={pillStyle(pp.anchor, i)}>
                  <span className="map-num">{s.n}</span>
                  {s.label}
                </span>
              ));
            }
            return [
              <span key={pp.id} className="map-pill" style={pillStyle(pp.anchor, 0)}>
                <Icon kind={pipe.kind} />
                {pipe.label}
              </span>,
            ];
          })}
        </div>
      </div>
      <Key />
      {inFlow ? (
        <div className="map-steps">
          {paths.map((p) => (
            <div key={p.n} className="map-path-block">
              <div className="map-path-title">
                Path {p.n} · {p.name}
              </div>
              {stepsOf(p).map(stepRow)}
            </div>
          ))}
          {strays.length > 0 ? <div className="map-path-block">{strays.map(stepRow)}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
