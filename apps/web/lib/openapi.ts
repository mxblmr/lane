import { LANE_PING_TOOL } from "./ping";

/**
 * Hand-written OpenAPI 3.1 document for the JSON connector face. U1 describes
 * only `lane_ping`; U19 adds the eight tools if U2 shows Muse needs them.
 */
export function buildOpenApiDocument(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Lane",
      version: "0.1.0",
      description:
        "Lane's JSON API for agents. Every operation is a POST with a JSON body and returns JSON.",
    },
    servers: [{ url: serverUrl }],
    paths: {
      "/api/v1/ping": {
        post: {
          operationId: LANE_PING_TOOL.name,
          summary: LANE_PING_TOOL.title,
          description: LANE_PING_TOOL.description,
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { type: "object", properties: {}, additionalProperties: false },
              },
            },
          },
          responses: {
            "200": {
              description: "Lane is reachable.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PingResult" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        PingResult: {
          type: "object",
          required: ["ok", "service", "server_time", "message"],
          properties: {
            ok: { type: "boolean", const: true },
            service: { type: "string", const: "lane" },
            server_time: {
              type: "string",
              format: "date-time",
              description: "Lane's server time in ISO 8601 UTC.",
            },
            message: {
              type: "string",
              description: "A plain line the agent can relay to the player.",
            },
          },
        },
      },
    },
  } as const;
}
