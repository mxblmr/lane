import type { AuthInfo } from "@modelcontextprotocol/server";
import { bearerToken } from "@lane/core/tools/identity";

/**
 * Player identity for the connector (KTD4). The player key arrives as an `Authorization: Bearer`
 * header or as a `player_key` tool argument; the core tool runner checks both. This module only
 * carries the bearer key from the HTTP request to the tool callback.
 *
 * Lane never refuses at the HTTP layer: a missing or unknown key comes back from the tool as an
 * envelope with a recovery instruction, and no 401 challenge pushes the client into an OAuth flow
 * Lane does not offer. The key is never logged and never read from the URL.
 */

type FetchHandler = (request: Request) => Promise<Response> | Response;

const CLIENT_ID = "lane-player";

/** The player key from the request's bearer header, or null. */
export function playerKeyFromRequest(request: Request): string | null {
  return bearerToken(request.headers.get("authorization"));
}

/** Wraps the MCP handler so tool callbacks see the bearer key as `ctx.http.authInfo.token`. */
export function withPlayerKey(handler: FetchHandler): (request: Request) => Promise<Response> {
  return async (request) => {
    const key = playerKeyFromRequest(request);
    if (key) {
      const auth: AuthInfo = { token: key, clientId: CLIENT_ID, scopes: [] };
      (request as Request & { auth?: AuthInfo }).auth = auth;
    }
    return handler(request);
  };
}

/** The bearer key a tool callback received, or null. */
export function playerKeyFromContext(ctx: { http?: { authInfo?: AuthInfo } }): string | null {
  const auth = ctx.http?.authInfo;
  return auth && auth.clientId === CLIENT_ID ? auth.token : null;
}
