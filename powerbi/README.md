# Power BI

A medida DAX `HTML_Dashboard.dax` foi adicionada com base no código enviado. Ela gera o layout HTML/CSS do painel e considera as colunas descritas no README principal.

**Ajuste aplicado:** o campo mostrado como histórico na tabela de próximos vencimentos foi corrigido para usar `[Histórico]` (o código recebido apontava para `[Situacao]`).

O tema `theme.json` é uma configuração inicial criada a partir das cores do CSS; o tema original e o arquivo `.pbix` não foram recebidos. Para usar a medida, confirme que a tabela se chama `Contas a pagar` e contém os nomes de colunas referenciados no DAX.
