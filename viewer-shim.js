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

  // --- pdf.js presentation-mode animation fix (v4) --------------------
  // Two problems, one root cause: in presentation mode pdf.js fires
  // pagechanging 3x per turn (extra scale-change pass; mozilla/pdf.js
  // #15745, WONTFIX upstream).  The scripting manager runs its
  // close-previous/open-new handler once PER PASS, so a single turn
  // sends the sandbox a scrambled PageOpen/PageClose stream:
  //   Close A, Open A(!), Open B, Close A, Open B(again), Close B(!)
  // where A = departed page and B = page turned to.  The manager's
  // passes arrive in separate tasks and the middle pass bounces
  // currentPageNumber back to A, so any filter keyed on
  // "current page at dispatch time" is racy:
  //   - zombie PageOpen of the departed page restarts its animate
  //     interval off-screen (frames keep advancing);
  //   - the trailing PageClose of B pauses B at the poster frame —
  //     autoplay freezes (a manual click restarts via /U);
  //   - on rapid turns A's /PC display writes land while A's DOM is
  //     detached (PM keeps only the current page attached), so they
  //     go to annotationStorage and are NEVER applied on re-attach —
  //     the layer is not re-rendered, so the replay never runs.  The
  //     re-attached layer shows stale inline visibility: leftover
  //     frames the animation's seekFrame (which hides only the frame
  //     it thinks is current) never cleans up — stacked gaussians.
  //
  // Fix, part 1 — burst-aware event state machine at the scripting
  // choke point (createScripting → dispatchEventInSandbox, installed
  // before webViewerLoad so the first document is covered too):
  //   - the LOGICAL page is tracked from the pagechanging stream by
  //     absorbing the burst's B, A, B pattern (an event whose
  //     `previous` matches the current logical page advances it);
  //   - the sandbox sees a strict Close(prev)/Open(next) alternation:
  //     opens are dropped when duplicated or when they target the
  //     departed page (zombie restart); closes are dropped when the
  //     page is not open or when it is the page we are logically ON
  //     (the burst's bounce pass closing the page just turned TO).
  // In normal mode pdf.js fires a single clean pagechanging per turn,
  // so the same machine is a no-op there.
  //
  // Fix, part 2 — display sync for detached pages.  Wrap
  // annotationStorage.setValue: when the viewer stores a raw
  // {display: N} for an element that is NOT in the DOM (the departed
  // page's layer is detached in PM), remember it, and apply it when
  // the layer comes back (burst settles / page rendered / PM exit).
  // Direct writes to attached elements invalidate pending entries, so
  // a restarting animation always wins over stale remembered state.
  function patchScriptingForPresentationMode(app) {
    const svcs = app.externalServices;
    if (!svcs || typeof svcs.createScripting !== "function") return;

    let inPresentationMode = !!app.pdfViewer?.isInPresentationMode;

    let logicalPage = null;
    let burstTimer = null;
    app.eventBus.on("pagechanging", (evt) => {
      if (evt.pageNumber === evt.previous) return;
      const inBurst = burstTimer !== null;
      if (logicalPage === null || !inBurst || evt.previous === logicalPage) {
        logicalPage = evt.pageNumber;
      }
      if (burstTimer !== null) clearTimeout(burstTimer);
      burstTimer = setTimeout(() => {
        burstTimer = null;
        setTimeout(syncPendingDisplay, 0);
      }, 120);
    });

    // --- sandbox open/close state (part 1) -----------------------------
    let sandboxOpenPage = null;

    // --- pending display writes for detached elements (part 2) --------
    const pendingDisplay = new Map(); // elementId -> visible bool
    const syncPendingDisplay = () => {
      if (pendingDisplay.size === 0) return;
      for (const [elementId, visible] of pendingDisplay) {
        const el = document.querySelector(`[data-element-id="${elementId}"]`);
        if (!el) continue; // still detached; retry on next trigger
        const container = el.closest("section") || el;
        container.style.visibility = visible ? "visible" : "hidden";
        pendingDisplay.delete(elementId);
      }
    };
    // In PM only the current page stays attached; sync remembered
    // visibilities when a layer (re-)attaches (MutationObserver — runs
    // as a microtask, before the /PO restart's display writes land),
    // after each burst settles, after renders, and on PM exit.
    let syncScheduled = false;
    const scheduleSync = () => {
      if (syncScheduled) return;
      syncScheduled = true;
      Promise.resolve().then(() => {
        syncScheduled = false;
        syncPendingDisplay();
      });
    };
    const attachObserver = (retries) => {
      const el = app.pdfViewer?.viewer;
      if (el) {
        new MutationObserver(scheduleSync).observe(el, { childList: true });
        return;
      }
      if (retries > 0) setTimeout(() => attachObserver(retries - 1), 500);
    };
    attachObserver(20); // ~10s
    app.eventBus.on("pagerendered", () => setTimeout(syncPendingDisplay, 0));
    app.eventBus.on("presentationmodechanged", (evt) => {
      inPresentationMode = evt.state > 0;
      if (!inPresentationMode) setTimeout(syncPendingDisplay, 150);
    });

    const hookStorage = (pdfDocument) => {
      const storage = pdfDocument?.annotationStorage;
      if (!storage || storage.__shimPatched) return;
      const origSetValue = storage.setValue.bind(storage);
      storage.setValue = function (elementId, value) {
        if (value && typeof value === "object") {
          if ("display" in value) {
            if (document.querySelector(`[data-element-id="${elementId}"]`)) {
              // raw-path write, element present: it lands via the
              // element dispatch instead — the sandbox has moved on
              pendingDisplay.delete(elementId);
            } else {
              // raw-path write for a detached element: remember the
              // intended visibility for when the layer re-attaches
              pendingDisplay.set(elementId, value.display % 2 === 0);
            }
          } else if (
            "noView" in value &&
            document.querySelector(`[data-element-id="${elementId}"]`)
          ) {
            // element-path display write (lands inline): invalidate
            // any pending entry so fresh state always wins
            pendingDisplay.delete(elementId);
          }
        }
        return origSetValue(elementId, value);
      };
      storage.__shimPatched = true;
    };

    const origCreate = svcs.createScripting.bind(svcs);
    svcs.createScripting = function (...args) {
      const scripting = origCreate(...args);
      const origDispatch = scripting?.dispatchEventInSandbox?.bind(scripting);
      if (!origDispatch) return scripting;

      scripting.dispatchEventInSandbox = async function (detail) {
        if (detail?.id === "page") {
          if (detail.name === "PageOpen") {
            if (
              detail.pageNumber === sandboxOpenPage ||
              (inPresentationMode &&
                logicalPage !== null &&
                detail.pageNumber !== logicalPage)
            ) {
              return; // duplicate open (burst echo) or zombie open of
              // the departed page — either would restart the animate
              // interval; the zombie runs it off-screen
            }
            sandboxOpenPage = detail.pageNumber;
          } else if (detail.name === "PageClose") {
            if (
              detail.pageNumber !== sandboxOpenPage ||
              (inPresentationMode && detail.pageNumber === logicalPage)
            ) {
              return; // close of a page that is not open (corrupted),
              // or of the page we are logically ON (the burst's bounce
              // pass closing the page just turned TO — it would pause
              // autoplay and re-poster it)
            }
            sandboxOpenPage = null;
          }
        }
        return origDispatch(detail);
      };

      // per-document state: a fresh sandbox starts with nothing open,
      // no logical page, no pending writes; hook the new storage too.
      const origCreateSandbox = scripting.createSandbox?.bind(scripting);
      if (origCreateSandbox) {
        scripting.createSandbox = function (...sargs) {
          sandboxOpenPage = null;
          logicalPage = null;
          pendingDisplay.clear();
          const r = origCreateSandbox(...sargs);
          hookStorage(app.pdfDocument);
          return r;
        };
      }
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
