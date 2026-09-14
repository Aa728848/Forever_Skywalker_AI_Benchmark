import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** Synthetic remote SSH endpoint only. The original connection-pool and real localhost tunnel server still run. */
export class Client extends EventEmitter {
  static instances = [];
  constructor() { super(); this.ended = false; Client.instances.push(this); }
  connect(config) { this.config = config; queueMicrotask(() => this.emit('ready')); return this; }
  end() { if (!this.ended) { this.ended = true; this.emit('end'); this.emit('close'); } }
  destroy() { this.end(); }
  forwardOut(_origin, _port, _host, _targetPort, callback) {
    const stream = new PassThrough(); stream.close = () => stream.destroy(); callback(undefined, stream);
  }
}
/** PTY/WebSocket upgrades are deliberately outside this module-integration fixture. */
export class WebSocket extends EventEmitter { static OPEN = 1; }
export class WebSocketServer extends EventEmitter {
  handleUpgrade() { throw new Error('本题禁止连接真实终端，WebSocket upgrade 未配置'); }
}
export function PluginManagerTab() { throw new Error('本题测试真实状态 face，不渲染 React 设置页'); }
