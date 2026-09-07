# presenter-console

A two-window presenter console for LaTeX **beamer** decks with speaker
notes — running entirely in your browser, no server required.

[**▶ Live demo (GitHub Pages)**](https://maxerbox.github.io/presenter-console/)

Pick **one** PDF — the double-width build from beamer's
`show notes on second screen=right` — and you get:

- a **presenter console**: speaker notes (right half of each page) plus
  a slide preview (left half), with an elapsed-time timer,
- an **audience window** running the stock official
  [pdf.js](https://github.com/mozilla/pdf.js) viewer, which receives a
  **cropped slide-only copy** of the same PDF, derived in-browser with
  [pdf-lib](https://github.com/Hopding/pdf-lib) — so
  **PDF-JavaScript animations still play** (`animate` package et al.).

Both windows stay in sync (page turns in either one drive the other),
and everything stays on your machine — the picked PDF is never uploaded
anywhere.

## Try it

### Online

Open the **[live demo](https://maxerbox.github.io/presenter-console/)**,
click **Try sample deck**, then **Open audience window** (allow the
popup), and turn pages with the arrow keys from either window. The
sample deck includes an `animate`-package animation to prove animations
survive the crop.

### Locally

```
python serve.py            # or: python -m http.server 8765
```

then open <http://localhost:8765/console.html>. Serving over http:// is
required — ES modules and the pdf.js worker will not load from file://.
Pick your own double-width deck, or try the bundled sample.

> [!NOTE]
> The demo PDF in the popup works on GitHub Pages too: the viewer and
> the console are served from the same origin, so `postMessage` sync
> works — no `?file=` query needed.

## Build your deck

Any beamer deck with
`\setbeameroption{show notes on second screen=right}` produces the
expected double-width PDF. For example:

```latex
\documentclass[aspectratio=169]{beamer}
\setbeameroption{show notes on second screen=right}
\begin{document}
\begin{frame}{Title}
  Slide content
  \note{Speaker notes — only the presenter sees these}
\end{frame}
\end{document}
```

See [`sample.tex`](sample.tex) for a deck that also includes an
`animate`-package animation, and a bare note-page template (no beamer
chrome, small font) so long notes fit the half-page.

## How it works

- The console renders both halves of the double-width pages with pdf.js
  (`screen.js`). Each repaint renders into a **fresh offscreen canvas**
  swapped in only after completion — this structurally avoids pdf.js'
  "cannot use the same canvas during multiple render() operations"
  error and the flipped/double-composited output it leaves behind.
- The audience deck is the **same document** re-saved with each
  double-width page's **CropBox set to its left half** (pdf-lib).
  CropBox surgery only touches page geometry — annotations (animate
  widgets), document JavaScript (`/Names`, `/OpenAction`), outlines and
  links all pass through untouched, so animations play in the official
  viewer.
- `viewer-shim.js`, tagged into `web/viewer.html`, polls
  `PDFViewerApplication`, subscribes to `pagechanging` on its event bus
  and `postMessage`s the page to the console; the console sends `goto`
  and the cropped deck bytes
  (`{type:"load", data}` → `PDFViewerApplication.open({data, filename})`).
- Page numbers are identical console ↔ audience (same underlying
  document), so sync is plain page numbers — no text mapping needed.

## Layout

```
console.html        presenter console (single file picker) — static
viewer-shim.js      sync bridge injected into web/viewer.html
screen.js           pdf.js half-rendering core (flip-safe, HiDPI)
pdf-lib.esm.min.js  pdf-lib 1.17.1 (in-browser CropBox cropping)
sample.tex/.pdf     sample double-width deck (animate animation + notes)
serve.py            tiny static server for local use
build/              pdf.js 6.3.289 core (pdf.mjs + pdf.worker.mjs)
web/                official pdf.js viewer (viewer.html / viewer.mjs …)
```

## Credits

- The halves pattern and the fresh-canvas rendering trick are from
  Euxane Tran-Girard's
  [Beamer Viewer](https://src.euxane.eu/beamer-viewer/) (EUPL-1.2).
- Audience rendering by Mozilla's
  [pdf.js](https://github.com/mozilla/pdf.js) viewer (Apache-2.0),
  pdf.js 6.3.289 official dist.
- Deck cropping by Hopding's
  [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT).

## License

Apache-2.0 — see [LICENSE](LICENSE). The vendored pdf.js viewer and its
assets remain under their original licenses (Apache-2.0 and, for some
wasm assets, their own terms — see `web/wasm/LICENSE_*`).
