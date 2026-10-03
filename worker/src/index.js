const BLING_AUTH_BASE = "https://www.bling.com.br/Api/v3/oauth";
const BLING_API_BASE = "https://api.bling.com.br/Api/v3";
const TOKEN_KEY = "bling:oauth:tokens";
const CATALOG_TTL_SECONDS = 24 * 60 * 60;
const PAID_TTL_SECONDS = 7 * 24 * 60 * 60;
const RATE_INTERVAL_MS = 350;
const TOKEN_EARLY_REFRESH_MS = 60 * 1000;

// This queue is isolate-local. It spaces calls handled by this Worker isolate;
// Cloudflare KV is eventually consistent and is not a global rate limiter.
let rateQueue = Promise.resolve();
let lastBlingCallAt = 0;
let refreshInFlight = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function normalizeSituation(value) {
  const source = value && typeof value === "object"
    ? (value.nome ?? value.descricao ?? value.situacao ?? value.id)
    : value;
  const raw = String(source ?? "").trim();
  const code = /^\d+$/.test(raw) ? Number(raw) : null;
  const normalized = raw.toLocaleLowerCase("pt-BR");
  if (code === 1 || normalized === "em aberto" || normalized === "aberto") {
    return { code: 1, label: "Em aberto" };
  }
  if (code === 2 || normalized === "pago") {
    return { code: 2, label: "Pago" };
  }
  if (code === 3 || normalized === "parcialmente pago") {
    return { code: 3, label: "Parcialmente pago" };
  }
  return { code, label: raw || "Não informado" };
}

export function toIsoDate(value) {
  if (value == null || value === "") return "";
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const br = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return "";
}

export function cleanText(value, maxLength = 500) {
  const source = value && typeof value === "object"
    ? (value.nome ?? value.descricao ?? value.texto ?? value.id ?? "")
    : value;
  return String(source ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

function json(data, status = 200, env = {}) {
  const origin = env.ALLOWED_ORIGIN || "*";
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
      "Vary": "Origin",
    },
  });
}

