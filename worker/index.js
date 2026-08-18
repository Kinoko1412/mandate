import { DurableObject } from 'cloudflare:workers';

const { handleFetchRequest } = require('../server/apiFetch');
const supabaseSync = require('../server/supabaseSync');

function applyWorkerEnv(env) {
  if (!env) return;
  if (env.OPENAI_API_KEY != null) process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
  if (env.OPENAI_MODEL != null) process.env.OPENAI_MODEL = env.OPENAI_MODEL;
  if (env.OPENAI_MODEL_CARBON != null) process.env.OPENAI_MODEL_CARBON = env.OPENAI_MODEL_CARBON;
  if (env.OPENAI_MODEL_AUTH != null) process.env.OPENAI_MODEL_AUTH = env.OPENAI_MODEL_AUTH;
  if (env.OPENAI_BASE_URL != null) process.env.OPENAI_BASE_URL = env.OPENAI_BASE_URL;
  if (env.SUPABASE_URL != null) process.env.SUPABASE_URL = env.SUPABASE_URL;
  if (env.SUPABASE_SERVICE_KEY != null) process.env.SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY;
}

/**
 * All /api/* traffic is routed through this single, fixed-name Durable
 * Object instance (see the default export below) so that server/store.js's
 * module-level `state` — and agentSession.js's in-memory session map — see
 * a single, consistent JS execution context, matching how a persistent
 * `npm start` Node process behaves. Without this, a stateless Workers
 * `fetch()` handler has no guarantee that consecutive requests from the
 * same browser tab land on the same isolate, so PolicyEngine decisions
 * (and audit history) could read stale state from a different isolate that
 * hasn't observed an earlier mutation yet — confirmed to happen in practice
 * at normal human click speed (2026-08-18 browser testing), not just as a
 * theoretical edge case. This is purely a consistency fix: it does not add
 * a database or persist state across deploys/evictions — `state` still
 * resets to fixture defaults exactly as before once the Durable Object is
 * evicted from memory (same "V1 刻意零持久化" behavior, just consistent
 * while the instance stays warm).
 */
export class MandateState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  async fetch(request) {
    applyWorkerEnv(this.env);
    const apiRes = await handleFetchRequest(request);
    if (apiRes) {
      // Await directly (rather than ctx.waitUntil) — a Durable Object's
      // fetch() promise chain is what the runtime keeps the instance alive
      // for, so this reliably lets fire-and-forget Supabase writes finish
      // before the response is returned.
      await supabaseSync.waitForPending();
      return apiRes;
    }
    return new Response('Not Found', { status: 404 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const id = env.MANDATE_STATE.idFromName('global');
      const stub = env.MANDATE_STATE.get(id);
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
