import { test } from "node:test";
import assert from "node:assert/strict";
import { Velocity, clampZoom, fitRect, flipFromThumb, resist, restingFlip, rubberband, shouldDismiss, step, swipeDirection, zoomAt, zoomBounds } from "../dist/index.js";

const near = (actual, expected, digits = 6) => assert.ok(Math.abs(actual - expected) < 10 ** -digits, `${actual} is not ${expected}`);
const none = { top: 0, right: 0, bottom: 0, left: 0 };

test("an image fits the room inside the padding, centred, and never past its own size when capped", () => {
  assert.deepEqual(fitRect({ width: 1000, height: 500 }, { width: 800, height: 600 }, none), { x: 0, y: 100, width: 800, height: 400 });
  const padded = fitRect({ width: 1000, height: 1000 }, { width: 800, height: 600 }, { top: 50, right: 20, bottom: 50, left: 20 });
  assert.deepEqual(padded, { x: 150, y: 50, width: 500, height: 500 });
  const small = fitRect({ width: 200, height: 100 }, { width: 800, height: 600 }, none, 1);
  assert.deepEqual(small, { x: 300, y: 250, width: 200, height: 100 });
});

test("the frame lands on a cover-cropped thumbnail, crop included", () => {
  const frame = { x: 0, y: 0, width: 1000, height: 500 };
  const thumb = { rect: { x: 100, y: 100, width: 100, height: 100 }, fit: "cover", position: { x: 0.5, y: 0.5 }, radius: 10 };
  const flip = flipFromThumb(frame, thumb);
  near(flip.scale, 0.2);
  near(flip.x, 50);
  near(flip.y, 100);
  near(flip.clip.left, 250);
  near(flip.clip.right, 250);
  near(flip.clip.top, 0);
  near(flip.clip.bottom, 0);
  near(flip.radius, 50);
  // The clipped, scaled frame covers exactly the thumbnail box.
  near(flip.x + flip.clip.left * flip.scale, 100);
  near(flip.x + (frame.width - flip.clip.right) * flip.scale, 200);
});

test("object-position moves the crop: a thumbnail pinned to the top shows the top of a tall picture", () => {
  const frame = { x: 300, y: 50, width: 400, height: 800 };
  const thumb = { rect: { x: 0, y: 0, width: 160, height: 100 }, fit: "cover", position: { x: 0.5, y: 0 }, radius: 0 };
  const flip = flipFromThumb(frame, thumb);
  near(flip.scale, 0.4);
  near(flip.clip.top, 0);
  near(flip.clip.bottom, 800 - 250);
  near(frame.y + flip.y + flip.clip.top * flip.scale, 0);
});

test("a contain thumbnail scales without a crop", () => {
  const flip = flipFromThumb({ x: 0, y: 0, width: 1000, height: 500 }, { rect: { x: 0, y: 0, width: 100, height: 100 }, fit: "contain", position: { x: 0.5, y: 0.5 }, radius: 0 });
  near(flip.scale, 0.1);
  near(flip.y, 25);
  assert.deepEqual(flip.clip, none);
});

test("zooming keeps the point under the finger in place", () => {
  const frame = { x: 100, y: 50, width: 600, height: 400 };
  const point = { x: 340, y: 210 };
  const before = { scale: 1, x: 0, y: 0 };
  const after = zoomAt(before, 2.5, point, frame);
  const imagePoint = (zoom) => ({ x: (point.x - frame.x - zoom.x) / zoom.scale, y: (point.y - frame.y - zoom.y) / zoom.scale });
  near(imagePoint(after).x, imagePoint(before).x);
  near(imagePoint(after).y, imagePoint(before).y);
});

test("a zoomed image covers the viewport and cannot be dragged off it; a small one stays centred", () => {
  const viewport = { width: 800, height: 600 };
  const frame = { x: 100, y: 100, width: 600, height: 400 };
  assert.deepEqual(zoomBounds(frame, 2, viewport), { x: [800 - 1200 - 100, -100], y: [600 - 800 - 100, -100] });
  assert.deepEqual(clampZoom({ scale: 2, x: 50, y: -2000 }, frame, viewport), { scale: 2, x: -100, y: -300 });
  // At its fitted size the frame is already centred, so the only offset left is none.
  assert.deepEqual(clampZoom({ scale: 1, x: 40, y: -40 }, frame, viewport), { scale: 1, x: 0, y: 0 });
});

test("rubber-banding gives less and less and never reaches the dimension", () => {
  const values = [10, 100, 400, 4000].map((d) => rubberband(d, 400));
  values.reduce((previous, value) => (assert.ok(value > previous), value), 0);
  assert.ok(values.at(-1) < 400);
  assert.equal(rubberband(-100, 400), -rubberband(100, 400));
  assert.equal(resist(50, 0, 100, 400), 50);
  assert.ok(resist(150, 0, 100, 400) < 150 && resist(150, 0, 100, 400) > 100);
});

test("a swipe moves on when it is far or quick enough, and a drag down closes the same way", () => {
  assert.equal(swipeDirection(-200, 0, 800), 1);
  assert.equal(swipeDirection(200, 0, 800), -1);
  assert.equal(swipeDirection(-40, -0.6, 800), 1);
  assert.equal(swipeDirection(-40, 0.6, 800), 0);
  assert.equal(swipeDirection(-40, -0.1, 800), 0);
  assert.equal(shouldDismiss(120, 0, 600), true);
  assert.equal(shouldDismiss(30, 0.8, 600), true);
  assert.equal(shouldDismiss(30, 0.1, 600), false);
});

test("stepping through a gallery stops at the ends unless it loops", () => {
  assert.equal(step(2, 1, 3, false), null);
  assert.equal(step(2, 1, 3, true), 0);
  assert.equal(step(0, -1, 3, true), 2);
  assert.equal(step(0, -1, 1, true), null);
  assert.equal(step(1, 1, 3, false), 2);
});

test("release velocity reads the last 100ms, so a pause before letting go reads as still", () => {
  const velocity = new Velocity();
  velocity.add(0, 0, 0);
  velocity.add(50, 0, 50);
  velocity.add(100, 0, 100);
  near(velocity.get(100).x, 1);
  near(velocity.get(400).x, 0);
});

test("a tilted thumbnail turns the frame around its own centre, and the resting frame keeps that pivot", () => {
  const frame = { x: 100, y: 50, width: 800, height: 800 };
  const thumb = { rect: { x: 300, y: 400, width: 200, height: 200 }, fit: "cover", position: { x: 0.5, y: 0.5 }, radius: 10, rotation: -6 };
  const flip = flipFromThumb(frame, thumb);
  assert.equal(flip.rotate, -6);
  assert.deepEqual(flip.pivot, { x: 300, y: 450 });
  // The pivot is where the thumbnail's centre lands, so turning around it leaves the centre in place.
  near(flip.x + 400 * flip.scale, flip.pivot.x);
  near(flip.y + 400 * flip.scale, flip.pivot.y);
  const rest = restingFlip(flip);
  assert.deepEqual([rest.x, rest.y, rest.scale, rest.rotate, rest.radius], [0, 0, 1, 0, 0]);
  assert.deepEqual(rest.pivot, flip.pivot);
  assert.equal(flipFromThumb(frame, { ...thumb, rotation: undefined }).rotate, 0);
});
