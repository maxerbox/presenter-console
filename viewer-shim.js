// Loaded inside the official pdf.js viewer (web/viewer.html) via a script
// tag; keeps the presenter console in sync.  The viewer is served from
// presenter/web/, so this file lives at presenter/viewer-shim.js and the
// tag must read <script src="../viewer-shim.js" defer></script> (NOT ./ —
// that 404s and silently breaks sync).
//
// Protocol with the opener (the console page, same origin):
//   → {type:"ready"}                    shim is up (sent when wired)
//   → {type:"loaded"}                   viewer finished opening a pushed deck
//   → {type:"pagechange",page,total}    page turned inside the viewer
//   ← {type:"load", data:Uint8Array}    deck bytes to open (static mode)
//   ← {type:"goto", page:N}             jump to page N
(function () {
  "use strict";
  const opener = window.opener;
  if (!opener) return;

  function post(msg) {
    opener.postMessage(msg, "*");
  }

  function wire(app) {
    if (!app || !app.eventBus) return false;
    app.eventBus.on("pagechanging", (evt) => {
      post({ type: "pagechange", page: evt.pageNumber, total: app.pagesCount });
    });
    patchScriptingForPresentationMode(app);
    return true;
  }

  // --- pdf.js presentation-mode animation fix -------------------------
  // In presentation mode pdf.js fires pagechanging 3x per page turn
  // (extra scale-change pass; mozilla/pdf.js#15745, WONTFIX upstream).
  // The scripting manager turns that into a scrambled PageOpen/PageClose
  // sequence: opens of the departed page (restarting its animation
  // off-screen) and closes of the page just turned TO (pausing it and
  // resetting it to the poster frame) — so animate-package autoplay
  // widgets end up frozen.  (A manual click restarts them via /U.)
  //
  // Fix: intercept the scripting layer (the single choke point every
  // Page event passes through) and, in presentation mode only, drop the
  // corrupted events:
  //   - PageClose targeting the CURRENT page — a legitimate close always
  //     targets the page being LEFT, after currentPageNumber advanced.
  //   - PageOpen targeting a NON-current page — a legitimate open always
  //     targets the current page (pagechanging/pagerendered/init paths).
  // What survives is exactly one close of the departed page + one open of
  // the current page, so autoplay runs seamlessly from the moment the
  // page appears (no poster-frame flash).  Normal mode is gated out
  // entirely via isInPresentationMode.
  //
  // Installed before webViewerLoad (this file is deferred, runs before
  // DOMContentLoaded), so it covers the first document too.
  function patchScriptingForPresentationMode(app) {
    const svcs = app.externalServices;
    if (!svcs || typeof svcs.createScripting !== "function") return;
    const origCreate = svcs.createScripting.bind(svcs);
    svcs.createScripting = function (...args) {
      const scripting = origCreate(...args);
      const origDispatch = scripting?.dispatchEventInSandbox?.bind(scripting);
      if (!origDispatch) return scripting;
      scripting.dispatchEventInSandbox = async function (detail) {
        if (detail?.id === "page" && app.pdfViewer?.isInPresentationMode) {
          const cur = app.pdfViewer.currentPageNumber;
          if (
            (detail.name === "PageClose" && detail.pageNumber === cur) ||
            (detail.name === "PageOpen" && detail.pageNumber !== cur)
          ) {
            return; // corrupted event from the presentation-mode burst
          }
        }
        return origDispatch(detail);
      };
      return scripting;
    };
  }

  // PDFViewerApplication is defined early; eventBus exists after scripts
  // load.  Try immediately, else poll briefly (the viewer has no public
  // ready event on window).
  function tryWire(retries) {
    if (wire(window.PDFViewerApplication)) {
      post({ type: "ready" });
      return;
    }
    if (retries > 0) setTimeout(() => tryWire(retries - 1), 250);
  }
  tryWire(80); // ~20s

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || typeof d !== "object") return;
    const app = window.PDFViewerApplication;
    if (d.type === "load" && app && app.open) {
      // Push the picked deck bytes into the official viewer.  Copy the
      // buffer: pdf.js transfers/detaches the ArrayBuffer it renders.
      const data =
        d.data instanceof Uint8Array ? new Uint8Array(d.data) : d.data;
      Promise.resolve(app.open({ data, filename: "slides.pdf" }))
        .then(() => post({ type: "loaded" }))
        .catch((e) => {
          console.error("shim: failed to open pushed deck", e);
          post({ type: "loaded" }); // still report; console shows status
        });
    } else if (d.type === "goto") {
      if (app && app.pdfViewer) app.pdfViewer.currentPageNumber = d.page;
    }
  });
})();