function text(message, status = 200, headers = {}) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function safeEqual(left, right) {
  const a = new TextEncoder().encode(String(left ?? ""));
  const b = new TextEncoder().encode(String(right ?? ""));
  let difference = a.length ^ b.length;
  const size = Math.max(a.length, b.length);
  for (let i = 0; i < size; i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

function isAuthorized(request, env) {
  if (!env.API_ACCESS_KEY) return false;
  return safeEqual(request.headers.get("X-API-Key"), env.API_ACCESS_KEY);
}

function requireKv(env) {
  if (!env.KV || typeof env.KV.get !== "function" || typeof env.KV.put !== "function") {
    throw new Error("KV binding não configurado");
  }
}

function getPath(object, path) {
  return path.split(".").reduce((value, key) => {
    if (value == null) return undefined;
    if (Array.isArray(value) && /^\d+$/.test(key)) return value[Number(key)];
    return value[key];
  }, object);
}

function firstValue(object, paths) {
  for (const path of paths) {
    const value = getPath(object, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function idOf(value) {
  if (value == null || value === "") return "";
  if (typeof value === "object") return String(value.id ?? value.codigo ?? value.idContato ?? "");
  return String(value);
}

export function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null || value === "") return 0;
  let text = String(value).replace(/[^\d.,-]/g, "");
  if (text.includes(",") && text.includes(".")) text = text.replace(/\./g, "").replace(",", ".");
  else if (text.includes(",")) text = text.replace(",", ".");
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

function unwrap(payload) {
  if (payload && typeof payload === "object" && Object.hasOwn(payload, "data")) return payload.data;
  return payload;
}

function rowsFrom(payload) {
  const data = unwrap(payload);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

function tokenBasicAuth(env) {
  if (!env.BLING_CLIENT_ID || !env.BLING_CLIENT_SECRET) {
    throw new Error("Configure BLING_CLIENT_ID e BLING_CLIENT_SECRET como secrets");
  }
  return `Basic ${btoa(`${env.BLING_CLIENT_ID}:${env.BLING_CLIENT_SECRET}`)}`;
}

async function readTokens(env) {
  requireKv(env);
  const raw = await env.KV.get(TOKEN_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveTokens(env, payload, previous = null) {
  requireKv(env);
  const expiresIn = Math.max(0, Number(payload.expires_in ?? 0));
  const record = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || previous?.refresh_token || "",
    token_type: payload.token_type || "Bearer",
    scope: payload.scope || previous?.scope || "",
    obtained_at: Date.now(),
    expires_at: Date.now() + expiresIn * 1000,
    refresh_expires_in: payload.refresh_expires_in ?? previous?.refresh_expires_in ?? null,
  };
  await env.KV.put(TOKEN_KEY, JSON.stringify(record));
  return record;
}

async function exchangeToken(env, fields, previous = null) {
  const body = new URLSearchParams(fields);
  const response = await fetch(`${BLING_AUTH_BASE}/token`, {
    method: "POST",
    headers: {
      Authorization: tokenBasicAuth(env),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(`Bling OAuth recusou a solicitação (HTTP ${response.status})`);
  }
  return saveTokens(env, payload, previous);
}

async function refreshAccessToken(env) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const previous = await readTokens(env);
    if (!previous?.refresh_token) throw new Error("Reautorização necessária: refresh token indisponível");
    return exchangeToken(env, {
      grant_type: "refresh_token",
      refresh_token: previous.refresh_token,
    }, previous);
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function accessToken(env) {
  const tokens = await readTokens(env);
  if (!tokens?.access_token) throw new Error("Integração não autorizada; acesse /login");
  if (Number(tokens.expires_at || 0) <= Date.now() + TOKEN_EARLY_REFRESH_MS) {
    return (await refreshAccessToken(env)).access_token;
  }
  return tokens.access_token;
}

async function waitForBlingSlot() {
  let release;
  const previous = rateQueue;
  rateQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const wait = Math.max(0, lastBlingCallAt + RATE_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastBlingCallAt = Date.now();
  } finally {
    release();
  }
}

async function requestBlingWithToken(path, env, token, allowRefresh) {
  let response;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await waitForBlingSlot();
    response = await fetch(`${BLING_API_BASE}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (response.status !== 429 || attempt === 4) break;
    await sleep(350 * attempt);
  }
  if (response.status === 401 && allowRefresh) {
    const refreshed = await refreshAccessToken(env);
    return requestBlingWithToken(path, env, refreshed.access_token, false);
  }
  if (!response.ok) throw new Error(`Bling API respondeu HTTP ${response.status}`);
  return response.json();
}

async function requestBling(path, env) {
  return requestBlingWithToken(path, env, await accessToken(env), true);
}

async function cachedReference(env, key, fetcher) {
  const cached = await env.KV.get(key);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* cache inválido: recarrega */ }
  }
  const record = await fetcher();
  if (record != null) {
    try {
      await env.KV.put(key, JSON.stringify(record), { expirationTtl: CATALOG_TTL_SECONDS });
    } catch {
      // KV pode limitar gravações; a resposta atual continua válida sem cache.
    }
  }
  return record;
}

function situationFrom(item) {
  const value = firstValue(item, ["situacao", "situacaoCodigo", "situacao.codigo", "situacao.id", "status"]);
  return normalizeSituation(value);
}

function sameMoney(left, right) {
  return Math.round(numberValue(left) * 100) === Math.round(numberValue(right) * 100);
}

async function cachedPaidAccount(env, id, listItem, situation) {
  const key = `paid:${id}`;
  const raw = await env.KV.get(key);
  if (!raw) return null;
  let cached;
  try { cached = JSON.parse(raw); } catch { await env.KV.delete(key); return null; }
  const currentDue = toIsoDate(firstValue(listItem, ["vencimento", "dataVencimento"]));
  const currentValue = firstValue(listItem, ["valor", "saldo"]);
  const valid = situation.code === 2
    && cached.SituacaoCodigo === 2
    && cached.Vencimento === currentDue
    && sameMoney(cached["Valor (R$)"], currentValue)
    && Boolean(cached.Pagamento)
    && Boolean(cached["Conta Financeira"])
    && !cached.Erros;
  if (valid) return cached;
  await env.KV.delete(key);
  return null;
}

async function enrichAccount(env, item) {
  const id = idOf(firstValue(item, ["id", "ID"]));
  const situation = situationFrom(item);
  if (!id) throw new Error("Conta sem ID retornado pelo Bling");

  if (situation.code !== 2) {
    try { await env.KV.delete(`paid:${id}`); } catch { /* best effort */ }
  } else {
    const cached = await cachedPaidAccount(env, id, item, situation);
    if (cached) return cached;
  }

  const errors = [];
  let detail = {};
  try {
    detail = unwrap(await requestBling(`/contas/pagar/${encodeURIComponent(id)}`, env)) || {};
  } catch (error) {
    errors.push(`Detalhe: ${error.message}`);
  }

  const contactId = idOf(firstValue(detail, ["contato", "fornecedor", "contato.id", "fornecedor.id"]) ?? firstValue(item, ["contato", "fornecedor"]));
  const paymentFormId = idOf(firstValue(detail, ["formaPagamento", "formaDePagamento", "formaPagamento.id"]) ?? firstValue(item, ["formaPagamento"]));
  const accountId = idOf(firstValue(detail, ["contaContabil", "contaFinanceira", "portador", "contaContabil.id", "contaFinanceira.id", "portador.id"]));
  const borderoId = idOf(firstValue(detail, ["bordero", "borderô", "bordero.id", "borderos.0.id"]));

  const lookup = async (kind, referenceId, path, label) => {
    if (!referenceId) return null;
    try {
      return await cachedReference(env, `catalog:${kind}:${referenceId}`, async () => unwrap(await requestBling(path, env)) || null);
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
      return null;
    }
  };

  const [contact, paymentForm, account, bordero] = await Promise.all([
    lookup("contato", contactId, `/contatos/${encodeURIComponent(contactId)}`, "Contato"),
    lookup("forma", paymentFormId, `/formas-pagamentos/${encodeURIComponent(paymentFormId)}`, "Forma de pagamento"),
    lookup("conta", accountId, `/contas-contabeis/${encodeURIComponent(accountId)}`, "Conta contábil"),
    lookup("bordero", borderoId, `/borderos/${encodeURIComponent(borderoId)}`, "Borderô"),
  ]);

  const settledAccountId = idOf(firstValue(bordero, ["contaContabil", "contaFinanceira", "conta", "portador", "contaContabil.id", "contaFinanceira.id", "conta.id", "portador.id"]));
  let settledAccount = null;
  const accountName = cleanText(firstValue(account, ["descricao", "nome", "numero", "conta.nome"]), 150);
  if (!accountName && settledAccountId && settledAccountId !== accountId) {
    settledAccount = await lookup("conta", settledAccountId, `/contas-contabeis/${encodeURIComponent(settledAccountId)}`, "Conta financeira da baixa");
  }

  const name = cleanText(firstValue(contact, ["nome", "nomeFantasia", "razaoSocial"]) ?? firstValue(detail, ["contato.nome", "fornecedor.nome", "nomeFornecedor", "fornecedor"]) ?? firstValue(item, ["contato.nome", "fornecedor.nome", "nomeFornecedor"]), 200);
  const document = cleanText(firstValue(contact, ["numeroDocumento", "cpfCnpj", "cnpj", "cpf"]) ?? firstValue(detail, ["contato.numeroDocumento", "contato.cpfCnpj"]), 30);
  const paymentDate = toIsoDate(firstValue(bordero, ["data", "dataPagamento", "dataBaixa"]) ?? firstValue(detail, ["dataPagamento", "dataBaixa", "pagamento.data"]));
  const financeName = accountName || cleanText(firstValue(settledAccount, ["descricao", "nome", "numero"]), 150);
  const financeFallback = cleanText(firstValue(bordero, ["contaFinanceira.descricao", "conta.descricao", "portador.descricao"]), 150);
  const payFormName = cleanText(firstValue(paymentForm, ["descricao", "nome"]) ?? firstValue(detail, ["formaPagamento.descricao", "formaDePagamento.descricao"]), 120);
  const value = numberValue(firstValue(item, ["valor", "Valor", "saldo"]) ?? firstValue(detail, ["valor", "saldo"]));
  const balance = numberValue(firstValue(detail, ["saldo", "valorSaldo"]) ?? firstValue(item, ["saldo"]));
  const dueDate = toIsoDate(firstValue(item, ["vencimento", "dataVencimento"]) ?? firstValue(detail, ["vencimento", "dataVencimento"]));

  const result = {
    ID: Number.isFinite(Number(id)) ? Number(id) : id,
    Fornecedor: name,
    "Valor (R$)": value,
    Emissão: toIsoDate(firstValue(detail, ["dataEmissao", "emissao", "dataEmissaoDocumento"]) ?? firstValue(item, ["dataEmissao", "emissao"])),
    Competência: toIsoDate(firstValue(detail, ["dataCompetencia", "competencia"]) ?? firstValue(item, ["dataCompetencia", "competencia"])),
    Vencimento: dueDate,
    Histórico: cleanText(firstValue(detail, ["historico", "descricao", "observacoes"]) ?? firstValue(item, ["historico", "descricao"]), 500),
    Pagamento: paymentDate,
    "Forma de Pagamento": payFormName,
    "Conta Financeira": financeName || financeFallback,
    Situação: situation.label,
    SituacaoCodigo: situation.code,
    Erros: cleanText(errors.join("; "), 1000),
    CPFCNPJ: document,
    Saldo: balance,
    NumeroDocumento: cleanText(firstValue(detail, ["numeroDocumento", "numero", "documento.numero"]) ?? firstValue(item, ["numeroDocumento"]), 80),
  };

  if (situation.code === 2 && result.Pagamento && result["Conta Financeira"] && !result.Erros) {
    try {
      await env.KV.put(`paid:${id}`, JSON.stringify(result), { expirationTtl: PAID_TTL_SECONDS });
    } catch {
      // Evita falhar o endpoint quando o KV aplica limite de escrita.
    }
  }
  return result;
}

function allowedFilters(searchParams) {
  const accepted = [
    "situacao",
    "dataVencimentoInicial",
    "dataVencimentoFinal",
    "dataEmissaoInicial",
    "dataEmissaoFinal",
  ];
  const params = new URLSearchParams();
  for (const name of accepted) {
    const value = searchParams.get(name);
    if (value) params.set(name, value);
  }
  return params;
}

async function listPayables(url, env) {
  requireKv(env);
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("pagina") || 1)));
  const limitRaw = Math.floor(Number(url.searchParams.get("limite") || 30));
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 30));
  const filters = allowedFilters(url.searchParams);
  filters.set("pagina", String(page));
  filters.set("limite", String(limit));

  const payload = await requestBling(`/contas/pagar?${filters.toString()}`, env);
  const items = rowsFrom(payload);
  const data = [];
  for (const item of items) {
    try {
      data.push(await enrichAccount(env, item));
    } catch (error) {
      data.push({
        ID: Number(firstValue(item, ["id", "ID"])) || "",
        Fornecedor: "",
        "Valor (R$)": numberValue(firstValue(item, ["valor", "Valor"])),
        Emissão: "",
        Competência: "",
        Vencimento: toIsoDate(firstValue(item, ["vencimento", "dataVencimento"])),
        Histórico: "",
        Pagamento: "",
        "Forma de Pagamento": "",
        "Conta Financeira": "",
        Situação: situationFrom(item).label,
        SituacaoCodigo: situationFrom(item).code,
        Erros: cleanText(error.message, 1000),
        CPFCNPJ: "",
        Saldo: numberValue(firstValue(item, ["saldo"])),
        NumeroDocumento: "",
      });
    }
  }
  return json({
    data,
    pagination: { pagina: page, limite: limit, retornados: data.length },
    errors: "",
  }, 200, env);
}

function randomState() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function login(env) {
  requireKv(env);
  if (!env.BLING_CLIENT_ID) return text("Configure o secret BLING_CLIENT_ID.", 503);
  const state = randomState();
  await env.KV.put(`oauth:state:${state}`, "1", { expirationTtl: 600 });
  const authorize = new URL(`${BLING_AUTH_BASE}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", env.BLING_CLIENT_ID);
  authorize.searchParams.set("state", state);
  return Response.redirect(authorize.toString(), 302);
}

async function callback(url, env) {
  requireKv(env);
  const oauthError = url.searchParams.get("error");
  if (oauthError) return text("A autorização do Bling foi recusada. Confira as permissões e tente novamente.", 400);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return text("Callback OAuth incompleto: code ou state ausente.", 400);
  const stateKey = `oauth:state:${state}`;
  const validState = await env.KV.get(stateKey);
  if (!validState) return text("State OAuth inválido ou expirado. Inicie novamente em /login.", 400);
  await env.KV.delete(stateKey);
  const fields = { grant_type: "authorization_code", code };
  if (env.BLING_REDIRECT_URI) fields.redirect_uri = env.BLING_REDIRECT_URI;
  try {
    await exchangeToken(env, fields);
    return text("Autorização do Bling concluída. Você já pode fechar esta janela.");
  } catch (error) {
    return text(`Falha ao trocar o authorization code: ${error.message}`, 502);
  }
}

async function tokenStatus(env) {
  const tokens = await readTokens(env);
  return json({
    authorized: Boolean(tokens?.access_token && tokens?.refresh_token),
    accessTokenExpiresAt: tokens?.expires_at ? new Date(tokens.expires_at).toISOString() : null,
    refreshTokenStored: Boolean(tokens?.refresh_token),
    action: tokens?.refresh_token ? "refresh disponível; token renova automaticamente" : "acesse /login para autorizar",
  }, 200, env);
}

async function forceRefresh(env) {
  try {
    const tokens = await refreshAccessToken(env);
    return json({ refreshed: true, accessTokenExpiresAt: new Date(tokens.expires_at).toISOString() }, 200, env);
  } catch (error) {
    return json({ refreshed: false, error: error.message }, 401, env);
  }
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
      "Access-Control-Max-Age": "86400",
    } });
  }
  if (request.method !== "GET") return json({ error: "Método não permitido" }, 405, env);
  if (url.pathname === "/login") return login(env);
  if (url.pathname === "/callback") return callback(url, env);

  if (["/contas-pagar", "/token-status", "/refresh"].includes(url.pathname)) {
    if (!env.API_ACCESS_KEY) return json({ error: "API indisponível: configure o secret API_ACCESS_KEY antes de liberar dados financeiros" }, 503, env);
    if (!isAuthorized(request, env)) return json({ error: "Não autorizado" }, 401, env);
    try {
      if (url.pathname === "/contas-pagar") return await listPayables(url, env);
      if (url.pathname === "/token-status") return await tokenStatus(env);
      return await forceRefresh(env);
    } catch (error) {
      const status = /não autorizada|reautorização necessária/i.test(error.message) ? 401 : 502;
      return json({ error: cleanText(error.message, 500) }, status, env);
    }
  }
  return json({ error: "Rota não encontrada" }, 404, env);
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
