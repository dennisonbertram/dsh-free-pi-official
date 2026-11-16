// FreePi for DeepSeek Harness, browser half. Hand-written in the harness module-loader format, so the package needs
// no build step.
//
// It reserves a strip above the composer (slot `conversation.input.dock`) and lays the FreePi bar, a frame served by
// the FreePi gateway, exactly over that strip. The frame element itself lives in the harness's overlay layer (slot
// `shell.overlay`), not inside the dock. That layer is a transparent sheet over the whole window; a frame underneath
// it is, to the browser, covered, and the frame has to be able to tell honestly whether its ad is on screen. Inside
// the layer nothing invisible sits above the bar, while the harness's own menus and dialogs still open over it.
window.__ModuleLoader__.load({
	id: "dsh-free-pi-official",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");

		// The bar says how tall its content is (label row plus card); it is given that, within these bounds.
		const MIN_HEIGHT = 76;
		const MAX_HEIGHT = 168;
		const GAP = 14;
		let height = 96;
		const spacers = new Set();
		let lastFit = null;
		let frame = null;
		let pairing = null;
		let pairingRequested = false;
		let pairingRetryTimer = 0;
		let loop = 0;
		let theme = "light";
		let frameOrigin = null;

		function onFrameMessage(event) {
			if (frame === null || event.source !== frame.contentWindow || event.origin !== frameOrigin || event.data?.type !== "freepi:height") return;
			const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(Number(event.data.height)) || 0));
			if (next === height) return;
			height = next;
			for (const node of spacers) node.style.height = height + "px";
		}

		function removeFrame() {
			window.removeEventListener("message", onFrameMessage);
			frame?.remove();
			frame = null;
			frameOrigin = null;
		}

		function pageTheme() {
			const match = /rgba?\(([^)]+)\)/.exec(getComputedStyle(document.body).backgroundColor);
			if (!match) return "light";
			const [r, g, b, a] = match[1].split(",").map(Number);
			if (a === 0) return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
			return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128 ? "dark" : "light";
		}

		function requestPairing() {
			if (pairingRequested) return;
			pairingRequested = true;
			const attempt = () => {
				if (spacers.size === 0) { pairingRequested = false; return; }
				fetch(new URL("freepi/pairing", document.baseURI), { credentials: "same-origin" })
					.then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
					.then((json) => { pairing = json; })
					.catch(() => {
						if (spacers.size === 0) { pairingRequested = false; return; }
						pairingRetryTimer = setTimeout(() => { pairingRetryTimer = 0; attempt(); }, 3000);
					});
			};
			attempt();
		}

		/** The host element the overlay slot gave us; the frame is created inside it once the pairing is known. */
		let host = null;

		function ensureFrame() {
			if (frame !== null || pairing === null || host === null) return;
			theme = pageTheme();
			frame = document.createElement("iframe");
			frame.id = "freepi-bar";
			frame.title = "FreePi: sponsored";
			frame.src = pairing.gateway + "/dsh/frame?install_id=" + encodeURIComponent(pairing.install_id) + "&theme=" + theme + "&v=" + encodeURIComponent(pairing.version);
			frameOrigin = new URL(pairing.gateway).origin;
			window.addEventListener("message", onFrameMessage);
			// A plain, fully opaque, unscaled box: anything else and the frame (rightly) stops counting itself as visible.
			// The overlay layer is click-through, so the bar opts back in to pointer events.
			Object.assign(frame.style, { position: "fixed", border: "0", margin: "0", padding: "0", background: "transparent", colorScheme: "normal", pointerEvents: "auto", display: "none" });
			frame.setAttribute("allow", "");
			host.append(frame);
		}

		function FreePiOverlay() {
			const ref = React.useRef(null);
			React.useEffect(() => {
				host = ref.current;
				return () => { host = null; removeFrame(); };
			}, []);
			return React.createElement("div", { ref, "data-freepi-overlay": "" });
		}

		/**
		 * The composer card next to a reserved strip: the nearest rounded box around the text box. In an open
		 * conversation the dock slot is wider than the composer; the bar lines up with the composer instead.
		 */
		function composerRect(spacer) {
			for (let scope = spacer.parentElement; scope !== null && scope !== document.body; scope = scope.parentElement) {
				const editable = scope.querySelector("textarea, [contenteditable=true]");
				if (editable === null) continue;
				for (let node = editable; node !== null && node !== scope; node = node.parentElement) {
					const rect = node.getBoundingClientRect();
					if (rect.width >= 280 && parseFloat(getComputedStyle(node).borderTopLeftRadius) >= 8) return rect;
				}
				return null;
			}
			return null;
		}

		/** Where the bar goes: the first reserved strip that is really laid out, at the composer's left edge and width. */
		function activeSpacer() {
			for (const node of spacers) {
				if (!node.isConnected) continue;
				const rect = node.getBoundingClientRect();
				if (!(rect.width > 0 && rect.height > 0)) continue;
				const composer = composerRect(node);
				if (composer !== null && composer.width <= rect.width) {
					// Remembered relative to the strip, so it still fits if the strip itself moves.
					lastFit = { offset: composer.left - rect.left, width: composer.width };
					return { left: composer.left, top: rect.top, width: composer.width, height: rect.height };
				}
				// The harness rebuilds the composer when a message is sent, and for a frame or two there is no text box to
				// measure. Keep the last measured width then, instead of jumping to the full strip and back.
				if (composer === null && lastFit !== null && lastFit.offset + lastFit.width <= rect.width + 1) {
					return { left: rect.left + lastFit.offset, top: rect.top, width: lastFit.width, height: rect.height };
				}
				return rect;
			}
			return null;
		}

		function tick() {
			loop = spacers.size > 0 ? requestAnimationFrame(tick) : 0;
			ensureFrame();
			if (frame === null) return;
			const rect = activeSpacer();
			if (rect === null) { frame.style.display = "none"; return; }
			const style = frame.style;
			style.display = "block";
			style.left = rect.left + "px";
			style.top = rect.top + "px";
			style.width = rect.width + "px";
			style.height = height + "px";
			const next = pageTheme();
			if (next !== theme) {
				theme = next;
				frame.contentWindow?.postMessage({ type: "freepi:theme", theme }, new URL(pairing.gateway).origin);
			}
		}

		function FreePiDock() {
			const ref = React.useRef(null);
			React.useEffect(() => {
				const node = ref.current;
				if (node === null) return undefined;
				spacers.add(node);
				requestPairing();
				if (loop === 0) loop = requestAnimationFrame(tick);
				return () => {
					spacers.delete(node);
					if (spacers.size === 0) {
						if (frame !== null) frame.style.display = "none";
						// A pending retry dies here; a request already in flight ends its own chain when it sees no dock.
						if (pairingRetryTimer !== 0) { clearTimeout(pairingRetryTimer); pairingRetryTimer = 0; pairingRequested = false; }
					}
				};
			}, []);
			return React.createElement("div", { ref, "data-freepi-dock": "", "aria-hidden": "true", style: { height: height + "px", marginBottom: GAP + "px", width: "100%", flex: "none" } });
		}

		exports.inject = ["slots"];
		exports.apply = function apply(ctx) {
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "freepi-bar", order: 100 }, FreePiDock));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "freepi-bar-frame" }, FreePiOverlay));
		};
		return module.exports;
	}
});
