/**
 * dsh-llm-verifier-pro — Web client: the Best-of-N settings panel.
 *
 * Registers one section in the dsh Web UI settings surface (the
 * `settings.section` slot — "adding a setting never means editing the shell")
 * bound to this plugin's Host-registered `verifier` settings namespace through
 * the settingsScope service: reads are sync snapshots (useSyncExternalStore),
 * writes are path-addressed field sets, and the Host hot-publishes external
 * document edits — a switch flip applies to the very next turn, no restart.
 *
 * The panel is deliberately ONE decision: the master Best-of-N switch plus a
 * candidate count, for EVERY conversation. There is no per-session tier — the
 * "which sessions" question has exactly one answer: all or none. A live
 * "Current effect" banner states that answer in plain English.
 */
window.__ModuleLoader__.load({
	id: "dsh-llm-verifier-pro",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		const { createElement: h, useSyncExternalStore, useState, useEffect } = react;

		/** The section's shared styles (one injected style tag). */
		const CSS = `
.verifier-panel{display:flex;flex-direction:column;gap:14px;max-width:560px;padding:4px 0}
.verifier-panel__title{font-size:15px;font-weight:600;margin:0}
.verifier-panel__desc{font-size:13px;line-height:1.6;color:var(--dsw-alias-text-secondary,#6b7280);margin:0}
.verifier-panel__options{display:flex;flex-direction:column;gap:8px}
.verifier-panel__option{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-default,#e5e7eb);border-radius:8px;cursor:pointer;transition:border-color .15s,background .15s}
.verifier-panel__option:hover{border-color:var(--dsw-alias-border-hover,#9ca3af)}
.verifier-panel__option--active{border-color:var(--dsw-alias-accent-primary,#2563eb);background:var(--dsw-alias-accent-subtle,#eff6ff)}
.verifier-panel__option input{margin-top:2px;accent-color:var(--dsw-alias-accent-primary,#2563eb)}
.verifier-panel__option-body{display:flex;flex-direction:column;gap:2px}
.verifier-panel__option-label{font-size:14px;font-weight:500}
.verifier-panel__option-hint{font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280)}
.verifier-panel__custom{display:flex;align-items:center;gap:8px;margin-left:22px}
.verifier-panel__custom input{width:64px;padding:4px 8px;border:1px solid var(--dsw-alias-border-default,#e5e7eb);border-radius:6px;font-size:13px;background:var(--dsw-alias-bg-canvas,#fff);color:var(--dsw-alias-text-primary,#111827)}
.verifier-panel__text{width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-default,#e5e7eb);border-radius:8px;font-size:13px;background:var(--dsw-alias-bg-canvas,#fff);color:var(--dsw-alias-text-primary,#111827);box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.verifier-panel__text:focus{outline:none;border-color:var(--dsw-alias-accent-primary,#2563eb)}
.verifier-panel__effect{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:8px;border:1px solid}
.verifier-panel__effect--on{border-color:var(--dsw-alias-success-border,rgba(34,197,94,.45));background:var(--dsw-alias-success-subtle,rgba(34,197,94,.08))}
.verifier-panel__effect--on .verifier-panel__effect-dot{background:#34d399}
.verifier-panel__effect--off{border-color:var(--dsw-alias-border-default,#e5e7eb);background:var(--dsw-alias-bg-subtle,#f9fafb)}
.verifier-panel__effect-dot{width:8px;height:8px;border-radius:50%;flex:none;margin-top:5px;background:var(--dsw-alias-text-tertiary,#9ca3af)}
.verifier-panel__effect-body{display:flex;flex-direction:column;gap:2px}
.verifier-panel__effect-text{font-size:13px;font-weight:600;color:var(--dsw-alias-text-primary,#111827)}
.verifier-panel__effect-note{font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280)}
.verifier-panel__section-title{font-size:13px;font-weight:600;margin:8px 0 0;color:var(--dsw-alias-text-primary,#111827)}
.verifier-panel__status{font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280);margin:0}
.verifier-panel__fold{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-default,#e5e7eb);border-radius:8px}
.verifier-panel__fold[open]{padding-bottom:14px}
.verifier-panel__fold-summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--dsw-alias-text-primary,#111827);user-select:none}
.verifier-panel__fold-body{display:flex;flex-direction:column;gap:12px;margin-top:10px}
.verifier-panel__mix{display:flex;flex-direction:column;gap:8px}
.verifier-panel__mix textarea{width:100%;min-height:88px;padding:8px 10px;border:1px solid var(--dsw-alias-border-default,#e5e7eb);border-radius:8px;font-size:12.5px;line-height:1.6;background:var(--dsw-alias-bg-canvas,#fff);color:var(--dsw-alias-text-primary,#111827);resize:vertical;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.verifier-panel__mix textarea:focus{outline:none;border-color:var(--dsw-alias-accent-primary,#2563eb)}
.verifier-panel__mix-actions{display:flex;align-items:center;gap:10px}
.verifier-panel__mix-btn{padding:5px 14px;border:1px solid var(--dsw-alias-border-default,#e5e7eb);border-radius:6px;background:var(--dsw-alias-bg-canvas,#fff);color:var(--dsw-alias-text-primary,#111827);font-size:12.5px;cursor:pointer;transition:border-color .15s}
.verifier-panel__mix-btn:hover{border-color:var(--dsw-alias-accent-primary,#2563eb)}
.verifier-panel__mix-btn:disabled{opacity:.5;cursor:not-allowed}
.verifier-panel__mix-hint{font-size:11.5px;color:var(--dsw-alias-text-secondary,#6b7280);line-height:1.5}
.verifier-panel__mix-badges{display:flex;flex-wrap:wrap;gap:6px;max-height:150px;overflow-y:auto}
.verifier-panel__mix-badge{padding:3px 10px;border:1px solid var(--dsw-alias-border-default,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-canvas,#fff);color:var(--dsw-alias-text-primary,#111827);font-size:11.5px;cursor:pointer;transition:border-color .15s;white-space:nowrap}
.verifier-panel__mix-badge:hover{border-color:var(--dsw-alias-accent-primary,#2563eb);color:var(--dsw-alias-accent-primary,#2563eb)}
.verifier-panel__degrade{display:flex;flex-direction:column;gap:6px}
.verifier-panel__degrade>label{cursor:pointer}
`;
		const CSS_TAG = "dsh-llm-verifier-pro/client/panel.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-llm-verifier-pro";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** The master switch options: off (master kill-switch) plus candidate counts. */
		const MODES = [
			{ key: "off", label: "Off", hint: "Nothing is sampled — every conversation answers as usual. This also overrides the config default." },
			{ key: "3", label: "Fast · 3-way", hint: "≈2–3× tokens, 2× latency (≈7–15 s/turn); ≈9 model calls" },
			{ key: "5", label: "Accurate · 5-way", hint: "≈3–5× tokens, 2–4× latency (≈12–30 s/turn); ≈16 model calls (paper default Bo5)" },
			{ key: "custom", label: "Custom", hint: "2–8 ways: cost & latency grow with the count (8 ways ≈6–8× tokens)" },
		];

		/** The live "current effect" banner, computed from the settings section every render. */
		function effectOf(section) {
			if (section.boN === true) {
				return {
					kind: "on",
					text: "Best-of-N is ON for every conversation · " + String(section.boNCandidates ?? 5) + "-way",
				};
			}
			return {
				kind: "off",
				text: "Best-of-N is OFF for every conversation",
			};
		}

		function modeKeyOf(section) {
			if (section.boN !== true) return "off";
			if (section.boNCandidates === 3) return "3";
			if (section.boNCandidates === 5) return "5";
			return "custom";
		}

		/** The Best-of-N settings section (rendered by the settings shell). */
		function BoNSettingsSection() {
			return h("div", { className: "verifier-panel" },
				h("h2", { className: "verifier-panel__title" }, "Best-of-N Conversation Mode"),
				h("p", { className: "verifier-panel__desc" },
					"LLM-as-a-Verifier selection (arXiv:2607.05391): when enabled, every conversation samples N answers in the background; a fine-grained verifier ranks them by log-probability expected score and only the winner is shown. This setting applies to every conversation — there is no per-session mode.")
			);
		}

		// The panel body needs the settingsScope service, which arrives through
		// the plugin context — composed below in apply().
		function BoNPanelBody({ scope, connection }) {
			const snapshot = useSyncExternalStore(
				(subscribe) => scope.subscribe(subscribe),
				() => scope.getSnapshot(),
			);
			const [customDraft, setCustomDraft] = useState("5");
			const [verifyDraft, setVerifyDraft] = useState("90");
			const [mixDraft, setMixDraft] = useState(null);
			const [savedMix, setSavedMix] = useState(false);
			// Available models for the mix picker (best-effort enrichment for
			// the badge list — the provider recognition below does NOT depend
			// on it: saving is an explicit split). Source: the connection's
			// `llm.providers` unary, which works for BOTH bundle and dynamic
			// loading (the official models panel uses it).
			// NOTE: declared BEFORE any conditional return — React hooks must
			// run unconditionally.
			const [availableModels, setAvailableModels] = useState(null);
			const [modelsError, setModelsError] = useState(null);
			useEffect(() => {
				let cancelled = false;
				try {
					if (connection && connection.api && typeof connection.api.llm.providers === "function") {
						connection.api.llm.providers({}).then((resp) => {
							if (cancelled) return;
							const value = resp && resp.result && resp.result.ok !== false ? resp.result.value : (resp && resp.value);
							const providers = value && Array.isArray(value.providers)
								? value.providers.map((p) => p && p.provider).filter((p) => typeof p === "string" && p.length > 0)
								: [];
							// llm.providers gives route NAMES only; the badge list
							// would need models too. Mark the source as loaded so
							// the panel doesn't show a permanently "loading" hint.
							if (providers.length > 0) setAvailableModels([]);
						}).catch(() => {});
					}
				} catch (error) { /* ignore */ }
				// Fallback enrichment: host RPC (harness only).
				try {
					host.call("verifier-pro.available-models").then((rows) => {
						if (cancelled) return;
						if (rows && Array.isArray(rows) && rows.length > 0) {
							setAvailableModels(rows);
						} else if (rows && rows.error) {
							setModelsError(String(rows.error));
						}
					}).catch((error) => { if (!cancelled) setModelsError(String(error && error.message || error)); });
				} catch (error) {
					if (!cancelled) setModelsError(String(error && error.message || error));
				}
				return () => { cancelled = true; };
			}, []);
			const status = snapshot.status;
			if (status === "loading") {
				return h("p", { className: "verifier-panel__status" }, "Loading settings…");
			}
			if (status !== "ready" || snapshot.value === undefined) {
				return h("p", { className: "verifier-panel__status" }, "Settings unavailable (this connection does not expose preferences).");
			}
			const section = snapshot.value;
			const activeKey = modeKeyOf(section);
			const busy = status === "ready" && snapshot.writable !== true;
			const effect = effectOf(section);

			const pick = (key) => {
				if (key === "off") { scope.set("boN", false); return; }
				if (key === "custom") {
					const n = Math.min(8, Math.max(2, Number.parseInt(customDraft, 10) || 5));
					scope.set("boN", true);
					scope.set("boNCandidates", n);
					return;
				}
				scope.set("boN", true);
				scope.set("boNCandidates", Number.parseInt(key, 10));
			};

			// Model mix editor. Each line is either:
			//   - `model` (a FULL model id WITHOUT `/`, e.g. `deepseek-v4-pro`) —
			//     sampled with the conversation's provider; or
			//   - `provider/model` — an explicit provider route, e.g.
			//     `omni-message/opencode-go/minimax-m3`.
			// The first `/` splits provider (left) from model id (right); that is
			// why a full model id containing `/` (e.g. `ollama-local/qwen3.8:27b`)
			// must be written as `omni-chat/ollama-local/qwen3.8:27b` to name its
			// provider explicitly — it can never ride "the conversation's
			// provider" in the panel, because the split would take the part
			// before `/` as the provider.
			// The panel holds a text draft that lazily reflects the stored
			// section; saving parses + writes it.
			const mixLines = Array.isArray(section.boNModelMix) && section.boNModelMix.length > 0
				? section.boNModelMix.map((entry) => {
					if (typeof entry === "string") return entry;
					if (entry && typeof entry === "object" && entry.model)
						return (entry.provider && entry.provider.length > 0)
							? entry.provider + "/" + entry.model
							: entry.model;
					return "";
				}).filter((line) => line.length > 0)
				: [];
			const mixText = mixDraft !== null ? mixDraft : mixLines.join("\n");
			const normalizeMix = (text) => {
				const entries = [];
				const lines = (text ?? "").split("\n");
				for (const raw of lines) {
					const line = raw.trim();
					if (line === "") continue;
					const firstSlash = line.indexOf("/");
					if (firstSlash > 0) {
						const provider = line.slice(0, firstSlash).trim();
						const model = line.slice(firstSlash + 1).trim();
						// Explicit provider route: provider/model-id...
						if (provider.length > 0 && model.length > 0) {
							entries.push({ provider, model });
							continue;
						}
					}
					// Full model id on the conversation's provider.
					entries.push(line);
				}
				return entries;
			};
			const saveMix = () => {
				const entries = normalizeMix(mixText);
				scope.set("boNModelMix", entries);
				setMixDraft(null); // re-sync from the stored section
				setSavedMix(true); // momentary "Saved ✓" feedback
				setTimeout(() => setSavedMix(false), 1500);
			};

			const appendModel = (row) => {
				// Explicit provider route when the badge's provider isn't the
				// conversation's provider — the panel can't know the latter, so
				// ALWAYS write the explicit route on click (it's unambiguous).
				const entry = row.provider + "/" + row.model;
				const current = mixText.trim();
				const next = current === "" ? entry : current + "\n" + entry;
				setMixDraft(next);
			};
			const restoreDefaults = () => {
				// An explicit empty mix = "follow the session model" (no model
				// mix). It OVERRIDES any plugin-config mix: the runtime treats
				// an unset section as "fall back to plugin config", but an
				// explicit [] as "no mix".
				scope.set("boNModelMix", []);
				setMixDraft(null);
			};

			return h("div", { className: "verifier-panel" },
				h("div", { className: "verifier-panel__effect verifier-panel__effect--" + effect.kind },
					h("span", { className: "verifier-panel__effect-dot" }),
					h("div", { className: "verifier-panel__effect-body" },
						h("span", { className: "verifier-panel__effect-text" }, effect.text),
						h("span", { className: "verifier-panel__effect-note" }, "Takes effect from the very next turn — no restart."),
					),
				),
				h("h3", { className: "verifier-panel__section-title" }, "Best-of-N mode"),
				h("div", { className: "verifier-panel__options" },
					MODES.map((mode) => h("label", {
						key: mode.key,
						className: `verifier-panel__option${activeKey === mode.key ? " verifier-panel__option--active" : ""}`,
						onClick: () => pick(mode.key),
					},
						h("input", { type: "radio", name: "verifier-bo-n-mode", checked: activeKey === mode.key, onChange: () => pick(mode.key), disabled: busy }),
						h("div", { className: "verifier-panel__option-body" },
							h("span", { className: "verifier-panel__option-label" }, mode.label),
							h("span", { className: "verifier-panel__option-hint" }, mode.hint),
							mode.key === "custom"
								? h("span", { className: "verifier-panel__custom" },
									"Ways: ",
									h("input", {
										type: "number", min: 2, max: 8, value: activeKey === "custom" ? String(section.boNCandidates ?? 5) : customDraft,
										onChange: (event) => { setCustomDraft(event.target.value); },
										onBlur: () => pick("custom"),
									}),
								)
								: null,
						),
					)),
				),
				h("details", { className: "verifier-panel__fold" },
					h("summary", { className: "verifier-panel__fold-summary" }, "Advanced settings"),
					h("div", { className: "verifier-panel__fold-body" },
						h("h3", { className: "verifier-panel__section-title" }, "Verifier (scoring model)"),
						h("label", { className: "verifier-panel__option" },
							h("input", { type: "checkbox", checked: false, style: { display: "none" } }),
							h("div", { className: "verifier-panel__option-body" },
								h("span", { className: "verifier-panel__option-hint" }, "The single model that grades every candidate pair and picks the winner. Empty → FOLLOW THE SESSION MODEL (zero-config default). One line, same rule as the Model mix: part before the first / is the provider, the rest the model id."),
							),
						),
						h("div", { className: "verifier-panel__mix" },
							h("textarea", {
								value: section.verifier ?? "",
								placeholder: "One line, same rule as Model mix:\n• provider/model (the provider's own endpoint & key are used automatically)\n  omni-chat/ollama-local/qwen3.8:27b\n• a bare model id WITHOUT / — rides the session's provider:\n  deepseek-chat\n\nEmpty = follow the session model.",
								disabled: busy,
								onChange: (event) => scope.set("verifier", event.target.value),
							}),
							h("div", { className: "verifier-panel__mix-hint" },
								"Endpoint and API key come from dsh's provider configuration — you never type a base URL. Clear the box to return to 'follow the session model'."),
						),
						h("h3", { className: "verifier-panel__section-title" }, "Verify timeout (seconds)"),
						h("label", { className: "verifier-panel__option" },
							h("input", { type: "checkbox", checked: false, style: { display: "none" } }),
							h("div", { className: "verifier-panel__option-body" },
								h("span", { className: "verifier-panel__option-hint" }, "Independent wall-clock budget for the ranking phase only (sampling keeps its own budget). On timeout the turn returns a plain answer with a footer note. Default 90 s."),
								h("span", { className: "verifier-panel__custom" },
									h("input", {
										type: "number", min: 30, max: 600, step: 10,
										value: String(Math.round((section.verifyTimeoutMsBoN ?? 90000) / 1000)),
										onChange: (event) => { setVerifyDraft(event.target.value); },
										onBlur: () => {
											const seconds = Math.min(600, Math.max(30, Number.parseInt(verifyDraft, 10) || 90));
											scope.set("verifyTimeoutMsBoN", seconds * 1000);
										},
									}),
								),
							),
						),
						h("h3", { className: "verifier-panel__section-title" }, "Sampling temperature"),
						h("label", { className: "verifier-panel__option" },
							h("input", { type: "checkbox", checked: false, style: { display: "none" } }),
							h("div", { className: "verifier-panel__option-body" },
								h("span", { className: "verifier-panel__option-hint" }, "Diversity temperature for the sampled candidates (0.0 = deterministic, higher = more diverse). Default 0.7."),
								h("span", { className: "verifier-panel__custom" },
									h("input", {
										type: "number", min: 0, max: 2, step: 0.1,
										value: String(section.samplingTemperature ?? 0.7),
										onChange: (event) => scope.set("samplingTemperature", Number.parseFloat(event.target.value) || 0.7),
									}),
								),
							),
						),
						h("h3", { className: "verifier-panel__section-title" }, "Answer footer"),
						h("label", { className: "verifier-panel__option" + (section.showFooter !== false ? " verifier-panel__option--active" : ""), onClick: () => scope.set("showFooter", section.showFooter === false) },
							h("input", { type: "checkbox", checked: section.showFooter !== false, onChange: () => scope.set("showFooter", section.showFooter === false), disabled: busy }),
							h("div", { className: "verifier-panel__option-body" },
								h("span", { className: "verifier-panel__option-label" }, "Show the Best-of-N footer"),
								h("span", { className: "verifier-panel__option-hint" }, "Append the muted “⚡ Best-of-N …” line under the winning answer. Turn off to keep answers clean."),
							),
						),
						h("h3", { className: "verifier-panel__section-title" }, "Rollout schedule"),
						h("div", { className: "verifier-panel__options" },
							[
								{ key: "parallel", label: "Parallel", hint: "All candidates fire at once — fastest when models are fast." },
								{ key: "serial", label: "Serial", hint: "One candidate at a time — safer when several candidates share one slow local model." },
							].map((entry) => {
								const activeSampling = section.samplingMode === "serial" ? "serial" : "parallel";
								return h("label", {
									key: entry.key,
									className: `verifier-panel__option${activeSampling === entry.key ? " verifier-panel__option--active" : ""}`,
									onClick: () => scope.set("samplingMode", entry.key),
								},
									h("input", { type: "radio", name: "verifier-bo-n-sampling-mode", checked: activeSampling === entry.key, onChange: () => scope.set("samplingMode", entry.key), disabled: busy }),
									h("div", { className: "verifier-panel__option-body" },
										h("span", { className: "verifier-panel__option-label" }, entry.label),
										h("span", { className: "verifier-panel__option-hint" }, entry.hint),
									),
								);
							}),
						),
						h("h3", { className: "verifier-panel__section-title" }, "Model mix (candidate diversity)"),
						h("div", { className: "verifier-panel__mix" },
							h("textarea", {
								value: mixText,
								placeholder: "One line per entry. The part before the first / is the provider, the rest is the model id:\n• provider/model (explicit provider):\n  omni-message/opencode-go/minimax-m3\n  omni-chat/ollama-local/qwen3.8:27b\n• a model id WITHOUT / (conversation's provider):\n  deepseek-v4-pro",
								disabled: busy,
								onChange: (event) => { setMixDraft(event.target.value); },
							}),
							h("div", { className: "verifier-panel__mix-actions" },
								h("button", { className: "verifier-panel__mix-btn", disabled: busy, onClick: saveMix }, savedMix ? "Saved ✓" : "Save model mix"),
								h("button", { className: "verifier-panel__mix-btn", disabled: busy, onClick: restoreDefaults }, "Restore config defaults"),
								h("span", { className: "verifier-panel__mix-hint" },
									"Candidate 0 is always the conversation's model (greedy anchor); the rest fill from this list in order, and slots beyond the list fall back to anchor-model variants. Empty = same-model sampling."),
							),
							(modelsError !== null
								? h("p", { className: "verifier-panel__mix-hint" }, "Available models unavailable: " + modelsError)
								: availableModels !== null
									? h("div", { className: "verifier-panel__mix" },
										h("div", { className: "verifier-panel__mix-hint" },
											"Available models (click to append above) — selected: " + String(mixLines.length)),
										h("div", { className: "verifier-panel__mix-badges" },
											availableModels.map((row) => h("button", {
												key: row.provider + "/" + row.model,
												type: "button",
												className: "verifier-panel__mix-badge",
												title: "provider: " + row.provider + " (click to add with this provider)",
												onClick: () => appendModel(row),
											}, row.provider + "/" + row.model)),
										),
									)
									: h("p", { className: "verifier-panel__mix-hint" }, "Loading available models…")
							),
						),
						h("h3", { className: "verifier-panel__section-title" }, "Scoring endpoint"),
						h("div", { className: "verifier-panel__degrade" },
							h("label", { className: "verifier-panel__option" + (section.autoDegrade !== false ? " verifier-panel__option--active" : ""), onClick: () => scope.set("autoDegrade", section.autoDegrade === false) },
								h("input", { type: "checkbox", checked: section.autoDegrade !== false, onChange: () => scope.set("autoDegrade", section.autoDegrade === false), disabled: busy }),
								h("div", { className: "verifier-panel__option-body" },
									h("span", { className: "verifier-panel__option-label" }, "Auto-degrade when the endpoint lacks logprobs"),
									h("span", { className: "verifier-panel__option-hint" },
										"On (default): when the endpoint returns no logprobs (e.g. MiniMax or some gateway routes), grading falls back to sampling the score letter; answers are still ranked and the footer marks “sampling scoring” (slightly less precise)."),
									h("span", { className: "verifier-panel__option-hint" },
										"Off: strict mode — unsupported endpoints surface the error directly and Bo-N turns return as plain answers. Never a silent downgrade."),
								),
							),
						),
					),
				),
				h("details", { className: "verifier-panel__fold" },
					h("summary", { className: "verifier-panel__fold-summary" }, "How do I know it’s running?"),
					h("div", { className: "verifier-panel__fold-body" },
						h("p", { className: "verifier-panel__desc" },
							"Every Best-of-N turn appends a muted footer to the answer — “⚡ Best-of-N · 5-choose-1 → …” — with the tier, elapsed time and token use. The server console also logs “[bo-n] mode: …” per turn."),
					),
				),
			);
		}

		const inject = ["slots", "settingsScope", "connection"];

		/**
		 * Register the settings section bound to the Host's `verifier` namespace.
		 * @param ctx - browser plugin context carrying slots and settingsScope.
		 */
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => {
				const scope = ctx.settingsScope.bind({ namespace: "verifier-pro" });
				// The connection service (declared in inject) fronts the unary
				// RPCs — llm.providers is how we learn the real provider routes
				// under BOTH loading modes (the harness RPC is dynamic-only).
				let connection;
				try { connection = ctx.get("connection"); } catch { connection = undefined; }
				return ctx.slots.register({
					name: "settings.section",
					id: "verifier-pro",
					order: 50,
					label: () => "Best-of-N",
				}, function VerifierSection() {
					return h("div", { className: "verifier-panel" },
						h("h2", { className: "verifier-panel__title" }, "Best-of-N Conversation Mode"),
						h("p", { className: "verifier-panel__desc" },
							"LLM-as-a-Verifier selection (arXiv:2607.05391): when enabled, every conversation samples N answers in the background; a fine-grained verifier ranks them by log-probability expected score and only the winner is shown. This setting applies to every conversation — there is no per-session mode."),
						h(BoNPanelBody, { scope, connection }),
					);
				});
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});