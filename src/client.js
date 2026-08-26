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

		const { createElement: h, useSyncExternalStore, useState } = react;

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
		function BoNPanelBody({ scope }) {
			const snapshot = useSyncExternalStore(
				(subscribe) => scope.subscribe(subscribe),
				() => scope.getSnapshot(),
			);
			const [customDraft, setCustomDraft] = useState("5");
			const [verifyDraft, setVerifyDraft] = useState("90");
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

		const inject = ["slots", "settingsScope"];

		/**
		 * Register the settings section bound to the Host's `verifier` namespace.
		 * @param ctx - browser plugin context carrying slots and settingsScope.
		 */
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => {
				const scope = ctx.settingsScope.bind({ namespace: "verifier-pro" });
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
						h(BoNPanelBody, { scope }),
					);
				});
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
