// ============================================================
// Supabase Edge Function: sync-melvin-programacao
// Autentica na API do Melvin (CMMS) e busca o relatório de
// cumprimento de programação, gravando no Supabase na mesma
// chave que o painel de Programação já lê (painelProgramacao_data_v1).
//
// Os nomes de campo do Melvin (dataCriada, dataProgramacao,
// dataExclusao, dataExecucao, dataEncerramento, codOrdem, tag,
// descricaoOs, descricaoEquipamento, executante) já são IDÊNTICOS
// às colunas da planilha que o painel lia até agora — a planilha
// era, na prática, um export deste mesmo relatório.
//
// HISTÓRICO DO CICLO: mesma estratégia da sincronização da Evocon
// (sync-evocon). Na primeira execução (ou com ?full=1 na URL) busca
// tudo desde CYCLE_START. Nas execuções seguintes busca só uma janela
// recente (REFRESH_DAYS) e mescla com o histórico já salvo.
//
// Como o relatório aceita filtro por data de programação OU por data
// de execução (mas não "OR" entre os dois ao mesmo tempo), a busca é
// feita em DUAS passadas — uma pela janela de dataProgramacao, outra
// pela janela de dataExecucao — e o resultado é mesclado por
// idOrdemServicoProgramacao (chave estável do relatório).
//
// SEGREDOS (Edge Functions > Manage secrets): MELVIN_USERNAME e
// MELVIN_PASSWORD (login do Melvin). Nunca escreva as credenciais
// neste arquivo. SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem
// automaticamente.
//
// Quando começar um novo ciclo, atualize CYCLE_START abaixo e rode
// uma vez com ?full=1 para refazer o histórico.
// ============================================================

const STORAGE_KEY = "painelProgramacao_data_v1";
const MELVIN_BASE = "https://api-novo.oimelvin.com.br";
const CYCLE_START = "2026-07-01"; // início do ciclo 26/27 (mesmo do painel de Disponibilidade)
const CYCLE_END = "2027-06-30";   // fim do ciclo — a janela de busca vai até aqui, não só até hoje,
                                   // senão OS programada pra uma data futura nunca é capturada (o
                                   // Melvin deixa programar com bastante antecedência)
const REFRESH_DAYS = 45;          // quanto do passado é reprocessado a cada execução incremental
const PAGE_SIZE = 500;

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

