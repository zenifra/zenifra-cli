import { createHash } from 'node:crypto';

const style = `
* { box-sizing: border-box; }
:root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; min-height: 100vh; min-height: 100svh; display: grid; place-items: center; background: #09090b; color: #fafafa; padding: 32px 20px; }
.page { width: min(100%, 480px); }
.brand { display: flex; align-items: center; justify-content: center; gap: 9px; margin-bottom: 36px; font-size: 23px; font-weight: 650; letter-spacing: -.8px; }
.brand svg { width: 34px; height: 34px; fill: currentColor; }
.card { padding: 42px 36px 32px; border: 1px solid #29292f; border-radius: 24px; background: #111114; box-shadow: 0 24px 80px #0005; text-align: center; }
.status { display: grid; place-items: center; width: 76px; height: 76px; margin: 0 auto 28px; border-radius: 50%; color: #6ee7b7; background: #142d25; border: 1px solid #2a5344; box-shadow: 0 0 0 8px #142d2545; }
.status svg { width: 34px; height: 34px; }
.cancelled .status { color: #d4d4d8; background: #232329; border-color: #3f3f46; box-shadow: 0 0 0 8px #23232965; }
.eyebrow { margin: 0 0 12px; color: #a1a1aa; font-size: 11px; font-weight: 650; letter-spacing: 2px; text-transform: uppercase; }
h1 { margin: 0; font-size: clamp(27px, 5vw, 34px); line-height: 1.2; font-weight: 650; letter-spacing: -1.1px; }
.description { margin: 16px auto 28px; max-width: 340px; color: #a1a1aa; font-size: 15px; line-height: 1.7; }
.next { display: flex; align-items: center; gap: 14px; padding: 18px; text-align: left; background: #1a1a1f; border: 1px solid #303036; border-radius: 12px; }
.terminal { flex: 0 0 auto; display: grid; place-items: center; width: 40px; height: 40px; border: 1px solid #3a3a42; border-radius: 9px; background: #24242b; }
.terminal svg { width: 21px; height: 21px; }
.next strong { display: block; font-size: 14px; font-weight: 600; }
.next p { margin: 5px 0 0; color: #a1a1aa; font-size: 12px; line-height: 1.6; }
.close { margin: 25px 0 0; color: #a1a1aa; font-size: 12px; line-height: 1.6; }
.footer { margin: 24px 0 0; text-align: center; color: #a1a1aa; font-size: 12px; }
@media (max-width: 420px) { .card { padding: 34px 22px 26px; } .brand { margin-bottom: 28px; } .next { padding: 14px; gap: 11px; } }
`;

export const oauthPagePolicy = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(style).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export function oauthCallbackPage(cancelled = false) {
  const title = cancelled ? 'Login cancelado' : 'Autorização recebida';
  const description = cancelled
    ? 'Você cancelou a autorização. Nenhum novo acesso foi concedido ao CLI.'
    : 'Sua autorização foi enviada ao Zenifra CLI. Continue no terminal para concluir o login.';
  const icon = cancelled ? '<path d="m8 8 8 8M16 8l-8 8"/>' : '<path d="m5 12 4 4L19 6"/>';
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${title} · Zenifra CLI</title>
<style>${style}</style>
</head>
<body>
<main class="page${cancelled ? ' cancelled' : ''}">
  <div class="brand" aria-label="Zenifra">
    <svg viewBox="0 0 1000 1000" aria-hidden="true"><path d="M298.27,353.7l-82.91,229.13c82.68-78.72,163.4-112.86,290.82-112.86h3.22c126.61-1.58,264.38-96.29,323.98-218.5h-395.9c-56.45,0-118.78,45.77-139.21,102.22Z"/><path d="M493.82,530.02h-3.22c-126.61,1.58-264.38,96.29-323.98,218.5h395.9c56.45,0,118.78-45.77,139.21-102.22l82.91-229.13c-82.68,78.72-163.4,112.86-290.82,112.86Z"/></svg>
    <span>zenifra</span>
  </div>
  <section class="card" aria-labelledby="title">
    <div class="status" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></div>
    <p class="eyebrow">Zenifra CLI</p>
    <h1 id="title">${title}</h1>
    <p class="description">${description}</p>
    <div class="next">
      <span class="terminal" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 7 5 5-5 5M13 17h6"/></svg></span>
      <div><strong>Volte ao seu terminal</strong><p>${cancelled ? 'Inicie um novo login quando quiser.' : 'A confirmação do login aparecerá por lá.'}</p></div>
    </div>
    <p class="close">Você já pode fechar esta aba.</p>
  </section>
  <p class="footer">Seu próximo passo está no terminal.</p>
</main>
</body>
</html>`;
}
