# lightbox

An image viewer in plain TypeScript with no dependencies. Pictures grow out of their thumbnails, crop and all, and fly back when closed. Swipe between them, drag down to close, pinch or double-tap to zoom, and drag a zoomed picture to look around.

![A picture growing out of its tile, a swipe to a screenshot, a zoom in to read the numbers, and a drag down that sends it back to its tile](demo/preview.webp)

Most viewers open a picture by fading it in over the page. This one starts from the thumbnail you tapped: if the tile showed only the middle of the picture, the open grows that crop out into the whole picture, and the close shrinks it back into the same tile. On a phone it behaves like the photo apps people already know.

- **Open and close from the thumbnail.** The crop, the corner radius and `object-position` all carry through, so a cover-cropped tile opens without a jump. A tilted thumbnail, like a print laid on a table, turns upright as it opens and tilts back as it lands.
- **Swipe, drag down, pinch.** Swipe between pictures, drag down to close with the backdrop fading as you go, pinch or double-tap to zoom, and pan with rubber-band edges. A quick flick is enough for all of them.
- **Desk too.** Arrow keys, Escape, a click to zoom, Ctrl and the wheel or a trackpad pinch to zoom at the pointer, and a sideways trackpad swipe to move on.
- **Thumbnail first.** The thumbnail shows at once; the full image takes over as soon as it has decoded.
- **Back closes it.** On a phone, the Back gesture closes the viewer instead of leaving the page.
- **Accessible.** A modal dialog with focus kept inside, every control labelled, the image's position announced, and focus back on the thumbnail when it closes. With reduced motion, pictures fade instead of flying.

## Install

The package is not on npm. Install it from GitHub, which builds it on the way in:

```bash
npm install github:drkxbt/lightbox
```

It installs as `@drkxbt/lightbox`. Import it and its stylesheet:

```js
import { lightbox } from "@drkxbt/lightbox";
import "@drkxbt/lightbox/lightbox.css";
```

## Usage

Link each thumbnail to its full image and give the links a shared `data-lightbox` value to make them one gallery:

```html
<a href="photos/harbour.jpg" data-lightbox="trip" data-width="3000" data-height="2000" data-caption="The harbour at dawn">
  <img src="photos/harbour-thumb.jpg" alt="Fishing boats in a harbour at dawn">
</a>
```

```js
lightbox(document);
```

Without script the links still open the images. `data-width` and `data-height` give the full image's size, so the viewer can place it before it loads; without them it uses the thumbnail's proportions. An empty `data-lightbox` opens a picture on its own. Images without a link work too: put `data-lightbox` on the `<img>` and, if the full image is a different file, `data-full` with its address.

Open a list of your own from script:

```js
const viewer = lightbox(document);
viewer.open(0, [
  { src: "/full/1.jpg", thumb: document.querySelector("#first"), width: 2400, height: 1600, caption: "One" },
  { src: "/full/2.jpg", width: 1600, height: 2400 },
]);
```

| Option | Default | |
| --- | --- | --- |
| `selector` | `"[data-lightbox]"` | Which elements open the viewer. |
| `loop` | `false` | Wrap from the last picture to the first. |
| `zoom` | `true` | Pinch, double-tap, click and wheel zoom. |
| `maxZoom` | `4` | The most a picture zooms, in times its fitted size. |
| `history` | `true` | Back closes the viewer. |
| `padding` | room for the controls | Space around the picture: a number, or a function of the viewport that returns `{ top, right, bottom, left }`. |
| `labels` | English | The controls' names and the counter, for other languages. |
| `onChange`, `onClose` | | Called with the index and item when the picture changes, and when the viewer closes. |

`lightbox()` returns `{ open(target, items?), close(), next(), previous(), isOpen, destroy() }`.

## Theming

```css
.lb {
  --lb-backdrop: rgb(9 9 11 / 0.97);
  --lb-text: #ffffff;
  --lb-button: rgb(255 255 255 / 0.1);
  --lb-button-hover: rgb(255 255 255 / 0.18);
  --lb-ease: cubic-bezier(0.32, 0.72, 0, 1);
  --lb-duration: 440ms;
  --lb-z: 1000;
}
```

The viewer stays dark whatever the page looks like, so pictures read at their own colours.

## How it works

- **The flight.** The full-size frame is placed where the picture will end up, then moved and scaled onto the thumbnail with a transform and cropped to what the tile shows with a clip path. Animating both to nothing grows the crop out into the whole picture; closing runs the same thing in reverse. Only `transform`, `clip-path` and `opacity` animate. A tilt is read from the thumbnail's and its ancestors' transforms, and the frame turns around the thumbnail's centre.
- **Three slides.** The current picture and its neighbours sit side by side. A swipe moves the row; when it lands, the slides rotate behind the scenes and the far one loads the next picture.
- **Gestures.** One finger decides what it is doing from the way it first moves: across to swipe, down to close, anywhere to pan when zoomed. Two fingers pinch around their midpoint. Release velocity comes from the last 100ms, so a pause before letting go reads as still.
- **Zoom.** Zooming keeps the point under the fingers in place. A zoomed picture can't be dragged off the screen: past an edge it meets rubber-band resistance and springs back.
- **Content Security Policy.** Nothing writes a `style` attribute or a `<style>` tag; positions are set through the style object, so it runs under `style-src 'self'`.

## Demo

```bash
npm run demo
```

Then open http://localhost:4324/demo/.

## Tests

```bash
npm test
```

Builds the package and tests the geometry: fitting, the flight from a cropped thumbnail, zooming at a point, the zoom bounds, rubber-banding, and the swipe and dismiss decisions.

## License

[MIT](LICENSE). The penguin art in `demo/images` is drk's and is not covered by the license; see [NOTICE](NOTICE).