// o relatório do Melvin devolve as datas já formatadas (não em ISO): aceita
// "dd/MM/yyyy", "dd/MM/yyyy HH:mm[:ss]" e, por segurança, também ISO puro
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
// dataCriada / dataProgramacao / dataExclusao são guardadas só com a data (AAAA-MM-DD),
// igual ao que o upload de planilha já gravava
function toDateOnlyIso(v: unknown): string | null {
  const d = parseMelvinDate(v);
  return d ? dIso(d) : null;
}
// dataExecucao / dataEncerramento guardam data e hora (o painel usa a hora para
// decidir se a execução ainda está "no prazo" no mesmo dia)
function toDateTimeIso(v: unknown): string | null {
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

// busca paginada de uma janela de datas, filtrando por UM campo de data por vez
// (dataProgramacaoInicio/Fim OU dataExecucaoInicio/Fim), conforme o relatório aceita
async function fetchWindow(token: string, dateField: "programacao" | "execucao", start: string, end: string) {
  const items: any[] = [];
  let skip = 0;
  for (;;) {
    const params = new URLSearchParams({
      SkipCount: String(skip),
      MaxResultCount: String(PAGE_SIZE),
    });
    if (dateField === "programacao") {
      params.set("DataProgramacaoInicio", start);
      params.set("DataProgramacaoFim", end);
    } else {
      params.set("DataExecucaoInicio", start);
      params.set("DataExecucaoFim", end);
    }
    const url = `${MELVIN_BASE}/api/services/app/OrdemServicoProgramacao/GetRelCumprimentoProgramacao?${params.toString()}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      throw new Error(`Melvin respondeu ${resp.status} em GetRelCumprimentoProgramacao (${dateField}): ${bodyText.slice(0, 300)}`);
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  try {
    const username = Deno.env.get("MELVIN_USERNAME");
    const password = Deno.env.get("MELVIN_PASSWORD");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!username || !password) throw new Error("MELVIN_USERNAME / MELVIN_PASSWORD não configurados nos secrets da função.");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes (deveriam existir automaticamente).");

    const forceFull = new URL(req.url).searchParams.get("full") === "1";
    const sbHeaders = { "apikey": serviceRoleKey, "Authorization": `Bearer ${serviceRoleKey}` };

    // histórico já salvo (se houver)
    let existing: any = null;
    const exResp = await fetch(`${supabaseUrl}/rest/v1/app_state?key=eq.${STORAGE_KEY}&select=data`, { headers: sbHeaders });
    if (exResp.ok) {
      const rows = await exResp.json();
      existing = rows?.[0]?.data ?? null;
    }
    const hasHistory = !!existing && Array.isArray(existing.records) && !!existing.coverageStart && existing.coverageStart <= CYCLE_START;
    const fullFetch = forceFull || !hasHistory;

    const end = new Date();
    const refreshFrom = dIso(new Date(end.getTime() - REFRESH_DAYS * 86400000));
    const startTime = fullFetch ? CYCLE_START : (refreshFrom > CYCLE_START ? refreshFrom : CYCLE_START);
    // vai até o fim do ciclo, não só até hoje — uma OS pode ser programada com bastante
    // antecedência (dataProgramacao numa semana futura), e se a janela parasse em "hoje" essa OS
    // nunca seria buscada, ficando com "Programada no Melvin?" errado em outros painéis até o dia
    // em que a data programada finalmente chegasse
    const endTime = CYCLE_END;

    const token = await authenticate(username, password);

    // duas passadas (por dataProgramacao e por dataExecucao), mescladas por id — uma OS pode
    // ter sido programada dentro da janela mas só executada fora dela, ou vice-versa
    const [byProgramacao, byExecucao] = await Promise.all([
      fetchWindow(token, "programacao", startTime, endTime),
      fetchWindow(token, "execucao", startTime, endTime),
    ]);
    const rawById = new Map<string, any>();
    for (const r of [...byProgramacao, ...byExecucao]) {
      const id = r.idOrdemServicoProgramacao || r.idProgramacao || `cod-${r.codOrdem}`;
      rawById.set(id, r);
    }

    const fetched = Array.from(rawById.values()).map((r) => ({
      id: r.idOrdemServicoProgramacao || r.idProgramacao || `cod-${r.codOrdem}`,
      codOrdem: r.codOrdem ?? "",
      tag: r.tag ?? "",
      descricaoOs: r.descricaoOs ?? "",
      descricaoEquipamento: r.descricaoEquipamento ?? "",
      dataCriada: toDateOnlyIso(r.dataCriada),
      dataProgramacao: toDateOnlyIso(r.dataProgramacao),
      dataExclusao: toDateOnlyIso(r.dataExclusao),
      dataExecucao: toDateTimeIso(r.dataExecucao),
      dataEncerramento: toDateTimeIso(r.dataEncerramento),
      executante: r.executante ?? "",
    }));

    let records: any[];
    if (fullFetch) {
      records = fetched;
    } else {
      // mantém o histórico anterior à janela e troca só o que foi rebuscado (por id)
      const fetchedIds = new Set(fetched.map((r) => r.id));
      const kept = existing.records.filter((r: any) => !fetchedIds.has(r.id) && (r.dataProgramacao || "") < startTime && (r.dataExecucao || "") < startTime);
      records = kept.concat(fetched);
    }
    // "AAAA-MM-DD" comparado como string funciona porque tem largura fixa
    records = records.filter((r) => (r.dataProgramacao && r.dataProgramacao >= CYCLE_START) || (r.dataExecucao && r.dataExecucao >= CYCLE_START) || (!r.dataProgramacao && !r.dataExecucao));

    const data = { sheetName: "melvin-api", records, coverageStart: CYCLE_START };

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
        totalProgramacao: byProgramacao.length,
        totalExecucao: byExecucao.length,
        ordensNoHistorico: records.length,
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
