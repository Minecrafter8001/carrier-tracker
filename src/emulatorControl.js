const zmq = require('zeromq');
const config = require('./config');

const TIMEOUT_MS = 3000;

// A fresh REQ socket per call: a REQ socket that timed out is stuck mid-exchange and can't be reused.
async function sendControl(request) {
  const socket = new zmq.Request({ sendTimeout: TIMEOUT_MS, receiveTimeout: TIMEOUT_MS, linger: 0 });
  try {
    socket.connect(config.emulatorControlUrl);
    await socket.send(JSON.stringify(request));
    const [reply] = await socket.receive();
    return JSON.parse(reply.toString('utf8'));
  } catch (err) {
    if (err.code === 'EAGAIN') throw new Error(`emulator not reachable at ${config.emulatorControlUrl}`);
    throw err;
  } finally {
    socket.close();
  }
}

module.exports = { sendControl };
