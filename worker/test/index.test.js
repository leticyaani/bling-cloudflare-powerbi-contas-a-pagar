import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, normalizeSituation, toIsoDate, cleanText, numberValue } from "../src/index.js";

function memoryKv() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
  };
}

test("normaliza códigos e rótulos de situação do Bling", () => {
  assert.deepEqual(normalizeSituation(1), { code: 1, label: "Em aberto" });
  assert.deepEqual(normalizeSituation("2"), { code: 2, label: "Pago" });
  assert.deepEqual(normalizeSituation({ id: 3 }), { code: 3, label: "Parcialmente pago" });
  assert.deepEqual(normalizeSituation("Em aberto"), { code: 1, label: "Em aberto" });
});

test("normaliza datas ISO e brasileiras", () => {
  assert.equal(toIsoDate("2026-10-02T00:00:00-03:00"), "2026-10-02");
  assert.equal(toIsoDate("02/10/2026"), "2026-10-02");
  assert.equal(toIsoDate(""), "");
  assert.equal(toIsoDate("data inválida"), "");
});

test("limpa controles, objetos e textos longos", () => {
  assert.equal(cleanText(" fornecedor\nX "), "fornecedor X");
  assert.equal(cleanText({ nome: "Fornecedor Exemplo" }), "Fornecedor Exemplo");
  assert.equal(cleanText("123456", 3), "123");
});

test("converte valores monetários sem remover ponto decimal", () => {
  assert.equal(numberValue(1234.56), 1234.56);
  assert.equal(numberValue("1234.56"), 1234.56);
  assert.equal(numberValue("1.234,56"), 1234.56);
  assert.equal(numberValue("R$ 1.234,56"), 1234.56);
});

test("recusa acesso financeiro se a chave não foi configurada", async () => {
  const response = await handleRequest(
    new Request("https://worker.example/contas-pagar"),
    { KV: memoryKv() }
  );
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.match(payload.error, /API_ACCESS_KEY/);
});

test("recusa chave ausente ou incorreta", async () => {
  const env = { API_ACCESS_KEY: "test-only-key", KV: memoryKv() };
  const response = await handleRequest(new Request("https://worker.example/token-status"), env);
  assert.equal(response.status, 401);
  const wrong = await handleRequest(
    new Request("https://worker.example/token-status", { headers: { "X-API-Key": "wrong" } }),
    env
  );
  assert.equal(wrong.status, 401);
});

test("OAuth inicia com state e callback troca o code uma única vez", async () => {
  const kv = memoryKv();
  const env = {
    BLING_CLIENT_ID: "client-test",
    BLING_CLIENT_SECRET: "secret-test",
    BLING_REDIRECT_URI: "https://worker.example/callback",
    KV: kv,
  };
  const login = await handleRequest(new Request("https://worker.example/login"), env);
  assert.equal(login.status, 302);
  const authorizeUrl = new URL(login.headers.get("Location"));
  assert.equal(authorizeUrl.hostname, "www.bling.com.br");
  const state = authorizeUrl.searchParams.get("state");
  assert.ok(state);
  assert.ok(await kv.get(`oauth:state:${state}`));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/oauth\/token$/);
    assert.match(String(options.headers.Authorization), /^Basic /);
    assert.equal(new URLSearchParams(options.body).get("grant_type"), "authorization_code");
    return new Response(JSON.stringify({ access_token: "mock-access", refresh_token: "mock-refresh", expires_in: 3600 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const callback = await handleRequest(new Request(`https://worker.example/callback?code=mock-code&state=${state}`), env);
    assert.equal(callback.status, 200);
    assert.match(await kv.get("bling:oauth:tokens"), /mock-refresh/);
    const replay = await handleRequest(new Request(`https://worker.example/callback?code=again&state=${state}`), env);
    assert.equal(replay.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retorna conta aberta enriquecida no contrato usado pelo Power Query", async () => {
  const kv = memoryKv();
  await kv.put("bling:oauth:tokens", JSON.stringify({ access_token: "mock-access", refresh_token: "mock-refresh", expires_at: Date.now() + 3600000 }));
  const env = { API_ACCESS_KEY: "test-only-key", KV: kv };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer mock-access");
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/contas/pagar")) {
      return Response.json({ data: [{ id: 101, situacao: 1, vencimento: "2026-10-10", valor: 1250.75 }] });
    }
    if (parsed.pathname.endsWith("/contas/pagar/101")) {
      return Response.json({ data: { id: 101, contato: { id: 201 }, formaPagamento: { id: 301 }, contaContabil: { id: 401 }, historico: "Serviço mensal", dataEmissao: "2026-09-01", dataCompetencia: "2026-09-01" } });
    }
    if (parsed.pathname.endsWith("/contatos/201")) return Response.json({ data: { nome: "Fornecedor Exemplo", numeroDocumento: "00000000000000" } });
    if (parsed.pathname.endsWith("/formas-pagamentos/301")) return Response.json({ data: { descricao: "Transferência" } });
    if (parsed.pathname.endsWith("/contas-contabeis/401")) return Response.json({ data: { descricao: "Banco principal" } });
    throw new Error(`Endpoint mock inesperado: ${parsed.pathname}`);
  };
  try {
    const response = await handleRequest(
      new Request("https://worker.example/contas-pagar?pagina=1&limite=30", { headers: { "X-API-Key": "test-only-key" } }),
      env
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.length, 1);
    assert.equal(payload.data[0].ID, 101);
    assert.equal(payload.data[0].Fornecedor, "Fornecedor Exemplo");
    assert.equal(payload.data[0]["Valor (R$)"], 1250.75);
    assert.equal(payload.data[0]["Conta Financeira"], "Banco principal");
    assert.equal(payload.data[0].Erros, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
