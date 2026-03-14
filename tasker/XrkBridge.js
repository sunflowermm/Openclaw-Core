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

  /** 从事件中抽取媒体与文件（图片 / 视频 / 音频 / 文件统一走 mediaUrls + files，供 OpenClaw 使用） */
  extractMedia(e) {
    const mediaUrls = [];
    const files = [];

    if (Array.isArray(e.msg)) {
      for (const segment of e.msg) {
        const data = segment.data || segment;
        const url = data.url || data.file;
        const name = data.name || data.file;
        if (!url) continue;
        if (segment.type === 'image') {
          mediaUrls.push(url);
        } else if (segment.type === 'video' || segment.type === 'record') {
          files.push({ url, name: name || (segment.type === 'video' ? 'video' : 'audio') });
        } else if (segment.type === 'file') {
          files.push({ url, name: name || 'file' });
        }
      }
    }

    const rawMessage = e.raw_message || '';
    const imageRegex = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]/g;
    let match;
    while ((match = imageRegex.exec(rawMessage)) !== null) {
      const url = match[1].replace(/&amp;/g, '&');
      if (url.startsWith('http') || url.startsWith('base64://')) mediaUrls.push(url);
    }

    return { mediaUrls, files };
  }

  /** 将 URL 或本机路径转为可发送形式（base64/http 直接透传，本地文件读成 base64） */
  async processUrl(url) {
    if (!url) return null;
    if (url.startsWith('base64://') || url.startsWith('http://') || url.startsWith('https://')) return url;
    let filePath = url.startsWith('file://') ? url.replace(/^file:\/\/+/i, '').replace(/^\/([A-Za-z]:)/, '$1') : url;
    try {
      if (fs.existsSync(filePath)) return `base64://${fs.readFileSync(filePath).toString('base64')}`;
    } catch (err) {
      this.makeLog('warn', ['读取本地文件失败', filePath, err?.message], 'XRK-OC');
    }
    return null;
  }

  /** MIME 或扩展名 → 常见后缀映射（办公 / 视频 / 音频等均能正确出后缀） */
  static EXT_MAP = {
    cfb: 'ppt',
    mscfb: 'pptx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  };

  /** 根据检测结果得到发往 QQ 的扩展名（统一入口，避免 file.cfb 等） */
  normalizeFileExt(ext, mime) {
    if (!ext && !mime) return 'bin';
    const m = this.constructor.EXT_MAP;
    if (mime && m[mime]) return m[mime];
    const lower = String(ext || '').toLowerCase();
    return (m[lower] ?? lower) || 'bin';
  }

  /** 检测结果：isImage / isVideo / isAudio 用于选 QQ 段类型，ext/mime 用于文件名与映射 */
  async detectFileType(url) {
    if (!url) return { isImage: false, isVideo: false, isAudio: false, ext: 'bin', mime: null };
    if (url.startsWith('base64://')) {
      try {
        const buffer = Buffer.from(url.replace(/^base64:\/\//, ''), 'base64');
        const ft = await fileTypeFromBuffer(buffer);
        if (ft) {
          const m = ft.mime;
          return {
            isImage: m.startsWith('image/'),
            isVideo: m.startsWith('video/'),
            isAudio: m.startsWith('audio/'),
            mime: m,
            ext: ft.ext,
          };
        }
      } catch (err) {
        this.makeLog('warn', ['检测文件类型失败', err?.message], 'XRK-OC');
      }
    }
    try {
      let pathname = url;
      if (url.startsWith('file://')) pathname = url.replace(/^file:\/\/+/i, '').replace(/^\/([A-Za-z]:)/, '$1');
      else if (url.startsWith('http://') || url.startsWith('https://')) pathname = new URL(url).pathname;
      const ext = path.extname(pathname.split('?')[0]).slice(1).toLowerCase();
      if (ext) {
        const img = /^(png|jpe?g|gif|webp|bmp|heic|avif|ico)$/.test(ext);
        const vid = /^(mp4|webm|mov|avi|mkv|flv|m4v|3gp|wmv)$/.test(ext);
        const aud = /^(mp3|wav|ogg|m4a|aac|flac|opus|amr)$/.test(ext);
        return { isImage: img, isVideo: vid, isAudio: aud, ext, mime: null };
      }
    } catch (_) {}
    return { isImage: false, isVideo: false, isAudio: false, ext: 'bin', mime: null };
  }

  /** 发往 QQ 的最终文件名：有有效原名用原名，否则用规范扩展名 */
  resolveFileName(file, fileInfo) {
    const raw = file?.name?.trim();
    const generic = /^file\.(bin|cfb|dat|mscfb)$/i;
    if (raw && raw !== 'file' && !generic.test(raw)) return raw;
    const ext = this.normalizeFileExt(fileInfo?.ext, fileInfo?.mime);
    return `file.${ext}`;
  }

  /** 统一发送回复内容：文本 + 图片/视频/音频/文件（按检测结果选 QQ 段类型，保证所有类型可发） */
  async sendReplyContent(reply, sendMsgFn) {
    if (reply.text) await sendMsgFn(String(reply.text));

    const items = [
      ...(Array.isArray(reply.mediaUrls) ? reply.mediaUrls.map(u => ({ url: u, name: null })) : []),
      ...(Array.isArray(reply.files) ? reply.files.map(f => ({ url: f.url, name: f.name })) : []),
    ];
    for (const item of items) {
      const processedUrl = await this.processUrl(item.url);
      if (!processedUrl) continue;
      const info = await this.detectFileType(processedUrl);
      const name = this.resolveFileName({ name: item.name }, info);
      const data = { file: processedUrl, name };
      if (info.isImage) await sendMsgFn([{ type: 'image', data: { file: processedUrl } }]);
      else if (info.isVideo) await sendMsgFn([{ type: 'video', data }]);
      else if (info.isAudio) await sendMsgFn([{ type: 'record', data }]);
      else await sendMsgFn([{ type: 'file', data }]);
    }
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

      await this.sendReplyContent(reply, msg => target.sendMsg(msg));
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
      await this.sendReplyContent(reply, msg => e.reply(msg));
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
