/**
 * XrkBridgeForward 插件
 *
 * 职责：监听主人私聊，经 XrkBridge Tasker 推给 OpenClaw。
 * 当 data/openclaw/openclaw.yaml 中 enabled 为 false 时不响应。
 */

async function isOpenclawEnabled() {
  const cm = global.ConfigManager;
  if (!cm?.configs?.get) return true;
  const openclaw = cm.configs.get('openclaw');
  if (!openclaw || typeof openclaw.read !== 'function') return true;
  try {
    const data = await openclaw.read();
    return data?.enabled !== false;
  } catch (_) {
    return true;
  }
}

export class XrkBridgeForward extends plugin {
  constructor() {
    super({
      name: 'XrkBridge Forward',
      dsc: '主人私聊 → XrkBridge → OpenClaw',
      // 统一走框架级 message 事件，依靠 e.isPrivate/e.isMaster 过滤，
      // 支持所有协议的主人私聊，而不仅限于 OneBot。
      event: 'message.private',
      priority: 1500,
    });
  }

  async accept(e) {
    if (!(await isOpenclawEnabled())) return false;
    if (!e || e.isGroup || !e.isPrivate || !e.isMaster) return false;
    const bridge = Bot.xrkBridge;
    if (!bridge || typeof bridge.forwardEvent !== 'function') return false;
    return await bridge.forwardEvent(e);
  }
}

