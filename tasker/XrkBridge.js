import { ulid } from 'ulid';
import fs from 'fs';
import path from 'path';
import { fileTypeFromBuffer } from 'file-type';

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
      if (!payload) return;

      this.makeLog('info', ['收到 OpenClaw 消息', JSON.stringify(payload)], 'XRK-OC');

      if (payload.type === 'reply') {
        if (payload.id) {
          const cache = this.pending.get(payload.id);
          if (cache) {
            this.makeLog('info', ['匹配到 pending 请求', payload.id], 'XRK-OC');
            this.pending.delete(payload.id);
            cache.resolve(payload);
            return;
          }
        }

        this.makeLog('info', ['调用 handleDirectReply'], 'XRK-OC');
        this.handleDirectReply(payload);
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

  sendToOpenclaw(e, text, mediaUrls = [], files = []) {
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
      mediaUrls: Array.isArray(mediaUrls) ? mediaUrls : [],
      files: Array.isArray(files) ? files : [],
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

  extractMedia(e) {
    const mediaUrls = [];
    const files = [];

    if (Array.isArray(e.msg)) {
      for (const segment of e.msg) {
        if (segment.type === 'image' && segment.data?.url) {
          mediaUrls.push(segment.data.url);
        } else if (segment.type === 'file' && segment.data?.url) {
          files.push({ url: segment.data.url, name: segment.data.name || segment.data.file });
        }
      }
    }

    const rawMessage = e.raw_message || '';
    const imageRegex = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]/g;
    let match;
    while ((match = imageRegex.exec(rawMessage)) !== null) {
      const url = match[1].replace(/&amp;/g, '&');
      if (url.startsWith('http') || url.startsWith('base64://')) {
        mediaUrls.push(url);
      }
    }

    return { mediaUrls, files };
  }

  async processImageUrl(url) {
    if (!url) return null;
    // base64 和网络 URL 直接返回
    if (url.startsWith('base64://')) return url;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    // 处理本地文件路径（支持 file:// 前缀和直接路径）
    let filePath = url;
    if (url.startsWith('file://')) {
      filePath = url.replace(/^file:\/\/+/i, '').replace(/^\/([A-Za-z]:)/, '$1');
    }
    // 尝试读取本地文件并转为 base64
    try {
      if (fs.existsSync(filePath)) {
        const buffer = fs.readFileSync(filePath);
        return `base64://${buffer.toString('base64')}`;
      }
    } catch (err) {
      this.makeLog('warn', ['读取本地文件失败', filePath, err?.message], 'XRK-OC');
    }
    return null;
  }

  async detectFileType(url) {
    if (!url) return { isImage: false, ext: 'bin' };

    if (url.startsWith('base64://')) {
      try {
        const base64Data = url.replace(/^base64:\/\//, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const fileType = await fileTypeFromBuffer(buffer);

        if (fileType) {
          const isImage = fileType.mime.startsWith('image/');
          return { isImage, mime: fileType.mime, ext: fileType.ext };
        }
      } catch (err) {
        this.makeLog('warn', ['检测文件类型失败', err?.message], 'XRK-OC');
      }
    }

    return { isImage: false, ext: 'bin' };
  }

  async handleDirectReply(reply) {
    this.makeLog('info', ['handleDirectReply 开始', `mediaUrls: ${reply.mediaUrls?.length || 0}, files: ${reply.files?.length || 0}`], 'XRK-OC');

    try {
      if (!reply.to) {
        this.makeLog('warn', ['reply.to 为空'], 'XRK-OC');
        return;
      }

      const isGroup = reply.to.kind === 'group';
      const targetId = isGroup ? reply.to.groupId : reply.to.userId;
      if (!targetId) {
        this.makeLog('warn', ['targetId 为空'], 'XRK-OC');
        return;
      }

      const selfId = reply.selfId ?? reply.to?.selfId ?? null;
      this.makeLog('info', [`目标: ${isGroup ? 'group' : 'user'} ${targetId}${selfId ? ` (self_id=${selfId})` : ''}`], 'XRK-OC');

      const sendMethod = isGroup ? Bot.pickGroup : Bot.pickFriend;
      const target = sendMethod.call(Bot, targetId, selfId);
      if (!target || typeof target.sendMsg !== 'function') {
        this.makeLog('error', ['无法获取发送目标', selfId ? `(self_id=${selfId})` : '未指定 selfId，可能发错端'], 'XRK-OC');
        return;
      }

      if (reply.text) {
        this.makeLog('info', ['发送文本消息'], 'XRK-OC');
        await target.sendMsg(String(reply.text));
      }

      if (Array.isArray(reply.mediaUrls) && reply.mediaUrls.length > 0) {
        this.makeLog('info', [`准备发送 ${reply.mediaUrls.length} 个媒体文件`], 'XRK-OC');
        for (const url of reply.mediaUrls) {
          const processedUrl = await this.processImageUrl(url);
          if (!processedUrl) continue;

          const fileInfo = await this.detectFileType(processedUrl);
          this.makeLog('info', [`文件类型检测: isImage=${fileInfo.isImage}, mime=${fileInfo.mime || 'unknown'}`], 'XRK-OC');

          if (fileInfo.isImage) {
            await target.sendMsg([{ type: 'image', data: { file: processedUrl } }]);
            this.makeLog('info', ['图片发送成功'], 'XRK-OC');
          } else {
            const fileName = `file.${fileInfo.ext || 'bin'}`;
            await target.sendMsg([{ type: 'file', data: { file: processedUrl, name: fileName } }]);
            this.makeLog('info', ['文件发送成功', fileName], 'XRK-OC');
          }
        }
      }

      if (Array.isArray(reply.files) && reply.files.length > 0) {
        this.makeLog('info', [`准备发送 ${reply.files.length} 个文件`], 'XRK-OC');
        for (const file of reply.files) {
          const processedUrl = await this.processImageUrl(file.url);
          if (processedUrl) {
            await target.sendMsg([{ type: 'file', data: { file: processedUrl, name: file.name } }]);
            this.makeLog('info', ['文件发送成功', file.name], 'XRK-OC');
          }
        }
      }
    } catch (err) {
      this.makeLog('error', ['处理直接回复失败', err?.message || err], 'XRK-OC');
    }
  }

  async forwardEvent(e) {
    const text = (e.msg || e.plainText || e.raw_message || '').trim();
    const { mediaUrls, files } = this.extractMedia(e);

    if (!text && mediaUrls.length === 0 && files.length === 0) return false;

    const reply = await this.sendToOpenclaw(e, text, mediaUrls, files).catch(err => {
      this.makeLog('error', ['调用 OpenClaw 失败', err?.message || err], e.self_id);
      return null;
    });

    if (!reply) return false;

    try {
      if (typeof e.reply !== 'function') return true;

      if (reply.text) {
        await e.reply(String(reply.text));
      }

      if (Array.isArray(reply.mediaUrls) && reply.mediaUrls.length > 0) {
        for (const url of reply.mediaUrls) {
          const processedUrl = await this.processImageUrl(url);
          if (!processedUrl) continue;

          const fileInfo = await this.detectFileType(processedUrl);
          if (fileInfo.isImage) {
            await e.reply([{ type: 'image', data: { file: processedUrl } }]);
          } else {
            const fileName = `file.${fileInfo.ext || 'bin'}`;
            await e.reply([{ type: 'file', data: { file: processedUrl, name: fileName } }]);
          }
        }
      }

      if (Array.isArray(reply.files) && reply.files.length > 0) {
        for (const file of reply.files) {
          const processedUrl = await this.processImageUrl(file.url);
          if (processedUrl) {
            await e.reply([{ type: 'file', data: { file: processedUrl, name: file.name } }]);
          }
        }
      }
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
