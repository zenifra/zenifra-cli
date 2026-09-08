import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { oauthCallbackPage, oauthPagePolicy } from './oauth-page.mjs';

const CLIENT_ID = 'zenifra-cli';
const fail = () => new Error('Resposta OAuth invalida. Tente fazer login novamente.');
export function oauthTarget(apiBase) {
  let url;
  try { url = new URL(apiBase); } catch { throw fail(); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/v1'
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('OAuth exige uma API HTTPS com caminho /v1 (HTTP permitido somente em loopback local).');
  }
  return { issuer: url.origin, resource: `${url.origin}/v1`, clientId: CLIENT_ID };
}
export function validateOAuthProfile(oauth, apiBase) {
  const target = oauthTarget(apiBase);
  if (!oauth || oauth.issuer !== target.issuer || oauth.resource !== target.resource || oauth.clientId !== CLIENT_ID) {
    throw new Error('O perfil OAuth pertence a outra API. Use a API original ou faca login em outro perfil.');
  }
  return target;
}
function checkCancelled(signal) {
  if (signal?.aborted) throw new Error('Login OAuth cancelado.');
}
async function jsonRequest(url, options = {}, signal) {
  checkCancelled(signal);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, 30_000);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    let response;
    try { response = await fetch(url, { ...options, redirect: 'error', signal: controller.signal }); }
    catch { checkCancelled(signal); throw new Error('Nao foi possivel conectar ao OAuth. Tente novamente.'); }
    checkCancelled(signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('OAuth recusou a solicitacao. Faca login novamente; nenhuma operacao foi repetida.');
    }
    const reader = response.body.getReader(); let length = 0; const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length; if (length > 65536) throw fail(); chunks.push(value);
      }
      checkCancelled(signal);
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { await reader.cancel().catch(() => {}); checkCancelled(signal); throw fail(); }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

function tokens(value, target, previousScope) {
  const scope = value?.scope ?? previousScope;
  if (!value || typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 16384
    || /\s/.test(value.access_token) || typeof value.refresh_token !== 'string' || !value.refresh_token || value.refresh_token.length > 16384
    || /\s/.test(value.refresh_token) || String(value.token_type).toLowerCase() !== 'bearer'
    || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 0 || value.expires_in > 86400
    || typeof scope !== 'string' || !scope.split(' ').includes('cli:read')
    || scope.split(' ').some(s => !['cli:read', 'cli:write', 'offline_access'].includes(s))) throw fail();
  return { authMode: 'oauth', accessToken: value.access_token, apiKey: undefined,
    oauth: { ...target, refreshToken: value.refresh_token, expiresAt: Date.now() + value.expires_in * 1000, scope } };
}
async function tokenRequest(target, parameters, previousScope, signal) {
  const value = await jsonRequest(`${target.issuer}/v1/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: CLIENT_ID, resource: target.resource, ...parameters }),
  }, signal);
  checkCancelled(signal);
  const result = tokens(value, target, previousScope);
  if (previousScope && result.oauth.scope.split(' ').some(s => !previousScope.split(' ').includes(s))) throw fail();
  return result;
}
export async function refreshOAuth(oauth) {
  const target = validateOAuthProfile(oauth, oauth.resource);
  if (!oauth.refreshToken) throw fail();
  return tokenRequest(target, { grant_type: 'refresh_token', refresh_token: oauth.refreshToken }, oauth.scope);
}
export async function revokeOAuth(oauth, apiBase) {
  const target = validateOAuthProfile(oauth, apiBase);
  let response;
  try {
    response = await fetch(`${target.issuer}/v1/oauth/revoke`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, token: oauth.refreshToken, token_type_hint: 'refresh_token' }) });
  } catch { throw new Error('Nao foi possivel revogar a conexao OAuth. O perfil foi preservado.'); }
  await response.body?.cancel();
  if (!response.ok) throw new Error('A revogacao OAuth falhou. O perfil foi preservado.');
}
export function openBrowser(url) {
  const executable = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise(resolve => {
    const child = spawn(executable, args, { shell: false, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.unref(); resolve(false); }, 3000);
    child.once('error', () => { clearTimeout(timer); resolve(false); }); child.once('exit', code => { clearTimeout(timer); resolve(code === 0); });
  });
}
export async function oauthLogin(apiBase, { readOnly = false, onAuthorize, timeoutMs = 180_000, signal } = {}) {
  const target = oauthTarget(apiBase);
  const metadata = await jsonRequest(`${target.issuer}/.well-known/oauth-authorization-server`, {}, signal);
  if (metadata.issuer !== target.issuer || metadata.authorization_endpoint !== `${target.issuer}/v1/oauth/authorize`
    || metadata.token_endpoint !== `${target.issuer}/v1/oauth/token` || metadata.revocation_endpoint !== `${target.issuer}/v1/oauth/revoke`
    || !metadata.code_challenge_methods_supported?.includes('S256') || metadata.authorization_response_iss_parameter_supported !== true) throw fail();
  const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(48).toString('base64url');
  const scope = readOnly ? 'cli:read offline_access' : 'cli:read cli:write offline_access';
  let resolveCode, rejectCode, accepted = false, port;
  const pending = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Attach a handler before invoking asynchronous browser launch.
  pending.catch(() => {});
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'"); res.setHeader('Referrer-Policy', 'no-referrer');
    const reject = () => { res.writeHead(400); res.end('Callback OAuth invalido.'); };
    if (accepted || req.method !== 'GET' || req.headers.host !== `127.0.0.1:${port}` || !req.url?.startsWith('/oauth/callback?') || req.url.length > 8192) return reject();
    const url = new URL(req.url, `http://127.0.0.1:${port}`); const p = url.searchParams;
    if (url.pathname !== '/oauth/callback' || [...p.keys()].some(k => !['code','state','iss','error','error_description','error_uri'].includes(k) || p.getAll(k).length !== 1)) return reject();
    const candidate = Buffer.from(p.get('state') || '');
    if (candidate.length !== state.length || !timingSafeEqual(candidate, Buffer.from(state)) || p.get('iss') !== target.issuer
      || (p.has('code') === p.has('error')) || (p.has('code') && !/^[\x21-\x7e]{1,2048}$/.test(p.get('code')))) return reject();
    accepted = true;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', oauthPagePolicy);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(oauthCallbackPage(p.has('error')));
    if (p.has('error')) rejectCode(new Error('Login OAuth cancelado ou recusado.')); else resolveCode(p.get('code'));
  });
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  const cancel = () => rejectCode(new Error('Login OAuth cancelado.'));
  let timer;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const authorize = new URL(metadata.authorization_endpoint);
    authorize.search = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirectUri, resource: target.resource,
      scope, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    timer = setTimeout(() => rejectCode(new Error('Tempo de login OAuth esgotado. Tente novamente.')), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    await onAuthorize(authorize.toString());
    const code = await pending;
    return await tokenRequest(target, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, scope, signal);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  }
}
