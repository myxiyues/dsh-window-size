/**
 * 窗口尺寸 · 客户端半。
 *
 * 手写的客户端 bundle：不经过打包器，直接按客户端的 ModuleLoader 格式注册，只 require("react")，
 * 其余全是原生 DOM —— 客户端换版本时不会踩到内部组件的形状。
 *
 * 座位：
 *  - settings.section → 「设置」里多一栏「窗口尺寸」（唯一入口；主界面不加任何东西）。
 * 数据：
 *  - ctx.connection.rpc.call("/api", "window-size/dispatch", { action, args })
 *    交给宿主半的 connection.fetch 路由处理（保存/应用/清除/读当前窗口）。
 */

window.__ModuleLoader__.load({
  id: "dsh-window-size",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const PLUGIN_ID = "dsh-window-size";
    const ENDPOINT = "window-size/dispatch";
    const inject = ["connection", "slots"];

    const C = {
      border: "1px solid rgba(128,128,128,0.28)",
      soft: "rgba(128,128,128,0.10)",
      accent: "rgba(64,132,255,0.95)",
      danger: "#e5484d",
    };

    const S = {
      root: { display: "flex", flexDirection: "column", gap: 10, padding: "6px 2px", fontSize: 13, lineHeight: 1.6, color: "inherit", maxWidth: 640 },
      title: { fontWeight: 600, fontSize: 17 },
      hint: { opacity: 0.66, fontSize: 12 },
      grid: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 },
      field: { display: "flex", flexDirection: "column", gap: 4 },
      label: { fontSize: 12, opacity: 0.75 },
      input: { padding: "5px 8px", background: "transparent", color: "inherit", border: C.border, borderRadius: 6, fontSize: 13, width: "100%", boxSizing: "border-box" },
      check: { display: "flex", alignItems: "center", gap: 8, fontSize: 13 },
      row: { display: "flex", flexWrap: "wrap", gap: 8 },
      button: { padding: "5px 10px", background: C.soft, color: "inherit", border: C.border, borderRadius: 6, cursor: "pointer", fontSize: 12.5, lineHeight: 1.5 },
      buttonPrimary: { padding: "5px 12px", background: C.accent, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12.5, lineHeight: 1.5 },
      status: { fontSize: 12, opacity: 0.7 },
      error: { fontSize: 12, color: C.danger, whiteSpace: "pre-wrap" },
      divider: { height: 1, background: "rgba(128,128,128,0.18)", margin: "2px 0" },
    };

    const defaultForm = { width: "", height: "", x: "", y: "", maximized: false, applyOnStart: true };
    const intText = (value) => (Number.isFinite(value) ? String(Math.round(value)) : "");

    /** 当前状态 → 表单草稿（有保存过的就用保存的，没有就用窗口现在的样子当起点）。 */
    const formOf = (state) => {
      const saved = state?.saved;
      if (saved) {
        return {
          width: intText(saved.width),
          height: intText(saved.height),
          x: saved.x === null || saved.x === undefined ? "" : intText(saved.x),
          y: saved.y === null || saved.y === undefined ? "" : intText(saved.y),
          maximized: saved.maximized === true,
          applyOnStart: saved.applyOnStart !== false,
        };
      }
      const rect = state?.current?.rect;
      return rect
        ? { ...defaultForm, width: intText(rect.width), height: intText(rect.height), x: intText(rect.x), y: intText(rect.y) }
        : { ...defaultForm };
    };

    const describe = (state) => {
      const parts = [];
      const rect = state?.current?.rect;
      if (rect) parts.push(`当前窗口 ${rect.width}×${rect.height} @ (${rect.x}, ${rect.y})${state.current.maximized ? "（最大化）" : ""}`);
      if (state?.screen) parts.push(`屏幕 ${state.screen.width}×${state.screen.height}`);
      if (state?.saved) parts.push(`已保存 ${state.saved.width}×${state.saved.height}${state.saved.maximized ? "（最大化）" : ""}`);
      return parts.join("｜");
    };

    const appliedText = (applied) => {
      if (!applied) return "没有结果";
      if (applied.ok !== true) return `未生效（${applied.code}${applied.error ? `：${applied.error}` : ""}）`;
      const after = applied.after;
      const where = after ? `，当前 ${after.width}×${after.height} @ (${after.x}, ${after.y})` : "";
      return `第 ${applied.attempts ?? 1} 次尝试生效${where}`;
    };

    /* ------------------------------------------------------------------ *
     * 设置页
     * ------------------------------------------------------------------ */

    function Section(props) {
      const rpc = props?.rpc;
      const [state, setState] = useState(null);
      const [form, setForm] = useState(defaultForm);
      const [dirty, setDirty] = useState(false);
      const [status, setStatus] = useState("");
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);

      /** 统一出口：出错写进 error 行，不把异常扔给设置页外壳。 */
      const run = useCallback(
        async (label, action, args) => {
          setBusy(true);
          setError("");
          try {
            const value = await rpc(action, args);
            if (value) {
              setState(value);
              setForm(formOf(value));
              setDirty(false);
            }
            return value;
          } catch (failure) {
            setError(`${label}失败：${failure?.message ?? failure}`);
            return undefined;
          } finally {
            setBusy(false);
          }
        },
        [rpc],
      );

      useEffect(() => {
        let alive = true;
        void (async () => {
          setBusy(true);
          try {
            const value = await rpc("state.get");
            if (!alive || !value) return;
            setState(value);
            setForm(formOf(value));
            setStatus(describe(value));
          } catch (failure) {
            if (alive) setError(`读取失败：${failure?.message ?? failure}`);
          } finally {
            if (alive) setBusy(false);
          }
        })();
        return () => {
          alive = false;
        };
      }, [rpc]);

      const edit = (key, value) => {
        setDirty(true);
        setForm((current) => ({ ...(current ?? defaultForm), [key]: value }));
      };

      // 渲染一律读 draft：草稿万一还没初始化也不会把整个设置页渲染炸掉。
      const draft = form ?? defaultForm;

      const save = () => {
        void (async () => {
          const value = await run("保存", "config.save", {
            width: draft.width,
            height: draft.height,
            x: draft.x === "" ? null : draft.x,
            y: draft.y === "" ? null : draft.y,
            maximized: draft.maximized,
            applyOnStart: draft.applyOnStart,
          });
          if (value) setStatus(`已保存并应用：${appliedText(value.applied)}｜${describe(value)}`);
        })();
      };

      const applySaved = () => {
        void (async () => {
          const value = await run("应用", "config.apply", {});
          if (value) setStatus(`已应用保存的尺寸：${appliedText(value.applied)}｜${describe(value)}`);
        })();
      };

      const fillFromCurrent = () => {
        void (async () => {
          const value = await run("读取当前窗口", "window.read", {});
          if (!value) return;
          const rect = value.fill?.rect;
          if (!rect) {
            setError("没找到客户端主窗口（窗口标题里应当带 “DeepSeek Harness”）");
            return;
          }
          setDirty(true);
          setForm((current) => ({
            ...(current ?? defaultForm),
            width: intText(rect.width),
            height: intText(rect.height),
            x: intText(rect.x),
            y: intText(rect.y),
            maximized: value.fill.maximized === true,
          }));
          setStatus(`已把当前窗口（${rect.width}×${rect.height} @ (${rect.x}, ${rect.y})）填进草稿，点「保存并应用」才会落盘。`);
        })();
      };

      const clear = () => {
        void (async () => {
          const value = await run("清除", "config.clear", {});
          if (value) {
            setStatus("已清除保存的尺寸，窗口回到客户端自己的默认值。");
            setDirty(false);
          }
        })();
      };

      const field = (label, key, placeholder) =>
        h(
          "label",
          { style: S.field, key },
          h("span", { style: S.label }, label),
          h("input", {
            style: S.input,
            type: "text",
            inputMode: "numeric",
            spellCheck: false,
            value: draft[key],
            placeholder: placeholder ?? "",
            disabled: busy,
            onChange: (event) => edit(key, event.target.value),
          }),
        );

      const check = (label, key, hint) =>
        h(
          "label",
          { style: S.check, key },
          h("input", {
            type: "checkbox",
            checked: draft[key] === true,
            disabled: busy,
            onChange: (event) => edit(key, event.target.checked),
          }),
          h("span", null, label, hint ? h("span", { style: S.label }, `（${hint}）`) : null),
        );

      const unavailable = state?.ffi && state.ffi.ok !== true;

      return h(
        "div",
        { style: S.root, "data-plugin": PLUGIN_ID, "data-busy": busy ? "1" : "0", "data-dirty": dirty ? "1" : "0" },
        h("div", { style: S.title }, "窗口尺寸"),
        h(
          "div",
          { style: S.hint },
          "保存客户端主窗口的宽高与位置：点保存立刻生效，以后每次启动客户端都会自动恢复一次。",
          state?.configFile ? `配置文件：${state.configFile}` : "",
        ),
        unavailable
          ? h("div", { style: S.error }, `窗口控制不可用：${state.ffi.error ?? "原因未知"}（设置能保存，但改不动窗口）`)
          : null,
        h(
          "div",
          { style: S.grid },
          field("宽（≥520）", "width"),
          field("高（≥600）", "height"),
          field("X（可留空）", "x", "留空 = 位置交给客户端"),
          field("Y（可留空）", "y", "留空 = 位置交给客户端"),
        ),
        h(
          "div",
          null,
          check("最大化启动", "maximized", "开启后忽略上面的尺寸与位置"),
          check("启动时自动应用", "applyOnStart", "关掉就只在你点保存时应用"),
        ),
        h("div", { style: S.row },
          h("button", { type: "button", style: S.buttonPrimary, disabled: busy, onClick: save }, busy ? "处理中…" : "保存并应用"),
          h("button", { type: "button", style: S.button, disabled: busy || !state?.saved, onClick: applySaved }, "应用已保存"),
          h("button", { type: "button", style: S.button, disabled: busy, onClick: fillFromCurrent }, "用当前窗口填充"),
          h("button", { type: "button", style: S.button, disabled: busy || !state?.saved, onClick: clear }, "清除保存"),
        ),
        h("div", { style: S.divider }),
        error ? h("div", { style: S.error }, error) : null,
        h("div", { style: S.status, "data-status": status || describe(state) }, status || describe(state)),
        state?.saved?.savedAt ? h("div", { style: S.hint }, `上次保存：${state.saved.savedAt}`) : null,
      );
    }

    /* ------------------------------------------------------------------ *
     * 注册
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      const rpc = async (action, args = {}) => {
        const result = await ctx.connection.rpc.call("/api", ENDPOINT, { action, args });
        if (!result || result.ok !== true) {
          const problem = new Error(result?.error?.message || "窗口尺寸请求失败");
          problem.code = result?.error?.code;
          throw problem;
        }
        return result.value;
      };

      // 「设置」里多一栏；主界面不加任何入口。
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: PLUGIN_ID,
            order: 35,
            label: () => "窗口尺寸",
            inject: () => ({ rpc }),
          },
          Section,
        ),
      );
    }

    exports.Section = Section;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});