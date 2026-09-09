# Handoff: pdf.js autoplay (PageOpen) not firing on slide navigation — animate-package OPD figure

## Status

- **LaTeX side: DONE** (by the other agent). The animated figure compiles and
  works.
- **This issue: delegated** by the user: "do not fix it yourself, I will use
  another agent, for the pdf.js issue".

## Symptom

In the presenter console's audience viewer (official pdf.js viewer,
presentation/fullscreen mode), navigating TO the animated slide shows only the
**poster frame** (static last frame). The animation plays **only when the user
clicks the animation widget manually**.

KEY DIAGNOSTIC: manual click works => the JS sandbox + animate's JavaScript are
fully functional. ONLY the PageOpen-triggered autoplay path fails on navigation.

## Reproduction

1. `cd C:\Users\SSI63\Documents\presenter-console`
2. `python serve.py` (serves on port 8765)
3. Open `http://localhost:8765/console.html`
4. A test deck with one animated frame is already copied there as
   `anim_test.pdf` (scratch deck: page 2 has a single animateinline animation,
   autoplay, poster=last).
5. Open the audience window, navigate to page 2 => poster frame only, no
   autoplay.

## Architecture (presenter-console)

- `console.html` — presenter view. Loads a double-width "notes" PDF (slide |
  note halves).
- The AUDIENCE deck is derived **in-browser**: pdf-lib CropBox surgery keeps the
  left halves. IMPORTANT: pages with aspect ratio <= 16/9 + 0.01 pass through
  UNTOUCHED — a single-width 16:9 test deck like `anim_test.pdf` is
  byte-identical for the audience viewer, so cropping is NOT the cause.
- Audience viewer = official pdf.js viewer (`web/viewer.html`) fed via
  `viewer-shim.js`: `app.open({data, filename:"slides.pdf"})`.
- Slide navigation: `app.pdfViewer.currentPageNumber = d.page` (programmatic
  page change).

## pdf.js version

- Bundled build: **6.3.289** (`build/pdf.mjs` `pdfjsVersion = 6.3.289`) — well
  above the animate manual's PDF.js >= 4.4.168 requirement.

## How animate embeds autoplay (verified in the test PDF)

- `animate.sty` (MiKTeX, v2024/10/14) writes, for each animation `anmN`:
  - The main widget: `/Subtype/Widget/FT/Btn/Ff 65536/T (anmN)` with
    `/AA <</PV <</S/JavaScript/JS ...>>/PO <</S/JavaScript/JS ...>>/PI .../PC ...>>`
    (PV=PageVisible, PO=PageOpen) plus mouse `/D` `/U` handlers. PO runs
    `if(aN_playsRight){aN_playFwd();}else{aN_playBwd();}`.
  - A hidden Foxit-compat `/Subtype/Screen` annotation with the same `/AA`
    PO/PV/PI/PC.
  - Frame widgets `T (0.0), T (0.1), ...` — these have **NO /P entry and NO
    /AA**.
- The page-open JS is embedded as a PDF stream object referenced from the /AA
  dicts.

## pdf.js PageOpen dispatch chain (researched, in bundled 6.3.289)

- `PDFScriptingManager` (web viewer) listens for `"pagechanging"` (dispatches
  PageClose for prev + PageOpen for new page) and `"pagerendered"` (if
  `_pageOpenPending.has(page) && page === current => dispatchPageOpen`).
- `#dispatchPageOpen` waits until the page's `renderingState === FINISHED`, else
  defers via `_pageOpenPending`.
- The sandbox dispatches `{id:"page", name:"PageOpen"}` =>
  `Doc._dispatchPageEvent` runs `#pageActions` (from page-level
  `getJSActions()`) + `#otherPageActions` (collected from field objects'
  `_actions.get("PageOpen")` in `_addField`, keyed by `field.obj._page + 1`).
- `AnnotationActionEventType` includes `PO: "PageOpen"` (confirmed in bundled
  `pdf.mjs` AND `pdf.worker.mjs` line ~202).
- `AnnotationFactory._getPageIndex` resolves a page via the annotation's `/P`
  entry, **with a fallback that scans all pages' /Annots**.

## Open questions / likely leads

1. Are the `anmN` widget's `/AA /PO` actions collected into `#otherPageActions`?
   The worker collects field actions during `#collectFieldObjects`/`_addField` —
   does the `anmN` widget get a resolved `_page` (its /P or the fallback scan)?
2. Does `"pagechanging"` actually fire when navigation is done via
   `pdfViewer.currentPageNumber = n` from the shim (vs. user scroll/click)?
3. PV (PageVisible) vs PO (PageOpen) semantics in pdf.js's presentation mode —
   maybe only one is dispatched and the widget ordering matters.
4. Whether `app.open({data})` (viewer-shim) vs. normal file open changes sandbox
   initialization order (scripting ready before first pagechange?).

## Relevant files

- `C:\Users\SSI63\Documents\presenter-console\viewer-shim.js`
- `C:\Users\SSI63\Documents\presenter-console\console.html`
- `C:\Users\SSI63\Documents\presenter-console\build\pdf.mjs`, `pdf.worker.mjs`,
  `web\viewer.mjs`
- `C:\Users\SSI63\Documents\presenter-console\anim_test.pdf` (reproduce case)
- LaTeX source of the test deck: `Stage\report\build\anim_test3.tex` (v3) /
  `anim_test2.tex` (v2). Figure:
  `Stage\report\figures\presentation\ mode_seeking_mode_covering_anim.tex`.
