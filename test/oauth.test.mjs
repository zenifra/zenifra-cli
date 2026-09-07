import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { oauthLogin, oauthTarget, refreshOAuth } from '../bin/lib/oauth.mjs';
async function fixture(t, handler) {
 const server=createServer(handler); await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();server.close();}); return `http://127.0.0.1:${server.address().port}`;
}
test('OAuth pins the API resource and refuses insecure or decorated origins',()=>{
 assert.equal(oauthTarget('https://api.example/v1').issuer,'https://api.example');
 for(const url of ['http://api.example/v1','https://api.example/v2','https://a:b@api.example/v1','https://api.example/v1?x=1']) assert.throws(()=>oauthTarget(url));
});
test('browser code flow validates callback and exchanges PKCE without exposing tokens',async t=>{
 let auth; let exchanges=0; let issuer;
 issuer=await fixture(t,async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.url==='/.well-known/oauth-authorization-server') return res.end(JSON.stringify({issuer,authorization_endpoint:issuer+'/v1/oauth/authorize',token_endpoint:issuer+'/v1/oauth/token',revocation_endpoint:issuer+'/v1/oauth/revoke',code_challenge_methods_supported:['S256'],authorization_response_iss_parameter_supported:true}));
 let raw=''; for await(const chunk of req)raw+=chunk;
 const body=new URLSearchParams(raw); exchanges++;
 assert.equal(body.get('client_id'),'zenifra-cli'); assert.equal(body.get('code'),'fixture-code');
 assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),auth.searchParams.get('code_challenge'));
 res.end(JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-refresh',token_type:'Bearer',expires_in:300,scope:'cli:read offline_access'}));
 });
 const result=await oauthLogin(issuer+'/v1',{readOnly:true,onAuthorize:async url=>{
 auth=new URL(url); const callback=new URL(auth.searchParams.get('redirect_uri'));
 callback.searchParams.set('state','wrong'); callback.searchParams.set('iss',issuer); callback.searchParams.set('code','fixture-code');
 assert.equal((await fetch(callback)).status,400);
 callback.searchParams.set('state',auth.searchParams.get('state'));
 const response=await fetch(callback); assert.equal(response.status,200);
 assert.match(response.headers.get('content-type'),/text\/html; charset=utf-8/);
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(response.headers.get('referrer-policy'),'no-referrer');
 const html=await response.text();
 assert.match(html,/<h1 id="title">Autorização recebida<\/h1>/);
 assert.match(html,/Volte ao seu terminal/);
 assert.match(html,/Você já pode fechar esta aba/);
 assert.doesNotMatch(html,/fixture-code|fixture-access|fixture-refresh|<script|https?:\/\//);
 assert.ok(!html.includes(auth.searchParams.get('state')));
 const css=html.match(/<style>([\s\S]*?)<\/style>/)?.[1]; assert.ok(css);
 const hash=createHash('sha256').update(css).digest('base64');
 assert.equal(response.headers.get('content-security-policy'),`default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
 }});
 assert.equal(exchanges,1); assert.equal(result.accessToken,'fixture-access');assert.equal(result.oauth.resource,issuer+'/v1');
});
test('discovery cannot redirect credentials to another host',async t=>{
 const issuer=await fixture(t,(_q,r)=>r.end(JSON.stringify({issuer:'https://other.example'})));
 await assert.rejects(oauthLogin(issuer+'/v1',{onAuthorize:()=>assert.fail()}),/OAuth/);
});
test('invalid refresh is sanitized and never retried',async t=>{
 let hits=0; const issuer=await fixture(t,(_q,r)=>{hits++;r.writeHead(400);r.end('{"error":"invalid_grant","error_description":"PRIVATE"}');});
 await assert.rejects(refreshOAuth({issuer,resource:issuer+'/v1',clientId:'zenifra-cli',refreshToken:'fixture'}),e=>!e.message.includes('PRIVATE')&&/login/.test(e.message)); assert.equal(hits,1);
});

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withProfileLock, atomicPrivateWrite } from '../bin/lib/profile-store.mjs';
test('profile lock serializes writers, releases on failure and never steals a held lock',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'zenifra-oauth-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const events=[];let unblock;const gate=new Promise(r=>unblock=r);
 const first=withProfileLock(dir,async()=>{events.push(1);await gate;events.push(2);});
 while(!events.length)await new Promise(r=>setTimeout(r,5));
 await assert.rejects(withProfileLock(dir,async()=>assert.fail(),{timeoutMs:30}),/profiles.lock/);
 const second=withProfileLock(dir,async()=>events.push(3));unblock();await Promise.all([first,second]);assert.deepEqual(events,[1,2,3]);
 await assert.rejects(withProfileLock(dir,async()=>{throw new Error('fixture');}));
 await withProfileLock(dir,async()=>atomicPrivateWrite(join(dir,'profiles.json'),'{"ok":true}'));
 assert.equal((await stat(dir)).mode&0o777,0o700);assert.equal((await stat(join(dir,'profiles.json'))).mode&0o777,0o600);
 assert.deepEqual(JSON.parse(await readFile(join(dir,'profiles.json'),'utf8')),{ok:true});
});
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
function run(args,dir,extra={}) { const child=spawn(process.execPath,['bin/zenifra.mjs',...args],{env:{...process.env,ZENIFRA_API_KEY:'',ZENIFRA_API_URL:'',ZENIFRA_CONFIG_DIR:dir,...extra},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);return new Promise(r=>child.once('close',code=>r({code,out,err}))); }
async function profileFixture(t, issuer) { const dir=await mkdtemp(join(tmpdir(),'zenifra-oauth-'));t.after(()=>rm(dir,{recursive:true,force:true}));const record={name:'test',authMode:'oauth',apiBaseUrl:issuer+'/v1',accessToken:'expired',oauth:{issuer,resource:issuer+'/v1',clientId:'zenifra-cli',refreshToken:'refresh-1',expiresAt:0,scope:'cli:read offline_access'}};await writeFile(join(dir,'profiles.json'),JSON.stringify({version:1,activeProfile:'test',profiles:{test:record,other:{name:'other',description:'preserve'}}}));return dir; }
test('simultaneous CLI reads rotate refresh once and persist private profile metadata',async t=>{
 let refreshes=0,reads=0;
 const issuer=await fixture(t,async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.url==='/v1/oauth/token'){refreshes++;await new Promise(r=>setTimeout(r,100));res.end(JSON.stringify({access_token:'fresh',refresh_token:'refresh-2',token_type:'Bearer',expires_in:300,scope:'cli:read offline_access'}));}
 else {reads++;assert.equal(req.headers.authorization,'Bearer fresh');res.end('{"data":[]}');}
 });const dir=await profileFixture(t,issuer);
 const results=await Promise.all([run(['orgs','--json'],dir),run(['orgs','--json'],dir)]);
 results.forEach(r=>assert.equal(r.code,0,r.err));assert.equal(refreshes,1);assert.equal(reads,2);
 const saved=JSON.parse(await readFile(join(dir,'profiles.json'),'utf8'));assert.equal(saved.profiles.test.oauth.refreshToken,'refresh-2');assert.equal(saved.profiles.other.description,'preserve');
 assert.equal((await stat(join(dir,'profiles.json'))).mode&0o777,0o600);
});
test('CLI refuses OAuth API mismatch and OAuth logout revokes only its grant',async t=>{
 const paths=[];const issuer=await fixture(t,async(req,res)=>{paths.push(req.url);res.end();});const dir=await profileFixture(t,issuer);
 let result=await run(['orgs','--api-base','https://other.example/v1'],dir);assert.notEqual(result.code,0);assert.equal(paths.length,0);
 result=await run(['auth','logout','--revoke'],dir);assert.equal(result.code,0,result.err);assert.deepEqual(paths,['/v1/oauth/revoke']);
 const saved=JSON.parse(await readFile(join(dir,'profiles.json'),'utf8'));assert.equal(saved.profiles.test.oauth,undefined);assert.equal(saved.profiles.test.accessToken,undefined);
});
function metadata(issuer) { return {issuer,authorization_endpoint:issuer+'/v1/oauth/authorize',token_endpoint:issuer+'/v1/oauth/token',revocation_endpoint:issuer+'/v1/oauth/revoke',code_challenge_methods_supported:['S256'],authorization_response_iss_parameter_supported:true}; }
test('callback rejects wrong issuer, duplicate values, path, Host, methods and replay',async t=>{
 let issuer;issuer=await fixture(t,(req,res)=>res.end(JSON.stringify(req.url.startsWith('/.well-known')?metadata(issuer):{access_token:'token',refresh_token:'refresh',token_type:'Bearer',expires_in:300,scope:'cli:read offline_access'})));
 await oauthLogin(issuer+'/v1',{onAuthorize:async address=>{
 const auth=new URL(address);const original=new URL(auth.searchParams.get('redirect_uri'));original.search=new URLSearchParams({state:auth.searchParams.get('state'),iss:issuer,code:'code'}).toString();
 for(const mutate of [u=>u.searchParams.set('iss','https://other.example'),u=>u.searchParams.append('state','duplicate'),u=>u.pathname='/elsewhere',u=>u.searchParams.set('code','')]){
 const bad=new URL(original);mutate(bad);assert.equal((await fetch(bad)).status,400);}
 assert.equal(await new Promise((resolve,reject)=>{const req=httpRequest(original,{headers:{Host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();}),400);
 assert.equal((await fetch(original,{method:'POST'})).status,400);
 assert.equal((await fetch(original)).status,200);
 // A second callback cannot cause another exchange, even while token endpoint responds.
 try { assert.notEqual((await fetch(original)).status,200); } catch(e) { if(e.name==='AssertionError')throw e; }
 }});
});
test('OAuth refusal, timeout and abort close callback without exposing provider text',async t=>{
 let issuer;issuer=await fixture(t,(_q,r)=>r.end(JSON.stringify(metadata(issuer))));
 await assert.rejects(oauthLogin(issuer+'/v1',{onAuthorize:async address=>{const auth=new URL(address);const cb=new URL(auth.searchParams.get('redirect_uri'));cb.search=new URLSearchParams({state:auth.searchParams.get('state'),iss:issuer,error:'access_denied',error_description:'PRIVATE'}).toString();await fetch(cb);}}),e=>/cancelado/.test(e.message)&&!e.message.includes('PRIVATE'));
 await assert.rejects(oauthLogin(issuer+'/v1',{timeoutMs:10,onAuthorize:()=>{}}),/esgotado/);
 const controller=new AbortController();await assert.rejects(oauthLogin(issuer+'/v1',{signal:controller.signal,onAuthorize:()=>controller.abort()}),/cancelado/);
});
test('CLI OAuth browser command saves the grant and never prints credentials',async t=>{
 let issuer;issuer=await fixture(t,(req,res)=>res.end(JSON.stringify(req.url.startsWith('/.well-known')?metadata(issuer):{access_token:'SECRET_ACCESS',refresh_token:'SECRET_REFRESH',token_type:'Bearer',expires_in:300,scope:'cli:read offline_access'})));
 const dir=await mkdtemp(join(tmpdir(),'zenifra-oauth-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const child=spawn(process.execPath,['bin/zenifra.mjs','auth','login','--oauth','--no-browser','--profile','local','--api-base',issuer+'/v1'],{env:{...process.env,ZENIFRA_CONFIG_DIR:dir,ZENIFRA_API_KEY:'',ZENIFRA_API_URL:''},stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());let output='',error='',sent=false;const closed=new Promise(r=>child.once('close',r));
 child.stderr.on('data',b=>error+=b);child.stdout.on('data',async b=>{output+=b;const address=output.match(/http:\/\/127\.0\.0\.1:\d+\/v1\/oauth\/authorize\?[^\n]+/);if(address&&!sent){sent=true;const auth=new URL(address[0]);const cb=new URL(auth.searchParams.get('redirect_uri'));cb.search=new URLSearchParams({code:'fixture-code',state:auth.searchParams.get('state'),iss:issuer}).toString();await fetch(cb);}});
 assert.equal(await closed,0,error);assert.equal(sent,true);assert.ok(!output.includes('SECRET'));assert.ok(!error.includes('SECRET'));
 const store=JSON.parse(await readFile(join(dir,'profiles.json'),'utf8'));assert.equal(store.activeProfile,'local');assert.equal(store.profiles.local.oauth.refreshToken,'SECRET_REFRESH');
 const view=await run(['profile','show','--json'],dir);assert.equal(view.code,0);assert.equal(JSON.parse(view.out).auth_mode,'oauth');assert.ok(!view.out.includes('SECRET'));
});
test('environment API key takes precedence with warning without OAuth refresh',async t=>{
 let authorization;const issuer=await fixture(t,(req,res)=>{assert.notEqual(req.url,'/v1/oauth/token');authorization=req.headers.authorization;res.end('{"data":[]}');});
 const dir=await profileFixture(t,issuer);const result=await run(['projects','--json'],dir,{ZENIFRA_API_KEY:'znf_fixture'});
 assert.equal(result.code,0,result.err);assert.equal(authorization,'Bearer znf_fixture');assert.match(result.err,/prioridade/);
});
test('concurrent profile update survives a refresh and OAuth mutations are not replayed',async t=>{
 let refreshStarted;const started=new Promise(r=>refreshStarted=r);let writes=0;let issuer;
 issuer=await fixture(t,async(req,res)=>{
 if(req.url==='/v1/oauth/token'){refreshStarted();await new Promise(r=>setTimeout(r,120));res.end(JSON.stringify({access_token:'fresh',refresh_token:'next',token_type:'Bearer',expires_in:300,scope:'cli:read offline_access'}));}
 else if(req.method==='PATCH'){writes++;req.socket.destroy();}
 else res.end('{"data":[]}');
 });const dir=await profileFixture(t,issuer);
 const reading=run(['orgs','--json'],dir);await started;
 const editing=run(['auth','api-key','--profile','other','--key','znf_fixture','--api-base',issuer+'/v1'],dir);
 for(const result of await Promise.all([reading,editing]))assert.equal(result.code,0,result.err);
 const saved=JSON.parse(await readFile(join(dir,'profiles.json'),'utf8'));assert.equal(saved.profiles.test.oauth.refreshToken,'next');assert.equal(saved.profiles.other.apiKey,'znf_fixture');
 await run(['profile','use','test'],dir);
 const result=await run(['project','image','set','--project','fixture','--org','fixture','--image','example:v1'],dir);assert.notEqual(result.code,0);assert.equal(writes,1);
});
test('failed OAuth revocation preserves the grant and default logout never calls the server',async t=>{
 let hits=0;const issuer=await fixture(t,(_q,r)=>{hits++;r.writeHead(400);r.end('SECRET_PROVIDER');});const dir=await profileFixture(t,issuer);
 let result=await run(['auth','logout','--revoke'],dir);assert.notEqual(result.code,0);assert.ok(!result.err.includes('SECRET_PROVIDER'));
 assert.equal(JSON.parse(await readFile(join(dir,'profiles.json'),'utf8')).profiles.test.oauth.refreshToken,'refresh-1');
 result=await run(['auth','logout'],dir);assert.equal(result.code,0,result.err);assert.equal(hits,1);
});
test('lock cleanup never removes a replacement lock',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'zenifra-oauth-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const lock=join(dir,'profiles.lock');await withProfileLock(dir,async()=>{await rm(lock);await writeFile(lock,'replacement');});
 assert.equal(await readFile(lock,'utf8'),'replacement');
});
test('SIGINT releases an owned profile lock',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'zenifra-oauth-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const child=spawn(process.execPath,['--input-type=module','-e',"import {withProfileLock} from './bin/lib/profile-store.mjs'; await withProfileLock(process.argv[1],async()=>{process.stdout.write('locked');await new Promise(r=>setTimeout(r,10000));});",dir],{stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());const closed=new Promise(r=>child.once('close',r));await new Promise(r=>child.stdout.once('data',r));child.kill('SIGINT');assert.equal(await closed,130);
 await assert.rejects(stat(join(dir,'profiles.lock')),e=>e.code==='ENOENT');
});
test('public catalogs never send a profile OAuth token to an overridden API',async t=>{
 let originalCalls=0;const original=await fixture(t,(_q,r)=>{originalCalls++;r.end('{"data":[]}');});
 const captured=[];const alternate=await fixture(t,(req,r)=>{captured.push(req.headers.authorization);r.end('{"data":[]}');});
 const dir=await profileFixture(t,original);
 let result=await run(['plans','--type','http','--json','--api-base',alternate+'/v1'],dir);
 assert.equal(result.code,0,result.err);assert.ok(captured.length>0);assert.ok(captured.every(value=>value===undefined));assert.equal(originalCalls,0);
 captured.length=0;result=await run(['plans','--type','http','--json','--api-base',alternate+'/v1'],dir,{ZENIFRA_API_KEY:'znf_explicit'});
 assert.equal(result.code,0,result.err);assert.ok(captured.length>0);assert.ok(captured.every(value=>value==='Bearer znf_explicit'));assert.equal(originalCalls,0);
});
test('SIGINT during the authorization-code exchange never persists or reports login success',async t=>{
 let issuer,child,exchanges=0;
 issuer=await fixture(t,(req,res)=>{
 if(req.url.startsWith('/.well-known'))return res.end(JSON.stringify(metadata(issuer)));
 exchanges++;child.kill('SIGINT');
 setTimeout(()=>res.end(JSON.stringify({access_token:'SECRET_CANCELLED_ACCESS',refresh_token:'SECRET_CANCELLED_REFRESH',token_type:'Bearer',expires_in:300,scope:'cli:read offline_access'})),100);
 });
 const dir=await mkdtemp(join(tmpdir(),'zenifra-oauth-cancel-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 child=spawn(process.execPath,['bin/zenifra.mjs','auth','login','--oauth','--no-browser','--profile','cancelled','--api-base',issuer+'/v1'],{env:{...process.env,ZENIFRA_CONFIG_DIR:dir,ZENIFRA_API_KEY:'',ZENIFRA_API_URL:''},stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());let out='',err='',sent=false;const closed=new Promise(r=>child.once('close',r));
 child.stderr.on('data',b=>err+=b);child.stdout.on('data',async b=>{out+=b;const address=out.match(/http:\/\/127\.0\.0\.1:\d+\/v1\/oauth\/authorize\?[^\n]+/);if(address&&!sent){sent=true;const auth=new URL(address[0]);const cb=new URL(auth.searchParams.get('redirect_uri'));cb.search=new URLSearchParams({code:'fixture-code',state:auth.searchParams.get('state'),iss:issuer}).toString();await fetch(cb);}});
 assert.notEqual(await closed,0);assert.equal(exchanges,1);assert.ok(!out.includes('sucesso'));assert.ok(!out.includes('SECRET_'));assert.ok(!err.includes('SECRET_'));
 await assert.rejects(stat(join(dir,'profiles.json')),e=>e.code==='ENOENT');
});
test('cancelling discovery stops login before opening a browser',async t=>{
 const controller=new AbortController();let issuer;
 issuer=await fixture(t,(_req,res)=>{controller.abort();setTimeout(()=>res.end(JSON.stringify(metadata(issuer))),50);});
 await assert.rejects(oauthLogin(issuer+'/v1',{signal:controller.signal,onAuthorize:()=>assert.fail('cancelled login must not open a browser')}),/cancelado/);
});
test('SIGINT while waiting to persist OAuth keeps the previous profile and never reports success',async t=>{
 let issuer,tokenReturned;const exchanged=new Promise(r=>tokenReturned=r);
 issuer=await fixture(t,(req,res)=>{
 if(req.url.startsWith('/.well-known'))return res.end(JSON.stringify(metadata(issuer)));
 res.end(JSON.stringify({access_token:'SECRET_NEW_ACCESS',refresh_token:'SECRET_NEW_REFRESH',token_type:'Bearer',expires_in:300,scope:'cli:read offline_access'}),tokenReturned);
 });
 const dir=await profileFixture(t,issuer);const before=await readFile(join(dir,'profiles.json'),'utf8');
 let release,locked;const gate=new Promise(r=>release=r);const acquired=new Promise(r=>locked=r);
 const holder=withProfileLock(dir,async()=>{locked();await gate;});await acquired;t.after(()=>release());
 const child=spawn(process.execPath,['bin/zenifra.mjs','auth','login','--oauth','--no-browser','--profile','test','--api-base',issuer+'/v1'],{env:{...process.env,ZENIFRA_CONFIG_DIR:dir,ZENIFRA_API_KEY:'',ZENIFRA_API_URL:''},stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());let out='',err='',sent=false;const closed=new Promise(r=>child.once('close',r));
 child.stderr.on('data',b=>err+=b);child.stdout.on('data',async b=>{out+=b;const address=out.match(/http:\/\/127\.0\.0\.1:\d+\/v1\/oauth\/authorize\?[^\n]+/);if(address&&!sent){sent=true;const auth=new URL(address[0]);const cb=new URL(auth.searchParams.get('redirect_uri'));cb.search=new URLSearchParams({code:'fixture-code',state:auth.searchParams.get('state'),iss:issuer}).toString();await fetch(cb);}});
 await exchanged;await new Promise(r=>setTimeout(r,150));child.kill('SIGINT');await new Promise(r=>setTimeout(r,100));
 assert.equal(await readFile(join(dir,'profiles.lock'),'utf8'),String(process.pid));release();await holder;
 assert.notEqual(await closed,0);assert.ok(!out.includes('sucesso'));assert.ok(!out.includes('SECRET_NEW'));assert.ok(!err.includes('SECRET_NEW'));
 assert.equal(await readFile(join(dir,'profiles.json'),'utf8'),before);
});
