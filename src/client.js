/**
 * dsh-llm-verifier-pro — Web client: the Best-of-N settings panel.
 *
 * Registers one section in the dsh Web UI settings surface (the
 * `settings.section` slot — "adding a setting never means editing the shell")
 * bound to this plugin's Host-registered `verifier` settings namespace through
 * the settingsScope service: reads are sync snapshots (useSyncExternalStore),
 * writes are path-addressed field sets, and the Host hot-publishes external
 * document edits — a switch flip applies to the very next turn, no restart.
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
.verifier-panel__option{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-default,#e5e7eb);border-radius:8px;cursor:pointer;transition:border-color .15s}
.verifier-panel__option:hover{border-color:var(--dsw-alias-border-hover,#9ca3af)}
.verifier-panel__option--active{border-color:var(--dsw-alias-accent-primary,#2563eb);background:var(--dsw-alias-accent-subtle,#eff6ff)}
.verifier-panel__option input{margin-top:2px;accent-color:var(--dsw-alias-accent-primary,#2563eb)}
.verifier-panel__option-body{display:flex;flex-direction:column;gap:2px}
.verifier-panel__option-label{font-size:14px;font-weight:500}
.verifier-panel__option-hint{font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280)}
.verifier-panel__custom{display:flex;align-items:center;gap:8px;margin-left:22px}
.verifier-panel__custom input{width:64px;padding:4px 8px;border:1px solid var(--dsw-alias-border-default,#e5e7eb);border-radius:6px;font-size:13px;background:var(--dsw-alias-bg-canvas,#fff);color:var(--dsw-alias-text-primary,#111827)}
.verifier-panel__notice{font-size:12px;line-height:1.5;color:var(--dsw-alias-text-secondary,#6b7280);border-left:3px solid var(--dsw-alias-accent-primary,#2563eb);padding-left:10px;margin:0}
.verifier-panel__degrade{display:flex;flex-direction:column;gap:6px;margin-top:2px}
.verifier-panel__degrade>label{cursor:pointer}
.verifier-panel__section-title{font-size:13px;font-weight:600;margin:8px 0 0;color:var(--dsw-alias-text-primary,#111827)}
.verifier-panel__status{font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280);margin:0}
.verifier-panel__mix{display:flex;flex-direction:column;gap:8px;margin-top:2px}
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
`;
		const CSS_TAG = "dsh-llm-verifier-pro/client/panel.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-llm-verifier-pro";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** The three canned modes plus custom. */
		const MODES = [
			{ key: "off", label: "关闭", hint: "普通回答：1× 延迟与消耗；仅当会话选择 \u201cBo-N 模式\u201d preset 时按会话生效" },
			{ key: "3", label: "快速经济 \u00b7 3 路采样", hint: "约 2–3× token、2× 延迟（约 7–15 秒/轮）；约 9 次模型调用" },
			{ key: "5", label: "精准 \u00b7 5 路采样", hint: "约 3–5× token、2–4× 延迟（约 12–30 秒/轮）；约 16 次模型调用（论文默认 Bo5）" },
			{ key: "custom", label: "自定义", hint: "2\u20138 路：消耗与耗时随路数增长（8 路约 6–8× token）" },
		];

		/** The preset-session tier (independent from the global tier). */
		const PRESET_TIERS = [
			{ key: "3", label: "快速经济 \u00b7 3 路", hint: "选中\u201cBo-N 模式\u201d的会话按 3 路采样" },
			{ key: "5", label: "精准 \u00b7 5 路（默认）", hint: "论文默认 Bo5" },
		];

		function presetKeyOf(section) {
			// unset falls back to the plugin default (5) — there is no third
			// option to be confused by: clicking "5" simply writes it down.
			return section.boNPresetCandidates === 3 ? "3" : "5";
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
				h("h2", { className: "verifier-panel__title" }, "Best-of-N 对话模式"),
				h("p", { className: "verifier-panel__desc" },
					"LLM-as-a-Verifier 择优（arXiv:2607.05391）：开启后每个回答在后台多路采样，由细粒度评审模型按对数概率期望分选出最佳答案，只把胜者呈现给你。")
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
				return h("p", { className: "verifier-panel__status" }, "正在读取设置…");
			}
			if (status !== "ready" || snapshot.value === undefined) {
				return h("p", { className: "verifier-panel__status" }, "设置暂不可用（此连接未暴露偏好设置）。");
			}
			const section = snapshot.value;
			const activeKey = modeKeyOf(section);
			const busy = status === "ready" && snapshot.writable !== true;

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

			const pickPreset = (key) => {
				scope.set("boNPresetCandidates", Number.parseInt(key, 10));
			};

			// Model mix editor. Each line is either:
			//   - `model` (a FULL model id, e.g. `ollama-local/qwen3.8:27b`) —
			//     sampled with the conversation's provider; or
			//   - `provider/model` — an explicit provider route, e.g.
			//     `omni-message/opencode-go/minimax-m3`.
			// The first `/` splits provider (left) from model id (right); a line
			// without `/` is a full model id on the conversation's provider.
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
				// Empty mix re-reads the plugin-config base (schema ⊕ base),
				// which is the "default" configuration.
				scope.set("boNModelMix", []);
				setMixDraft(null);
			};

			return h("div", { className: "verifier-panel" },
				h("h3", { className: "verifier-panel__section-title" }, "一、全局 Best-of-N（所有会话）"),
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
							mode.key === "custom" && activeKey === "custom" || mode.key === "custom"
								? h("span", { className: "verifier-panel__custom" },
									"路数：",
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
				h("h3", { className: "verifier-panel__section-title" }, "二、\u201cBo-N 模式\u201d会话档位（选中该 preset 的会话）"),
				h("div", { className: "verifier-panel__options" },
					PRESET_TIERS.map((tier) => h("label", {
						key: tier.key,
						className: `verifier-panel__option${presetKeyOf(section) === tier.key ? " verifier-panel__option--active" : ""}`,
						onClick: () => pickPreset(tier.key),
					},
						h("input", { type: "radio", name: "verifier-bo-n-preset-tier", checked: presetKeyOf(section) === tier.key, onChange: () => pickPreset(tier.key), disabled: busy }),
						h("div", { className: "verifier-panel__option-body" },
							h("span", { className: "verifier-panel__option-label" }, tier.label),
							h("span", { className: "verifier-panel__option-hint" }, tier.hint),
						),
					)),
				),
				h("label", { className: "verifier-panel__option", },
					h("input", { type: "checkbox", checked: false, style: { display: "none" } }),
					h("div", { className: "verifier-panel__option-body" },
						h("span", { className: "verifier-panel__option-label" }, "评分超时（秒）"),
						h("span", { className: "verifier-panel__option-hint" }, "评审阶段的独立时间预算（不被采样挤占）；超时该轮按普通回答返回并在 footer 说明。默认 90 秒。"),
						h("span", { className: "verifier-panel__custom" },
							h("input", {
								type: "number", min: 30, max: 600, step: 10,
								value: String(Math.round((section.verifyTimeoutMs ?? 90000) / 1000)),
								onChange: (event) => { setVerifyDraft(event.target.value); },
								onBlur: () => {
									const seconds = Math.min(600, Math.max(30, Number.parseInt(verifyDraft, 10) || 90));
									scope.set("verifyTimeoutMs", seconds * 1000);
								},
							}),
						),
					),
				),
				h("h3", { className: "verifier-panel__section-title" }, "模型混合（候选多样性）"),
				h("div", { className: "verifier-panel__mix" },
					h("textarea", {
						value: mixText,
						placeholder: "每行一个。\n• 完整 model id（用会话的 provider）：\n  ollama-local/qwen3.8:27b\n• provider/model（跨 provider 采样）：\n  omni-message/opencode-go/minimax-m3\n  deepseek-official/deepseek-v4-pro",
						disabled: busy,
						onChange: (event) => { setMixDraft(event.target.value); },
					}),
					h("div", { className: "verifier-panel__mix-actions" },
						h("button", { className: "verifier-panel__mix-btn", disabled: busy, onClick: saveMix }, "保存混合模型"),
						h("button", { className: "verifier-panel__mix-btn", disabled: busy, onClick: restoreDefaults }, "恢复配置默认"),
						h("span", { className: "verifier-panel__mix-hint" },
							"第 0 个候选始终用当前会话模型（贪心锚点）；其余按此列表逐格分配，超出列表的格子回退为锚点模型的高温变体。留空 = 全部同模型采样。"),
					),
					(modelsError !== null
						? h("p", { className: "verifier-panel__mix-hint" }, "可用模型不可用：" + modelsError)
						: availableModels !== null
							? h("div", { className: "verifier-panel__mix" },
								h("div", { className: "verifier-panel__mix-hint" },
									"可用模型（点击追加到上方列表）——已选：" + String(mixLines.length) + " 个"),
								h("div", { className: "verifier-panel__mix-badges" },
									availableModels.map((row) => h("button", {
										key: row.provider + "/" + row.model,
										type: "button",
										className: "verifier-panel__mix-badge",
										title: "provider: " + row.provider + "（点击以该 provider 加入混合）",
										onClick: () => appendModel(row),
									}, row.provider + "/" + row.model)),
								),
							)
							: h("p", { className: "verifier-panel__mix-hint" }, "正在读取可用模型…")
					),
				),
				h("div", { className: "verifier-panel__degrade" },
					h("label", { className: "verifier-panel__option" + (section.autoDegrade !== false ? " verifier-panel__option--active" : ""), onClick: () => scope.set("autoDegrade", section.autoDegrade === false) },
						h("input", { type: "checkbox", checked: section.autoDegrade !== false, onChange: () => scope.set("autoDegrade", section.autoDegrade === false), disabled: busy }),
						h("div", { className: "verifier-panel__option-body" },
							h("span", { className: "verifier-panel__option-label" }, "评分端点不支持时自动降级"),
							h("span", { className: "verifier-panel__option-hint" },
								"开启（默认）：评审端点无 logprobs（如 MiniMax 或部分网关路由）时自动切换采样评分，回答照常择优，footer 标注\u201c采样评分\u201d（精度略降）。"),
							h("span", { className: "verifier-panel__option-hint" },
								"关闭：严格模式，不支持时不生效——Bo-N 轮次按普通回答返回并在 footer 说明原因，verify 工具直接报错反馈。"),
						),
					),
				),
				h("p", { className: "verifier-panel__notice" },
					"\u26a0 \u5f00\u542f\u540e\u5168\u5c40\u751f\u6548\uff1a\u6240\u6709\u4f1a\u8bdd\u7684\u6bcf\u4e2a\u56de\u7b54\u90fd\u4f1a\u591a\u8def\u91c7\u6837\u62e9\u4f18\uff0ctoken \u6d88\u8017\u4e0e\u8017\u65f6\u6309\u4e0a\u9762\u6863\u4f4d\u6807\u6ce8\u589e\u957f\uff1b\u4e0b\u4e00\u8f6e\u5bf9\u8bdd\u7acb\u5373\u751f\u6548\uff0c\u65e0\u9700\u91cd\u542f\u3002\u6bcf\u8f6e\u56de\u7b54\u5c3e\u90e8\u7684 footer \u4f1a\u663e\u793a\u5b9e\u9645\u8017\u65f6\u4e0e token \u6d88\u8017\u3002\u9000\u51fa\u65b9\u5f0f\uff1a\u968f\u65f6\u5207\u56de\u201c\u5173\u95ed\u201d\u3002"),
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
						h("h2", { className: "verifier-panel__title" }, "Best-of-N \u5bf9\u8bdd\u6a21\u5f0f"),
						h("p", { className: "verifier-panel__desc" },
							"LLM-as-a-Verifier \u62e9\u4f18\uff08arXiv:2607.05391\uff09\uff1a\u5f00\u542f\u540e\u6bcf\u4e2a\u56de\u7b54\u5728\u540e\u53f0\u591a\u8def\u91c7\u6837\uff0c\u7531\u7ec6\u7c92\u5ea6\u8bc4\u5ba1\u6a21\u578b\u6309\u5bf9\u6570\u6982\u7387\u671f\u671b\u5206\u9009\u51fa\u6700\u4f73\u7b54\u6848\uff0c\u53ea\u628a\u80dc\u8005\u5448\u73b0\u7ed9\u4f60\u3002"),
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
