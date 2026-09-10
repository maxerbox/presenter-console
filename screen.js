// Shared rendering core for the presenter console (console.html).
//
// Halves pattern from Euxane Tran-Girard's Beamer Viewer (EUPL-1.2,
// https://src.euxane.eu/beamer-viewer/): the double-width PDF produced
// by beamer's `show notes on second screen=right` is cropped per render
// — "left" shows the slide half (slide preview), "right" the notes half.
//
// Every repaint renders into a NEW offscreen canvas that is swapped in
// only after the render completes.  This structurally avoids pdf.js'
// "Cannot use the same canvas during multiple render() operations"
// error (and the flipped/double-composited output it leaves behind),
// even when page turns arrive faster than renders finish.

"use strict";

// Half to display: "left" = slide (audience), "right" = notes (console).
// plain = a single-width page (deck without notes): show it as-is.
// opts.cancelled: optional predicate — when it turns true while the
// render is in flight (a newer showPage superseded this one), the
// finished canvas is NOT swapped in, so a slow render of an OLD page
// can never overwrite a NEWER one (out-of-order completion race).
async function renderHalf(pdf, pageNumber, half, canvasHost, opts) {
  const cancelled = opts && opts.cancelled ? opts.cancelled : () => false;
  const page = await pdf.getPage(pageNumber);
  const vp0 = page.getViewport({ scale: 1 });
  const isDouble =
    vp0.width > vp0.height && vp0.width / vp0.height > 16 / 9 + 0.01;

  // Region of the base page to display, in unscaled page units.
  let clip;
  if (!isDouble) {
    clip = { x: 0, y: 0, w: vp0.width, h: vp0.height };
  } else if (half === "left") {
    clip = { x: 0, y: 0, w: vp0.width / 2, h: vp0.height };
  } else {
    clip = { x: vp0.width / 2, y: 0, w: vp0.width / 2, h: vp0.height };
  }

  const availW = canvasHost.clientWidth - 8;
  const availH = canvasHost.clientHeight - 8;
  const scale = Math.min(availW / clip.w, availH / clip.h);

  // Offscreen canvas; sized to the clipped region at devicePixelRatio
  // so text stays crisp on HiDPI screens.
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(clip.w * scale * dpr));
  canvas.height = Math.max(1, Math.floor(clip.h * scale * dpr));
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.objectFit = "contain";
  const ctx = canvas.getContext("2d");

  const task = page.render({
    canvasContext: ctx,
    viewport: page.getViewport({ scale: scale * dpr }),
    // pdf.js renders the full page; translate the content so the
    // desired half lands on the canvas (and crop via canvas size).
    transform: [1, 0, 0, 1, -clip.x * scale * dpr, -clip.y * scale * dpr],
  });
  await task.promise;
  // Swap only after a successful render; on error keep the old canvas.
  // A newer render superseded this one — drop it silently.
  if (cancelled()) return;
  canvasHost.replaceChildren(canvas);
}

// Simple elapsed-time presenter timer, started on the first page turn
// (beamer-viewer semantics: Timer.start() on pageTurnCount === 1).
function makeTimer(textEl) {
  let startedAt = null;
  let interval = null;
  return {
    start() {
      if (startedAt != null) return;
      startedAt = Date.now();
      interval = setInterval(() => {
        const s = Math.floor((Date.now() - startedAt) / 1000);
        const mm = String(Math.floor(s / 60)).padStart(2, "0");
        const ss = String(s % 60).padStart(2, "0");
        textEl.textContent = mm + ":" + ss;
      }, 500);
    },
    reset() {
      startedAt = null;
      clearInterval(interval);
      textEl.textContent = "00:00";
    },
  };
}

export { makeTimer, renderHalf };
