import { app } from "../../scripts/app.js";

const EXT_NAME = "Comfy.PinnedInputs";
const STORAGE_KEY = "pinnedinputs_pins";
const SYNC_INTERVAL_MS = 600;

let panelRoot = null;
let syncFns = [];      // per-row sync functions; each returns false if its pin went structurally stale
let syncTimer = null;
let dragKey = null;    // key of the pin currently being dragged, null when idle
const textareaHeights = new Map(); // pinKey → height string saved by user drag

// ── Storage helpers ────────────────────────────────────────────────────────────

function getPins() {
    try { return (app.graph?.extra?.[STORAGE_KEY] ?? []).filter(Boolean); }
    catch { return []; }
}

function savePins(pins) {
    if (!app.graph) return;
    if (!app.graph.extra) app.graph.extra = {};
    app.graph.extra[STORAGE_KEY] = pins;
}

function isPinned(nodeId, widgetName) {
    return getPins().some(p => p.nodeId === nodeId && p.widgetName === widgetName);
}

function resolvePin(pin) {
    const node = app.graph?.getNodeById(pin.nodeId) ?? null;
    const widget = node?.widgets?.find(w => w.name === pin.widgetName) ?? null;
    return { node, widget };
}

// ── Pin / unpin actions ────────────────────────────────────────────────────────

function pinWidget(node, widget) {
    if (isPinned(node.id, widget.name)) return;
    const pins = getPins();
    const title = node.title || node.type || `Node ${node.id}`;
    pins.push({ nodeId: node.id, widgetName: widget.name, label: `${title} › ${widget.name}` });

    // Auto-pin the control_after_generate companion for seed widgets
    if ((widget.name === "seed" || widget.name === "noise_seed") &&
        !isPinned(node.id, "control_after_generate")) {
        const sibling = node.widgets?.find(w => w.name === "control_after_generate");
        if (sibling) {
            pins.push({
                nodeId: node.id,
                widgetName: "control_after_generate",
                label: `${title} › control_after_generate`,
            });
        }
    }

    savePins(pins);
    rebuildPanel();
}

function unpinWidget(nodeId, widgetName) {
    savePins(getPins().filter(p => !(p.nodeId === nodeId && p.widgetName === widgetName)));
    rebuildPanel();
}

// ── Drag & drop reordering ─────────────────────────────────────────────────────

function pinKey(p) {
    return `${p.nodeId}::${p.widgetName}`;
}

function movePin(srcKey, dstKey, placeAfter) {
    const pins = getPins();
    const from = pins.findIndex(p => pinKey(p) === srcKey);
    if (from === -1) return;
    const [moved] = pins.splice(from, 1);
    let to = pins.findIndex(p => pinKey(p) === dstKey);
    if (to === -1) return;               // target vanished mid-drag; getPins() copy is discarded
    if (placeAfter) to += 1;
    pins.splice(to, 0, moved);
    savePins(pins);
    rebuildPanel();
}

function clearDropMarker(row) {
    row.style.boxShadow = "";
    delete row.dataset.dropAfter;
}

// ── Apply a value change back to the canvas widget ────────────────────────────

function applyValue(node, widget, value) {
    widget.value = value;
    widget.callback?.(value, app.canvas, node, null, null);
    app.graph.setDirtyCanvas(true);
}

// True if the user is currently interacting with `el` (don't overwrite their input)
function isFocused(el) {
    const a = document.activeElement;
    return !!a && (a === el || el.contains?.(a));
}

// ── Build an HTML control that mirrors a LiteGraph widget ─────────────────────
// Returns { el, sync } — sync() pulls the current widget value into the control.

