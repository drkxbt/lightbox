/* The arithmetic behind the viewer, kept free of the DOM so it can be tested on its own. Rectangles are in CSS
   pixels relative to the viewport. */

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A zoom state: the image drawn at `scale` times its fitted size, its top-left corner moved by (x, y) from where
 *  the fitted image sits. */
export interface Zoom {
  scale: number;
  x: number;
  y: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The largest rectangle with the image's proportions that fits the viewport inside `padding`, centred. With
 *  `maxScale` the image is never drawn larger than that many times its natural size. */
export function fitRect(natural: Size, viewport: Size, padding: Insets, maxScale = Infinity): Rect {
  const roomWidth = Math.max(1, viewport.width - padding.left - padding.right);
  const roomHeight = Math.max(1, viewport.height - padding.top - padding.bottom);
  const scale = Math.min(roomWidth / natural.width, roomHeight / natural.height, maxScale);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return {
    x: padding.left + (roomWidth - width) / 2,
    y: padding.top + (roomHeight - height) / 2,
    width,
    height,
  };
}

export interface Thumb {
  /** Where the thumbnail's box sits on screen. */
  rect: Rect;
  /** How the thumbnail draws its picture into that box. */
  fit: "cover" | "contain";
  /** object-position as fractions: 0.5, 0.5 is centred, 0.5, 0 is pinned to the top. */
  position: Point;
  /** The box's corner radius in px. */
  radius: number;
}

export interface Flip {
  /** Moves and scales the fitted frame (transform-origin at its top-left) onto the thumbnail's picture. */
  x: number;
  y: number;
  scale: number;
  /** Crops the frame, in its own unscaled pixels, to the part of the picture the thumbnail shows. */
  clip: Insets;
  radius: number;
}

/**
 * How to draw the full-size frame so it lands exactly on its thumbnail, crop included. A thumbnail with
 * object-fit: cover shows only part of the picture, so the frame is scaled until the picture covers the thumbnail's
 * box and then clipped to that box; animating both to zero grows the crop out into the whole picture.
 */
export function flipFromThumb(frame: Rect, thumb: Thumb): Flip {
  const { rect } = thumb;
  const cover = Math.max(rect.width / frame.width, rect.height / frame.height);
  const contain = Math.min(rect.width / frame.width, rect.height / frame.height);
  const scale = thumb.fit === "contain" ? contain : cover;
  const drawnWidth = frame.width * scale;
  const drawnHeight = frame.height * scale;
  // Where the drawn picture's corner sits inside the thumbnail box, by object-position.
  const offsetX = (rect.width - drawnWidth) * thumb.position.x;
  const offsetY = (rect.height - drawnHeight) * thumb.position.y;
  const clip =
    thumb.fit === "contain"
      ? { top: 0, right: 0, bottom: 0, left: 0 }
      : (() => {
          const left = -offsetX / scale;
          const top = -offsetY / scale;
          return { top, left, right: frame.width - left - rect.width / scale, bottom: frame.height - top - rect.height / scale };
        })();
  return {
    x: rect.x + offsetX - frame.x,
    y: rect.y + offsetY - frame.y,
    scale,
    clip,
    radius: thumb.radius / scale,
  };
}

/** The offset range that keeps a zoomed image covering the viewport along one axis, or centred when it is
 *  smaller than the viewport. `start` and `length` are the fitted frame's position and size on that axis. */
function axisBounds(start: number, length: number, scale: number, viewport: number): [number, number] {
  const drawn = length * scale;
  if (drawn <= viewport) {
    const centred = (viewport - drawn) / 2 - start;
    return [centred, centred];
  }
  return [viewport - drawn - start, -start];
}

export function zoomBounds(frame: Rect, scale: number, viewport: Size): { x: [number, number]; y: [number, number] } {
  return {
    x: axisBounds(frame.x, frame.width, scale, viewport.width),
    y: axisBounds(frame.y, frame.height, scale, viewport.height),
  };
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A zoom pulled back inside its bounds. */
export function clampZoom(zoom: Zoom, frame: Rect, viewport: Size): Zoom {
  const bounds = zoomBounds(frame, zoom.scale, viewport);
  return { scale: zoom.scale, x: clamp(zoom.x, ...bounds.x), y: clamp(zoom.y, ...bounds.y) };
}

/** Zooms to `scale` keeping the image point under `point` where it is, the way a pinch or a double tap expects. */
export function zoomAt(zoom: Zoom, scale: number, point: Point, frame: Rect): Zoom {
  const ratio = scale / zoom.scale;
  return {
    scale,
    x: point.x - frame.x - (point.x - frame.x - zoom.x) * ratio,
    y: point.y - frame.y - (point.y - frame.y - zoom.y) * ratio,
  };
}

/** Resistance past an edge: the further it is pulled, the less it moves, never past `dimension`. */
export function rubberband(distance: number, dimension: number, constant = 0.55): number {
  const sign = Math.sign(distance);
  const magnitude = Math.abs(distance);
  return sign * (1 - 1 / ((magnitude * constant) / dimension + 1)) * dimension;
}

/** An offset with any overshoot past `[min, max]` turned into rubber-band resistance. */
export function resist(value: number, min: number, max: number, dimension: number): number {
  if (value < min) return min + rubberband(value - min, dimension);
  if (value > max) return max + rubberband(value - max, dimension);
  return value;
}

/** Whether a horizontal swipe should move to the next or previous image: far enough, or quick enough. */
export function swipeDirection(dx: number, velocity: number, width: number): -1 | 0 | 1 {
  if (Math.abs(dx) > width * 0.22 || (Math.abs(velocity) > 0.35 && Math.sign(velocity) === Math.sign(dx) && Math.abs(dx) > 12)) {
    return dx < 0 ? 1 : -1;
  }
  return 0;
}

/** Whether a vertical drag should close the viewer. */
export function shouldDismiss(dy: number, velocity: number, height: number): boolean {
  return Math.abs(dy) > height * 0.16 || (Math.abs(velocity) > 0.5 && Math.sign(velocity) === Math.sign(dy) && Math.abs(dy) > 16);
}

/** The next index in a gallery of `count`, wrapping when `loop` is on; null past either end. */
export function step(index: number, by: number, count: number, loop: boolean): number | null {
  const next = index + by;
  if (next >= 0 && next < count) return next;
  if (!loop || count < 2) return null;
  return ((next % count) + count) % count;
}

/** Recent pointer positions, for a release velocity in px/ms that ignores a pause before letting go. */
export class Velocity {
  private samples: Array<{ t: number; x: number; y: number }> = [];

  add(x: number, y: number, t: number): void {
    this.samples.push({ t, x, y });
    while (this.samples.length > 2 && t - this.samples[0].t > 100) this.samples.shift();
  }

  get(now: number): Point {
    const recent = this.samples.filter((sample) => now - sample.t <= 100);
    if (recent.length < 2) return { x: 0, y: 0 };
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = Math.max(1, last.t - first.t);
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
  }

  reset(): void {
    this.samples = [];
  }
}
