/** @vitest-environment node */
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserGatewaySocket } from "./gateway-browser-socket.ts";

type MockSocketEvent = { code?: number; data?: unknown; reason?: string };
type MockSocketHandler = (event: MockSocketEvent) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly OPEN = 1;
  readonly close = vi.fn((code?: number, _reason?: string) => {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("invalid code", "InvalidAccessError");
    }
  });
  readonly handlers = new Map<string, MockSocketHandler[]>();
  readyState = 0;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, handler: MockSocketHandler) {
    const handlers = this.handlers.get(type) ?? [];
    handlers.push(handler);
    this.handlers.set(type, handlers);
  }

  send(_data: string) {}

  emit(type: string, event: MockSocketEvent = {}) {
    for (const handler of this.handlers.get(type) ?? []) {
      handler(event);
    }
  }
}

function createHandlers() {
  return {
    open: vi.fn(),
    message: vi.fn(),
    close: vi.fn(),
    error: vi.fn(),
  };
}

describe("createBrowserGatewaySocket", () => {
  let socket: MockWebSocket;
  let handlers: ReturnType<typeof createHandlers>;
  let socketAdapter: ReturnType<typeof createBrowserGatewaySocket>;
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    vi.stubGlobal("WebSocket", MockWebSocket);
    handlers = createHandlers();
    socketAdapter = createBrowserGatewaySocket("wss://gateway.example", handlers);
    const created = sockets[0];
    if (!created) {
      throw new Error("expected a websocket instance");
    }
    socket = created;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("closes a websocket that never finishes opening", async () => {
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.error.mock.calls[0]?.[0]).toEqual(
      new Error(
        `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`,
      ),
    );
    expect(socket.close).toHaveBeenCalledOnce();
    expect(handlers.close).toHaveBeenCalledExactlyOnceWith(
      1006,
      `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`,
    );

    socket.emit("error");
    socket.emit("open");
    socket.emit("message", { data: "late message" });
    socket.emit("close", { code: 1006, reason: "" });
    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.close).toHaveBeenCalledOnce();
    expect(handlers.open).not.toHaveBeenCalled();
    expect(handlers.message).not.toHaveBeenCalled();
  });

  it("preserves a remote native close code and reason", async () => {
    socket.emit("close", { code: 1006, reason: "gateway supplied a close reason" });
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.close).toHaveBeenCalledExactlyOnceWith(1006, "gateway supplied a close reason");
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("clears the opening deadline after the socket opens", async () => {
    socket.readyState = MockWebSocket.OPEN;
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.open).toHaveBeenCalledOnce();
    expect(handlers.error).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("clears the opening deadline after a native transport failure", async () => {
    socket.emit("error");
    socket.emit("close", { code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.error).toHaveBeenCalledWith(new Error("websocket error"));
    expect(handlers.close).toHaveBeenCalledWith(1006, "");
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("clears the opening deadline when the client closes the socket", async () => {
    socketAdapter.close(1000, "stopped");
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(socket.close).toHaveBeenCalledWith(1000, "stopped");
    expect(handlers.error).not.toHaveBeenCalled();
  });

  it("maps protocol policy-violation closes to the browser-safe connect failure code", () => {
    expect(() => socketAdapter.close(1008, "connect failed")).not.toThrow();
    expect(socket.close).toHaveBeenCalledWith(4008, "connect failed");
  });

  it("does not normalize other invalid browser close codes", () => {
    expect(() => socketAdapter.close(1009, "invalid client close")).toThrow(
      expect.objectContaining({ name: "InvalidAccessError" }),
    );
  });

  it("preserves policy-violation closes received from the gateway", () => {
    socket.emit("close", { code: 1008, reason: "pairing required" });

    expect(handlers.close).toHaveBeenCalledWith(1008, "pairing required");
  });

  it.each([
    { code: 4000, nativeCode: 4000, reason: "reconnect" },
    { code: 1008, nativeCode: 4008, reason: "connect failed" },
    { code: undefined, nativeCode: undefined, reason: undefined },
  ])(
    "retires a local close immediately and exactly once ($code)",
    ({ code, nativeCode, reason }) => {
      socket.readyState = MockWebSocket.OPEN;
      socket.emit("open");
      handlers.open.mockClear();
      handlers.close.mockImplementation(() => {
        // A terminal callback may synchronously ask to close the abandoned adapter again.
        socketAdapter.close(4000, "again");
      });

      socketAdapter.close(code, reason);

      expect(socket.close).toHaveBeenCalledExactlyOnceWith(nativeCode, reason);
      expect(handlers.close).toHaveBeenCalledExactlyOnceWith(code ?? 1000, reason ?? "");
      expect(socketAdapter.isOpen()).toBe(false);

      socket.emit("close", { code: 1006, reason: "late close" });
      socket.emit("message", { data: "late message" });
      socket.emit("error");
      socket.emit("open");
      expect(handlers.close).toHaveBeenCalledOnce();
      expect(handlers.message).not.toHaveBeenCalled();
      expect(handlers.error).not.toHaveBeenCalled();
      expect(handlers.open).not.toHaveBeenCalled();
    },
  );
});