function makeControl(widget, node) {
    const type = widget.type;
    const opts = widget.options ?? {};

    // ── combo (dropdown) ──────────────────────────────────────────────────────
    if (type === "combo") {
        // LiteGraph calls values functions as values(widget, node)
        const getValues = () => {
            const v = opts.values;
            try { return (typeof v === "function" ? v(widget, node) : v) ?? []; }
            catch { return []; }
        };
        let values = getValues();

        const sel = document.createElement("select");
        sel.style.cssText = "width:100%;padding:4px 6px;box-sizing:border-box";

        // Options are mapped by index so non-string combo values survive intact
        const fill = () => {
            sel.innerHTML = "";
            values.forEach((v, i) => {
                const o = document.createElement("option");
                o.value = String(i);
                o.textContent = String(v);
                sel.appendChild(o);
            });
            const idx = values.indexOf(widget.value);
            if (idx >= 0) sel.selectedIndex = idx;
            else if (widget.value != null) {
                // Current value not in the list (e.g. model file removed): show it, but inert
                const o = document.createElement("option");
                o.value = "-1";
                o.textContent = `${widget.value} (missing)`;
                o.selected = true;
                sel.prepend(o);
            }
        };
        fill();

        sel.onchange = () => {
            const idx = parseInt(sel.value, 10);
            if (idx >= 0 && idx < values.length) applyValue(node, widget, values[idx]);
        };

        const sync = () => {
            if (isFocused(sel)) return;
            const fresh = getValues();
            const changed = fresh.length !== values.length || fresh.some((v, i) => v !== values[i]);
            if (changed) { values = fresh; fill(); return; }
            const idx = values.indexOf(widget.value);
            if (idx >= 0 && sel.selectedIndex !== idx) sel.selectedIndex = idx;
        };
        return { el: sel, sync };
    }

    // ── toggle (boolean) ─────────────────────────────────────────────────────
    if (type === "toggle") {
        const wrap = document.createElement("label");
        wrap.style.cssText = "display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none";
        const chk = document.createElement("input");
        chk.type = "checkbox";
        const lbl = document.createElement("span");
        lbl.style.cssText = "font-size:12px;color:var(--fg-color,#ccc)";
        const reflect = () => (lbl.textContent = chk.checked ? "On" : "Off");
        chk.checked = !!widget.value;
        reflect();
        chk.onchange = () => { reflect(); applyValue(node, widget, chk.checked); };
        wrap.append(chk, lbl);

        const sync = () => {
            if (chk.checked !== !!widget.value) { chk.checked = !!widget.value; reflect(); }
        };
        return { el: wrap, sync };
    }

    // ── number (INT / FLOAT) ─────────────────────────────────────────────────
    if (type === "number") {
        // Trust the widget's declared precision, never the current value:
        // a FLOAT sitting at 8.0 must NOT be treated as an INT (would round 7.5 → 8).
        const isInt = opts.precision === 0;
        // Legacy LiteGraph stores options.step at 10x the real step; the new
        // frontend exposes the true step as options.step2.
        const realStep = opts.step2 ?? (typeof opts.step === "number" ? opts.step / 10 : null);

        const inp = document.createElement("input");
        inp.type = "number";
        inp.style.cssText = "width:100%;padding:4px 6px;box-sizing:border-box";
        if (opts.min != null) inp.min = opts.min;
        if (opts.max != null) inp.max = opts.max;
        inp.step = isInt ? "1" : (realStep != null && realStep > 0 ? String(realStep) : "any");
        inp.value = widget.value ?? 0;

        inp.onchange = () => {
            let v = parseFloat(inp.value);
            if (!Number.isFinite(v)) { inp.value = widget.value ?? 0; return; }   // blank / garbage → revert
            if (isInt) v = Math.round(v);
            if (opts.min != null) v = Math.max(v, opts.min);                      // typed values bypass the
            if (opts.max != null) v = Math.min(v, opts.max);                      // browser's min/max, so clamp
            inp.value = v;
            applyValue(node, widget, v);
        };

        const sync = () => {
            if (isFocused(inp)) return;
            const cur = widget.value ?? 0;
            if (parseFloat(inp.value) !== cur) inp.value = cur;
        };
        return { el: inp, sync };
    }

    // ── customtext / multiline string ─────────────────────────────────────────
    if (type === "customtext" || opts.multiline) {
        const ta = document.createElement("textarea");
        ta.style.cssText =
            "width:100%;box-sizing:border-box;resize:vertical;min-height:80px;" +
            "padding:4px 6px;font-family:monospace;font-size:11px;line-height:1.5";
        ta.value = widget.value ?? "";
        ta.onchange = () => applyValue(node, widget, ta.value);

        const sync = () => {
            if (isFocused(ta)) return;
            const cur = widget.value ?? "";
            if (ta.value !== cur) ta.value = cur;
        };
        return { el: ta, sync };
    }

    // ── text / string / fallback ──────────────────────────────────────────────
    const inp = document.createElement("input");
    inp.type = "text";
    inp.style.cssText = "width:100%;padding:4px 6px;box-sizing:border-box";
    inp.value = String(widget.value ?? "");
    inp.onchange = () => applyValue(node, widget, inp.value);

    const sync = () => {
        if (isFocused(inp)) return;
        const cur = String(widget.value ?? "");
        if (inp.value !== cur) inp.value = cur;
    };
    return { el: inp, sync };
}

// ── Build one row in the sidebar panel ───────────────────────────────────────

