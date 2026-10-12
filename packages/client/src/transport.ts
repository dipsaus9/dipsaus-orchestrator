// The seam between the runtime-free protocol core and a real connection (0004 amendment of
// 2026-10-12). `client/node` implements it on the Unix socket with `ws+unix://`; a browser client
// will implement it on the loopback listener. A transport carries text frames and knows nothing of
// their meaning.

export interface TransportHandlers {
  /** The connection is open and frames may be sent. */
  onOpen(): void;
  /** One text frame from the daemon. */
  onMessage(text: string): void;
  /** The connection closed or could not be opened; called at most once per connection. */
  onClose(): void;
}

export interface TransportConnection {
  /** Sends one text frame; a closed connection drops it. */
  send(text: string): void;
  close(): void;
}

export interface Transport {
  /**
   * Opens one connection. Handlers are never called before `connect` returns, and `onClose` is
   * called once when the connection ends, also after `close()` or a failed open.
   */
  connect(handlers: TransportHandlers): TransportConnection;
}
