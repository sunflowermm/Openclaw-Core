# Openclaw-Core

XRK-AGT 的 **OpenClaw 桥接核心**：在 XRK-AGT 侧提供与 OpenClaw Gateway 的 WebSocket 桥接（Tasker + 插件），并可通过配置总开关关闭，业务模块独立、不依赖底层默认配置目录。

## 目录结构

```
Openclaw-Core/
├── README.md
├── index.js                    # 入口，仅导出 Core 元信息
├── commonconfig/
│   └── openclaw.js             # 总开关配置（data/openclaw/openclaw.yaml）
├── default/
│   └── openclaw.yaml           # 默认配置模板（首次读取时复制到 data/openclaw/）
├── tasker/
│   └── XrkBridge.js            # 自定义 Tasker，WS 服务端，供 OpenClaw 插件连接
├── plugin/
│   └── XrkBridgeForward.js     # 主人私聊 → 转发到 XrkBridge → OpenClaw
└── OpenClaw-xrk-bridger/       # OpenClaw 侧通道插件（见下方 README）
    ├── README.md
    ├── package.json
    ├── openclaw.plugin.json
    ├── tsconfig.json
    ├── src/
    └── dist/                   # 构建产物，需部署到 OpenClaw extensions
```

## 配置（总开关）

- **路径**：`data/openclaw/openclaw.yaml`（由框架 commonconfig 统一管理，首次不存在时从 `core/Openclaw-Core/default/openclaw.yaml` 复制）
- **字段**：
  - `enabled`（boolean）：`true` 时加载 XrkBridge Tasker 与 XrkBridgeForward 插件并响应桥接；`false` 时不注册 Tasker、插件不处理事件

修改后需重启 XRK-AGT 或依赖配置热加载生效。

## 桥接链路

1. **XRK-AGT 侧**  
   - Napcat/OneBotv11 连接 XRK-AGT → 主人私聊触发 `onebot.message.private`。  
   - `XrkBridgeForward` 插件（`enabled` 为 true 时）将消息交给 `XrkBridge` Tasker。  
   - `XrkBridge` 在路径 `/XrkBridge` 提供 WebSocket 服务，将消息发给已连接的 OpenClaw 插件并等待回复，再通过 `e.reply` 回 QQ。

2. **OpenClaw 侧**  
   - 安装并启用本 Core 下的 **OpenClaw-xrk-bridger** 通道插件，配置 `wsUrl: ws://<XRK-AGT 地址>:端口/XrkBridge`。  
   - 插件以 WS 客户端连接 XRK-AGT，收到消息后走 OpenClaw 的 channel/runtime 流程，回复经同一 WS 发回 XRK-AGT。

## 底层依赖与可用性

本 Core 仅依赖 XRK-AGT 框架既有能力，不修改 `src/`：

| 能力 | 说明 |
|------|------|
| **commonconfig 加载** | `src/infrastructure/commonconfig/loader.js` 会扫描 `core/*/commonconfig/*.js`，本 Core 的 `openclaw.js` 会被加载，key 为 `openclaw`。 |
| **Tasker 加载** | `src/infrastructure/tasker/loader.js` 扫描 `core/*/tasker/*.js`，若模块导出 `register(bot)` 则调用。本 Core 的 `XrkBridge.js` 导出 `register(bot)`，内部根据 `openclaw.enabled` 决定是否 `Bot.tasker.push(...)`。 |
| **Plugin 加载** | `src/infrastructure/plugins/loader.js` 扫描 `core/*/plugin/*.js` 并加载。`XrkBridgeForward` 在 `accept()` 内读取 `openclaw.enabled`，为 false 时直接 return false。 |
| **全局对象** | 使用 `Bot`、`global.ConfigManager`、基类 `plugin`，与框架约定一致。 |

确保主项目已具备：`#infrastructure/commonconfig/commonconfig.js`、`#utils/paths.js`、TaskerLoader 的 `mod.register(bot)` 调用、PluginLoader 对 `core/*/plugin` 的扫描。

## 许可证

MIT