function buildPinRow(pin) {
    const { node, widget } = resolvePin(pin);
    const key = pinKey(pin);

    const row = document.createElement("div");
    row.style.cssText = "padding:10px 12px;border-bottom:1px solid var(--border-color,#333)";

    // Drag source (armed only via the grip handle, see below)
    row.addEventListener("dragstart", (e) => {
        dragKey = key;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", key);   // Firefox requires data to start a drag
        row.style.opacity = "0.4";
    });
    row.addEventListener("dragend", () => {
        dragKey = null;
        row.draggable = false;
        row.style.opacity = "";
        clearDropMarker(row);
    });

    // Drop target: marker line above or below the midpoint of the hovered row
    row.addEventListener("dragover", (e) => {
        if (!dragKey || dragKey === key) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const r = row.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        row.dataset.dropAfter = after ? "1" : "";
        row.style.boxShadow = after
            ? "inset 0 -2px 0 0 var(--p-primary-color,#5585ff)"
            : "inset 0 2px 0 0 var(--p-primary-color,#5585ff)";
    });
    row.addEventListener("dragleave", () => clearDropMarker(row));
    row.addEventListener("drop", (e) => {
        if (!dragKey || dragKey === key) return;
        e.preventDefault();
        const after = row.dataset.dropAfter === "1";
        clearDropMarker(row);
        movePin(dragKey, key, after);                // saves + rebuilds the panel
        dragKey = null;
    });

    // Header: grip + label + unpin button
    const hdr = document.createElement("div");
    hdr.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px";

    const grip = document.createElement("span");
    grip.textContent = "⠿";
    grip.title = "Drag to reorder";
    grip.style.cssText =
        "cursor:grab;color:var(--fg-color,#888);opacity:0.45;font-size:12px;" +
        "flex-shrink:0;user-select:none";
    grip.onmouseenter = () => (grip.style.opacity = "0.9");
    grip.onmouseleave = () => (grip.style.opacity = "0.45");
    // Only the grip arms dragging, so text selection in inputs keeps working
    grip.addEventListener("mousedown", () => { row.draggable = true; });
    grip.addEventListener("mouseup", () => { row.draggable = false; });

    const lbl = document.createElement("span");
    lbl.textContent = pin.label;
    lbl.style.cssText =
        "font-size:11px;font-weight:600;color:var(--fg-color,#ccc);" +
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0";
    if (node) {
        lbl.title = `${pin.label} — click to locate node`;
        lbl.style.cursor = "pointer";
        lbl.onclick = () => {
            const cur = resolvePin(pin).node;
            if (!cur) return;
            app.canvas?.centerOnNode?.(cur);
            app.canvas?.selectNode?.(cur);
        };
    } else {
        lbl.title = pin.label;
    }

    const unpinBtn = document.createElement("button");
    unpinBtn.textContent = "✕";
    unpinBtn.title = "Unpin";
    unpinBtn.style.cssText =
        "background:none;border:none;cursor:pointer;color:var(--fg-color,#888);" +
        "font-size:13px;padding:0;line-height:1;opacity:0.5;flex-shrink:0";
    unpinBtn.onmouseenter = () => (unpinBtn.style.opacity = "1");
    unpinBtn.onmouseleave = () => (unpinBtn.style.opacity = "0.5");
    unpinBtn.onclick = () => unpinWidget(pin.nodeId, pin.widgetName);

    hdr.append(grip, lbl, unpinBtn);
    row.appendChild(hdr);

    if (!node || !widget) {
        const warn = document.createElement("div");
        warn.textContent = "⚠ Widget not found (stale pin)";
        warn.style.cssText = "font-size:11px;color:#f90;font-style:italic";
        row.appendChild(warn);
        // Stays valid while unresolved; resolving again (e.g. undo restored
        // the node) reports stale so the panel rebuilds into a live row.
        syncFns.push(() => resolvePin(pin).widget == null);
        return row;
    }

    const ctrl = makeControl(widget, node);
    if (ctrl) {
        if (ctrl.el.tagName === "TEXTAREA") {
            const saved = textareaHeights.get(key);
            if (saved) ctrl.el.style.height = saved;
            ctrl.el.addEventListener("mouseup", () => {
                if (ctrl.el.style.height) textareaHeights.set(key, ctrl.el.style.height);
            });
        }
        row.appendChild(ctrl.el);
        // Row is stale if the pin no longer resolves to the same objects
        // (node deleted, workflow reloaded/undone, widget converted to input).
        syncFns.push(() => {
            const cur = resolvePin(pin);
            if (cur.node !== node || cur.widget !== widget) return false;
            ctrl.sync();
            return true;
        });
    }
    return row;
}

// ── Periodic canvas → panel sync (keeps seeds etc. fresh without manual ↺) ────

