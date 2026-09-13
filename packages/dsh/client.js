// Client half of the llm-workbuddy dsh plugin.
//
// dsh loads this file via the package's `exports["./client"]` entry. It must be
// a plain CommonJS module that calls `window.__ModuleLoader__.load(...)` — no
// build step. It registers a `settings.section` that embeds core's Vue
// management UI (served by the Node half at /workbuddy/) inside dsh's own
// Settings panel, so the user configures token/login naturally.
window.__ModuleLoader__.load({
  // Must equal the package name: dsh addresses the client bundle as
  // `<package-name>/client.js` in its combo URL, and the loader keys the
  // registration by this id.
  id: "@wbaw/dsh-workbuddy",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");

    // The embedded management UI. Fills the settings section area.
    //
    // dsh's settings dialog layout is hostile to plain CSS:
    //   - The section host is `display: contents`, breaking any flex/percent
    //     chain from inside the section up to the dialog.
    //   - The real layout slot for the section is `.VOzbGW_options` (a
    //     `position: static`, `overflow: auto` block sized by the dialog
    //     minus the left nav rail and the dialog header). Wrapping the iframe
    //     in `position: absolute; inset: 0` anchors it to the nearest
    //     positioned ancestor, which is `.VOzbGW_panel` — the WHOLE dialog
    //     (763x765 incl. header + left nav), so the iframe overflows into
    //     regions dsh already paints itself.
    //
    // Fix: position the wrapper with `position: fixed` and copy
    // `.VOzbGW_options`'s viewport rect (`getBoundingClientRect`) into
    // inline `top/left/width/height` on every layout tick. A ResizeObserver
    // on `.VOzbGW_options` plus `window.addEventListener("resize",
    // ...)` keeps the wrapper glued when dsh animates the dialog open /
    // closed or the user resizes the window. The wrapper lives in a portal-
    // like role: when the section unmounts, React removes the wrapper from
    // the DOM and the observer/listeners with it, so there's no leak.
    //
    // The iframe src carries a unique query so the browser can never serve
    // a cached copy of the SPA HTML from a previous run (the served HTML has
    // Cache-Control: no-store, but the BROWSER cache from BEFORE that header
    // was added can still hit on the same URL — a unique query forces a real
    // network fetch every time).
    //
    // The catch: this component must compute `v` exactly ONCE per real mount.
    // If we read `Date.now()` inside the render body, every React re-render
    // (parent state change, settings dialog toggle, anything) produces a new
    // `v`, which becomes a new `key` on the iframe, which makes React
    // UNMOUNT and re-create the iframe — the entire Vue app boots from
    // scratch, the user's region choice resets, the UI flashes, and clicks
    // mid-render get swallowed. useState's lazy initializer runs only on the
    // first render, so it locks the timestamp in for the component's lifetime.
    function WorkbuddySettings() {
      var srcRef = react.useState(function () { return "_=" + Date.now(); })[0];
      var ref = react.useRef(null);

      react.useEffect(function () {
        var wrapper = ref.current;
        if (!wrapper) return;
        var host = wrapper.closest(".VOzbGW_options");
        if (!host) {
          // Layout changed under us (dsh refactor, different dialog family).
          // Fall back to filling the viewport; better than zero.
          wrapper.style.top = "0";
          wrapper.style.left = "0";
          wrapper.style.width = "100vw";
          wrapper.style.height = "100vh";
          return;
        }
        function sync() {
          var r = host.getBoundingClientRect();
          wrapper.style.top = r.top + "px";
          wrapper.style.left = r.left + "px";
          wrapper.style.width = r.width + "px";
          wrapper.style.height = r.height + "px";
        }
        sync();
        var ro = new ResizeObserver(sync);
        ro.observe(host);
        window.addEventListener("resize", sync);
        return function () {
          ro.disconnect();
          window.removeEventListener("resize", sync);
        };
      }, []);

      return react.createElement(
        "div",
        {
          ref: ref,
          style: {
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            zIndex: 0,
          },
        },
        react.createElement("iframe", {
          key: srcRef,
          ref: function (el) { currentIframe = el; },
          // `lang` rides the query so the Node half can inject it into the
          // served HTML: the first paint is already translated, instead of
          // rendering English and flipping once the iframe loads. It is
          // captured at mount (the host's language rarely moves, and a change
          // is handled live by the bridge below).
          src:
            "/workbuddy/?" +
            srcRef +
            (currentLocale ? "&lang=" + encodeURIComponent(currentLocale) : ""),
          title: "WorkBuddy Anywhere",
          style: {
            width: "100%",
            height: "100%",
            border: "none",
            display: "block",
            // dsh's dialog panel itself has a 32px border-radius at every
            // corner. The iframe sits inside `.VOzbGW_options`, which is
            // a tight rectangle that extends into the panel's bottom-right
            // rounded-corner zone — only there, because that's the one
            // corner where `.VOzbGW_options` (positioned at the bottom-right
            // of the panel) actually meets the panel's own rounded corner.
            // The other three corners of the iframe sit comfortably inside
            // the panel's flat edges. Round ONLY the iframe's bottom-right
            // corner to match the panel's curve there; leave the other
            // three corners flush so the iframe hugs the panel's straight
            // edges exactly. (Core UI's own rounded corners at TL/BR are
            // 20px, so they stay visible inside the iframe's 32px BR clip.)
            borderBottomRightRadius: "32px",
          },
          onLoad: function (e) {
            pushThemeInto(e.currentTarget);
            // Re-assert the language: the src tag covers the boot, this covers
            // a host language change that happened while the panel was closed.
            applyLocaleTo(e.currentTarget, currentLocale);
          },
        })
      );
    }

    // The resolved dsh theme, read from dsh's OWN service — `ctx.theme`
    // (`@deepseek-ai/dsh-client-ui-theme` provides it, and `theme/change`
    // fires whenever the user picks a different one or `system` flips with the
    // OS). This is the clean signal: no DOM scraping, no MutationObserver, no
    // polling.
    var currentThemeKind = null;

    /**
     * Copy dsh's resolved theme into the embedded management page.
     *
     * The iframe is a SEPARATE DOCUMENT: CSS custom properties do not cross the
     * boundary, so dsh's `--dsw-*` tokens are invisible to core's UI. dsh's own
     * theme service is the authoritative source, and it tells us two things we
     * need:
     *
     *   1. `colorScheme` ("dark" | "light") — core ships both palettes and
     *      activates the light one with a `light` class on <html>, so toggling
     *      that class is all it takes for core to look right in either theme.
     *   2. The dark palette we pin via inline `--wb-*` overrides was measured
     *      from dsh's DARK dialog. Those values must be REMOVED in light mode,
     *      otherwise they would hold core at dark colours under a light shell.
     */
    function pushThemeInto(iframeEl) {
      if (!iframeEl) return;
      var doc;
      try {
        // Same origin (both served from this host), so this is safe.
        doc = iframeEl.contentDocument;
      } catch (_e) {
        return;
      }
      if (!doc || !doc.documentElement) return;
      var root = doc.documentElement;
      var light = currentThemeKind === "light";
      root.classList.toggle("light", light);
      if (light) {
        // Drop the pinned dark palette so core's own light variables apply.
        var styleMap = root.style;
        for (var i = styleMap.length - 1; i >= 0; i--) {
          var name = styleMap.item(i);
          if (name.indexOf("--wb-") === 0) styleMap.removeProperty(name);
        }
      }
    }

    /** Read the current theme kind from dsh, then sync the iframe to it. */
    function syncTheme(ctx, iframeEl) {
      var snapshot;
      try {
        snapshot = ctx.theme && ctx.theme.getTheme ? ctx.theme.getTheme() : null;
      } catch (_e) {
        return;
      }
      var scheme =
        snapshot && snapshot.active && snapshot.active.colorScheme
          ? snapshot.active.colorScheme
          : snapshot && snapshot.preference === "light"
            ? "light"
            : null;
      if (!scheme) return;
      currentThemeKind = scheme;
      pushThemeInto(iframeEl || currentIframe);
    }

    // ── Locale ────────────────────────────────────────────────────────────
    //
    // dsh's ACTIVE language, as a raw tag ("zh-CN"). Read from dsh's own
    // locale service, which is the authoritative source — NOT from
    // `$DSH_HOME/settings.yaml`, which only carries a value once the user
    // EXPLICITLY picks a language in dsh's Settings. dsh's default is
    // "follow the browser", so a Chinese macOS yields Chinese with nothing
    // written to that file at all; reading the file would then find no
    // preference, inject nothing, and leave the embedded page on its own
    // `index.html` default of English.
    //
    // `ctx.locale.getLocale().active` is that resolved value, and
    // `locale/change` fires when it moves (`syncDocumentLanguage` set
    // `document.documentElement.lang` from the same snapshot, so the DOM
    // fallback below agrees with the service when the service is absent).
    var currentLocale = null;

    /** Read dsh's active language tag, preferring the service over the DOM. */
    function readDshLocale(ctx) {
      try {
        var snap = ctx.locale && ctx.locale.getLocale ? ctx.locale.getLocale() : null;
        if (snap && typeof snap.active === "string" && snap.active) return snap.active;
      } catch (_e) {
        /* fall through to the DOM */
      }
      // Same document we are running in — dsh writes its resolved language
      // here (`syncDocumentLanguage`), so this is equivalent, not a guess.
      var lang = document.documentElement.lang;
      return lang ? lang : null;
    }

    /**
     * Point the embedded page at a language tag.
     *
     * Two channels, for two different moments:
     *   - the tag rides the iframe `src` so the SERVER injects it into the
     *     HTML and the very first paint is already translated (no flash of
     *     English);
     *   - a live change (the user switches language with the panel open) has
     *     no new HTML to inject, so we call the bridge core exposes from
     *     `main.ts` — the only way across the document boundary.
     */
    function applyLocaleTo(iframeEl, tag) {
      if (!tag || !iframeEl) return;
      var win;
      try {
        win = iframeEl.contentWindow;
      } catch (_e) {
        return;
      }
      if (!win || typeof win.__WORKBUDDY_APPLY_LOCALE__ !== "function") return;
      try {
        win.__WORKBUDDY_APPLY_LOCALE__(tag);
      } catch (_e) {
        /* a not-yet-booted document simply gets it on the next onLoad */
      }
    }

    /** Read dsh's language, then sync the iframe to it. */
    function syncLocale(ctx, iframeEl) {
      var tag = readDshLocale(ctx);
      if (!tag) return;
      currentLocale = tag;
      applyLocaleTo(iframeEl || currentIframe, tag);
    }

    /** The mounted settings iframe, so a theme/locale change can find it. */
    var currentIframe = null;

    // `theme` and `locale` are dsh's own services (provided by
    // dsh-client-ui-theme / dsh-client-locale); injecting them is what makes
    // `ctx.theme` / `ctx.locale` readable in `apply`.
    var inject = ["slots", "modelDirectories", "theme", "locale"];

    // ------------------------------------------------------------------------
    // Composer-slot injections.
    //
    // Two kinds of occupants live here:
    //
    //   (a) A real WorkBuddy credit chip in `conversation.input.left` — sits
    //       immediately to the LEFT of the model selector, reads quota from
    //       `/workbuddy/api/usage` (proxied by the Node half), and clicks
    //       through to the WorkBuddy settings iframe. This is the temporary
    //       resting place; the user is still deciding where it really belongs.
    //
    //   (b) Visible PLACEHOLDER bars in every other candidate slot, so the
    //       user can SEE where each one is on screen and pick the one they
    //       like. Each placeholder is a tiny yellow chip tagged with the
    //       exact slot name, so the answer to "where does this surface"
    //       stops being guesswork. The placeholders are temporary and are
    //       expected to be removed once the user picks a slot.
    // ------------------------------------------------------------------------

    // The chip + popover need one small style sheet, shared by both. The
    // WorkBuddy mark is a single-color SVG painted via CSS mask so it
    // inherits the text colour — the same trick dsh uses for its own
    // trigger icons. It lives at module level because BOTH the style sheet
    // (below) and the settings-nav icon painting reference it.
    var WB_ICON_DATAURL = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M32%206.91V10.05L31.21%209.65L29.28%206.43L27.10%203.65L25.74%202.41L24.86%202.22L24.06%202.95L23.01%204.60L20.69%209.95L17.82%2010.98L15.44%2012.16L12.90%2013.82L10.51%2015.83L4.70%2015.14L2.89%2015.20L1.74%2015.58L1.50%2015.95L1.48%2016.57L2.08%2018.86L3.24%2021.52L5.07%2024.85L5.14%2028.06L4.34%2029.61L4.32%2031.49L2.52%2030.43L1.16%2028.93L0.30%2027.10L0.03%2025.77V6.23L0.53%204.26L1.16%203.07L2.02%202.02L3.07%201.16L4.90%200.30L6.91%200H25.09L26.44%200.13L27.74%200.53L28.93%201.16L30.43%202.52L31.18%203.65L31.70%204.90L32%206.91ZM13.72%2019.56L24.47%2013.43L26.63%2012.92L28.64%2013.07L30%2013.52L31.25%2014.26L32.33%2015.25L33.10%2016.33L35.45%2020.66L35.80%2022.39L35.65%2024.40L35.19%2025.76L34.46%2027L33.46%2028.09L32.20%2028.97L20.37%2035.73L18.21%2036.25L16.20%2036.10L14.08%2035.23L12.36%2033.74L9.79%2029.42L9.11%2027.35L9.13%2025.05L10.06%2022.64L11.43%2021.02L13.72%2019.56ZM18.38%2024.85L16.18%2024.27L15.60%2026.46L17.32%2029.45L19.52%2030.03L20.10%2027.84L18.38%2024.85ZM24.84%2019.27L24.25%2021.46L25.98%2024.45L28.17%2025.04L28.76%2022.85L27.03%2019.86L24.84%2019.27Z%22%20fill%3D%22black%22%20fill-rule%3D%22evenodd%22%2F%3E%3C%2Fsvg%3E";

    var WB_CHIP_STYLE_ID = "llm-workbuddy-chip-style";
    function ensureSlotStyle() {
      if (document.getElementById(WB_CHIP_STYLE_ID)) return;
      var s = document.createElement("style");
      s.id = WB_CHIP_STYLE_ID;
      s.setAttribute("data-plugin", "llm-workbuddy");
      s.textContent = [
        // Trigger button — aligned with dsh's model-selector trigger
        // (._7KE1Ra_trigger): bare icon+label, no border, ghost hover.
        ".wb-credit-chip {",
        "  min-width: 0;",
        "  height: 28px;",
        "  color: var(--dsw-alias-label-secondary, inherit);",
        "  cursor: pointer;",
        "  background: 0 0;",
        "  border: none;",
        "  border-radius: 24px;",
        "  outline: none;",
        "  align-items: center;",
        "  gap: 4px;",
        "  padding: 0 4px 0 8px;",
        "  font: inherit;",
        "  font-size: 13px;",
        "  font-weight: 500;",
        "  line-height: 20px;",
        "  display: flex;",
        "  user-select: none;",
        "  white-space: nowrap;",
        "}",
        ".wb-credit-chip:hover { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent)); }",
        ".wb-credit-chip:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3, transparent); }",
        ".wb-credit-chip[data-state='loading'] { opacity: 0.55; }",
        // The WorkBuddy mark, single-color via mask so it inherits the
        // trigger's label colour exactly like dsh's own trigger icons.
        ".wb-credit-icon {",
        "  width: 16px;",
        "  height: 16px;",
        "  flex: none;",
        "  background-color: currentColor;",
        "  -webkit-mask: url(\"" + WB_ICON_DATAURL + "\") no-repeat center / contain;",
        "  mask: url(\"" + WB_ICON_DATAURL + "\") no-repeat center / contain;",
        "}",
        ".wb-credit-label { overflow: hidden; text-overflow: ellipsis; }",
        // Popover menu — aligned with dsh's model-selector menu
        // (._7KE1Ra_menu): menu surface token, 20px radius, 4px padding,
        // prominent elevation, portal-fixed positioning.
        ".wb-popover {",
        "  position: fixed;",
        "  z-index: 1100;",
        "  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, #1c1c1e));",
        "  color: var(--dsw-alias-label-primary, inherit);",
        "  width: max-content;",
        "  min-width: 240px;",
        "  max-width: min(420px, 100vw - 32px);",
        "  max-height: min(360px, 100vh - 96px);",
        "  box-shadow: var(--dsw-elevation-prominent, 0 8px 30px rgba(0,0,0,0.28));",
        "  border: 0;",
        "  border-radius: 20px;",
        "  padding: 4px;",
        "  display: flex;",
        "  flex-direction: column;",
        "  overflow: hidden;",
        "  font: inherit;",
        "  font-size: 13px;",
        "  line-height: 20px;",
        "}",
        ".wb-popover-head {",
        "  display: flex;",
        "  align-items: center;",
        "  justify-content: space-between;",
        "  padding: 8px 10px 2px;",
        "  font-size: 12px;",
        "  font-weight: 500;",
        "  color: var(--dsw-alias-label-tertiary, inherit);",
        "}",
        ".wb-popover-head .wb-refresh {",
        "  background: none;",
        "  border: none;",
        "  color: inherit;",
        "  cursor: pointer;",
        "  font: inherit;",
        "  font-size: 12px;",
        "  padding: 2px 8px;",
        "  border-radius: 8px;",
        "}",
        ".wb-popover-head .wb-refresh:hover { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent)); }",
        // Progress bar — the quota the ACTIVE (region-filtered) account holds.
        ".wb-quota { padding: 6px 10px 4px; }",
        ".wb-progress {",
        "  height: 6px;",
        "  border-radius: 3px;",
        "  background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 12%, transparent));",
        "  overflow: hidden;",
        "}",
        ".wb-progress-fill {",
        "  height: 100%;",
        "  border-radius: 3px;",
        "  background: var(--wb-credit-color, #30d158);",
        "  transition: width 200ms ease;",
        "}",
        ".wb-quota-row {",
        "  display: flex;",
        "  justify-content: space-between;",
        "  font-size: 12px;",
        "  color: var(--dsw-alias-label-tertiary, inherit);",
        "  margin-top: 4px;",
        "}",
        // Section headers, matching the model menu's sticky group titles.
        ".wb-section-label {",
        "  color: var(--dsw-alias-label-tertiary, inherit);",
        "  padding: 6px 10px 3px;",
        "  font-size: 12px;",
        "  font-weight: 500;",
        "  line-height: 18px;",
        "}",
        // Account cells — matching the model menu's option cells
        // (._7KE1Ra_cell): 40px tall, 10px radius, hover token.
        ".wb-account {",
        "  box-sizing: border-box;",
        "  width: 100%;",
        "  color: var(--dsw-alias-label-primary, inherit);",
        "  cursor: pointer;",
        "  text-align: left;",
        "  background: 0 0;",
        "  border: none;",
        "  border-radius: 10px;",
        "  padding: 8px 10px;",
        "  font: inherit;",
        "  font-size: 14px;",
        "  line-height: 22px;",
        "  display: block;",
        "}",
        ".wb-account:hover { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent)); }",
        ".wb-account:disabled { opacity: 0.5; cursor: default; }",
        // The touched row keeps full contrast but shows a subtle pulse, so
        // "working on THIS one" reads without dimming the whole menu.
        ".wb-account[data-pending='true'] { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent)); }",
        ".wb-account[data-pending='true'] .wb-account-sub { opacity: 0.5; }",
        // Line 1: name + badges, flexible width so long names truncate.
        ".wb-account .wb-account-main { display: block; min-width: 0; }",
        ".wb-account .wb-account-line { display: flex; align-items: center; gap: 8px; }",
        ".wb-account .wb-account-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
        ".wb-account .wb-account-badge {",
        "  font-size: 11px;",
        "  line-height: 16px;",
        "  padding: 0 6px;",
        "  border-radius: 6px;",
        "  background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 12%, transparent));",
        "  color: var(--dsw-alias-label-tertiary, inherit);",
        "}",
        ".wb-account .wb-account-check { flex: none; color: var(--dsw-alias-label-primary, inherit); }",
        // Line 2: credits left / percent right — smaller and tertiary.
        ".wb-account .wb-account-sub {",
        "  display: flex;",
        "  justify-content: space-between;",
        "  font-size: 12px;",
        "  line-height: 18px;",
        "  color: var(--dsw-alias-label-tertiary, inherit);",
        "  margin-top: 2px;",
        "}",
        // The bare 自动 row keeps the single-line shape.
        "button.wb-account > .wb-account-name:first-child:last-child { flex: 1; }",
        ".wb-empty { font-size: 13px; color: var(--dsw-alias-label-tertiary, inherit); padding: 8px 10px 10px; }",
      ].join("\n");
      document.head.appendChild(s);
    }

    // The two WorkBuddy routes this plugin registers with dsh. The chip
    // renders only while the user is on one of these providers. Defined as
    // a Set for O(1) lookup and to make the visibility rule one obvious
    // place to update when (and only when) the registered routes change.
    var WORKBUDDY_PROVIDERS = new Set(["workbuddy", "workbuddy-intl"]);

    // The credit chip + popover. dsh wires each session-scoped list-slot
    // entry an `injected` face (see our `inject: (sessionId) => ({ store })`
    // below) containing the per-session `SnapshotStore<ModelDirectoryState>`
    // owned by `ctx.modelDirectories`. We subscribe through React's
    // `useSyncExternalStore` so the chip re-renders exactly when the active
    // selection changes — no DOM scraping, no MutationObserver, no polling.
    //
    // Clicking the chip opens a small popover (anchored to the chip, closed
    // on outside-click / Escape) that lets the user:
    //   - see the active account's credit balance as a progress bar
    //   - switch region (CN / INTL)
    //   - toggle auto-account selection
    //   - switch the active account
    // All mutations go through the same `/workbuddy/api/*` RPC proxy the
    // embedded management UI uses, so the popover and the settings page stay
    // in sync.
    function WorkbuddyCreditChip(props) {
      var useState = react.useState;
      var useEffect = react.useEffect;
      var useRef = react.useRef;
      var useSyncExternalStore = react.useSyncExternalStore;
      var createElement = react.createElement;
      ensureSlotStyle();
      // `props.store` is supplied by our slot `inject` callback. In the
      // session-scarce phases (no session yet, or the composer is in the
      // hero placeholder) dsh still mounts the slot but with no injected
      // face — treat that as "no active model" and hide the chip.
      var store = props && props.store;
      var modelState = store
        ? useSyncExternalStore(
            function (fn) { return store.subscribe(fn); },
            function () { return store.getSnapshot(); },
            function () { return store.getSnapshot(); }
          )
        : null;
      var provider = modelState && modelState.current && modelState.current.provider;
      var providerMatches = !!(provider && WORKBUDDY_PROVIDERS.has(provider));
      // The region is DERIVED from the active model group's provider, never
      // user-picked: `workbuddy` (CN) → "cn", `workbuddy-intl` → "intl".
      // This keeps the chip's data in lockstep with whichever cluster the
      // current model actually talks to.
      var derivedRegion = provider === "workbuddy-intl" ? "intl" : "cn";

      // WorkBuddy account/usage state, fetched from the RPC proxy.
      var _b = useState(null); // { usage, state } snapshot
      var wb = _b[0];
      var setWb = _b[1];
      var _c = useState(false);
      var open = _c[0];
      var setOpen = _c[1];
      var _d = useState(null); // popover position {left, top}
      var pos = _d[0];
      var setPos = _d[1];
      // Which mutation is in flight: null, "auto", or an account key. Only
      // that row renders as pending — see `patchLocal` for why.
      var _e = useState(null);
      var pending = _e[0];
      var setPending = _e[1];
      var triggerRef = useRef(null);
      var popRef = useRef(null);

      // Load the full service state. Every account row already carries its
      // own usage snapshot (`accounts[].usage`), and `state.usage`/the
      // region-scoped active account mirror it — so ONE request serves the
      // chip, the progress bar, AND the per-account credit lines. The
      // region is always the one derived from the current model group's
      // provider (`derivedRegion`), so the data shown always matches the
      // cluster the active model talks to.
      function loadWb() {
        return fetch("/workbuddy/api/" + derivedRegion + "/state", { credentials: "include" })
          .then(function (resp) { return resp.ok ? resp.json() : null; })
          .then(function (svc) {
            if (!svc) return;
            setWb({ state: svc });
          })
          .catch(function () {
            setWb({ state: null, error: true });
          });
      }

      // Load once when the chip is visible, and RELOAD whenever the derived
      // region changes: switching the model group moves chat to the other
      // cluster (a different active account + different credits), so the
      // previously loaded snapshot is stale the moment the provider flips.
      useEffect(function () {
        if (!providerMatches) return;
        var cancelled = false;
        loadWb();
        var id = setInterval(function () {
          if (!cancelled) loadWb();
        }, 60_000);
        return function () { cancelled = true; clearInterval(id); };
      }, [providerMatches, derivedRegion]);

      // Close on outside click / Escape while open.
      useEffect(function () {
        if (!open) return;
        function onDown(e) {
          if (triggerRef.current && triggerRef.current.contains(e.target)) return;
          if (popRef.current && popRef.current.contains(e.target)) return;
          setOpen(false);
        }
        function onKey(e) {
          if (e.key === "Escape") setOpen(false);
        }
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return function () {
          document.removeEventListener("mousedown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);

      // Position the popover above the chip when it opens.
      useEffect(function () {
        if (!open) { setPos(null); return; }
        function place() {
          var rect = triggerRef.current && triggerRef.current.getBoundingClientRect();
          if (!rect) return;
          var MARGIN = 12;
          var pw = popRef.current ? popRef.current.offsetWidth : 280;
          var ph = popRef.current ? popRef.current.offsetHeight : 200;
          var x = rect.right - pw;
          var y = rect.top - 8 - ph;
          if (pw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - pw - MARGIN);
          if (ph > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - ph - MARGIN);
          setPos({ left: x, top: y });
        }
        place();
        window.addEventListener("scroll", place, true);
        window.addEventListener("resize", place);
        return function () {
          window.removeEventListener("scroll", place, true);
          window.removeEventListener("resize", place);
        };
      }, [open, wb]);

      // Render nothing when the current model is not a WorkBuddy route.
      if (!providerMatches) return null;

      // Derive chip display from the loaded state. `state.usage` is the
      // ACTIVE account's quota for the connected cluster — which after the
      // region filter below is exactly the account the current model group
      // uses. Switching the model group flips `derivedRegion`, refetches,
      // and this number follows.
      var svc = wb && wb.state;
      var usage = svc && svc.usage;
      var pct = usage && usage.size > 0
        ? Math.round((usage.remain / usage.size) * 100)
        : null;
      var remain = usage ? Math.max(0, Math.floor(usage.remain)) : null;
      var total = usage ? Math.max(0, Math.floor(usage.size)) : null;
      var color = pct === null ? "#8e8e93"
        : pct >= 30 ? "#30d158"
        : pct >= 10 ? "#ffd60a"
        : "#ff453a";
      var chipText = remain !== null
        ? (remain >= 10000
            ? (Math.round(remain / 100) / 100) + "k"
            : String(remain))
        : (wb && wb.error ? "离线" : "…");

      // ACCOUNTS AND AUTO ARE REGION-SCOPED. `accounts` mixes both clusters
      // (a CN account and an INTL account coexist in one list — see
      // `AccountSummary.region` in core). The chip serves whichever cluster
      // the current model group's provider routes to, so we filter to that
      // region only and ignore the rest entirely.
      var regionAccounts = ((svc && svc.accounts) || []).filter(function (a) {
        return a.region === derivedRegion;
      });
      var autoSelect = !!(svc && svc.settings && svc.settings.autoSelectAccount);
      var regionTitle = derivedRegion === "intl" ? "国际版" : "国内版";

      // Optimistic mutations. Writing the expected result into local state
      // BEFORE the request lands makes the menu respond instantly; the
      // server response then reconciles (or a reload reverts on failure).
      // Only the touched row shows a pending state — the previous `busy`
      // flag disabled and dimmed the WHOLE list, which read as a freeze on
      // the multi-second billing round trip that `switchAccount` performs
      // host-side.
      function patchLocal(mutate) {
        setWb(function (prev) {
          if (!prev || !prev.state) return prev;
          var next = JSON.parse(JSON.stringify(prev.state));
          mutate(next);
          return { state: next };
        });
      }
      function toggleAuto() {
        if (pending) return;
        var target = !autoSelect;
        setPending("auto");
        patchLocal(function (s) {
          if (s.settings) s.settings.autoSelectAccount = target;
        });
        fetch("/workbuddy/api/settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ autoSelectAccount: target }),
        }).then(function (resp) {
          if (!resp.ok) throw new Error("settings update failed");
        }).catch(function () {
          return loadWb();
        }).finally(function () { setPending(null); });
      }
      // Picking a specific account means "stop allocating automatically" —
      // the two options are one radio group, so auto is turned off first.
      // Optimistically, so the ✓ lands on the clicked row at once.
      function switchAccount(key) {
        if (pending) return;
        var wasAuto = autoSelect;
        setPending(key);
        patchLocal(function (s) {
          if (wasAuto && s.settings) s.settings.autoSelectAccount = false;
          // Exactly one row is active per region; the ✓ follows the click.
          for (var i = 0; i < s.accounts.length; i++) {
            if (s.accounts[i].region === derivedRegion) {
              s.accounts[i].active = s.accounts[i].key === key;
              s.accounts[i].auto = false;
            }
          }
          s.activeKey = key;
        });
        // Two independent writes with no ordering between them: the manual
        // selection slot, and the auto flag. Both must land before the
        // state we paint is authoritative, so the reload waits for both.
        var jobs = [
          fetch("/workbuddy/api/accounts/switch", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: key }),
          }),
        ];
        if (wasAuto) {
          jobs.push(
            fetch("/workbuddy/api/settings", {
              method: "PATCH",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ autoSelectAccount: false }),
            })
          );
        }
        return Promise.all(jobs).then(function (responses) {
          var switchResp = responses[0];
          if (!switchResp.ok) throw new Error("switch failed");
          if (wasAuto && !responses[1].ok) throw new Error("auto off failed");
          // The switch response is the new ServiceState, so adopt it rather
          // than paying a second getState round trip. Two corrections:
          //   1. The route is NOT `{region}`-scoped, so its `activeKey` /
          //      `usage` resolve against `settings.region` — which can be the
          //      OTHER cluster from the one the current model group routes
          //      to. Every account's own `active` flag IS region-correct, so
          //      re-derive those two fields from this region's active row.
          //   2. Auto was just switched off, so the response still carries
          //      the stale flags; clear them to match what we just wrote.
          return switchResp.json().then(function (svc) {
            if (!svc) return loadWb();
            var next = JSON.parse(JSON.stringify(svc));
            var pick = null;
            for (var i = 0; i < (next.accounts || []).length; i++) {
              var ac = next.accounts[i];
              if (wasAuto) ac.auto = false;
              if (ac.region === derivedRegion && ac.active) pick = ac;
            }
            if (next.settings && wasAuto) next.settings.autoSelectAccount = false;
            if (pick) {
              next.activeKey = pick.key;
              if (pick.usage) next.usage = pick.usage;
            }
            setWb({ state: next });
          });
        }).catch(function () {
          return loadWb();
        }).finally(function () { setPending(null); });
      }

      // Trigger: icon + credits only — same ghost shape as dsh's own
      // model-selector trigger (no border, no dot, no "WB · " prefix).
      var chip = createElement("button", {
        type: "button",
        ref: triggerRef,
        className: "wb-credit-chip",
        "data-state": wb && wb.error ? "error" : (wb ? "ready" : "loading"),
        "aria-haspopup": "menu",
        "aria-expanded": open,
        title: "WorkBuddy 积分（" + regionTitle + "）",
        onClick: function () { setOpen(!open); },
      }, createElement("span", { className: "wb-credit-icon" }), createElement("span", {
        className: "wb-credit-label",
      }, chipText));

      if (!open) return chip;

      // Build the popover body. Each account row is TWO lines: the name
      // (plus ✓ / auto badge) on top, and that account's own credit balance
      // below — remain on the left, percent on the right, smaller and in
      // the tertiary label colour. `accounts[].usage` carries the per-account
      // snapshot, so no extra request is needed.
      var rows = regionAccounts.map(function (a) {
        var au = a.usage;
        var apct = au && au.size > 0 ? Math.round((au.remain / au.size) * 100) : null;
        var aremain = au ? Math.max(0, Math.floor(au.remain)) : null;
        return createElement("button", {
          key: a.key,
          type: "button",
          className: "wb-account",
          "data-pending": String(pending === a.key),
          // Only THIS row locks while its own switch is in flight; siblings
          // stay clickable so a mis-click is one click to correct.
          disabled: pending !== null && pending !== a.key,
          onClick: function () { switchAccount(a.key); },
        },
          createElement("span", { className: "wb-account-main" },
            createElement("span", { className: "wb-account-line" },
              createElement("span", { className: "wb-account-name" }, a.label || a.nickname || a.uid || a.key),
              // RADIO GROUP: exactly one of 自动 / an account row is
              // checked. Auto on ⇒ only 自动; auto off ⇒ only the active
              // account. Clicking any row moves the single ✓ there.
              a.auto ? createElement("span", { className: "wb-account-badge" }, "auto") : null,
              a.active && !autoSelect ? createElement("span", { className: "wb-account-check" }, "✓") : null),
            createElement("span", { className: "wb-account-sub" },
              createElement("span", null, aremain !== null ? aremain + " 积分" : "积分未知"),
              createElement("span", null, apct !== null ? apct + "%" : ""))));
      });

      // The 自动 row aggregates THIS REGION: the pool auto-select draws from
      // is the region's accounts, so the totals it shows are their sum.
      var regionRemain = 0;
      var regionSize = 0;
      var haveRegionUsage = false;
      for (var ri = 0; ri < regionAccounts.length; ri++) {
        var ru = regionAccounts[ri].usage;
        if (!ru) continue;
        haveRegionUsage = true;
        regionRemain += Math.max(0, ru.remain || 0);
        regionSize += Math.max(0, ru.size || 0);
      }
      var regionPct = haveRegionUsage && regionSize > 0
        ? Math.round((regionRemain / regionSize) * 100)
        : null;

      var popover = createElement("div", {
        ref: popRef,
        className: "wb-popover",
        role: "menu",
        style: pos ? { left: pos.left + "px", top: pos.top + "px" } : { visibility: "hidden", left: 0, top: 0 },
      },
        createElement("div", { className: "wb-popover-head" },
          "WorkBuddy " + regionTitle,
          createElement("button", { type: "button", className: "wb-refresh", disabled: pending !== null, onClick: function () { loadWb(); } }, "刷新")),
        pct !== null ? createElement("div", { className: "wb-quota" },
          createElement("div", { className: "wb-progress" },
            createElement("div", { className: "wb-progress-fill", style: { width: pct + "%", "--wb-credit-color": color } })),
          createElement("div", { className: "wb-quota-row" },
            createElement("span", null, remain + " / " + total),
            createElement("span", null, pct + "%"))) : null,
        createElement("div", { className: "wb-section-label" }, "账号"),
        // "自动" is a first-class OPTION in the account list with the SAME
        // two-line shape as an account row — name + ✓ on line 1 (the check
        // is pushed to the right edge by the shared flex line), region
        // totals on line 2. Radio group: auto on ⇒ no account is checked.
        createElement("button", {
          type: "button",
          className: "wb-account",
          "data-pending": String(pending === "auto"),
          disabled: pending !== null && pending !== "auto",
          onClick: toggleAuto,
        },
          createElement("span", { className: "wb-account-main" },
            createElement("span", { className: "wb-account-line" },
              createElement("span", { className: "wb-account-name" }, "自动"),
              createElement("span", { className: "wb-account-check" }, autoSelect ? "✓" : "")),
            createElement("span", { className: "wb-account-sub" },
              createElement("span", null, haveRegionUsage ? Math.floor(regionRemain) + " 积分" : "积分未知"),
              createElement("span", null, regionPct !== null ? regionPct + "%" : "")))),
        regionAccounts.length === 0
          ? createElement("div", { className: "wb-empty" }, "该区域暂无账号")
          : createElement("div", null, rows));

      return createElement("div", { style: { display: "contents" } }, chip, popover);
    }

    // The chip is the only composer occupant we register. It lives at
    // `conversation.input.right` — see the registration call below.
    // (SlotMarker was the temporary placeholder component used while we
    // were evaluating candidate slots; it is removed now that the chip
    // lives at `conversation.input.right`.)

    function apply(ctx) {
      // Follow dsh's theme: read it once, then re-read on every change. The
      // embedded management page cannot see dsh's tokens (separate document),
      // so this is what keeps it in step with the user's light/dark choice
      // instead of being frozen at whatever was current when it loaded.
      syncTheme(ctx);
      ctx.on("theme/change", function () { syncTheme(ctx); });

      // Same contract for the language: read it once (so the iframe src can
      // carry it), then re-read on every change so an open panel follows a
      // switch made in dsh's Settings.
      syncLocale(ctx);
      ctx.on("locale/change", function () { syncLocale(ctx); });

      // `settings.section` is a child slot owned by the settings panel, so it is
      // added with `ctx.slots.inject` (a direct `register` is rejected because
      // the parent's children table must declare it).
      ctx.effect(function () {
        return ctx.slots.inject("settings.section", function () {
          return ctx.slots.register(
            {
              name: "settings.section",
              id: "workbuddy",
              order: 30,
              label: function () {
                return "Workbuddy";
              },
            },
            WorkbuddySettings
          );
        });
      }, "llm-workbuddy: settings section");

      // Inject every composer/header slot listed above. Each slot declaration
      // is independent — they may or may not be present depending on which
      // other dsh plugins are loaded (e.g. some slots are session-scoped and
      // only appear once a session is open). `slots.inject` is the right
      // primitive here: it registers the contribution against the slot's
      // declaration, which `ui-conversation` declares when it boots.
      //
      // Component registration shape: dsh's slot renderer calls the
      // registered function with `(ownerProps)` AS A REACT COMPONENT, so
      // `useState` / `useEffect` inside the function are valid. Do NOT wrap
      // the component in another `function () { return Component(...); }`
      // — calling the component outside React's render context throws
      // "Invalid hook call" and silently produces an empty slot occupant.
      // The marker slot needs props (slot name + width variant); we bake
      // those in via a factory so each slot registration gets its own
      // marker React component without sharing state.
      //
      // We do NOT wrap each `slots.inject` in `ctx.effect(...)` — every
      // other plugin (`dsh-client-ui-attachment`, `dsh-client-ui-approval`,
      // `dsh-client-ui-brand-official`) calls `slots.inject` directly from
      // `apply()`. Wrapping the inject call in an outer effect attaches the
      // registration to that effect's fiber, which is scoped to `apply()`
      // and dies the moment `apply()` finishes — so the slot never gets
      // the registration at all. Calling `slots.inject` directly keeps the
      // registration alive on the slot's own fiber.
      // The WorkBuddy credit chip lives in `conversation.input.right` —
// immediately before the model selector / send action. dsh wires the
// per-session `SnapshotStore<ModelDirectoryState>` into our chip through
// the entry-level `inject: (sessionId) => ({ store })` callback, and the
// chip subscribes to it with `useSyncExternalStore`. That means:
//   - no DOM scraping
//   - no MutationObserver
//   - no polling timers
//   - re-renders the EXACT instant dsh records a new active selection
// The chip itself hides itself when the active provider is not in the
// `WORKBUDDY_PROVIDERS` set, so non-workbuddy users see an empty slot.
//
// The `ctx.inject(["slots", "modelDirectories"], scope => ...)` pattern is
// what dsh-client-ui-model-selection uses to reach the `modelDirectories`
// Cordis service (provided by `ModelDirectoryResolver`); the service is
// not in the ctx's default `inject` set. We mirror that pattern verbatim.
      ctx.inject(["slots", "modelDirectories"], function (scope) {
        var models = scope.modelDirectories;
        scope.slots.inject("conversation.input.right", function () {
          return scope.slots.register(
            {
              name: "conversation.input.right",
              id: "workbuddy-credit-chip",
              priority: 10,
              inject: function (sessionId) {
                var directory = models.directoryFor(sessionId);
                return { store: directory.store };
              },
            },
            WorkbuddyCreditChip
          );
        });
      });

      // Replace the default gear icon dsh assigns to unknown section ids with
      // our own single-color SVG mark. dsh's navIcon() has a fixed map
      // (models / agent-presets / plugins) and a gear fallback for everything
      // else — no way to contribute a custom icon through the slot protocol,
      // so we paint ours on top of the gear with a content+mask-image trick.
      //
      // Selector strategy: do NOT use :nth-of-type — other plugins can
      // register their own settings sections and shift our position. The
      // label "Workbuddy" is ours and unique, so we locate our nav cell by
      // the label's text content, mark it with a private data attribute, and
      // then target that attribute from CSS. The marker is reapplied on
      // every settings-dialog mount via a MutationObserver so we survive dsh
      // tearing the dialog down and rebuilding it.
      var tagButton = function () {
        // dsh renders nav cells as `button.VOzbGW_navCell` with a
        // `span.VOzbGW_navLabel` child whose textContent is the registered
        // label. Find our cell by text match, then mark the button so CSS
        // can hide dsh's icon and paint ours via ::before.
        var labels = document.querySelectorAll(".VOzbGW_navLabel");
        for (var i = 0; i < labels.length; i++) {
          if (labels[i].textContent.trim() === "Workbuddy") {
            var btn = labels[i].closest("button.VOzbGW_navCell");
            if (btn && !btn.hasAttribute("data-llm-workbuddy")) {
              btn.setAttribute("data-llm-workbuddy", "");
            }
          }
        }
      };
      // Run once now, and re-run whenever the settings nav subtree mutates
      // (dsh re-mounts the whole dialog on close/reopen, which drops our
      // marker attribute along with the rest of the tree).
      tagButton();
      var navObserver = new MutationObserver(tagButton);
      navObserver.observe(document.body, { childList: true, subtree: true });

      var style = document.createElement("style");
      // The mark we paint in place of dsh's default gear. The SVG is fully
      // URL-encoded (every "<", ">", '"', "#", space, etc. replaced with
      // %XX), so the whole dataurl is a plain ASCII string with no special
      // characters — safe to drop inside JS without any further escaping,
      // and safe for the CSS url() parser to read back.

      style.setAttribute("data-plugin", "llm-workbuddy");
      style.textContent = [
        // dsh draws the default gear inside .VOzbGW_navIcon; hide it on our
        // cell so only the ::before mask below is visible.
        'button[data-llm-workbuddy] .VOzbGW_navIcon { display: none !important; }',
        // Paint our mark in the same 16x16 slot as the hidden icon, using a
        // single-color SVG via mask so it inherits currentColor (auto-fits
        // dsh's light/dark theme). The url() uses the URL-encoded dataurl
        // above — every special character in the SVG has already been turned
        // into %XX, so the CSS parser sees a plain ASCII string.
        'button[data-llm-workbuddy]::before {',
        '  content: "";',
        '  display: inline-block;',
        '  flex: none;',
        '  width: 16px;',
        '  height: 16px;',
        '  background-color: currentColor;',
        '  -webkit-mask: url("' + WB_ICON_DATAURL + '") no-repeat center / contain;',
        '  mask: url("' + WB_ICON_DATAURL + '") no-repeat center / contain;',
        '}',
      ].join("\n");
      document.head.appendChild(style);
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
