import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { createPortal } from "react-dom";
import { subsolarPoint } from "@super-work/core";
import { createEarthRenderer, type EarthGlobeMode, type EarthRenderer } from "../lib/earthRenderer";

interface EarthGlobeProps {
  mode: EarthGlobeMode;
  suspended: boolean;
}

const CANVAS_SIDE = 360;
const KEY_STEP = 12;
const KEY_ROTATION: Record<string, [longitude: number, latitude: number]> = {
  ArrowLeft: [KEY_STEP, 0],
  ArrowRight: [-KEY_STEP, 0],
  ArrowUp: [0, -KEY_STEP],
  ArrowDown: [0, KEY_STEP],
};
const utcClock = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC",
});

function coordinates(date: Date) {
  const { latitude, longitude } = subsolarPoint(date);
  return {
    latitude: `${Math.abs(latitude).toFixed(1)}°${latitude >= 0 ? "N" : "S"}`,
    longitude: `${Math.abs(longitude).toFixed(1)}°${longitude >= 0 ? "E" : "W"}`,
    time: utcClock.format(date),
  };
}

/** Keep one renderer mounted and move it between two reserved slots. */
export function EarthGlobe({ mode, suspended }: EarthGlobeProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<EarthRenderer | null>(null);
  const view = useRef({ mode, visible: false, size: 0 });
  const [renderStatus, setRenderStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [readout, setReadout] = useState(() => coordinates(new Date()));
  const [heroSlot, setHeroSlot] = useState<HTMLElement | null>(null);
  const pointer = useRef<{ id: number; x: number; y: number; degreesPerPixel: number } | null>(null);

  useLayoutEffect(() => {
    const enabled = mode === "hero" && !suspended && renderStatus === "ready";
    setHeroSlot(enabled
      ? layerRef.current?.parentElement?.querySelector<HTMLElement>('[data-earth-slot="hero"]') ?? null
      : null
    );
    return () => { pointer.current = null; };
  }, [mode, suspended, renderStatus]);

  function startDrag(event: PointerEvent<HTMLDivElement>): void {
    if (!event.isPrimary || event.button !== 0 || pointer.current) return;
    const target = event.currentTarget;
    const width = target.getBoundingClientRect().width;
    if (!width) return;
    target.setPointerCapture(event.pointerId);
    target.dataset.dragging = "true";
    pointer.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY, degreesPerPixel: 155 / width,
    };
    event.preventDefault();
  }

  function drag(event: PointerEvent<HTMLDivElement>): void {
    const previous = pointer.current;
    if (previous?.id !== event.pointerId) return;
    const { clientX, clientY } = event;
    rendererRef.current?.rotateView(
      (previous.x - clientX) * previous.degreesPerPixel,
      (clientY - previous.y) * previous.degreesPerPixel,
    );
    previous.x = clientX;
    previous.y = clientY;
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>): void {
    if (pointer.current?.id !== event.pointerId) return;
    pointer.current = null;
    delete event.currentTarget.dataset.dragging;
  }

  function rotateWithKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Home") {
      event.preventDefault();
      rendererRef.current?.resetView();
      return;
    }
    const delta = KEY_ROTATION[event.key];
    if (!delta) return;
    event.preventDefault();
    rendererRef.current?.rotateView(...delta);
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) setReadout(coordinates(new Date()));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    void createEarthRenderer(canvas).then((renderer) => {
      if (disposed) {
        renderer.dispose();
        return;
      }
      rendererRef.current = renderer;
      const { mode, visible, size } = view.current;
      renderer.update(mode, visible, size);
      setRenderStatus("ready");
    }).catch(() => {
      if (!disposed) setRenderStatus("unavailable");
    });
    return () => {
      disposed = true;
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const root = layer?.parentElement;
    const slot = root?.querySelector<HTMLElement>(`[data-earth-slot="${mode}"]`);
    if (!layer || !root || !slot) return;
    const scrollArea = slot.closest<HTMLElement>(".canvas");
    let frame = 0;
    let downsizeTimer = 0;
    let covering = false;

    function measure(): void {
      frame = 0;
      if (!layer || !root || !slot) return;
      const anchor = slot.getBoundingClientRect();
      const workspace = root.getBoundingClientRect();
      const scroll = scrollArea?.getBoundingClientRect();
      const withinCanvas = !scroll || (anchor.bottom > scroll.top && anchor.top < scroll.bottom);
      const visible = !suspended && anchor.width > 0 && withinCanvas;
      layer.style.setProperty("--earth-x", `${anchor.left - workspace.left}px`);
      layer.style.setProperty("--earth-y", `${anchor.top - workspace.top}px`);
      layer.style.setProperty("--earth-size", `${anchor.width}px`);
      layer.style.setProperty("--earth-scale", String(anchor.width / CANVAS_SIDE));
      layer.dataset.visible = String(visible);
      const size = covering ? Math.max(anchor.width, view.current.size) : anchor.width;
      view.current = { mode, visible, size };
      rendererRef.current?.update(mode, visible, size);
    }

    const schedule = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    covering = mode === "mini" && view.current.mode === "hero";
    if (covering) {
      downsizeTimer = window.setTimeout(() => {
        covering = false;
        schedule();
      }, 590);
    }
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    observer.observe(slot);
    if (scrollArea) observer.observe(scrollArea);
    root.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);

    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(downsizeTimer);
    };
  }, [mode, suspended]);

  const { latitude, longitude, time } = readout;
  return (
    <div
      ref={layerRef}
      className={`earth-globe is-${mode}`}
      data-render={renderStatus}
      role="img"
      aria-label={renderStatus === "unavailable" ? "3D 地球当前不可用" : `实时昼夜地球，太阳直射点 ${latitude} ${longitude}，UTC ${time}`}
    >
      <div className="earth-globe__stage" aria-hidden="true">
        <canvas className="earth-globe__webgl" ref={canvasRef} />
        <span className="earth-globe__fallback" />
      </div>
      <div className="earth-globe__caption" aria-hidden="true">
        <span className="earth-globe__legend">
          {renderStatus === "unavailable" ? "3D 地球不可用" : "太阳直射点"}
          {heroSlot ? <span className="earth-globe__drag-hint">· 拖动旋转</span> : null}
        </span>
        {renderStatus === "ready" ? (
          <span className="earth-globe__coordinates">{latitude} · {longitude} <small>UTC {time}</small></span>
        ) : null}
      </div>
      {heroSlot ? createPortal(
        <div
          className="earth-globe__drag-target"
          role="group"
          tabIndex={0}
          aria-label="旋转地球视角"
          aria-description="拖动或使用方向键旋转，双击或按 Home 恢复默认视角。"
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home"
          onPointerDown={startDrag}
          onPointerMove={drag}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onLostPointerCapture={finishDrag}
          onDoubleClick={() => rendererRef.current?.resetView()}
          onKeyDown={rotateWithKeyboard}
        />,
        heroSlot,
      ) : null}
    </div>
  );
}
