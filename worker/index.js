const { handleFetchRequest } = require('../server/apiFetch');
const supabaseSync = require('../server/supabaseSync');

function applyWorkerEnv(env) {
  if (!env) return;
  if (env.OPENAI_API_KEY != null) process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
  if (env.OPENAI_MODEL != null) process.env.OPENAI_MODEL = env.OPENAI_MODEL;
  if (env.OPENAI_BASE_URL != null) process.env.OPENAI_BASE_URL = env.OPENAI_BASE_URL;
  if (env.SUPABASE_URL != null) process.env.SUPABASE_URL = env.SUPABASE_URL;
  if (env.SUPABASE_SERVICE_KEY != null) process.env.SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY;
}

export default {
  async fetch(request, env, ctx) {
    applyWorkerEnv(env);
    const apiRes = await handleFetchRequest(request);
    if (apiRes) {
      // Fire-and-forget Supabase writes triggered while handling this request are not
      // awaited (see supabaseSync.js) — without this, Cloudflare can tear down the
      // isolate as soon as the response below is returned, killing those writes
      // mid-flight on fast requests that don't otherwise keep the isolate busy.
      ctx.waitUntil(supabaseSync.waitForPending());
      return apiRes;
    }
    const pathname = new URL(request.url).pathname;
    if (pathname.includes('.bak-')) {
      return new Response('Not found', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
