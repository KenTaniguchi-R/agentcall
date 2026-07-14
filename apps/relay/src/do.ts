import { DurableObject } from "cloudflare:workers";
export class HandleDO extends DurableObject {
  override async fetch(_req: Request): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  }
}
