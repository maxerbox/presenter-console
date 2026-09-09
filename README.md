# Presenter console (one PDF, notes + audience animations)

> Published as
> [maxerbox/presenter-console](https://github.com/maxerbox/presenter-console) —
> live demo: <https://maxerbox.github.io/presenter-console/> (the published copy
> is `Documents/presenter-console/`, refreshed from this folder by re-copying
> the app files).

Pick **one** PDF — the double-width presentation build (`slide | notes`) — and
get a two-window presenter setup:

- **Audience window** runs the stock **official pdf.js viewer**
  (`web/viewer.html`) — full PDF-JavaScript support, so `animate`-package
  animations play. It receives a **cropped slide-only copy** of your PDF,
  derived in-browser via pdf-lib CropBox surgery (page objects, `/Annots`
  widgets, document JS and links all survive — verified).
- **Presenter console** shows the **notes (right half)** of every page on the
  left, and on the right the **current slide stacked above the next slide**, in
  **two resizable regions** (drag the separators — one vertical between notes
  and slides, one horizontal between current and next slide; double- click to
  reset), with an elapsed-time timer.
- **Presenter tools** (buttons next to the timer):
  - **⊙ Pointer** — a red laser dot follows your mouse over the current slide in
    the console _or_ the audience window, and shows in both. Positions are
    normalized (0–1) slide coordinates, so they stay correct at any window size,
    zoom or presentation mode.
  - **✎ Marker** — draw freehand on the current slide; strokes appear on the
    audience slide as a screen-only overlay, **live while you draw** (like
    pdf.js' own pencil tool). Strokes are stored per deck (content-hashed) and
    per page in `localStorage`, so they survive console reloads and page turns.
    Drawing never disturbs played animations.
  - **🖌 Text** — click on the slide and type (pdf.js FreeText-style): the first
    line's baseline sits at the click point, `Escape`/`Ctrl+Enter` (or clicking
    elsewhere) commits, an empty editor is discarded. The **size dropdown** next
    to it sets the default font size (relative to slide height, like pdf.js'
    size input); annotations are stored per deck/page like strokes and mirror
    to the audience window as SVG text.
  - **🝆 Eraser** — drag over marker strokes or text to delete them (hold
    `Ctrl` for a larger radius; a ring shows the erase area). Works on both
    kinds of annotations, and erasures can be undone like anything else.
  - **↩ Undo / 🗑 Trash** — undo the last stroke, text or erasure (Ctrl+Z works
    too, also inside the text editor's history); trash wipes every page's
    annotations. Undo history is per session.
  - Divider sizes, tool toggles and the font size are remembered across
    sessions.

## Layout

```
presenter/
├── console.html        presenter console (single file picker) — static
├── viewer-shim.js      sync bridge injected into web/viewer.html
├── screen.js           shared pdf.js half-rendering core (flip-safe)
├── split.min.js        Split.js 1.6.5 (resizable two-region layout)
├── pdf-lib.esm.min.js  pdf-lib 1.17.1 (in-browser CropBox cropping)
├── sample.tex/.pdf     sample double-width deck (pgfplots + animate)
├── sample_talk.pdf     bundled copy of the internship-talk notes build
├── serve.py            static server (localhost:8765)
├── build/              pdf.js 6.3.289 core (pdf.mjs + worker + sandbox)
└── web/                official viewer.html / viewer.mjs + wasm assets
```

## Usage

1. Build the double-width PDF with `show notes on second screen=right` (only
   this one — the audience deck is derived from it automatically; the regular
   single-width build is not needed). A ready-made copy of the internship-talk
   build is bundled as `sample_talk.pdf`.

2. Serve (from `presenter/`): `python serve.py`

3. Open `http://localhost:8765/console.html`, click **Browse PDF…** (or drag &
   drop the file onto the page) and pick `sample_talk.pdf`. Or click **Try
   sample deck** to load the bundled 3-page demo.

4. Click **Open audience window** (allow the popup), drag it to the projector,
   press `f` for fullscreen.

5. Drive with keyboard (Space / arrows / PageUp / PageDown) from either window,
   or the console buttons. Both stay in sync; the timer starts on the first page
   turn (reset to 00:00 with the ↻ button next to it, or by clicking the timer —
   it restarts on your next page turn). Drag the separators to resize: the
   vertical one splits notes from the slide column, the horizontal one splits
   current from next slide; double-click a separator to reset; sizes are
   remembered across sessions.

## How it works

- `..._presentation_notes.tex` sets `show notes on second screen=right` →
  double-width pages (slide | notes). This is the ONLY PDF involved.
- The console renders both halves with `screen.js` `renderHalf()` — each repaint
  renders into a **fresh offscreen canvas** swapped in only after completion, so
  pdf.js' "same canvas during multiple render() operations" error (and
  flipped/double-composited output) cannot happen. HiDPI-aware
  (`devicePixelRatio`).
- `makeAudienceDeck()` re-saves the same document with pdf-lib, each
  double-width page's CropBox set to its left half. CropBox surgery only touches
  page geometry — annotations (animate widgets), document JS (`/Names`,
  `/OpenAction`), outlines and links pass through untouched, so animations play
  in the official viewer.
- `viewer-shim.js` (tagged into `web/viewer.html` as
  `<script src="../viewer-shim.js" defer>`) polls `PDFViewerApplication`,
  subscribes `pagechanging` on its eventBus and `postMessage`s the page to the
  console; the console sends `goto` and the cropped deck bytes
  (`{type:"load", data}` → `PDFViewerApplication.open({data, filename})`).
- Pointer, marker and text traffic travels over the same channel (`pointer`,
  `tools`, `strokes`, `strokeLive`, `strokesClearAll` messages — text
  annotations ride along in the per-page stroke lists as `{kind:"text", …}`
  entries). The shim re-injects its overlay (an SVG + a positioned dot) into
  the current page div whenever pdf.js rebuilds it, and the console re-adopts
  the audience popup after a console reload via a periodic `hello` heartbeat.
  Deck opens in the viewer are serialized and `goto`s that arrive before pages
  exist are deferred, so a reloaded console can never crash the viewer
  mid-open.
- Page numbers are identical console↔audience (same underlying document), so
  sync is plain page numbers — no text mapping needed.
- Re-picking a PDF while the audience window is open pushes the new cropped deck
  to it automatically.

## Gotchas

- The shim tag path is `../viewer-shim.js` (viewer lives in `web/`) —
  `./viewer-shim.js` 404s and silently kills sync.
- ES modules + WASM need http:// (serve.py), not file://
- Slides without a `\note{}` show an empty right half in the console — content,
  not a bug.
- Note-overflow continuation pages: beamer repeats the slide half and carries
  the note text over; the audience sees them cropped like any other page (the
  slide repeats) — acceptable for presentation flow.
