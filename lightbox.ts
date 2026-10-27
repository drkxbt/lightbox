import {
  Velocity,
  clamp,
  clampZoom,
  fitRect,
  flipFromThumb,
  resist,
  shouldDismiss,
  step,
  swipeDirection,
  zoomAt,
  zoomBounds,
  type Insets,
  type Point,
  type Rect,
  type Size,
  type Thumb,
  type Zoom,
} from "./geometry.js";

export interface Item {
  /** The full-size image. */
  src: string;
  /** The element the picture grows out of and returns to. Without one it fades in and out. */
  thumb?: HTMLImageElement | null;
  /** The full image's natural size. Without it the viewer uses the thumbnail's proportions until the image loads. */
  width?: number;
  height?: number;
  alt?: string;
  caption?: string;
  /** Where focus goes back to on close. Defaults to the thumbnail's link. */
  trigger?: HTMLElement | null;
}

export interface Labels {
  dialog: string;
  close: string;
  next: string;
  previous: string;
  zoomIn: string;
  zoomOut: string;
  counter: (index: number, count: number) => string;
}

export interface LightboxOptions {
  /** Which elements open the viewer. Links use their href; images use data-full, then their own source. */
  selector?: string;
  /** Wrap from the last image to the first. */
  loop?: boolean;
  /** Pinch, double-tap and wheel zoom. */
  zoom?: boolean;
  /** The most an image zooms, in times its fitted size. */
  maxZoom?: number;
  /** Pressing Back closes the viewer instead of leaving the page. */
  history?: boolean;
  /** Space kept around the image; a number or a function of the viewport. */
  padding?: number | ((viewport: Size) => Insets);
  labels?: Partial<Labels>;
  onChange?: (index: number, item: Item) => void;
  onClose?: () => void;
}

export interface Lightbox {
  /** Opens a gallery at `index`, or the gallery an element belongs to at that element. */
  open(target: number | Element, items?: Item[]): void;
  close(): void;
  next(): void;
  previous(): void;
  readonly isOpen: boolean;
  destroy(): void;
}

const GAP = 24;
const DEFAULT_LABELS: Labels = {
  dialog: "Image viewer",
  close: "Close",
  next: "Next image",
  previous: "Previous image",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  counter: (index, count) => `${index + 1} / ${count}`,
};
const ICONS = {
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  next: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  previous: '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>',
  // The upright stroke folds away when zoomed in, turning plus into minus.
  zoom: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 4.5 4.5M8 10.5h5"/><path class="lb-upright" d="M10.5 8v5"/>',
};

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = () => typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
const viewportSize = (): Size => ({ width: document.documentElement.clientWidth, height: window.innerHeight });

