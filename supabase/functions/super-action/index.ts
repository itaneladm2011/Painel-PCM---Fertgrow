// ============================================================
// Supabase Edge Function: sync-melvin-solicitacoes
// Autentica na API do Melvin (CMMS) e busca as Solicitações de
// Serviço, gravando no Supabase na chave que o painel de
// Solicitações de Serviço lê (painelSolicitacoes_data_v1).
//
// PREMISSA (definida pelo usuário): uma solicitação é considerada
// "atendida" no momento em que uma Ordem de Serviço é aberta
// atrelada a ela (campo idOrdemServico preenchido) — não precisa a
// OS estar encerrada. As duas médias de tempo pedidas usam sempre a
// data de ABERTURA da solicitação como referência:
//   - tempo de atendimento = dataAbertura da OS vinculada − dataAbertura da solicitação
//   - tempo de encerramento = dataEncerramento da OS vinculada − dataAbertura da solicitação
//
// A lista de solicitações (SolicitacaoServico/GetGridAll) não traz as
// datas da OS vinculada, só o id dela — por isso, para cada
// solicitação atendida cujas datas da OS ainda não conhecemos (ou
// cuja OS ainda estava aberta na última sincronização, podendo ter
// fechado desde então), buscamos a OS individualmente
// (OrdemServico/Get?Id=...) e guardamos o resultado. Uma vez que a
// OS aparece com dataEncerramento preenchida, ela nunca mais precisa
// ser rebuscada (não muda mais) — isso mantém as execuções de hora
// em hora rápidas mesmo com o histórico do ciclo inteiro.
//
// HISTÓRICO DO CICLO: mesma estratégia das outras sincronizações do
// Melvin/Evocon. Na primeira execução (ou com ?full=1 na URL) busca
// tudo desde CYCLE_START. Nas execuções seguintes busca só uma
// janela recente (REFRESH_DAYS) e mescla com o histórico já salvo.
//
// SEGREDOS: usa os mesmos MELVIN_USERNAME / MELVIN_PASSWORD já
// cadastrados para a sincronização de Programação (secrets são do
// projeto inteiro, não por função — não precisa cadastrar de novo).
//
// PLANTA: a lista simples (SolicitacaoServico/GetAll) não traz o setor
// de forma utilizável (idSetor da solicitação vem sempre zerado, e
// resolver pelo setor do equipamento trouxe outra coisa — códigos
// internos tipo "MTZ-ADM", não as plantas). A tela de Solicitações do
// próprio Melvin usa outro endpoint para popular a grade
// (SolicitacaoServico/GetGridAll), cujo retorno já vem com o setor
// pronto em texto (setorDescricao, ex.: "PLANTA 01") — confirmado
// comparando com o print da tela do usuário. Por isso a busca da
// lista inteira trocou de GetAll para GetGridAll.
// ============================================================

const STORAGE_KEY = "painelSolicitacoes_data_v1";
const MELVIN_BASE = "https://api-novo.oimelvin.com.br";
const CYCLE_START = "2026-07-01"; // início do ciclo 26/27 (mesmo dos outros painéis)
const REFRESH_DAYS = 45;
const PAGE_SIZE = 500;
const OS_LOOKUP_CONCURRENCY = 6; // nº de buscas de OS individual em paralelo

