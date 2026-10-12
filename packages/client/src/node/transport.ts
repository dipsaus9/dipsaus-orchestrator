// The Unix-socket transport (0006 decision 9): WebSocket over `<runtime>/dipo.sock` with Bun's
// `ws+unix://` URL scheme, one text frame per contract frame.

import type { Transport } from "../transport";

/** Connects to the daemon socket at `socketPath` (an absolute path). */
export function unixSocketTransport(socketPath: string): Transport {
  const url = `ws+unix://${socketPath}`;
  return {
    connect(handlers) {
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        handlers.onClose();
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        queueMicrotask(end);
        return { send() {}, close() {} };
      }
      const decoder = new TextDecoder();
      ws.addEventListener("open", () => {
        if (!ended) handlers.onOpen();
      });
      ws.addEventListener("message", (event) => {
        if (ended) return;
        const data: unknown = event.data;
        if (typeof data === "string") handlers.onMessage(data);
        else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
          handlers.onMessage(decoder.decode(data));
        }
      });
      ws.addEventListener("error", end);
      ws.addEventListener("close", end);
      return {
        send(text) {
          if (!ended && ws.readyState === WebSocket.OPEN) ws.send(text);
        },
        close() {
          ws.close();
          end();
        },
      };
    },
  };
}
