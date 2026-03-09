import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import paths from '#utils/paths.js';
import ConfigBase from '#infrastructure/commonconfig/commonconfig.js';

const DEFAULT_SOURCE = path.join(paths.root, 'core', 'Openclaw-Core', 'default', 'openclaw.yaml');

/**
 * OpenClaw-Core 总开关配置，业务独立：配置仅存于 data/openclaw/，默认由本 Core default 目录复制而来。
 */
export default class OpenclawConfig extends ConfigBase {
  constructor() {
    super({
      name: 'openclaw',
      displayName: 'OpenClaw 桥接',
      description: 'OpenClaw 总开关：关闭后不加载 XrkBridge Tasker 与 XrkBridgeForward 插件',
      filePath: 'data/openclaw/openclaw.yaml',
      fileType: 'yaml',
      schema: {
        fields: {
          enabled: {
            type: 'boolean',
            label: '启用 OpenClaw 桥接',
            description: '关闭后 Tasker 与 Plugin 不加载',
            default: true,
            component: 'Switch',
          },
        },
      },
    });
  }

  async read(useCache = true) {
    const targetPath = this._resolveFilePath();
    try {
      await fs.access(targetPath);
    } catch {
      if (existsSync(DEFAULT_SOURCE)) {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(DEFAULT_SOURCE, targetPath);
      }
    }
    return super.read(useCache);
  }
}
