# Cloudflare Worker

A implementação inicial está em `src/index.js`. Ela fornece OAuth2 com `state` anti-CSRF, consulta contas a pagar, enriquece registros, mantém cache no KV, renova token e exige chave de acesso nos endpoints que expõem dados financeiros.

## Preparação e implantação

1. Entre nesta pasta e instale as dependências versionadas: `npm ci`.
2. Autentique-se com `npx wrangler login`.
3. Crie um namespace KV: `npx wrangler kv namespace create KV`.
4. Edite `wrangler.toml`: descomente o binding `KV` e substitua o ID pelo retornado pela Cloudflare. Atualize `BLING_REDIRECT_URI` para a URL exata do Worker terminada em `/callback`.
5. Cadastre **a mesma URL** como redirect/callback no app Bling e habilite os escopos somente de leitura descritos no README principal.
6. Configure os secrets, sem incluí-los em arquivos versionados:

   ```sh
   npx wrangler secret put BLING_CLIENT_ID
   npx wrangler secret put BLING_CLIENT_SECRET
   npx wrangler secret put API_ACCESS_KEY
   ```

   Gere uma chave forte para `API_ACCESS_KEY`; não use a chave do arquivo de exemplo.

7. Rode as verificações locais: `npm run check`, `npm test` e `npx wrangler deploy --dry-run`.
8. Faça deploy: `npx wrangler deploy`.
9. Acesse `https://SEU-WORKER.workers.dev/login` uma vez para concluir o consentimento no Bling.
10. Teste `GET /token-status` e `GET /contas-pagar?pagina=1&limite=30` usando o cabeçalho `X-API-Key`.

## Rotas

| Rota | Acesso | Descrição |
|---|---|---|
| `GET /login` | pública | inicia OAuth e grava `state` de uso único por 10 minutos |
| `GET /callback` | pública, com validação do `state` | troca o authorization code e guarda os tokens no KV |
| `GET /contas-pagar` | `X-API-Key` obrigatório | lista/enriquece contas paginadas |
| `GET /token-status` | `X-API-Key` obrigatório | informa validade sem expor token |
| `GET /refresh` | `X-API-Key` obrigatório | força renovação do token |

Os endpoints financeiros retornam `503` se `API_ACCESS_KEY` estiver ausente. O callback OAuth não exige a chave, mas valida um `state` aleatório de uso único. Tokens são gravados no KV; Client ID/Secret e a chave de acesso devem ser secrets.

**Ainda é necessário testar os nomes dos relacionamentos do detalhe, borderô e conta contábil com uma conta de homologação.** Não use em produção antes de validar permissões, dados e proteção de acesso.
