// PHASE S4 — process-wide singletons for the serve client and supervisor.

import { getServeBaseUrl, getTimeoutMs } from "../../config/index.js";
import { ServeClient } from "./client.js";
import { ServeSupervisor, defaultServeDeps } from "./process.js";

let client: ServeClient | null = null;
let supervisor: ServeSupervisor | null = null;

export function getServeClient(): ServeClient {
  if (!client) client = new ServeClient({ baseUrl: getServeBaseUrl(), timeoutMs: getTimeoutMs() });
  return client;
}

export function getServeSupervisor(): ServeSupervisor {
  if (!supervisor) supervisor = new ServeSupervisor(defaultServeDeps(getServeClient()));
  return supervisor;
}

export function resetRuntime(): void {
  client = null;
  supervisor = null;
}