function syncValues() {
    if (dragKey || !panelRoot?.isConnected || !syncFns.length) return;
    for (const fn of syncFns) {
        if (fn() === false) {        // structural change → rebuild once and stop
            rebuildPanel();
            return;
        }
    }
}

function ensureSyncLoop() {
    if (syncTimer == null) syncTimer = setInterval(syncValues, SYNC_INTERVAL_MS);
}

// ── Rebuild the full sidebar panel from scratch ───────────────────────────────

function rebuildPanel() {
    if (!panelRoot) return;
    panelRoot.innerHTML = "";
    syncFns = [];

    ensureStyles();

    const wrapper = document.createElement("div");
    wrapper.style.cssText = "display:flex;flex-direction:column;height:100%;overflow:hidden";

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.style.cssText =
        "display:flex;justify-content:space-between;align-items:center;" +
        "padding:8px 12px;border-bottom:2px solid var(--border-color,#333);flex-shrink:0";
    const titleEl = document.createElement("span");
    titleEl.textContent = "Pinned Inputs";
    titleEl.style.cssText = "font-size:13px;font-weight:700;color:var(--fg-color,#eee)";
    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "↺";
    refreshBtn.title = "Rebuild panel (refreshes labels and dropdown options)";
    refreshBtn.style.cssText =
        "background:none;border:none;cursor:pointer;color:var(--fg-color,#aaa);" +
        "font-size:17px;padding:0;line-height:1";
    refreshBtn.onclick = rebuildPanel;
    toolbar.append(titleEl, refreshBtn);
    wrapper.appendChild(toolbar);

    // Body
    const body = document.createElement("div");
    body.style.cssText = "flex:1;overflow-y:auto";

    const pins = getPins();
    if (pins.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText =
            "padding:24px;text-align:center;color:var(--fg-color,#888);" +
            "font-size:12px;line-height:1.8;opacity:0.7";
        empty.innerHTML =
            "No pins yet.<br>" +
            "Right-click a node and choose<br>" +
            "<strong>📌 Pin widget…</strong>";
        body.appendChild(empty);
    } else {
        for (const pin of pins) body.appendChild(buildPinRow(pin));
    }

    wrapper.appendChild(body);
    panelRoot.appendChild(wrapper);
}

// ── Shared stylesheet injected once into <head> ───────────────────────────────

function ensureStyles() {
    if (document.getElementById("pinned-inputs-styles")) return;
    const s = document.createElement("style");
    s.id = "pinned-inputs-styles";
    s.textContent = `
        #pinned-inputs-panel input,
        #pinned-inputs-panel select,
        #pinned-inputs-panel textarea {
            background: var(--comfy-input-bg, #1e1e1e);
            color: var(--fg-color, #ddd);
            border: 1px solid var(--border-color, #444);
            border-radius: 4px;
        }
        #pinned-inputs-panel input:focus,
        #pinned-inputs-panel select:focus,
        #pinned-inputs-panel textarea:focus {
            outline: none;
            border-color: var(--p-primary-color, #5585ff);
        }
    `;
    document.head.appendChild(s);
}

// ── Extension registration ────────────────────────────────────────────────────

app.registerExtension({
    name: EXT_NAME,

    async setup() {
        if (app.extensionManager?.registerSidebarTab) {
            app.extensionManager.registerSidebarTab({
                id: "pinned-inputs",
                icon: "pi pi-thumbtack",
                title: "Pinned Inputs",
                tooltip: "Pinned widget controls",
                type: "custom",
                render(el) {
                    el.id = "pinned-inputs-panel";
                    el.style.cssText = "height:100%;box-sizing:border-box;overflow:hidden";
                    panelRoot = el;
                    rebuildPanel();
                    ensureSyncLoop();
                },
            });
        }
    },

    // Re-sync panel after a workflow is loaded
    afterConfigureGraph() {
        rebuildPanel();
    },

    // Inject "📌 Pin widget…" into every node's right-click menu
    beforeRegisterNodeDef(nodeType) {
        const orig = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            orig?.call(this, canvas, options);

            const node = this;
            const widgets = node.widgets?.filter(w => w.type !== "button");
            if (!widgets?.length) return;

            options.push(null); // separator
            options.push({
                content: "📌 Pin widget…",
                has_submenu: true,
                submenu: {
                    options: widgets.map(w => ({
                        content: isPinned(node.id, w.name) ? `✓ ${w.name}` : w.name,
                        callback() {
                            if (isPinned(node.id, w.name)) unpinWidget(node.id, w.name);
                            else pinWidget(node, w);
                        },
                    })),
                },
            });
        };
    },
});
