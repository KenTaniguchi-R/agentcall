import { DurableObject } from "cloudflare:workers";

type CallerAttachment = { kind: "caller"; from: string; call_id?: string };
type ListenerAttachment = { kind: "listener" };

export class HandleDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/status") {
      return Response.json({ online: this.ctx.getWebSockets("listener").length > 0 });
    }
    if (url.pathname === "/ws") {
      const role = url.searchParams.get("role");
      const from = req.headers.get("X-Verified-From") ?? "";
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      if (role === "listen") {
        for (const old of this.ctx.getWebSockets("listener")) old.close(4000, "replaced");
        this.ctx.acceptWebSocket(server, ["listener"]);
        server.serializeAttachment({ kind: "listener" } satisfies ListenerAttachment);
      } else {
        this.ctx.acceptWebSocket(server, ["caller"]);
        server.serializeAttachment({ kind: "caller", from } satisfies CallerAttachment);
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }
}
