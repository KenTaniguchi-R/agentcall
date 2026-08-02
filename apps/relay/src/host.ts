// Split out of index.ts: workerd treats every named export of the entry
// module as a potential WorkerEntrypoint and rejects non-handler values
// outright ("Incorrect type for map entry 'RELAY_HOST'"), killing the worker
// at startup under current wrangler/workerd. This file has no default
// export, so it is never mistaken for an entry module and can be imported
// from anywhere (index.ts included) without that restriction applying.
export const RELAY_HOST = "agentcall.benree.tech";
