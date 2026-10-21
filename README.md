# dsh-window-size（窗口尺寸）

DSH 客户端主窗口的尺寸与位置，存下来，并在**每次启动客户端时自动恢复一次**。

## 入口在哪

只在一个地方：**客户端 → 设置 → 窗口尺寸**（`settings.section` 插槽）。
主界面不加按钮、不加面板，也不注册任何工具或命令。

## 怎么用

1. 打开「设置 → 窗口尺寸」；
2. 填宽 / 高（下限就是客户端自己的 `minWidth 520`、`minHeight 600`），X / Y 可留空（留空=位置交给客户端）；
3. 点「保存并应用」→ 立刻生效，同时落盘；
4. 以后每次启动客户端，宿主半会在窗口出现后应用一次保存的尺寸，然后停手。

想回到客户端默认尺寸 → 「清除保存」（删掉配置文件）。

## 它是怎么做的（以及为什么不长成"守护脚本"的样子）

- **没有计划任务、没有常驻轮询、没有外部脚本进程**。窗口操作在客户端宿主进程内直接用 Win32 完成：
  通过客户端自带的 `koffi`（`resources\app.asar.unpacked\dsh\node_modules\koffi`）绑定 `user32.dll`，
  调 `EnumWindows / GetWindowRect / SetWindowPos / ShowWindow`。
  宿主进程是客户端主进程的子进程，完整性级别与窗口一致，所以 `SetWindowPos` 不会被 UIPI 拦下。
- 动手的时刻只有两个：**客户端启动后收敛一次**、**用户在设置页点保存/应用**。
  客户端没开的时候，这里什么都不存在——不会有任何进程、窗口、弹窗。
- 只认"标题含 `DeepSeek Harness`"或"属于本进程树"的可见窗口，绝不碰其它程序的窗口。
- 窗口控制加载失败也不会抛给宿主：设置页会显示失败原因，配置照样能存。

## 文件与协议

| 位置 | 说明 |
| --- | --- |
| `~/.dsh/window-size.json` | 保存的配置：`{width,height,x,y,maximized,applyOnStart,savedAt}` |
| `~/.dsh/window-size.log` | 只有启动应用/保存的结果行，供排查（自动截断，不会无限涨） |
| `POST /api/window-size/dispatch` | 宿主半注册的 RPC（走 `connection.fetch.register`） |

RPC 报文与 `dsh-novel-desk` 同一套：

```jsonc
// 客户端 → 宿主
{ "type": "client-request", "method": "window-size/dispatch", "rpcId": "…", "payload": { "action": "config.save", "args": { "width": 2027, "height": 1074, "x": 231, "y": 163 } } }
// 宿主 → 客户端
{ "type": "server-response", "rpcId": "…", "result": { "ok": true, "value": { "saved": {}, "current": {}, "applied": {} } } }
```

`action` 取值：`state.get` / `config.save` / `config.apply` / `config.clear` / `window.read` / `windows.list`。

## 安装

```sh
# 客户端自带 pnpm；profile 在 ~/.dsh/profiles/desktop
# 已经通过 dsh-super-injector 的 dev_install_package 装配（profile package.json 的 link 依赖 + dsh.profile.bundles）
```

包内 `cordis.patch.yml` 就一行 `insert`，保证重启后由 profile 的 bundles 正常装配。

## 卸载

1. 从 profile 的 `dsh.profile.bundles` 与 `dependencies` 里删掉 `dsh-window-size`，删掉
   `~/.dsh/profiles/desktop/node_modules/dsh-window-size` 这个 junction；
2. 删掉 `~/.dsh/window-size.json` 与 `~/.dsh/window-size.log`。

（用注入器就一步：`dev_uninject_plugin` 匹配 `dsh-window-size`。）