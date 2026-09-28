/**
 * dsh-llm-verifier-pro — Web client: the plugin's configuration form on the
 * Plugins page.
 *
 * dsh 0.1.7 draws no form for a third-party plugin by itself: the Host serves
 * the `.volatile()` Config fields of the `llm-verifier-pro` entry through
 * `ctx.configForms`, and this page renders them into the bundle's own
 * `plugins.bundle.config` slot (keyed by the package name, as dshmarket does).
 * It registers only while the Host serves the entry, so a profile without the
 * plugin shows no trace of it. A save writes the profile patch; the Loader
 * commits volatile edits into the running plugin, so they apply to the next
 * turn without a restart.
 *
 * Hand-written in the ModuleLoader format the dsh web client loads; `react`
 * and `@deepseek-ai/dsh-client-ui-primitives` are the host's shared modules.
 */
window.__ModuleLoader__.load({
	id: "dsh-llm-verifier-pro",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const { createElement: h } = require("react");
		const ui = require("@deepseek-ai/dsh-client-ui-primitives");

		/** Host entry id (the bundle patch's row id) whose Config this page edits. */
		const ENTRY = "llm-verifier-pro";
		/** Package name the Plugins page keys this bundle's configuration by. */
		const PACKAGE = "dsh-llm-verifier-pro";
		/** Dictionary namespace owned by this plugin. */
		const NS = "llmVerifierPro";

		const en = {
			verifierSection: "Verifier",
			boNSection: "Best-of-N mode",
			verifier: "Verifier route",
			verifierHint: "provider/model, e.g. omni-chat/agnes/agnes-3.0-flash. Empty follows the conversation's model.",
			model: "Verifier model",
			modelHint: "Used only when Verifier route is empty. Empty follows the conversation's model.",
			baseUrl: "Base URL",
			baseUrlHint: "OpenAI-compatible endpoint, used only when Verifier route is empty. Empty follows the session provider.",
			timeoutMs: "Request timeout (ms)",
			maxConcurrency: "Max concurrent verifier calls",
			autoDegrade: "Fall back to sampling scoring when the endpoint returns no logprobs",
			boN: "Best-of-N for every conversation",
			boNHint: "Each plain-text answer is sampled N ways and the verifier keeps the best.",
			boNCandidates: "Candidates (N)",
			samplingMode: "Rollout schedule",
			parallel: "Parallel",
			serial: "Serial",
			samplingTemperature: "Sampling temperature",
			timeoutMsBoN: "Sampling phase budget (ms)",
			verifyTimeoutMsBoN: "Verify phase budget (ms)",
			showFooter: "Show the Best-of-N footer under the answer",
			boNPivots: "Tournament pivots (k)",
			boNSeed: "Tournament seed",
			boNModelMix: "Model mix",
			boNModelMixHint: "Models for candidates after the first, separated by ;. provider/model or a bare model id. Empty uses the conversation's model.",
			criteria: "Extra grading criteria",
			criteriaHint: "Separated by ;.",
			overridden: "Overridden",
			reset: "Reset to default",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			invalidNumber: "Enter a number, or leave blank to use the default.",
			invalidText: "This value is not accepted."
		};
		const zh = {
			verifierSection: "验证器",
			boNSection: "Best-of-N 模式",
			verifier: "验证器路由",
			verifierHint: "provider/model，例如 omni-chat/agnes/agnes-3.0-flash。留空则跟随当前对话的模型。",
			model: "验证器模型",
			modelHint: "仅在验证器路由为空时使用。留空则跟随当前对话的模型。",
			baseUrl: "Base URL",
			baseUrlHint: "OpenAI 兼容端点，仅在验证器路由为空时使用。留空则跟随会话的 provider。",
			timeoutMs: "单次请求超时（毫秒）",
			maxConcurrency: "验证器最大并发数",
			autoDegrade: "端点不返回 logprobs 时降级为采样评分",
			boN: "所有对话启用 Best-of-N",
			boNHint: "每个纯文本回答采样 N 份，由验证器选出最好的一份。",
			boNCandidates: "候选数（N）",
			samplingMode: "采样调度",
			parallel: "并行",
			serial: "串行",
			samplingTemperature: "采样温度",
			timeoutMsBoN: "采样阶段时限（毫秒）",
			verifyTimeoutMsBoN: "验证阶段时限（毫秒）",
			showFooter: "在回答下方显示 Best-of-N 脚注",
			boNPivots: "锦标赛枢轴数（k）",
			boNSeed: "锦标赛种子",
			boNModelMix: "模型混合",
			boNModelMixHint: "第一个之后的候选所用模型，用 ; 分隔。写 provider/model 或纯模型 id。留空则使用当前对话的模型。",
			criteria: "额外评分标准",
			criteriaHint: "用 ; 分隔。",
			overridden: "已覆盖",
			reset: "恢复默认",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			invalidNumber: "请填数字；留空表示使用默认值。",
			invalidText: "该值无效。"
		};

		/** A true/false field; the draft text is "true" or "false". */
		function booleanField(field) {
			return {
				field,
				format: (value) => typeof value === "boolean" ? String(value) : "",
				parse: (text) => text === "true" ? { kind: "set", value: true }
					: text === "false" ? { kind: "set", value: false }
					: text === "" ? { kind: "clear" }
					: void 0
			};
		}
		/** One of a fixed set of strings. */
		function choiceField(field, choices) {
			return {
				field,
				format: (value) => typeof value === "string" ? value : "",
				parse: (text) => text === "" ? { kind: "clear" } : choices.includes(text) ? { kind: "set", value: text } : void 0
			};
		}
		/**
		 * A string list edited as `;`-separated text. Model-mix entries stored as
		 * `{ provider, model }` show as `provider/model`, which the plugin resolves
		 * back to the same route.
		 */
		function listField(field) {
			return {
				field,
				format: (value) => Array.isArray(value)
					? value.map((entry) => typeof entry === "string" ? entry
						: entry && typeof entry === "object" ? (entry.provider ? `${entry.provider}/${entry.model}` : String(entry.model ?? ""))
						: "").filter(Boolean).join("; ")
					: "",
				parse: (text) => {
					const value = text.split(";").map((part) => part.trim()).filter(Boolean);
					return value.length === 0 ? { kind: "clear" } : { kind: "set", value };
				}
			};
		}

		const TEXT = ["verifier", "model", "baseUrl"];
		const NUMBER = ["timeoutMs", "maxConcurrency", "boNCandidates", "samplingTemperature", "timeoutMsBoN", "verifyTimeoutMsBoN", "boNPivots", "boNSeed"];
		const BOOLEAN = ["autoDegrade", "boN", "showFooter"];
		const LIST = ["boNModelMix", "criteria"];
		const FIELDS = [...TEXT, ...NUMBER, ...BOOLEAN, ...LIST, "samplingMode"];

		/** The page's staged form over the `llm-verifier-pro` entry. */
		class VerifierFormController {
			constructor(scope) {
				this.form = new ui.SettingsFormModel(scope, [
					...TEXT.map((field) => ui.settingsTextField(field)),
					...NUMBER.map((field) => ui.settingsNumberField(field)),
					...BOOLEAN.map(booleanField),
					...LIST.map(listField),
					choiceField("samplingMode", ["parallel", "serial"])
				]);
				this.store = this.form.bind(() => {
					const state = { ...this.form.shell() };
					for (const field of FIELDS) state[field] = this.form.field(field);
					return state;
				});
			}
			inject() {
				return { hooks: { verifierForm: this.store }, ...this.form.actions() };
			}
			dispose() {
				this.form.dispose();
			}
		}

		const styles = {
			section: { margin: "16px 0 4px", fontSize: 13, fontWeight: 600 },
			row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "6px 0" },
			rowText: { display: "flex", flexDirection: "column", gap: 2 },
			label: { fontSize: 13 },
			hint: { fontSize: 12, color: "var(--dsw-alias-text-secondary, #6b7280)" },
			reset: { fontSize: 12, background: "none", border: "none", cursor: "pointer", color: "var(--dsw-alias-accent-primary, #2563eb)", padding: 0 }
		};

		/** A labelled switch for one boolean field, with the override reset the value fields also offer. */
		function SwitchRow({ id, t, field, state, edit, resetField, hint }) {
			const current = state[field];
			return h("div", { style: styles.row },
				h("div", { style: styles.rowText },
					h("label", { htmlFor: id, style: styles.label }, t(field)),
					hint ? h("span", { style: styles.hint }, hint) : null,
					current.overridden ? h("button", { type: "button", style: styles.reset, disabled: !state.writable, onClick: () => resetField(field) }, t("reset")) : null),
				h(ui.Switch, { checked: current.text === "true", label: t(field), disabled: !state.writable, onChange: (next) => edit(field, String(next)) }));
		}

		/** Render the verifier's configuration form. */
		function VerifierConfigPage(props) {
			const { t } = props;
			const state = props.useVerifierForm((snapshot) => snapshot);
			if (props.view === "summary") return null;
			const common = { t, state, edit: props.edit, resetField: props.resetField };
			const valueField = (field, extra = {}) => h(ui.SettingsValueField, {
				key: field,
				id: `plugin-config-verifier-pro-${field}`,
				label: t(field),
				overriddenLabel: t("overridden"),
				resetLabel: t("reset"),
				invalidLabel: NUMBER.includes(field) ? t("invalidNumber") : t("invalidText"),
				numeric: NUMBER.includes(field),
				disabled: !state.writable,
				...state[field],
				onEdit: (text) => props.edit(field, text),
				onReset: () => props.resetField(field),
				...extra
			});
			const mode = state.samplingMode.text === "serial" ? "serial" : "parallel";
			return h(ui.SettingsForm, {
				labels: { unavailable: t("unavailable"), readOnly: t("readOnly"), saveFailed: t("saveFailed"), save: t("save"), saving: t("saving") },
				state,
				onSave: props.save,
				onDiscard: props.discard
			},
				h("div", { style: styles.section }, t("verifierSection")),
				valueField("verifier", { hint: t("verifierHint") }),
				valueField("model", { hint: t("modelHint") }),
				valueField("baseUrl", { hint: t("baseUrlHint") }),
				valueField("timeoutMs"),
				valueField("maxConcurrency"),
				h(SwitchRow, { ...common, id: "plugin-config-verifier-pro-autoDegrade", field: "autoDegrade" }),
				h("div", { style: styles.section }, t("boNSection")),
				h(SwitchRow, { ...common, id: "plugin-config-verifier-pro-boN", field: "boN", hint: t("boNHint") }),
				valueField("boNCandidates"),
				h("div", { style: styles.row },
					h("span", { style: styles.label }, t("samplingMode")),
					h(ui.SegmentedControl, {
						id: "plugin-config-verifier-pro-samplingMode",
						label: t("samplingMode"),
						value: mode,
						options: [{ value: "parallel", label: t("parallel") }, { value: "serial", label: t("serial") }],
						disabled: !state.writable,
						onChange: (next) => props.edit("samplingMode", next)
					})),
				valueField("samplingTemperature"),
				valueField("timeoutMsBoN"),
				valueField("verifyTimeoutMsBoN"),
				h(SwitchRow, { ...common, id: "plugin-config-verifier-pro-showFooter", field: "showFooter" }),
				valueField("boNPivots"),
				valueField("boNSeed"),
				valueField("boNModelMix", { hint: t("boNModelMixHint") }),
				valueField("criteria", { hint: t("criteriaHint") }));
		}

		/** Required browser services. */
		const inject = ["slots", "locale", "configForms"];

		/** Mount the form while the Host serves the `llm-verifier-pro` entry. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "llm-verifier-pro: dictionaries");
			const page = new VerifierFormController(ctx.configForms.get(ENTRY));
			ctx.effect(() => () => {
				page.dispose();
			}, "llm-verifier-pro: form subscription");
			ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: PACKAGE,
				locale: NS,
				inject: () => page.inject()
			}, VerifierConfigPage))), "llm-verifier-pro: page");
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
