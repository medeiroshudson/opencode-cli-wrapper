import { createServer } from "node:http";
import type { Server } from "node:http";

export interface FakeServeOptions {
  readonly text?: string;
  readonly deltas?: readonly string[];
  readonly failMessage?: number;
  /** Open the SSE stream, send one non-terminal event, then never end it. */
  readonly hangEventStream?: boolean;
}

export interface FakeServe {
  readonly url: string;
  readonly calls: { createSession: number; message: number; deleteSession: number };
  close(): Promise<void>;
}

const CATALOG = {
  providers: [
    {
      id: "opencode",
      models: {
        "mimo-v2.6-flash-free": {
          id: "mimo-v2.6-flash-free",
          providerID: "opencode",
          limit: { context: 200000, output: 32000 },
        },
      },
    },
  ],
};

export async function startFakeServe(opts: FakeServeOptions = {}): Promise<FakeServe> {
  const deltas = opts.deltas ?? ["po", "ng"];
  const calls = { createSession: 0, message: 0, deleteSession: 0 };

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    const sendJson = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url === "/global/health") return sendJson(200, { healthy: true });
    if (url === "/config/providers") return sendJson(200, CATALOG);
    if (url === "/session" && req.method === "POST") {
      calls.createSession += 1;
      return sendJson(200, { id: "ses_fake" });
    }
    if (url.startsWith("/session/") && url.endsWith("/message")) {
      calls.message += 1;
      if (opts.failMessage) return sendJson(opts.failMessage, { error: "boom" });
      return sendJson(200, { info: { finish: "stop" }, parts: [{ type: "text", text: opts.text ?? "pong" }] });
    }
    if (url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (opts.hangEventStream) {
        res.flushHeaders();
        res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
        return;
      }
      const sid = "ses_fake";
      // The text part is announced before its deltas: a delta is only answer text
      // when its partID was seen on a part of type "text" (see serve/events.ts).
      res.write(`data: ${JSON.stringify({ type: "message.part.updated", properties: { sessionID: sid, part: { id: "prt_1", type: "text", text: "" } } })}\n\n`);
      for (const d of deltas) {
        res.write(`data: ${JSON.stringify({ type: "message.part.delta", properties: { sessionID: sid, partID: "prt_1", field: "text", delta: d } })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: sid } })}\n\n`);
      return res.end();
    }
    if (url.startsWith("/session/") && req.method === "DELETE") {
      calls.deleteSession += 1;
      return sendJson(200, {});
    }
    return sendJson(404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        // A hung SSE response is never idle, so server.close() alone would wait forever.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}