// necessário pro botão "Sincronizar agora" do painel (chamado direto do navegador,
// cron via pg_net não precisa disso mas não atrapalha)
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function dIso(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseMelvinDate(v: unknown): Date | null {
  if (!v || typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (br) {
    const year = br[3].length < 4 ? 2000 + Number(br[3]) : Number(br[3]);
    return new Date(year, Number(br[2]) - 1, Number(br[1]), Number(br[4] || 0), Number(br[5] || 0), Number(br[6] || 0));
  }
  const iso = new Date(s);
  return isNaN(iso.getTime()) ? null : iso;
}
function toIsoOrNull(v: unknown): string | null {
  const d = parseMelvinDate(v);
  return d ? d.toISOString() : null;
}

async function authenticate(username: string, password: string): Promise<string> {
  const resp = await fetch(`${MELVIN_BASE}/api/TokenAuth/Authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userNameOrEmailAddress: username, password, rememberClient: false }),
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    throw new Error(`Falha ao autenticar no Melvin (${resp.status}): ${bodyText.slice(0, 300)}`);
  }
  const json = await resp.json();
  const token = json?.result?.accessToken;
  if (!token) throw new Error("Login no Melvin OK, mas a resposta não trouxe accessToken.");
  return token;
}

async function fetchSolicitacoes(token: string, start: string, end: string) {
  const items: any[] = [];
  let skip = 0;
  for (;;) {
    const params = new URLSearchParams({
      DataInicio: start,
      DataFim: end,
      SkipCount: String(skip),
      MaxResultCount: String(PAGE_SIZE),
    });
    const url = `${MELVIN_BASE}/api/services/app/SolicitacaoServico/GetGridAll?${params.toString()}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      throw new Error(`Melvin respondeu ${resp.status} em SolicitacaoServico/GetGridAll: ${bodyText.slice(0, 300)}`);
    }
    const page = await resp.json();
    const pageItems: any[] = page?.result?.items ?? [];
    items.push(...pageItems);
    const total = page?.result?.totalCount ?? pageItems.length;
    skip += PAGE_SIZE;
    if (skip >= total || pageItems.length === 0) break;
  }
  return items;
}

async function fetchOrdemServico(token: string, id: string) {
  const url = `${MELVIN_BASE}/api/services/app/OrdemServico/Get?Id=${encodeURIComponent(id)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const json = await resp.json();
  return json?.result ?? null;
}

// busca as OS's vinculadas em lotes paralelos (evita N chamadas sequenciais e não estoura o tempo da função)
async function fetchOrdensEmLotes(token: string, ids: string[]) {
  const byId = new Map<string, any>();
  for (let i = 0; i < ids.length; i += OS_LOOKUP_CONCURRENCY) {
    const batch = ids.slice(i, i + OS_LOOKUP_CONCURRENCY);
    const results = await Promise.all(batch.map((id) => fetchOrdemServico(token, id).catch(() => null)));
    batch.forEach((id, idx) => { if (results[idx]) byId.set(id, results[idx]); });
  }
  return byId;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  try {
    const username = Deno.env.get("MELVIN_USERNAME");
    const password = Deno.env.get("MELVIN_PASSWORD");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!username || !password) throw new Error("MELVIN_USERNAME / MELVIN_PASSWORD não configurados nos secrets do projeto.");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes (deveriam existir automaticamente).");

    const forceFull = new URL(req.url).searchParams.get("full") === "1";
    const sbHeaders = { "apikey": serviceRoleKey, "Authorization": `Bearer ${serviceRoleKey}` };

    let existing: any = null;
    const exResp = await fetch(`${supabaseUrl}/rest/v1/app_state?key=eq.${STORAGE_KEY}&select=data`, { headers: sbHeaders });
    if (exResp.ok) {
      const rows = await exResp.json();
      existing = rows?.[0]?.data ?? null;
    }
    const hasHistory = !!existing && Array.isArray(existing.records) && !!existing.coverageStart && existing.coverageStart <= CYCLE_START;
    const fullFetch = forceFull || !hasHistory;
    const existingById = new Map<string, any>((existing?.records ?? []).map((r: any) => [r.id, r]));

    const end = new Date();
    const refreshFrom = dIso(new Date(end.getTime() - REFRESH_DAYS * 86400000));
    const startTime = fullFetch ? CYCLE_START : (refreshFrom > CYCLE_START ? refreshFrom : CYCLE_START);
    const endTime = dIso(end);

    const token = await authenticate(username, password);
    const raw = await fetchSolicitacoes(token, startTime, endTime);

    // decide quais OS's vinculadas precisam ser (re)buscadas: novas, ou cujo encerramento ainda não conhecíamos
    const idsParaBuscar: string[] = [];
    raw.forEach((r) => {
      if (!r.idOrdemServico) return;
      const prev = existingById.get(r.id);
      if (!prev || !prev.osDataEncerramento) idsParaBuscar.push(r.idOrdemServico);
    });
    const osById = await fetchOrdensEmLotes(token, Array.from(new Set(idsParaBuscar)));

    const fetched = raw.map((r) => {
      const prev = existingById.get(r.id);
      const os = r.idOrdemServico ? osById.get(r.idOrdemServico) : null;
      const osDataAbertura = os ? toIsoOrNull(os.dataAbertura) : (prev ? prev.osDataAbertura ?? null : null);
      const osDataEncerramento = os ? toIsoOrNull(os.dataEncerramento) : (prev ? prev.osDataEncerramento ?? null : null);
      const codigoOrdemServicoDestino = os && os.codOrdem != null ? String(os.codOrdem) : (prev ? prev.codigoOrdemServicoDestino ?? "" : "");
      return {
        id: r.id,
        codigo: r.codigo ?? null,
        dataAbertura: toIsoOrNull(r.dataAbertura),
        status: r.status ?? null,
        statusTexto: r.statusTexto ?? "",
        arquivada: !!r.arquivada,
        idOrdemServico: r.idOrdemServico ?? null,
        codigoOrdemServicoDestino,
        osDataAbertura,
        osDataEncerramento,
        solicitante: r.solicitante ?? "",
        canalTexto: r.canalTexto ?? "",
        prioridade: r.descricaoPrioridade ?? "",
        equipamento: r.equipamentoTag || r.equipamentoDescricao || "",
        oficina: "",
        setor: r.setorDescricao ?? "", // pronto no próprio retorno do GetGridAll, sem precisar de lookup
        solicitacao: r.solicitacao ?? "",
      };
    });

    let records: any[];
    if (fullFetch) {
      records = fetched;
    } else {
      const fetchedIds = new Set(fetched.map((r) => r.id));
      const kept = (existing.records as any[]).filter((r) => !fetchedIds.has(r.id) && (r.dataAbertura || "") < startTime);
      records = kept.concat(fetched);
    }
    records = records.filter((r) => (r.dataAbertura || "") >= CYCLE_START);

    const data = { records, coverageStart: CYCLE_START };

    const upsertResp = await fetch(`${supabaseUrl}/rest/v1/app_state`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...sbHeaders,
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        key: STORAGE_KEY,
        data,
        file_name: "melvin-api",
        updated_at: new Date().toISOString(),
      }),
    });
    if (!upsertResp.ok) {
      const bodyText = await upsertResp.text().catch(() => "");
      throw new Error(`Falha ao gravar no Supabase (${upsertResp.status}): ${bodyText.slice(0, 300)}`);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        modo: fullFetch ? "completo (desde o início do ciclo)" : `incremental (últimos ${REFRESH_DAYS} dias)`,
        janelaBuscada: `${startTime} a ${endTime}`,
        solicitacoesRecebidas: raw.length,
        ordensConsultadas: idsParaBuscar.length,
        solicitacoesNoHistorico: records.length,
        solicitacoesComSetorResolvido: fetched.filter((r) => !!r.setor).length,
        amostraSetores: Array.from(new Set(fetched.map((r) => r.setor).filter(Boolean))).slice(0, 8),
        arquivadasRecebidas: raw.filter((r: any) => r.arquivada).length,
      }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e && (e as Error).message || e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
