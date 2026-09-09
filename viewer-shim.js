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
//   ← {type:"pointer", x,y,visible}     red pointer position (normalized)
//   ← {type:"tools", laser, marker}     pointer/marker toggle state
//   ← {type:"strokes", page, list}      marker strokes for a page
//   ← {type:"strokesClearAll"}          every marker stroke deleted
(function () {
  "use strict";
  const opener = window.opener;
  if (!opener) return;

  function post(msg) {
    opener.postMessage(msg, "*");
  }

  // --- presenter tools overlay (pointer + marker) --------------------
  // Screen-only layer per page div: a red dot for the pointer and an
  // SVG with the marker strokes (normalized coordinates).  Injected on
  // demand and re-injected on every layer attach (pdf.js rebuilds page
  // children during zoom/Presentation Mode), same MutationObserver
  // pattern as the animation fix.  Purely visual: no annotationStorage
  // writes, so printing and animations are untouched.
  const toolsOverlay = {
    laserOn: false,
    markerOn: false,
    pointer: { x: 0.5, y: 0.5, visible: false },
    strokes: new Map(), // page -> [ {pts, color, width} ]
    dot: null,
    svg: null,
  };

  function removeToolsOverlay() {
    toolsOverlay.dot?.remove();
    toolsOverlay.svg?.remove();
    toolsOverlay.dot = null;
    toolsOverlay.svg = null;
    toolsOverlay.pageDiv = null;
  }

  function ensureToolsOverlay(pageDiv) {
    if (!pageDiv) return;
    // Re-inject when the page div changes OR when pdf.js rebuilt the
    // div's children (replaceChildren drops appended overlays).
    if (
      toolsOverlay.dot &&
      toolsOverlay.pageDiv === pageDiv &&
      pageDiv.contains(toolsOverlay.dot)
    )
      return;
    removeToolsOverlay();
    toolsOverlay.pageDiv = pageDiv;
    const dot = document.createElement("div");
    dot.className = "pc-laser-dot";
    const svg = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg"
    );
    svg.setAttribute("class", "pc-ink-svg");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("viewBox", "0 0 1000 1000");
    toolsOverlay.dot = dot;
    toolsOverlay.svg = svg;
    pageDiv.append(dot, svg);
    applyPointer();
    renderStrokes();
  }

  function applyPointer() {
    const dot = toolsOverlay.dot;
    if (!dot) return;
    if (!toolsOverlay.laserOn || !toolsOverlay.pointer.visible) {
      dot.style.display = "none";
      return;
    }
    dot.style.left = toolsOverlay.pointer.x * 100 + "%";
    dot.style.top = toolsOverlay.pointer.y * 100 + "%";
    dot.style.display = "block";
  }

  function renderStrokes() {
    const svg = toolsOverlay.svg;
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const list = toolsOverlay.strokes.get(currentPageNumber()) || [];
    for (const s of list) {
      if (!s.pts || !s.pts.length) continue;
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path"
      );
      let d = `M ${s.pts[0][0] * 1000} ${s.pts[0][1] * 1000}`;
      for (let i = 1; i < s.pts.length; i++) {
        d += ` L ${s.pts[i][0] * 1000} ${s.pts[i][1] * 1000}`;
      }
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", s.color || "rgba(230,30,30,0.9)");
      path.setAttribute("stroke-width", (s.width || 0.0045) * 1000);
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(path);
    }
  }

  // Track the CURRENT page div: overlays must live inside it so page
  // scrolling/zoom transforms them with the slide.
  function currentPageNumber() {
    const app = toolsOverlay.app || window.PDFViewerApplication;
    return app?.pdfViewer?.currentPageNumber ?? toolsOverlay.page;
  }

  function currentPageDiv() {
    const n = currentPageNumber();
    if (!n) return null;
    return document.querySelector(`[data-page-number="${n}"]`);
  }

  function syncToolsOverlay() {
    ensureToolsOverlay(currentPageDiv());
  }

  function wire(app) {
    if (!app || !app.eventBus) return false;
    app.eventBus.on("pagechanging", (evt) => {
      post({ type: "pagechange", page: evt.pageNumber, total: app.pagesCount });
      syncToolsOverlay();
      renderStrokes();
    });
    patchScriptingForPresentationMode(app);
    toolsOverlay.app = app;
    // Overlays must follow the viewer's own page rebuilds (zoom, PM
    // entry/exit): re-inject when the current page div changes children.
    // Debounced — pdf.js rebuilds many children in bursts during zoom.
    let syncScheduled = false;
    const scheduleSync = () => {
      if (syncScheduled) return;
      syncScheduled = true;
      Promise.resolve().then(() => {
        syncScheduled = false;
        syncToolsOverlay();
      });
    };
    const attachWatcher = () => {
      const viewer = app.pdfViewer?.viewer;
      if (viewer) {
        new MutationObserver(scheduleSync).observe(viewer, {
          childList: true,
          subtree: true,
        });
        return;
      }
      setTimeout(attachWatcher, 500);
    };
    attachWatcher();
    // Hovering the AUDIENCE window itself drives the pointer too: the
    // presenter may stand at the podium machine.  Normalized against the
    // current page's canvasWrapper (= exactly the rendered slide area),
    // mirrored back to the console so its preview dot follows as well.
    let hoverFrame = null;
    let hoverPending = null;
    document.addEventListener("pointermove", (ev) => {
      if (!toolsOverlay.laserOn) return;
      const pageDiv = currentPageDiv();
      const cw = pageDiv?.querySelector(":scope > .canvasWrapper");
      if (!cw) return;
      const r = cw.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const x = (ev.clientX - r.left) / r.width;
      const y = (ev.clientY - r.top) / r.height;
      const inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
      hoverPending = { x, y, visible: inside };
      if (hoverFrame !== null) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = null;
        toolsOverlay.pointer = hoverPending;
        applyPointer();
        post({ type: "pointerFromAudience", ...hoverPending });
      });
    });
    document.addEventListener("pointerleave", () => {
      if (!toolsOverlay.laserOn) return;
      toolsOverlay.pointer = { x: 0, y: 0, visible: false };
      applyPointer();
      post({ type: "pointerFromAudience", x: 0, y: 0, visible: false });
    });
    return true;
  }

  // --- pdf.js presentation-mode animation fix (v5) --------------------
  // Part 3 (v5) additionally suppresses the poster-frame flash on page
  // entry for autoplay animations — see the part-3 block below.
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
        new MutationObserver(() => {
          scheduleSync();
          // flip AFTER syncPendingDisplay's microtask so remembered
          // raw-path writes apply first and the flip normalizes on top
          Promise.resolve().then(suppressPosterFlash);
        }).observe(el, {
          childList: true,
          subtree: true, // catch annotation layer / section attaches
        });
        return;
      }
      if (retries > 0) setTimeout(() => attachObserver(retries - 1), 500);
    };
    attachObserver(20); // ~10s
    app.eventBus.on("pagerendered", () => {
      suppressPosterFlash();
      setTimeout(syncPendingDisplay, 0);
    });
    app.eventBus.on("pagechanging", () => suppressPosterFlash());
    app.eventBus.on("presentationmodechanged", (evt) => {
      inPresentationMode = evt.state > 0;
      if (!inPresentationMode) setTimeout(syncPendingDisplay, 150);
    });

    // --- poster-flash suppression for autoplay animations (part 3) ---
    // animate's [autoplay,poster=last] PDFs REST on the final frame
    // (the poster): every frame widget except the poster is /F 2
    // (hidden).  pdf.js paints that static state the moment a page's
    // annotation layer attaches, but the animate PageOpen JS only
    // runs ~100ms later (render FINISHED + sandbox round-trip), so
    // the audience briefly sees the FINAL frame — the faint "arrows
    // on the first frame" flash — before frame 0 appears and
    // playback starts.  Fix: when a layer attaches and an autoplay
    // animation sits in its pristine poster state, pre-apply the very
    // display change the PageOpen JS is about to make (poster hidden,
    // frame 0 visible) inside the same microtask as the attach
    // mutation — before the browser can paint.  Screen-only (inline
    // styles only, no annotationStorage writes): printing and the
    // later real JS state are unaffected, and layer rebuilds re-run
    // the flip via the same observer.
    let animMap = null; // [{page, frames:[{k,id}], firstId, posterId, autoplay}]
    let animMapPromise = null;
    const ensureAnimMap = () => {
      const doc = app.pdfDocument;
      if (animMapPromise || !doc) return;
      animMapPromise = (async () => {
        let fields = null;
        try {
          fields = await doc.getFieldObjects();
        } catch (e) {
          return;
        }
        if (!fields || typeof fields.entries !== "function") return;
        // frame widgets are named "<animNum>.<k>" on the anm's page
        const framesByName = new Map();
        for (const [name, arr] of fields.entries()) {
          const m = /^(\d+)\.(\d+)$/.exec(name);
          if (m && arr && arr.length) {
            framesByName.set(name, {
              n: m[1],
              k: +m[2],
              id: arr[0].id,
              page: arr[0].page,
            });
          }
        }
        const map = [];
        for (const [name, arr] of fields.entries()) {
          const m = /^anm(\d+)$/.exec(name);
          if (!m || !arr || !arr.length) continue;
          const n = m[1];
          const main = arr[0];
          const frames = [];
          for (const fr of framesByName.values()) {
            if (fr.n === n && fr.page === main.page) frames.push(fr);
          }
          if (!frames.length) continue;
          frames.sort((a, b) => a.k - b.k);
          // autoplay: the /PO script ends with an UNCONDITIONAL
          // playFwd/playBwd dispatch (autoresume wraps it in isPaused,
          // button-controlled animations have no play call at all)
          let autoplay = false;
          try {
            const po = main.actions?.get?.("PageOpen");
            const js = Array.isArray(po) ? po.join("\n") : "";
            autoplay = js.endsWith(
              "_playsRight){a" + n + "_playFwd();}else{a" + n + "_playBwd();}"
            );
          } catch (e) {}
          map.push({
            page: main.page + 1,
            frames,
            firstId: frames[0].id,
            posterId: frames[frames.length - 1].id,
            autoplay,
          });
        }
        if (app.pdfDocument === doc) {
          animMap = map;
          // the current page's layer may have attached while the
          // field-object round-trip was in flight — flip it now
          suppressPosterFlash();
        }
      })();
    };
    const applyAnimDisplay = (section, id, visible) => {
      section.style.visibility = visible ? "visible" : "hidden";
      // direct write invalidates any pending raw-path write (the
      // shim's rule: fresh state always wins over remembered state)
      pendingDisplay.delete(id);
    };
    const suppressPosterFlash = () => {
      if (!animMap || !animMap.length) return;
      for (const anim of animMap) {
        if (!anim.autoplay) continue;
        const pageDiv = document.querySelector(
          '[data-page-number="' + anim.page + '"]'
        );
        const layer = pageDiv?.querySelector(".annotationLayer");
        if (!layer) continue;
        let posterSection = null,
          posterVisible = false,
          firstSection = null,
          visibleCount = 0,
          complete = true;
        for (const fr of anim.frames) {
          const sec = layer.querySelector(
            '[data-annotation-id="' + fr.id + '"]'
          );
          if (!sec) {
            complete = false;
            break;
          }
          const vis = getComputedStyle(sec).visibility !== "hidden";
          if (fr.id === anim.posterId) {
            posterSection = sec;
            posterVisible = vis;
          }
          if (fr.id === anim.firstId) firstSection = sec;
          if (vis) visibleCount++;
        }
        if (!complete || !posterSection || !firstSection) continue;
        if (!posterVisible || visibleCount !== 1) continue; // not pristine
        // pristine poster state: pre-apply the PageOpen JS's first
        // display change (playFwd -> stopFirst -> seekFrame(0))
        applyAnimDisplay(posterSection, anim.posterId, false);
        applyAnimDisplay(firstSection, anim.firstId, true);
      }
    };

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
          animMap = null;
          animMapPromise = null;
          const r = origCreateSandbox(...sargs);
          hookStorage(app.pdfDocument);
          ensureAnimMap();
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

  // Heartbeat: the console page can reload (F5) and lose its reference
  // to this popup.  A periodic hello lets a reloaded console re-adopt
  // this window and re-push the deck; the console ignores hellos while
  // everything is already in sync.
  setInterval(() => {
    try {
      if (!opener.closed) post({ type: "hello" });
    } catch {}
  }, 2000);

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || typeof d !== "object") return;
    const app = window.PDFViewerApplication;
    if (d.type === "load" && app && app.open) {
      // New deck: drop any presenter-tools state tied to the old one.
      removeToolsOverlay();
      toolsOverlay.strokes.clear();
      toolsOverlay.pointer = { x: 0, y: 0, visible: false };
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
    } else if (d.type === "pointer") {
      toolsOverlay.pointer = { x: d.x, y: d.y, visible: d.visible };
      applyPointer();
    } else if (d.type === "tools") {
      toolsOverlay.laserOn = !!d.laser;
      toolsOverlay.markerOn = !!d.marker;
      applyPointer();
    } else if (d.type === "strokes") {
      toolsOverlay.strokes.set(d.page, d.list || []);
      if (d.page === currentPageNumber()) renderStrokes();
    } else if (d.type === "strokesClearAll") {
      toolsOverlay.strokes.clear();
      renderStrokes();
    }
  });
})();
