// A looping tour for recordings: open a picture, swipe on, zoom into a screenshot and look around, zoom out, drag
// down to close. Every loop ends where it began.
import { lightbox } from "../dist/index.js";

const PERIOD = 10000;
const viewer = lightbox(document, { history: false });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = (at) => wait(Math.max(0, at - performance.now()));
const track = () => document.querySelector(".lb-track");
const pointer = (type, x, y, id = 1) =>
  track().dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: id, pointerType: "touch", button: 0, buttons: 1, bubbles: true }));

async function drag(from, to, ms) {
  pointer("pointerdown", from.x, from.y);
  const steps = Math.max(4, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Eased like a finger: quick off the mark, slowing as it lets go.
    const e = 1 - (1 - t) ** 2;
    pointer("pointermove", from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    await wait(16);
  }
  pointer("pointerup", to.x, to.y);
}

async function doubleTap(x, y) {
  pointer("pointerdown", x, y);
  pointer("pointerup", x, y);
  await wait(110);
  pointer("pointerdown", x, y);
  pointer("pointerup", x, y);
}

async function cycle(t0) {
  const w = innerWidth;
  const h = innerHeight;
  await until(t0 + 500);
  document.querySelector(".tour > :first-child").click();
  await until(t0 + 1900);
  await drag({ x: w * 0.72, y: h * 0.5 }, { x: w * 0.3, y: h * 0.52 }, 260);
  await until(t0 + 3300);
  await doubleTap(w * 0.36, h * 0.38);
  await until(t0 + 4500);
  await drag({ x: w * 0.5, y: h * 0.5 }, { x: w * 0.3, y: h * 0.42 }, 420);
  await until(t0 + 6000);
  await doubleTap(w * 0.5, h * 0.5);
  await until(t0 + 7200);
  await drag({ x: w * 0.5, y: h * 0.42 }, { x: w * 0.53, y: h * 0.72 }, 300);
}

await document.fonts.ready;
await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
await wait(300);
const start = performance.now();
// For a recorder: the loop's period and its first frame in wall-clock milliseconds, to cut exactly one loop.
window.tour = { period: PERIOD, start: performance.timeOrigin + start };
for (let k = 0; ; k++) await cycle(start + k * PERIOD);
