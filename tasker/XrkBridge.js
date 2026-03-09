import { ulid } from 'ulid';

/**
 * XRK-AGT 自定义 Tasker：与 OpenClaw Bridge 通道通过 WebSocket 互通。
 * 仅当 data/openclaw/openclaw.yaml 中 enabled 为 true 时注册（见 register）。
 */
const XrkBridgeTasker = class {
  id = 'XRK-OC';
  name = 'XrkBridge';
  path = this.name;

  ws = null;
  pending = new Map();
  timeout = 120000;

  makeLog(level, msg, selfId) {
    if (Array.isArray(msg)) Bot.makeLog(level, msg, selfId);
    else Bot.makeLog(level, String(msg), selfId);
  }

  attach(ws) {
    this.ws = ws;
    this.makeLog('mark', 'OpenClaw Bridge 已连接', 'XRK-OC');

    ws.on('message', data => {
      let payload;
      try {
        payload = JSON.parse(String(data));
      } catch (err) {
        this.makeLog('error', ['解析 OpenClaw 消息失败', data, err], 'XRK-OC');
        return;
      }
      if (!payload || !payload.id) return;
      if (payload.type === 'reply') {
        const cache = this.pending.get(payload.id);
        if (!cache) return;
        this.pending.delete(payload.id);
        cache.resolve(payload);
      }
    });

    ws.on('close', () => {
      this.makeLog('warn', 'OpenClaw Bridge 连接关闭', 'XRK-OC');
      this.ws = null;
      for (const [, cache] of this.pending) cache.reject(new Error('OpenClaw Bridge 已断开'));
      this.pending.clear();
    });

    ws.on('error', err => {
      this.makeLog('error', ['OpenClaw Bridge WS 错误', err], 'XRK-OC');
    });
  }

  sendToOpenclaw(e, text) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(Bot.makeError('OpenClaw Bridge 未连接'));
    }
    const id = ulid();
    const isGroup = !!e.group_id;
    const payload = {
      id,
      type: 'message',
      kind: isGroup ? 'group' : 'direct',
      selfId: String(e.self_id || ''),
      userId: String(e.user_id || ''),
      groupId: isGroup ? String(e.group_id) : undefined,
      text: String(text || ''),
    };
    const ticket = Promise.withResolvers();
    this.pending.set(id, { ...ticket, e });
    const timer = setTimeout(() => {
      if (!this.pending.has(id)) return;
      this.pending.delete(id);
      ticket.reject(Bot.makeError('OpenClaw Bridge 响应超时'));
    }, this.timeout);
    ticket.promise.finally(() => clearTimeout(timer)).catch(() => {});
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      this.pending.delete(id);
      clearTimeout(timer);
      return Promise.reject(err);
    }
    return ticket.promise;
  }

  async forwardEvent(e) {
    const text = (e.msg || e.plainText || e.raw_message || '').trim();
    if (!text) return false;
    const reply = await this.sendToOpenclaw(e, text).catch(err => {
      this.makeLog('error', ['调用 OpenClaw 失败', err?.message || err], e.self_id);
      return null;
    });
    if (!reply || !reply.text) return false;
    try {
      if (typeof e.reply === 'function') await e.reply(String(reply.text));
    } catch (err) {
      this.makeLog('error', ['发送 OpenClaw 回复失败', err?.message || err], e.self_id);
    }
    return true;
  }

  load() {
    if (!Array.isArray(Bot.wsf[this.path])) Bot.wsf[this.path] = [];
    Bot.wsf[this.path].push(ws => this.attach(ws));
    this.makeLog('info', 'XrkBridge Tasker 已注册 WS 路径 /XrkBridge', 'XRK-OC');
    Bot.xrkBridge = this;
  }
};

/**
 * 仅当 openclaw 配置 enabled 为 true 时注册 Tasker，否则不加载、不响应。
 */
export async function register(bot) {
  let enabled = true;
  const cm = global.ConfigManager;
  if (cm?.configs?.get) {
    const openclaw = cm.configs.get('openclaw');
    if (openclaw && typeof openclaw.read === 'function') {
      try {
        const data = await openclaw.read();
        enabled = data?.enabled !== false;
      } catch (_) {}
    }
  }
  if (!enabled) return;
  Bot.tasker.push(new XrkBridgeTasker());
}