function defaultPadding(viewport: Size): Insets {
  // Room for the top bar and the caption on a phone; a calmer margin on a desk.
  return viewport.width < 640 ? { top: 56, right: 0, bottom: 64, left: 0 } : { top: 64, right: 72, bottom: 72, left: 72 };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function iconButton(className: string, label: string, icon: string): HTMLButtonElement {
  const button = element("button", `lb-btn ${className}`);
  button.type = "button";
  button.setAttribute("aria-label", label);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = icon;
  button.append(svg);
  return button;
}

/** How a thumbnail shows its picture, read from its computed style. `ours` is a thumbnail the viewer itself hid
 *  while its picture is open, which still counts as on the page. */
function readThumb(image: HTMLImageElement, ours = false): Thumb | null {
  const box = image.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const viewport = viewportSize();
  if (box.bottom < 0 || box.right < 0 || box.top > viewport.height || box.left > viewport.width) return null;
  const style = getComputedStyle(image);
  if ((style.visibility === "hidden" && !ours) || Number(style.opacity) === 0) return null;
  const [px = "50%", py = "50%"] = style.objectPosition.split(" ");
  const fraction = (value: string, free: number) =>
    value.endsWith("%") ? parseFloat(value) / 100 : free ? clamp(parseFloat(value) / free, 0, 1) : 0.5;
  const fit = style.objectFit === "contain" || style.objectFit === "scale-down" ? "contain" : "cover";
  return {
    rect: { x: box.left, y: box.top, width: box.width, height: box.height },
    fit,
    position: { x: fraction(px, box.width), y: fraction(py, box.height) },
    radius: parseFloat(style.borderTopLeftRadius) || 0,
  };
}

/** One picture in the track: a frame at its fitted rectangle, a layer inside it for zoom and pan, the image. */
class Slide {
  readonly element = element("div", "lb-slide");
  readonly frame = element("div", "lb-frame");
  readonly layer = element("div", "lb-layer");
  readonly image = element("img", "lb-img");
  item: Item | null = null;
  natural: Size = { width: 1, height: 1 };
  sized = false;
  rect: Rect = { x: 0, y: 0, width: 1, height: 1 };
  zoom: Zoom = { scale: 1, x: 0, y: 0 };

  constructor() {
    this.image.draggable = false;
    this.image.decoding = "async";
    this.layer.append(this.image);
    this.frame.append(this.layer);
    this.element.append(this.frame);
  }

  show(item: Item | null): void {
    this.item = item;
    this.zoom = { scale: 1, x: 0, y: 0 };
    this.element.hidden = !item;
    if (!item) {
      this.image.removeAttribute("src");
      return;
    }
    const thumb = item.thumb;
    this.sized = Boolean(item.width && item.height);
    this.natural = this.sized
      ? { width: item.width!, height: item.height! }
      : thumb?.naturalWidth
        ? { width: thumb.naturalWidth, height: thumb.naturalHeight }
        : { width: 4, height: 3 };
    // Same file as the thumbnail: its natural size is the real one.
    if (thumb && thumb.currentSrc && thumb.currentSrc === new URL(item.src, location.href).href) this.sized = true;
    this.image.alt = item.alt ?? "";
    // The thumbnail's pixels show at once; the full image takes over when it has decoded.
    this.image.src = thumb?.currentSrc || item.src;
    if (this.image.src !== new URL(item.src, location.href).href) this.load(item);
  }

  private load(item: Item): void {
    const full = new Image();
    full.decoding = "async";
    full.src = item.src;
    full
      .decode()
      .then(() => {
        if (this.item !== item) return;
        this.image.src = item.src;
        const aspectChanged = Math.abs(full.naturalWidth / full.naturalHeight - this.natural.width / this.natural.height) > 0.01;
        this.natural = { width: full.naturalWidth, height: full.naturalHeight };
        this.sized = true;
        if (aspectChanged) this.element.dispatchEvent(new Event("lb-resize", { bubbles: true }));
      })
      .catch(() => {});
  }

  layout(viewport: Size, padding: Insets): void {
    this.rect = fitRect(this.natural, viewport, padding, this.sized ? 1 : Infinity);
    const { style } = this.frame;
    style.left = `${this.rect.x}px`;
    style.top = `${this.rect.y}px`;
    style.width = `${this.rect.width}px`;
    style.height = `${this.rect.height}px`;
    this.zoom = clampZoom(this.zoom, this.rect, viewport);
    this.paint(false);
  }

  /** The most this slide zooms: at least twice its fitted size, enough to see it at full resolution, never past
   *  `limit`. */
  maxScale(limit: number): number {
    return Math.max(2, Math.min(limit, (this.natural.width / this.rect.width) * 1.5));
  }

  paint(animate: boolean): void {
    this.layer.classList.toggle("lb-animate", animate);
    this.layer.style.transform = `translate(${this.zoom.x}px, ${this.zoom.y}px) scale(${this.zoom.scale})`;
  }

  get zoomed(): boolean {
    return this.zoom.scale > 1.01;
  }
}

/**
 * Opens images in a viewer where they grow out of their thumbnails. Bind it once to a page or a container: every
 * element matching `selector` opens it, and elements sharing a data-lightbox value form a gallery you can swipe
 * through. Without script the links still open the image.
 */
export function lightbox(root: ParentNode = document, options: LightboxOptions = {}): Lightbox {
  const selector = options.selector ?? "[data-lightbox]";
  const labels = { ...DEFAULT_LABELS, ...options.labels };
  const zoomEnabled = options.zoom !== false;
  const maxZoom = options.maxZoom ?? 4;
  const useHistory = options.history !== false;
  const padFor = (viewport: Size): Insets =>
    typeof options.padding === "function"
      ? options.padding(viewport)
      : typeof options.padding === "number"
        ? { top: options.padding, right: options.padding, bottom: options.padding, left: options.padding }
        : defaultPadding(viewport);

  // The viewer: built on first use and kept for the next.
  let built = false;
  const viewer = element("div", "lb");
  const backdrop = element("div", "lb-backdrop");
  const track = element("div", "lb-track");
  const slides = [new Slide(), new Slide(), new Slide()];
  const bar = element("div", "lb-bar");
  const counter = element("span", "lb-counter");
  const zoomButton = iconButton("lb-zoom", labels.zoomIn, ICONS.zoom);
  const closeButton = iconButton("lb-close", labels.close, ICONS.close);
  const previousButton = iconButton("lb-prev", labels.previous, ICONS.previous);
  const nextButton = iconButton("lb-next", labels.next, ICONS.next);
  const caption = element("p", "lb-caption");
  const live = element("div", "lb-sr");

  function build() {
    if (built) return;
    built = true;
    viewer.setAttribute("role", "dialog");
    viewer.setAttribute("aria-modal", "true");
    viewer.setAttribute("aria-label", labels.dialog);
    viewer.tabIndex = -1;
    viewer.hidden = true;
    counter.setAttribute("aria-hidden", "true");
    live.setAttribute("aria-live", "polite");
    bar.append(counter, zoomButton, closeButton);
    track.append(...slides.map((slide) => slide.element));
    viewer.append(backdrop, track, bar, previousButton, nextButton, caption, live);
    if (!zoomEnabled) zoomButton.hidden = true;
    document.body.append(viewer);
    wire();
  }

  // State
  let items: Item[] = [];
  let index = 0;
  let phase: "closed" | "opening" | "open" | "closing" = "closed";
  let viewport = viewportSize();
  let hiddenThumb: HTMLImageElement | null = null;
  let returnFocus: HTMLElement | null = null;
  let inerted: Element[] = [];
  let pushedHistory = false;
  const listeners: Array<() => void> = [];
  const on = (target: EventTarget, type: string, handler: (event: any) => void, opts?: AddEventListenerOptions) => {
    target.addEventListener(type, handler, opts);
    listeners.push(() => target.removeEventListener(type, handler, opts));
  };

  const current = () => slides[1];
  const motionOk = () => !reducedMotion();

  function place() {
    slides.forEach((slide, i) => {
      slide.element.style.transform = `translateX(${(i - 1) * (viewport.width + GAP)}px)`;
    });
  }

  function layoutAll() {
    viewport = viewportSize();
    const padding = padFor(viewport);
    for (const slide of slides) if (slide.item) slide.layout(viewport, padding);
    place();
  }

  function fill() {
    const loop = Boolean(options.loop);
    const at = (by: number) => {
      const i = step(index, by, items.length, loop);
      return i === null ? null : items[i];
    };
    slides[0].show(at(-1));
    slides[1].show(items[index]);
    slides[2].show(at(1));
  }

  function updateChrome() {
    const count = items.length;
    counter.textContent = count > 1 ? labels.counter(index, count) : "";
    const item = items[index];
    caption.textContent = item?.caption ?? "";
    caption.hidden = !item?.caption;
    const loop = Boolean(options.loop);
    previousButton.hidden = nextButton.hidden = count < 2;
    previousButton.disabled = step(index, -1, count, loop) === null;
    nextButton.disabled = step(index, 1, count, loop) === null;
    const zoomed = current().zoomed;
    zoomButton.setAttribute("aria-label", zoomed ? labels.zoomOut : labels.zoomIn);
    zoomButton.toggleAttribute("data-zoomed", zoomed);
    viewer.toggleAttribute("data-zoomed", zoomed);
  }

  function announce() {
    const item = items[index];
    const parts = [items.length > 1 ? labels.counter(index, items.length) : "", item?.alt || item?.caption || ""];
    live.textContent = parts.filter(Boolean).join(". ");
  }

  function hideThumb(thumb: HTMLImageElement | null | undefined) {
    if (hiddenThumb && hiddenThumb !== thumb) hiddenThumb.style.visibility = "";
    hiddenThumb = thumb ?? null;
    if (hiddenThumb) hiddenThumb.style.visibility = "hidden";
  }

  function lockPage(lock: boolean) {
    const html = document.documentElement;
    if (lock) {
      const scrollbar = window.innerWidth - html.clientWidth;
      html.style.overflow = "hidden";
      if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
      inerted = [...document.body.children].filter((child) => child !== viewer && !(child as HTMLElement).inert);
      for (const child of inerted) (child as HTMLElement).inert = true;
    } else {
      html.style.overflow = "";
      document.body.style.paddingRight = "";
      for (const child of inerted) (child as HTMLElement).inert = false;
      inerted = [];
    }
  }

  function setFlip(slide: Slide, flip: ReturnType<typeof flipFromThumb> | null) {
    const { style } = slide.frame;
    if (!flip) {
      style.transform = "";
      style.clipPath = "";
      return;
    }
    const { top, right, bottom, left } = flip.clip;
    style.transform = `translate(${flip.x}px, ${flip.y}px) scale(${flip.scale})`;
    style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px round ${flip.radius}px)`;
  }

  function afterTransition(target: HTMLElement, done: () => void, fallback: number) {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      target.removeEventListener("transitionend", onEnd);
      done();
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === target) finish();
    };
    target.addEventListener("transitionend", onEnd);
    setTimeout(finish, fallback);
  }

  function open(target: number | Element, list?: Item[]) {
    build();
    if (phase === "closing" || phase === "opening") return;
    if (list) {
      items = list;
      index = typeof target === "number" ? clamp(target, 0, list.length - 1) : 0;
    } else if (typeof target === "number") {
      // A number alone reopens the last gallery at that image.
      if (!items.length) return;
      index = clamp(target, 0, items.length - 1);
    } else {
      const found = collect(target);
      if (!found) return;
      items = found.items;
      index = found.index;
    }
    if (!items.length) return;
    const item = items[index];
    returnFocus = item.trigger ?? (item.thumb?.closest("a, button, [tabindex]") as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);

    viewer.hidden = false;
    viewer.dataset.phase = phase = "opening";
    lockPage(true);
    fill();
    layoutAll();
    updateChrome();
    announce();
    if (useHistory && !pushedHistory) {
      history.pushState({ ...(history.state ?? {}), lightbox: true }, "");
      pushedHistory = true;
    }

    const slide = current();
    const thumb = item.thumb ? readThumb(item.thumb) : null;
    const flip = thumb && motionOk() ? flipFromThumb(slide.rect, thumb) : null;
    viewer.classList.remove("lb-fade");
    slide.frame.classList.remove("lb-animate");
    setFlip(slide, flip);
    if (!flip) viewer.classList.add("lb-fade");
    // Two frames: the start state is painted before the transition to the end state begins.
    void viewer.offsetWidth;
    hideThumb(item.thumb);
    requestAnimationFrame(() => {
      viewer.dataset.phase = "opening-active";
      slide.frame.classList.add("lb-animate");
      setFlip(slide, flip ? { x: 0, y: 0, scale: 1, clip: { top: 0, right: 0, bottom: 0, left: 0 }, radius: 0 } : null);
      afterTransition(slide.frame, () => {
        // Closed before the opening finished: the close owns the frame now.
        if (phase !== "opening") return;
        slide.frame.classList.remove("lb-animate");
        setFlip(slide, null);
        viewer.dataset.phase = phase = "open";
        closeButton.focus({ preventScroll: true });
      }, 700);
    });
    options.onChange?.(index, item);
  }

  function close() {
    if (phase !== "open" && phase !== "opening") return;
    const slide = current();
    const item = items[index];
    viewer.dataset.phase = phase = "closing";
    const thumb = item?.thumb ? readThumb(item.thumb, item.thumb === hiddenThumb) : null;
    const flip = thumb && motionOk() ? flipFromThumb(slide.rect, thumb) : null;
    hideThumb(item?.thumb);
    slide.zoom = { scale: 1, x: 0, y: 0 };
    slide.paint(true);
    viewer.classList.toggle("lb-fade", !flip);
    slide.frame.classList.add("lb-animate");
    requestAnimationFrame(() => {
      viewer.dataset.phase = "closing-active";
      if (flip) setFlip(slide, flip);
      afterTransition(slide.frame, finishClose, flip ? 600 : 320);
    });
    if (pushedHistory) {
      pushedHistory = false;
      if (history.state?.lightbox) history.back();
    }
  }

  function finishClose() {
    if (phase !== "closing") return;
    phase = "closed";
    viewer.hidden = true;
    viewer.dataset.phase = "closed";
    for (const slide of slides) {
      slide.frame.classList.remove("lb-animate");
      setFlip(slide, null);
      slide.show(null);
    }
    backdrop.style.opacity = "";
    track.style.transform = "";
    hideThumb(null);
    lockPage(false);
    returnFocus?.focus({ preventScroll: true });
    options.onClose?.();
  }

  // Moving between images: the track slides one width over, then the slides rotate behind the scenes.
  let moving = false;
  function go(direction: -1 | 1, fromX = 0) {
    if (moving || phase !== "open") return;
    const target = step(index, direction, items.length, Boolean(options.loop));
    if (target === null) {
      snapTrack();
      return;
    }
    moving = true;
    track.classList.add("lb-animate");
    track.style.transform = `translateX(${fromX}px)`;
    void track.offsetWidth;
    track.style.transform = `translateX(${-direction * (viewport.width + GAP)}px)`;
    afterTransition(track, () => {
      track.classList.remove("lb-animate");
      index = target;
      if (direction === 1) slides.push(slides.shift()!);
      else slides.unshift(slides.pop()!);
      // The slide that wrapped around is now the far neighbour; it gets that image.
      const loop = Boolean(options.loop);
      const far = step(index, direction, items.length, loop);
      slides[direction === 1 ? 2 : 0].show(far === null ? null : items[far]);
      for (const slide of slides) {
        slide.zoom = { scale: 1, x: 0, y: 0 };
      }
      track.replaceChildren(...slides.map((slide) => slide.element));
      layoutAll();
      track.style.transform = "";
      moving = false;
      // The thumbnail of the picture on screen stays hidden, so the page behind matches what will fly home.
      hideThumb(items[index].thumb);
      updateChrome();
      announce();
      options.onChange?.(index, items[index]);
    }, 520);
  }

  function snapTrack() {
    track.classList.add("lb-animate");
    track.style.transform = "";
    afterTransition(track, () => track.classList.remove("lb-animate"), 520);
  }

  function setZoom(next: Zoom, animate: boolean) {
    const slide = current();
    slide.zoom = next;
    slide.paint(animate);
    updateChrome();
  }

  function toggleZoom(point?: Point) {
    if (!zoomEnabled) return;
    const slide = current();
    if (slide.zoomed) {
      setZoom({ scale: 1, x: 0, y: 0 }, true);
      return;
    }
    const at = point ?? { x: slide.rect.x + slide.rect.width / 2, y: slide.rect.y + slide.rect.height / 2 };
    const scale = Math.min(slide.maxScale(maxZoom), Math.max(2, slide.natural.width / slide.rect.width));
    setZoom(clampZoom(zoomAt(slide.zoom, scale, at, slide.rect), slide.rect, viewport), true);
  }

  /* Gestures. One pointer pans a zoomed image, or swipes between images, or drags down to close, whichever way it
     starts moving. Two pointers pinch. A tap toggles the controls on touch and closes when it lands outside the
     image; a second tap zooms. */
  const pointers = new Map<number, Point>();
  const velocity = new Velocity();
  let gesture: "none" | "pending" | "pan" | "swipe" | "dismiss" | "pinch" = "none";
  let start: Point = { x: 0, y: 0 };
  let startTime = 0;
  let startZoom: Zoom = { scale: 1, x: 0, y: 0 };
  let pinchStart = { distance: 1, mid: { x: 0, y: 0 } };
  let lastTap = { time: 0, x: 0, y: 0 };
  let tapTimer = 0;

  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const onImage = (point: Point) => {
    const { rect, zoom } = current();
    const x = rect.x + zoom.x;
    const y = rect.y + zoom.y;
    return point.x >= x && point.x <= x + rect.width * zoom.scale && point.y >= y && point.y <= y + rect.height * zoom.scale;
  };

  function beginPinch() {
    const [a, b] = [...pointers.values()];
    gesture = "pinch";
    pinchStart = { distance: Math.max(1, distance(a, b)), mid: midpoint(a, b) };
    startZoom = { ...current().zoom };
    current().layer.classList.remove("lb-animate");
  }

  function onPointerDown(event: PointerEvent) {
    if (phase !== "open" || moving) return;
    if ((event.target as Element).closest(".lb-btn, .lb-caption")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    try {
      track.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks cannot be captured; the gesture still works without it.
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2 && zoomEnabled) {
      beginPinch();
      return;
    }
    if (pointers.size > 2) return;
    gesture = "pending";
    start = { x: event.clientX, y: event.clientY };
    startTime = performance.now();
    startZoom = { ...current().zoom };
    velocity.reset();
    velocity.add(event.clientX, event.clientY, startTime);
  }

  function onPointerMove(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const slide = current();
    if (gesture === "pinch" && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const mid = midpoint(a, b);
      const raw = startZoom.scale * (distance(a, b) / pinchStart.distance);
      const max = slide.maxScale(maxZoom);
      // Past either limit the pinch meets resistance, so it can be pushed but springs back.
      const scale = raw > max ? max + (raw - max) * 0.3 : raw < 1 ? Math.max(0.4, 1 - (1 - raw) * 0.6) : raw;
      const zoom = zoomAt(startZoom, scale, pinchStart.mid, slide.rect);
      setZoom({ scale, x: zoom.x + mid.x - pinchStart.mid.x, y: zoom.y + mid.y - pinchStart.mid.y }, false);
      backdrop.style.opacity = scale < 1 ? String(clamp(scale * 1.6 - 0.6, 0, 1)) : "";
      return;
    }
    if (pointers.size !== 1) return;
    const now = performance.now();
    velocity.add(event.clientX, event.clientY, now);
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (gesture === "pending") {
      if (Math.hypot(dx, dy) < 8) return;
      if (slide.zoomed) gesture = "pan";
      else gesture = Math.abs(dx) > Math.abs(dy) && items.length > 1 ? "swipe" : Math.abs(dy) >= Math.abs(dx) ? "dismiss" : "swipe";
    }
    if (gesture === "pan") {
      const bounds = zoomBounds(slide.rect, slide.zoom.scale, viewport);
      setZoom({
        scale: slide.zoom.scale,
        x: resist(startZoom.x + dx, bounds.x[0], bounds.x[1], viewport.width),
        y: resist(startZoom.y + dy, bounds.y[0], bounds.y[1], viewport.height),
      }, false);
    } else if (gesture === "swipe") {
      const loop = Boolean(options.loop);
      const blocked = (dx > 0 && step(index, -1, items.length, loop) === null) || (dx < 0 && step(index, 1, items.length, loop) === null);
      const x = blocked ? resist(dx, 0, 0, viewport.width) : dx;
      track.classList.remove("lb-animate");
      track.style.transform = `translateX(${x}px)`;
    } else if (gesture === "dismiss") {
      const progress = Math.min(1, Math.abs(dy) / viewport.height);
      slide.frame.classList.remove("lb-animate");
      slide.frame.style.transform = `translate(${dx * 0.35}px, ${dy}px) scale(${1 - progress * 0.25})`;
      backdrop.style.opacity = String(1 - Math.min(1, progress * 2.2));
      viewer.toggleAttribute("data-dragging", true);
    }
  }

  function onPointerUp(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return;
    const point = pointers.get(event.pointerId)!;
    pointers.delete(event.pointerId);
    const slide = current();

    if (gesture === "pinch") {
      if (pointers.size === 1) {
        // One finger left: carry on as a pan from here.
        const [rest] = [...pointers.values()];
        start = rest;
        startZoom = { ...slide.zoom };
        gesture = slide.zoomed ? "pan" : "pending";
        velocity.reset();
      } else {
        gesture = "none";
      }
      if (slide.zoom.scale < 0.72) {
        close();
        return;
      }
      backdrop.style.opacity = "";
      const max = slide.maxScale(maxZoom);
      if (slide.zoom.scale < 1) setZoom({ scale: 1, x: 0, y: 0 }, true);
      else if (slide.zoom.scale > max) setZoom(clampZoom(zoomAt(slide.zoom, max, pinchStart.mid, slide.rect), slide.rect, viewport), true);
      else setZoom(clampZoom(slide.zoom, slide.rect, viewport), true);
      return;
    }
    if (pointers.size) return;

    const now = performance.now();
    const v = velocity.get(now);
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    const kind = gesture;
    gesture = "none";

    if (kind === "pan") {
      // A flick carries on a little, then settles inside the bounds.
      const projected = { scale: slide.zoom.scale, x: slide.zoom.x + v.x * 220, y: slide.zoom.y + v.y * 220 };
      setZoom(clampZoom(projected, slide.rect, viewport), true);
    } else if (kind === "swipe") {
      const direction = swipeDirection(dx, v.x, viewport.width);
      const loop = Boolean(options.loop);
      if (direction && step(index, direction, items.length, loop) !== null) go(direction, dx);
      else snapTrack();
    } else if (kind === "dismiss") {
      viewer.removeAttribute("data-dragging");
      if (shouldDismiss(dy, v.y, viewport.height)) {
        close();
      } else {
        slide.frame.classList.add("lb-animate");
        slide.frame.style.transform = "";
        backdrop.style.opacity = "";
        afterTransition(slide.frame, () => slide.frame.classList.remove("lb-animate"), 520);
      }
    } else if (kind === "pending" && now - startTime < 300) {
      tap(point, event.pointerType);
    }
  }

  function tap(point: Point, pointerType: string) {
    const now = performance.now();
    const double = now - lastTap.time < 300 && Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < 40;
    clearTimeout(tapTimer);
    if (double) {
      lastTap = { time: 0, x: 0, y: 0 };
      toggleZoom(point);
      return;
    }
    lastTap = { time: now, x: point.x, y: point.y };
    const hitImage = onImage(point);
    if (pointerType === "mouse") {
      // A mouse click acts at once: on the image it zooms, beside it it closes.
      lastTap = { time: 0, x: 0, y: 0 };
      if (hitImage) toggleZoom(point);
      else close();
      return;
    }
    // On touch, wait to see whether a second tap follows.
    tapTimer = window.setTimeout(() => {
      if (hitImage) viewer.toggleAttribute("data-quiet");
      else close();
    }, 300);
  }

  let wheelAcc = 0;
  let wheelTimer = 0;
  function onWheel(event: WheelEvent) {
    if (phase !== "open") return;
    event.preventDefault();
    const slide = current();
    if (event.ctrlKey && zoomEnabled) {
      // A trackpad pinch arrives as a wheel event with ctrlKey set.
      const scale = clamp(slide.zoom.scale * Math.exp(-event.deltaY * 0.01), 1, slide.maxScale(maxZoom));
      setZoom(clampZoom(zoomAt(slide.zoom, scale, { x: event.clientX, y: event.clientY }, slide.rect), slide.rect, viewport), false);
      return;
    }
    if (slide.zoomed) {
      setZoom(clampZoom({ scale: slide.zoom.scale, x: slide.zoom.x - event.deltaX, y: slide.zoom.y - event.deltaY }, slide.rect, viewport), false);
      return;
    }
    // A sideways trackpad swipe moves between images, once per gesture.
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      wheelAcc += event.deltaX;
      clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => (wheelAcc = 0), 180);
      if (Math.abs(wheelAcc) > 60 && !moving) {
        go(wheelAcc > 0 ? 1 : -1);
        wheelAcc = -Math.sign(wheelAcc) * 10000;
      }
    }
  }

  function onKey(event: KeyboardEvent) {
    if (phase !== "open") return;
    const slide = current();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowRight" && !slide.zoomed) {
      event.preventDefault();
      go(1);
    } else if (event.key === "ArrowLeft" && !slide.zoomed) {
      event.preventDefault();
      go(-1);
    } else if ((event.key === "+" || event.key === "=") && zoomEnabled) {
      event.preventDefault();
      if (!slide.zoomed) toggleZoom();
    } else if ((event.key === "-" || event.key === "0") && slide.zoomed) {
      event.preventDefault();
      setZoom({ scale: 1, x: 0, y: 0 }, true);
    } else if (event.key === "Tab") {
      // Focus stays inside the viewer.
      const stops = [zoomButton, closeButton, previousButton, nextButton].filter((button) => !button.hidden && !button.disabled);
      if (!stops.length) return;
      const at = stops.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : at === stops.length - 1 ? 0 : at + 1;
      event.preventDefault();
      stops[next].focus();
    }
  }

  function wire() {
    on(track, "pointerdown", onPointerDown);
    on(track, "pointermove", onPointerMove);
    on(track, "pointerup", onPointerUp);
    on(track, "pointercancel", onPointerUp);
    on(track, "lb-resize", () => layoutAll());
    on(viewer, "wheel", onWheel, { passive: false });
    on(viewer, "contextmenu", (event: Event) => {
      if (gesture === "pinch") event.preventDefault();
    });
    on(closeButton, "click", close);
    on(nextButton, "click", () => go(1));
    on(previousButton, "click", () => go(-1));
    on(zoomButton, "click", () => toggleZoom());
    on(backdrop, "click", close);
    on(document, "keydown", onKey);
    on(window, "resize", () => {
      if (phase === "open") layoutAll();
    });
    on(window, "popstate", () => {
      if (pushedHistory && phase !== "closed") {
        pushedHistory = false;
        close();
      }
    });
    if (finePointer()) viewer.classList.add("lb-fine");
  }

  /* Galleries from the page: elements sharing a data-lightbox value belong together; an empty value opens alone. */
  function itemFor(trigger: Element): Item {
    const image = (trigger instanceof HTMLImageElement ? trigger : trigger.querySelector("img")) as HTMLImageElement | null;
    const data = (trigger as HTMLElement).dataset;
    const src =
      trigger instanceof HTMLAnchorElement ? trigger.href : data.full || image?.dataset.full || image?.currentSrc || image?.src || "";
    const figure = trigger.closest("figure");
    const figcaption = figure?.querySelector("figcaption")?.textContent?.trim();
    return {
      src,
      thumb: image,
      width: Number(data.width) || undefined,
      height: Number(data.height) || undefined,
      alt: image?.alt ?? "",
      caption: data.caption ?? figcaption ?? undefined,
      trigger: trigger instanceof HTMLElement ? trigger : null,
    };
  }

  function collect(target: Element): { items: Item[]; index: number } | null {
    const trigger = target.closest(selector);
    if (!trigger) return null;
    const group = (trigger as HTMLElement).dataset.lightbox ?? "";
    const members = group
      ? [...root.querySelectorAll<HTMLElement>(selector)].filter((element) => element.dataset.lightbox === group)
      : [trigger];
    return { items: members.map(itemFor), index: Math.max(0, members.indexOf(trigger as HTMLElement)) };
  }

  function onClick(event: MouseEvent) {
    const trigger = (event.target as Element).closest?.(selector);
    if (!trigger || !(root as Node).contains(trigger)) return;
    // Modified clicks keep their usual meaning: a new tab, a download.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(trigger);
  }
  function onTriggerKey(event: KeyboardEvent) {
    const trigger = (event.target as Element).closest?.(selector);
    if (!trigger || trigger instanceof HTMLAnchorElement || trigger instanceof HTMLButtonElement) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(trigger);
    }
  }
  // Images used as triggers without a link around them are made reachable by keyboard.
  for (const trigger of root.querySelectorAll<HTMLElement>(selector)) {
    if (trigger instanceof HTMLImageElement) {
      trigger.tabIndex = 0;
      trigger.setAttribute("role", "button");
      if (!trigger.getAttribute("aria-label")) trigger.setAttribute("aria-label", `Open image${trigger.alt ? `: ${trigger.alt}` : ""}`);
    }
  }
  root.addEventListener("click", onClick as EventListener);
  root.addEventListener("keydown", onTriggerKey as EventListener);

  return {
    open,
    close,
    next: () => go(1),
    previous: () => go(-1),
    get isOpen() {
      return phase !== "closed";
    },
    destroy() {
      root.removeEventListener("click", onClick as EventListener);
      root.removeEventListener("keydown", onTriggerKey as EventListener);
      if (phase !== "closed") {
        phase = "closing";
        finishClose();
      }
      for (const off of listeners.splice(0)) off();
      viewer.remove();
    },
  };
}
