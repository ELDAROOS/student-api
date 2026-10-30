// Вызов настоящего Express через Node IncomingMessage/ServerResponse без TCP-порта.
// Полезно в изолированной среде, где listen() запрещён.
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import assert from 'node:assert/strict';

export default function request(app) {
  return Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (url) => {
    const headers = {};
    let payload;
    const pending = {
      type(value) {
        headers['content-type'] = value === 'json' ? 'application/json' : value === 'text' ? 'text/plain' : value;
        return pending;
      },
      send(value) {
        if (typeof value === 'string') {
          payload = value;
          headers['content-type'] ??= 'text/plain';
        } else {
          payload = JSON.stringify(value);
          headers['content-type'] ??= 'application/json';
        }
        return pending;
      },
      async expect(status) {
        const result = await new Promise((resolve, reject) => {
          const chunks = [];
          const socket = new Duplex({
            read() {},
            write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
          });
          socket.on('error', reject);
          const req = new IncomingMessage(socket);
          req.method = method.toUpperCase();
          req.url = url;
          req.httpVersion = '1.1';
          req.httpVersionMajor = 1;
          req.httpVersionMinor = 1;
          req.headers = { host: 'localhost', ...headers };
          if (payload !== undefined) req.headers['content-length'] = String(Buffer.byteLength(payload));
          const res = new ServerResponse(req);
          res.assignSocket(socket);
          const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error('Express не завершил ответ за 5 секунд.'));
          }, 5000);
          res.on('error', (error) => { clearTimeout(timeout); reject(error); });
          res.on('finish', () => {
            clearTimeout(timeout);
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const separator = raw.indexOf('\r\n\r\n');
              const text = raw.slice(separator + 4);
              const responseHeaders = Object.fromEntries(Object.entries(res.getHeaders()));
              const body = text && String(responseHeaders['content-type']).includes('application/json')
                ? JSON.parse(text) : {};
              resolve({ status: res.statusCode, headers: responseHeaders, text, body });
            } catch (error) { reject(error); }
            finally { socket.destroy(); }
          });
          app(req, res);
          if (payload !== undefined) req.push(Buffer.from(payload));
          req.complete = true;
          req.push(null);
        });
        assert.equal(result.status, status, `${method.toUpperCase()} ${url}: ${result.text}`);
        return result;
      },
    };
    return pending;
  }]));
}
