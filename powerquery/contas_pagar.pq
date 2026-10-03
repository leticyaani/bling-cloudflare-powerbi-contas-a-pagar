// Antes de usar: crie o parâmetro de texto pWorkerApiKey no Power Query.
// Troque SEU-WORKER.workers.dev pelo endereço real do Worker.
// A fonte Web deve usar credencial Anônima; a chave segue no cabeçalho X-API-Key.
let
    BaseUrl = "https://SEU-WORKER.workers.dev",
    ApiKey = pWorkerApiKey,
    PageSize = 30,
    MaxPages = 100,
    Columns = {
        "ID",
        "Fornecedor",
        "Valor (R$)",
        "Emissão",
        "Competência",
        "Vencimento",
        "Histórico",
        "Pagamento",
        "Forma de Pagamento",
        "Conta Financeira",
        "Situação",
        "SituacaoCodigo",
        "Erros"
    },

    GetPage = (PageNumber as number) as record =>
        let
            Response = Json.Document(
                Web.Contents(
                    BaseUrl,
                    [
                        RelativePath = "contas-pagar",
                        Query = [
                            pagina = Text.From(PageNumber, "en-US"),
                            limite = Text.From(PageSize, "en-US")
                        ],
                        Headers = [
                            #"X-API-Key" = ApiKey,
                            Accept = "application/json"
                        ],
                        Timeout = #duration(0, 0, 10, 0)
                    ]
                )
            ),
            RawRows = try Response[data] otherwise {},
            Rows = if Value.Is(RawRows, type list) then RawRows else {},
            ApiErrors = try Text.From(Response[errors]) otherwise ""
        in
            [Rows = Rows, Errors = ApiErrors],

    PageStates = List.Generate(
        () => [Index = 1, Page = GetPage(1)],
        each [Index] <= MaxPages and List.Count([Page][Rows]) > 0,
        each
            if [Index] < MaxPages then
                [Index = [Index] + 1, Page = GetPage([Index] + 1)]
            else
                [Index = MaxPages + 1, Page = [Rows = {}, Errors = ""]],
        each [Page][Rows]
    ),
    AllRows = List.Combine(PageStates),
    AsTable = Table.FromRecords(AllRows, Columns, MissingField.UseNull),

    ToDate = (InputValue as any) as nullable date =>
        if InputValue = null or InputValue = "" then
            null
        else if Value.Is(InputValue, type date) then
            InputValue
        else
            let
                TextValue = Text.From(InputValue),
                IsoDate = try Date.FromText(Text.Start(TextValue, 10), [Format = "yyyy-MM-dd", Culture = "en-US"])
                    otherwise try Date.FromText(TextValue, [Culture = "pt-BR"]) otherwise null
            in
                IsoDate,
    ToNumber = (InputValue as any) as nullable number =>
        if InputValue = null or InputValue = "" then null
        else if Value.Is(InputValue, type number) then InputValue
        else try Number.FromText(Text.From(InputValue), "en-US") otherwise try Number.FromText(Text.From(InputValue), "pt-BR") otherwise null,
    ToInt64 = (InputValue as any) as nullable number =>
        if InputValue = null or InputValue = "" then null
        else try Int64.From(InputValue) otherwise try Int64.From(Number.FromText(Text.From(InputValue), "en-US")) otherwise null,

    Typed = Table.TransformColumns(
        AsTable,
        {
            {"ID", each ToInt64(_), Int64.Type},
            {"Fornecedor", each if _ = null then "" else Text.From(_), type text},
            {"Valor (R$)", each ToNumber(_), Currency.Type},
            {"Emissão", each ToDate(_), type date},
            {"Competência", each ToDate(_), type date},
            {"Vencimento", each ToDate(_), type date},
            {"Histórico", each if _ = null then "" else Text.From(_), type text},
            {"Pagamento", each ToDate(_), type date},
            {"Forma de Pagamento", each if _ = null then "" else Text.From(_), type text},
            {"Conta Financeira", each if _ = null then "" else Text.From(_), type text},
            {"Situação", each if _ = null then "" else Text.From(_), type text},
            {"SituacaoCodigo", each ToInt64(_), Int64.Type},
            {"Erros", each if _ = null then "" else Text.From(_), type text}
        },
        null,
        MissingField.UseNull
    ),
    UniqueRows = Table.Distinct(Typed, {"ID"}),
    SortedRows = Table.Sort(UniqueRows, {{"Vencimento", Order.Ascending}})
in
    SortedRows
