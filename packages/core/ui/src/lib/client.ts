/**
 * Typed façade over the chosen transport.
 *
 * `call("getState")` returns `ServiceState` — the types come straight from the
 * core's RPC contract, so a method rename breaks the UI build instead of
 * failing at runtime.
 */

import type { RpcMethod, RpcParams, RpcResult } from "@core/rpc";
import { createTransport, type Transport } from "./transports";

let transport: Transport | undefined;

function getTransport(): Transport {
  transport ??= createTransport();
  return transport;
}

export async function call<M extends RpcMethod>(
  method: M,
  params?: RpcParams<M>
): Promise<RpcResult<M>> {
  return (await getTransport().call(method, params)) as RpcResult<M>;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
