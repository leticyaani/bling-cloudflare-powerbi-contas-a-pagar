# Power Query

O script executável `contas_pagar.pq` pagina de 1 até a primeira página vazia (máximo de 100), com limite de 30 registros por página, timeout de 10 minutos, deduplicação por ID e conversão de tipos.

## Configuração

1. Substitua `https://SEU-WORKER.workers.dev` no script pela URL do Worker.
2. Crie no Power Query um parâmetro de texto chamado `pWorkerApiKey`, marque-o como **Privado** e informe o valor do secret `API_ACCESS_KEY` configurado no Worker.
3. Ao configurar a fonte Web, selecione autenticação **Anônima**. A chave segue no cabeçalho `X-API-Key` definido no M.
4. Não publique um PBIX com a chave sem avaliar quem poderá baixá-lo ou extraí-la.

A paginação começa explicitamente em `pagina=1` e o passo seguinte chama `pagina + 1`, evitando o erro de índice mencionado nas notas recebidas.
