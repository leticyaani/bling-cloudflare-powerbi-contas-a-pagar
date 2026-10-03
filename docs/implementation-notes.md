# Notas de implementação

## Especificação recebida

- Worker: `GET /contas-pagar`, com `pagina` (a partir de 1), `limite` (1–100; padrão 30), `situacao`, filtros de emissão/vencimento; `GET /login`, `/callback`, `/token-status` e `/refresh`.
- Bling: lista `/contas/pagar`; detalhes `/contas/pagar/{id}`; enriquecimento com contatos, formas de pagamento, contas contábeis e borderôs.
- Situação: `1 = Em aberto`, `2 = Pago`, `3 = Parcialmente pago` (o código 3 precisa ser confirmado no ambiente Bling do usuário).
- Limite: espera nominal de 350 ms entre chamadas e até quatro tentativas para HTTP 429; uma renovação e repetição após 401.
- Cache: referências por 24 h; contas pagas por 7 dias apenas quando pagamento e conta financeira foram encontrados e não há erros; não cachear contas abertas. Invalidar cache de conta paga ao mudar valor/vencimento ou situação.
- Power Query: páginas de 30 linhas, até 100 páginas, timeout de 10 minutos, deduplicação por ID, nomes de colunas em português e ordenação pelo vencimento.
- Power BI: 13 colunas usadas na tabela; `CPFCNPJ`, `Saldo` e `NumeroDocumento` podem ser retornados pelo Worker sem serem carregados no modelo.

## Decisões e limites

- A chave `API_ACCESS_KEY` é obrigatória para `/contas-pagar`, `/token-status` e `/refresh`; o Worker falha fechado se não estiver configurada. `/login` e `/callback` ficam acessíveis para permitir o OAuth, e o callback valida `state` de uso único.
- Credenciais Bling, a chave da API e o ID do namespace KV são placeholders. Nenhuma credencial foi incluída no Git.
- A limitação de 350 ms é serializada dentro de cada isolate Worker; não é um limitador global coordenado entre isolates. Retentativas 429 são a salvaguarda para concorrência entre instâncias.
- Os identificadores/campos de relacionamento variam conforme o objeto retornado pela conta Bling; a implementação tenta os caminhos comuns e deixa uma mensagem em `Erros` quando uma consulta de enriquecimento falha. Validar com uma conta de teste antes de produção.
- Antes de distribuir o PBIX, trate `pWorkerApiKey` como segredo: qualquer pessoa que consiga extrair os parâmetros do arquivo poderá reutilizar a chave. Use uma chave forte, rotação e escopo de acesso restrito.
- A implementação não foi validada contra uma conta Bling real; não foram fornecidos tokens nem dados de teste e eles não devem ser enviados aqui.

## Referências oficiais

- [Bling — Aplicativos e OAuth](https://developer.bling.com.br/aplicativos)
- [Bling — Autenticação da API v3](https://developer.bling.com.br/bling-api)
- [Bling — Perguntas frequentes (limites, paginação e `state`)](https://developer.bling.com.br/perguntas-frequentes)
- [Cloudflare — KV bindings](https://developers.cloudflare.com/kv/concepts/kv-bindings/)
- [Cloudflare — Escrita e `expirationTtl` no KV](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)
- [Cloudflare — Secrets para Workers](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Microsoft — `Web.Contents`](https://learn.microsoft.com/en-us/powerquery-m/web-contents)
- [Microsoft — `List.Generate`](https://learn.microsoft.com/en-us/powerquery-m/list-generate)
