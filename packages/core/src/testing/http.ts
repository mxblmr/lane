import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A Web-standard route handler, the shape Next.js route exports and mcp-handler use. */
export type FetchHandler = (request: Request) => Promise<Response> | Response;

/** Handlers per path, then per HTTP method, for example `{ "/api/mcp": { POST: handler } }`. */
export type RouteTable = Record<string, Partial<Record<string, FetchHandler>>>;

export type LocalServer = {
  /** Origin of the server, for example `http://127.0.0.1:53211`. */
  origin: string;
  close(): Promise<void>;
};

/**
 * Serves Web-standard route handlers on a real local HTTP port, so tests and
 * scripts can call routes over the network the way a deployed client does.
 * Test helper only; never imported by a route.
 */
export async function serveRoutes(routes: RouteTable): Promise<LocalServer> {
  const server = createServer((req, res) => {
    handle(routes, req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end(String(error));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handle(routes: RouteTable, req: IncomingMessage, res: ServerResponse) {
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const method = (req.method ?? "GET").toUpperCase();
  const route = routes[url.pathname];
  if (!route) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  const handler = route[method];
  if (!handler) {
    res.statusCode = 405;
    res.end("method not allowed");
    return;
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

  const request = new Request(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
  const response = await handler(request);

  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  // Stream chunk by chunk so server-sent event responses reach the client as they are written.
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}
