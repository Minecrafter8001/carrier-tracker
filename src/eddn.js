const { EventEmitter } = require('node:events');
const zlib = require('node:zlib');
const zmq = require('zeromq');

const RECONNECT_DELAY_MS = 5000;
const STATS_INTERVAL_MS = 60_000;

class EddnClient extends EventEmitter {
  constructor({ url, silenceSeconds }) {
    super();
    this.url = url;
    this.silenceMs = silenceSeconds * 1000;
    this.stopped = false;
    this.socket = null;
    this.received = 0;
  }

  start() {
    this.statsTimer = setInterval(() => {
      console.log(`[eddn] ${this.received} messages in the last ${STATS_INTERVAL_MS / 1000}s`);
      this.received = 0;
    }, STATS_INTERVAL_MS);
    this.loop = this.run();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.statsTimer);
    this.socket?.close();
    await this.loop;
  }

  async run() {
    while (!this.stopped) {
      // receiveTimeout makes receive() reject when EDDN goes silent, triggering a reconnect.
      const socket = new zmq.Subscriber({ receiveTimeout: this.silenceMs });
      this.socket = socket;
      try {
        socket.connect(this.url);
        socket.subscribe();
        console.log(`[eddn] connected to ${this.url}`);
        while (!this.stopped) {
          const [payload] = await socket.receive();
          this.received += 1;
          this.handle(payload);
        }
      } catch (err) {
        if (this.stopped) break;
        const reason = err.code === 'EAGAIN' ? `no messages for ${this.silenceMs / 1000}s` : err.message;
        console.warn(`[eddn] disconnected: ${reason}`);
      } finally {
        if (!socket.closed) socket.close();
      }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
    }
  }

  handle(payload) {
    let doc;
    try {
      doc = JSON.parse(zlib.inflateSync(payload).toString('utf8'));
    } catch {
      return;
    }
    this.emit('message', doc);
  }
}

module.exports = { EddnClient };
