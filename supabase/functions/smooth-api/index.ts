// ============================================================
// Supabase Edge Function: sync-melvin-preventivas
// Autentica na API do Melvin (CMMS) e busca o histórico de geração
// das preventivas (FMP — Ficha de Manutenção Preventiva), para
// alimentar o Mapa de 52 Semanas. Grava no Supabase na chave que o
// painel lê (painelPreventivas_data_v1).
//
// COMO FUNCIONA A GERAÇÃO DE PREVENTIVAS NO MELVIN: cada plano (FMP)
// tem uma periodicidade (ex.: a cada 30 dias) e, a cada ciclo, o
// Melvin gera automaticamente uma ocorrência prevista com uma data
// esperada (dataExecucao) e, quando dá certo, a Ordem de Serviço
// correspondente (idOrdemServico/codOrdem). O endpoint
// Fmp/GetHistoricoGeracao devolve esse histórico, um item por
// ocorrência prevista, já com os dados do plano (tagFmp, idFmp,
// idEquipamento) aninhados em "fmpGeracao".
//
// Esse histórico NÃO diz se a OS foi realmente concluída — só que
// foi gerada. Por isso, para cada ocorrência com idOrdemServico,
// buscamos a OS individualmente (mesmo padrão já usado na
// sincronização de Solicitações) para saber a dataEncerramento. Uma
// vez que uma OS aparece encerrada, não precisa ser rebuscada de
// novo — mantém as execuções de hora em hora rápidas mesmo com o
// ciclo inteiro de histórico.
//
// PREMISSA (mesma já usada em Programação): uma ocorrência cujo
// prazo (dataExecucao) ainda não passou não é "atrasada" — só depois
// que a semana dela já fechou é que conta como atraso se a OS não
// tiver sido encerrada.
//
// HISTÓRICO DO CICLO: mesma estratégia das outras sincronizações do
// Melvin/Evocon. Na primeira execução (ou com ?full=1 na URL) busca
// tudo desde CYCLE_START. Nas execuções seguintes busca só uma
// janela recente (REFRESH_DAYS) e mescla com o histórico já salvo.
//
// LIMITE DE 30 DIAS: diferente dos outros endpoints do Melvin já
// usados neste painel, o Fmp/GetHistoricoGeracao recusa (422) uma
// janela maior que 30 dias. Por isso a busca é sempre fatiada em
// blocos de até 28 dias (fetchHistoricoGeracao), mesmo na primeira
// carga do ciclo inteiro.
//
// SEGREDOS: usa os mesmos MELVIN_USERNAME / MELVIN_PASSWORD já
// cadastrados para as outras sincronizações do Melvin (secrets são
// do projeto inteiro, não por função — não precisa cadastrar de novo).
//
// OCORRÊNCIAS FUTURAS PROJETADAS: o Melvin só gera a OS de uma
// preventiva perto da data (não o ciclo inteiro adiantado), então o
// histórico sozinho deixa a maior parte do mapa sem nada previsto
// além do curto prazo. Por isso, para cada plano (FMP) que aparece no
// histórico, também buscamos Fmp/GetById (dataExecucaoProximaOS +
// periodicidade.dia) e projetamos as próximas datas até CYCLE_END,
// marcadas com "projetado: true" — o painel mostra essas em azul mais
// claro ("estimativa"), diferente do azul das já confirmadas pelo
// Melvin.
//
// PLANO DIÁRIO × FIM DE SEMANA: um plano com periodicidade de 1 dia
// não tem execução esperada aos sábados/domingos (ninguém faz a rotina
// no fim de semana). Ocorrências (reais ou projetadas) que caiam nesses
// dias são descartadas antes de gravar, senão viram "atrasada" pra
// sempre (nunca vai existir OS fechando um sábado/domingo).
//
// DUPLICAÇÃO DE GERAÇÃO: confirmado com o planejador — quando alguém
// antecipa manualmente a geração da OS de uma preventiva, o Melvin não
// cancela a geração automática, e no dia certo gera outra ocorrência
// pro mesmo plano+equipamento+data. Sem tratar isso, a mesma pendência
// contava 2x nas "atrasadas" do mapa. dedupOcorrenciasDoMesmoDia junta
// essas duplicatas, preferindo a que já tiver OS vinculada.
// ============================================================

const STORAGE_KEY = "painelPreventivas_data_v1";
const MELVIN_BASE = "https://api-novo.oimelvin.com.br";
const CYCLE_START = "2026-07-01"; // início do ciclo 26/27 (mesmo dos outros painéis)
const CYCLE_END = "2027-06-30";   // fim do ciclo — o mapa mostra o ciclo inteiro (52 semanas), incluindo datas já previstas no futuro
const REFRESH_DAYS = 45;
const PAGE_SIZE = 500;
const OS_LOOKUP_CONCURRENCY = 6;

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

// esse endpoint específico não aceita janela maior que 30 dias ("O período não pode exceder 30
// dias") — diferente dos outros do Melvin que já integramos. Por isso a busca de um período maior
// (ciclo inteiro, ou até os REFRESH_DAYS do modo incremental) é fatiada em blocos de até 28 dias.
async function fetchHistoricoGeracaoJanela(token: string, start: string, end: string) {
  const items: any[] = [];
  let skip = 0;
  for (;;) {
    const params = new URLSearchParams({
      DataInicio: start,
      DataFim: end,
      SkipCount: String(skip),
      MaxResultCount: String(PAGE_SIZE),
    });
    const url = `${MELVIN_BASE}/api/services/app/Fmp/GetHistoricoGeracao?${params.toString()}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      throw new Error(`Melvin respondeu ${resp.status} em Fmp/GetHistoricoGeracao (${start} a ${end}): ${bodyText.slice(0, 300)}`);
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

async function fetchHistoricoGeracao(token: string, start: string, end: string) {
  const CHUNK_DAYS = 28;
  const items: any[] = [];
  let chunkStart = new Date(start + "T00:00:00");
  const endDate = new Date(end + "T00:00:00");
  while (chunkStart <= endDate) {
    const chunkEndMs = Math.min(chunkStart.getTime() + (CHUNK_DAYS - 1) * 86400000, endDate.getTime());
    const chunkEnd = new Date(chunkEndMs);
    const chunkItems = await fetchHistoricoGeracaoJanela(token, dIso(chunkStart), dIso(chunkEnd));
    items.push(...chunkItems);
    chunkStart = new Date(chunkEnd.getTime() + 86400000);
  }
  return items;
}

// busca completa (paginada) do cadastro de equipamentos — permite resolver a tag/descrição de
// TODA ocorrência (mesmo as futuras, sem OS gerada ainda), em vez de depender de uma OS já aberta
// já ter vindo com o campo "equipamentos" preenchido.
async function fetchEquipamentos(token: string) {
  const byId = new Map<string, { tag: string; descricao: string }>();
  let skip = 0;
  for (;;) {
    const params = new URLSearchParams({
      SkipCount: String(skip),
      MaxResultCount: String(PAGE_SIZE),
    });
    const url = `${MELVIN_BASE}/api/services/app/Equipamento/GetAll?${params.toString()}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      throw new Error(`Melvin respondeu ${resp.status} em Equipamento/GetAll: ${bodyText.slice(0, 300)}`);
    }
    const page = await resp.json();
    const items: any[] = page?.result?.items ?? [];
    items.forEach((it) => {
      if (it?.id) byId.set(it.id, { tag: it.tag ?? "", descricao: it.descricao ?? "" });
    });
    const total = page?.result?.totalCount ?? items.length;
    skip += PAGE_SIZE;
    if (skip >= total || items.length === 0) break;
  }
  return byId;
}

async function fetchOrdemServico(token: string, id: string) {
  const url = `${MELVIN_BASE}/api/services/app/OrdemServico/Get?Id=${encodeURIComponent(id)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const json = await resp.json();
  return json?.result ?? null;
}

async function fetchOrdensEmLotes(token: string, ids: string[]) {
  const byId = new Map<string, any>();
  for (let i = 0; i < ids.length; i += OS_LOOKUP_CONCURRENCY) {
    const batch = ids.slice(i, i + OS_LOOKUP_CONCURRENCY);
    const results = await Promise.all(batch.map((id) => fetchOrdemServico(token, id).catch(() => null)));
    batch.forEach((id, idx) => { if (results[idx]) byId.set(id, results[idx]); });
  }
  return byId;
}

// O Melvin só gera a OS de uma preventiva perto da data (não o ciclo inteiro adiantado), então
// Fmp/GetHistoricoGeracao sozinho deixa a maioria das linhas do mapa sem nenhuma ocorrência futura.
// Fmp/GetById traz "dataExecucaoProximaOS" (a próxima data que o próprio Melvin já calculou pra esse
// plano) e "periodicidade.dia" (intervalo em dias) — usamos os dois pra PROJETAR as próximas
// ocorrências até o fim do ciclo, plano por plano.
async function fetchFmp(token: string, id: string) {
  const url = `${MELVIN_BASE}/api/services/app/Fmp/GetById?Id=${encodeURIComponent(id)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const json = await resp.json();
  return json?.result ?? null;
}

async function fetchFmpsEmLotes(token: string, ids: string[]) {
  const byId = new Map<string, any>();
  for (let i = 0; i < ids.length; i += OS_LOOKUP_CONCURRENCY) {
    const batch = ids.slice(i, i + OS_LOOKUP_CONCURRENCY);
    const results = await Promise.all(batch.map((id) => fetchFmp(token, id).catch(() => null)));
    batch.forEach((id, idx) => { if (results[idx]) byId.set(id, results[idx]); });
  }
  return byId;
}

// Fmp/GetById NÃO devolve o objeto "periodicidade" aninhado preenchido (vem null, apesar do Swagger
// documentar o campo) — só o "idPeriodicidade" (uma referência). O intervalo em dias precisa ser
// resolvido à parte, na tabela de periodicidades (lista fixa pequena, sem paginação).
async function fetchPeriodicidades(token: string) {
  const byId = new Map<string, { dia: number; descricao: string }>();
  const url = `${MELVIN_BASE}/api/services/app/Periodicidade/GetPeriodicidades`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    throw new Error(`Melvin respondeu ${resp.status} em Periodicidade/GetPeriodicidades: ${bodyText.slice(0, 300)}`);
  }
  const json = await resp.json();
  const items: any[] = json?.result?.items ?? [];
  items.forEach((it) => {
    if (it?.id) byId.set(it.id, { dia: Number(it.dia) || 0, descricao: it.descricao ?? "" });
  });
  return byId;
}

// o Melvin às vezes gera DUAS ocorrências reais para o mesmo plano+equipamento na mesma data —
// confirmado pelo planejador: quando alguém antecipa a geração manual de uma OS, o Melvin não
// cancela a geração automática, e no dia certo gera de novo (duplicando). Sem isso, a mesma
// pendência contaria 2x nas "atrasadas" do mapa. Mantém a que tiver OS vinculada, se alguma tiver.
function dedupOcorrenciasDoMesmoDia(records: any[]) {
  const byKey = new Map<string, any>();
  let soloIdx = 0;
  for (const r of records) {
    if (!r.idFmp || !r.idEquipamento || !r.dataExecucaoPrevista) {
      byKey.set(`solo-${soloIdx++}`, r); // sem par completo pra comparar — mantém como está
      continue;
    }
    const chave = `${r.idFmp}|${r.idEquipamento}|${String(r.dataExecucaoPrevista).slice(0, 10)}`;
    const atual = byKey.get(chave);
    if (!atual) { byKey.set(chave, r); continue; }
    if (r.idOrdemServico && !atual.idOrdemServico) byKey.set(chave, r); // prefere a que já tem OS
  }
  return Array.from(byKey.values());
}

// gera as ocorrências futuras de um PAR plano+equipamento (a partir da última ocorrência real
// conhecida DESSE par, ou de dataExecucaoProximaOS quando o plano é de equipamento único e ainda
// não tem nenhuma ocorrência real) até CYCLE_END, pulando qualquer data já coberta por uma
// ocorrência real do Melvin pra não duplicar a célula no mapa.
//
// IMPORTANTE: projeta por PAR (idFmp + idEquipamento), não só por idFmp — um plano tipo "rota"
// (indRota) se aplica a vários equipamentos, cada um com sua própria agenda, e o campo
// idEquipamento do Fmp/GetById vem vazio nesse caso (só existe no nível de cada ocorrência real,
// em fmpGeracao.idEquipamento). Projetar por par também garante que a tag do equipamento seja
// resolvida do mesmo jeito confiável já usado nas ocorrências reais (via Equipamento/GetAll).
function projetarOcorrenciasDoPar(fmp: any, idFmp: string, idEquipamento: string, equip: { tag: string; descricao: string } | undefined, periodicidadesById: Map<string, { dia: number; descricao: string }>, datasReais: Set<string>, todayIso: string, cycleEndDate: Date) {
  if (fmp?.isActive === false) return []; // plano cadastrado mas ainda não iniciado — não vai gerar OS de verdade
  const periodDias = fmp?.periodicidade?.dia || (fmp?.idPeriodicidade ? periodicidadesById.get(fmp.idPeriodicidade)?.dia : null);
  if (!periodDias || periodDias <= 0) return [];
  let anchorIso: string | null = null;
  const ultimaReal = Array.from(datasReais).sort().pop();
  if (ultimaReal) {
    anchorIso = dIso(new Date(new Date(ultimaReal + "T00:00:00").getTime() + periodDias * 86400000));
  } else if (fmp.idEquipamento === idEquipamento && fmp.dataExecucaoProximaOS) {
    // só confia em dataExecucaoProximaOS (que é do plano, não do par) quando o plano realmente é
    // de equipamento único e bate com esse par — evita atribuir a data errada num plano de rota
    anchorIso = toIsoOrNull(fmp.dataExecucaoProximaOS);
  }
  if (!anchorIso) return [];
  // plano diário (periodicidade de 1 dia) não espera execução aos sábados/domingos — pula esses
  // dias tanto aqui (projeção futura) quanto no filtro de ocorrências reais logo abaixo, no handler
  const diario = periodDias === 1;
  const out: any[] = [];
  let cursor = new Date(anchorIso.slice(0, 10) + "T00:00:00");
  let guard = 0;
  while (cursor <= cycleEndDate && guard < 400) {
    const cursorIso = dIso(cursor);
    const fimDeSemana = diario && (cursor.getDay() === 0 || cursor.getDay() === 6);
    if (cursorIso >= todayIso && !fimDeSemana && !datasReais.has(cursorIso)) {
      out.push({
        id: `proj-${idFmp}-${idEquipamento}-${cursorIso}`,
        idFmp,
        tagFmp: fmp.tagFmp ?? "",
        descricaoFmp: fmp.descricaoOS || fmp.tagFmp || "",
        idEquipamento,
        equipamentoTag: equip?.tag || "",
        equipamentoDescricao: equip?.descricao || "",
        dataExecucaoPrevista: cursor.toISOString(),
        idOrdemServico: null,
        codOrdem: null,
        osDataAbertura: null,
        osDataEncerramento: null,
        projetado: true,
        periodDiasResolvido: periodDias,
      });
    }
    cursor = new Date(cursor.getTime() + periodDias * 86400000);
    guard++;
  }
  return out;
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

    // o mapa mostra o ciclo inteiro, incluindo datas já previstas no futuro (não só o passado/mês
    // atual) — por isso a busca completa vai até CYCLE_END, e a incremental também olha um pouco
    // pra frente (pega ocorrências novas que a Melvin acabou de gerar), não só pra trás
    const today = new Date();
    const refreshFrom = dIso(new Date(today.getTime() - REFRESH_DAYS * 86400000));
    const refreshTo = dIso(new Date(today.getTime() + REFRESH_DAYS * 86400000));
    const startTime = fullFetch ? CYCLE_START : (refreshFrom > CYCLE_START ? refreshFrom : CYCLE_START);
    const endTime = fullFetch ? CYCLE_END : (refreshTo < CYCLE_END ? refreshTo : CYCLE_END);

    const token = await authenticate(username, password);
    const raw = await fetchHistoricoGeracao(token, startTime, endTime);
    const equipamentosById = await fetchEquipamentos(token);

    const idsParaBuscar: string[] = [];
    raw.forEach((r) => {
      if (!r.idOrdemServico) return;
      const prev = existingById.get(r.id);
      // encerrada ou cancelada é estado terminal — não muda mais, não precisa reconsultar
      if (!prev || (!prev.osDataEncerramento && !prev.osDataExclusao)) idsParaBuscar.push(r.idOrdemServico);
    });
    const osById = await fetchOrdensEmLotes(token, Array.from(new Set(idsParaBuscar)));

    const fetched = raw.map((r) => {
      const prev = existingById.get(r.id);
      const os = r.idOrdemServico ? osById.get(r.idOrdemServico) : null;
      const osDataAbertura = os ? toIsoOrNull(os.dataAbertura) : (prev ? prev.osDataAbertura ?? null : null);
      const osDataEncerramento = os ? toIsoOrNull(os.dataEncerramento) : (prev ? prev.osDataEncerramento ?? null : null);
      // campo confirmado via inspeção direta da resposta de OrdemServico/Get (diferente do
      // "dataExclusao" usado no relatório de Programação — essa API usa outro nome aqui:
      // dataCancelada + indCancelada:true + statusTexto:"Cancelada"). Uma preventiva com OS
      // cancelada não deveria contar como atrasada (a pendência em si foi cancelada, não ficou pra trás)
      const osDataExclusao = os ? toIsoOrNull(os.dataCancelada) : (prev ? prev.osDataExclusao ?? null : null);
      // o campo "dataExecucao" do item do histórico (Fmp/GetHistoricoGeracao, usado abaixo como
      // fallback) reflete quando aquela ocorrência foi GERADA, não o prazo real da OS — confirmado
      // comparando com a tela do Melvin: uma OS aberta hoje mas com prazo pra daqui a 2 semanas
      // aparecia como "atrasada hoje" porque usávamos a data de geração em vez do prazo. Quando a OS
      // já existe, o prazo de verdade é o campo "prazoMaximo" do objeto da OS (OrdemServico/Get) —
      // o mesmo que a coluna "Prazo" mostra na tela de Ordens de Serviço do Melvin.
      const osPrazoMaximo = os ? toIsoOrNull(os.prazoMaximo) : (prev ? prev.osPrazoMaximo ?? null : null);
      const fg = r.fmpGeracao ?? {};
      // resolvido via cadastro completo de equipamentos (Equipamento/GetAll) — funciona pra TODA
      // ocorrência, inclusive futura/sem OS gerada ainda, diferente da tentativa anterior que só
      // achava a tag quando uma OS já resolvida trazia o campo "equipamentos" preenchido.
      const equip = fg.idEquipamento ? equipamentosById.get(fg.idEquipamento) : null;
      const equipamentoTag = equip?.tag || (prev ? prev.equipamentoTag ?? "" : "");
      const equipamentoDescricao = equip?.descricao || (prev ? prev.equipamentoDescricao ?? "" : "");
      return {
        id: r.id,
        idFmp: fg.idFmp ?? null,
        tagFmp: fg.tagFmp ?? "",
        descricaoFmp: fg.descricao ?? "",
        idEquipamento: fg.idEquipamento ?? null,
        equipamentoTag,
        equipamentoDescricao,
        // prioriza o prazo real da OS (prazoMaximo) quando ela já existe; só cai pro campo do
        // histórico de geração (menos confiável, às vezes reflete a data de geração) quando a OS
        // ainda não foi gerada
        dataExecucaoPrevista: osPrazoMaximo || toIsoOrNull(r.dataExecucao),
        idOrdemServico: r.idOrdemServico ?? null,
        codOrdem: r.codOrdem ?? null,
        osDataAbertura,
        osDataEncerramento,
        osDataExclusao,
        osPrazoMaximo,
      };
    });

    let records: any[];
    if (fullFetch) {
      records = fetched;
    } else {
      const fetchedIds = new Set(fetched.map((r) => r.id));
      const kept = (existing.records as any[]).filter((r) => !fetchedIds.has(r.id) && (r.dataExecucaoPrevista || "") < startTime);
      records = kept.concat(fetched);
    }
    records = records.filter((r) => (r.dataExecucaoPrevista || "") >= CYCLE_START);
    const totalAntesDedup = records.length;
    records = dedupOcorrenciasDoMesmoDia(records);
    const duplicatasRemovidas = totalAntesDedup - records.length;

    // projeta as próximas ocorrências de cada plano até o fim do ciclo, com base na periodicidade
    // cadastrada — o histórico do Melvin sozinho só traz o que ele já gerou (normalmente perto da
    // data), deixando o resto do mapa vazio
    const idsFmpParaBuscar = Array.from(new Set(records.map((r: any) => r.idFmp).filter(Boolean)));
    const fmpById = await fetchFmpsEmLotes(token, idsFmpParaBuscar);
    const periodicidadesById = await fetchPeriodicidades(token);
    const todayIso = dIso(new Date());
    const cycleEndDate = new Date(CYCLE_END + "T00:00:00");

    // plano diário (periodicidade de 1 dia) não espera execução aos sábados/domingos — uma
    // ocorrência real do Melvin caindo nesses dias é ruído (ninguém faz a rotina no fim de semana)
    // e, sem OS, nunca vai ser fechada, inflando artificialmente as "atrasadas" do mapa
    const registrosDescartadosFimDeSemana = { count: 0 };
    // periodDiasResolvido fica gravado no registro (diagnóstico) — assim dá pra conferir direto no
    // painel qual periodicidade foi resolvida pra cada plano, sem precisar adivinhar.
    // planoAtivo (Fmp.isActive) identifica plano cadastrado mas ainda não iniciado (aguardando
    // definições do planejador) — o Fmp/GetHistoricoGeracao ainda calcula uma data prevista pra
    // esses planos mesmo sem eles estarem rodando de verdade, o que inflava as "atrasadas" com
    // ocorrências que o Melvin nunca teria gerado OS de qualquer forma.
    records = records.map((r: any) => {
      if (!r.idFmp) return { ...r, periodDiasResolvido: null, planoAtivo: null, planejaOsAutomaticamente: null, fmpDataInicio: null };
      const fmp = fmpById.get(r.idFmp);
      const periodDias = fmp?.periodicidade?.dia || (fmp?.idPeriodicidade ? periodicidadesById.get(fmp.idPeriodicidade)?.dia : null);
      return {
        ...r,
        periodDiasResolvido: periodDias ?? null,
        planoAtivo: fmp ? !!fmp.isActive : null,
        // plano pode estar ativo mas configurado pra NÃO gerar OS sozinho — exige disparo manual
        // do planejador a cada ciclo. Testando se isso explica as atrasadas-sem-OS de plano ativo.
        planejaOsAutomaticamente: fmp ? !!fmp.planejarOsAutomaticamente : null,
        // "Início do Plano" na ficha do Melvin — quando o planejador reinicia um plano (nova
        // periodicidade, novo ciclo de controle), essa data avança. Ocorrências do histórico
        // anteriores a ela pertencem à configuração ANTERIOR do plano: o Melvin não mantém o
        // vínculo com a OS pra elas (idOrdemServico vem null mesmo quando a OS existe e já foi
        // encerrada), o que as fazia aparecer como "atrasada sem OS" pra sempre, por engano.
        fmpDataInicio: fmp ? toIsoOrNull(fmp.dataInicio) : null,
      };
    });
    records = records.filter((r: any) => {
      if (!r.dataExecucaoPrevista || r.periodDiasResolvido !== 1) return true;
      const dow = new Date(String(r.dataExecucaoPrevista).slice(0, 10) + "T00:00:00").getDay();
      const fimDeSemana = dow === 0 || dow === 6;
      if (fimDeSemana) registrosDescartadosFimDeSemana.count++;
      return !fimDeSemana;
    });
    const registrosDescartadosPreReinicio = { count: 0 };
    records = records.filter((r: any) => {
      // só descarta quando a ocorrência JÁ tem um desfecho ambíguo (sem OS vinculada e sem
      // encerramento) — se já tem OS vinculada normalmente, mantém o registro de qualquer forma
      if (r.idOrdemServico || !r.fmpDataInicio || !r.dataExecucaoPrevista) return true;
      const ehAnteriorAoReinicio = String(r.dataExecucaoPrevista).slice(0, 10) < String(r.fmpDataInicio).slice(0, 10);
      if (ehAnteriorAoReinicio) registrosDescartadosPreReinicio.count++;
      return !ehAnteriorAoReinicio;
    });

    // pares (plano, equipamento) observados nas ocorrências REAIS — não usa o idEquipamento do
    // Fmp/GetById porque plano de rota (indRota) deixa esse campo vazio no nível do plano
    const paresReais = new Map<string, { idFmp: string; idEquipamento: string; datas: Set<string> }>();
    records.forEach((r: any) => {
      if (!r.idFmp || !r.idEquipamento || !r.dataExecucaoPrevista) return;
      const chave = `${r.idFmp}|${r.idEquipamento}`;
      if (!paresReais.has(chave)) paresReais.set(chave, { idFmp: r.idFmp, idEquipamento: r.idEquipamento, datas: new Set() });
      paresReais.get(chave)!.datas.add(String(r.dataExecucaoPrevista).slice(0, 10));
    });
    const projetadas: any[] = [];
    paresReais.forEach(({ idFmp, idEquipamento, datas }) => {
      const fmp = fmpById.get(idFmp);
      if (!fmp) return;
      const equip = equipamentosById.get(idEquipamento);
      projetadas.push(...projetarOcorrenciasDoPar(fmp, idFmp, idEquipamento, equip, periodicidadesById, datas, todayIso, cycleEndDate));
    });
    records = records.concat(projetadas);

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

    const planosUnicos = new Set(records.map((r) => r.idFmp).filter(Boolean));
    const equipamentosUnicos = new Set(records.map((r) => r.idEquipamento).filter(Boolean));
    const semTag = records.filter((r) => !r.equipamentoTag).length;
    return new Response(
      JSON.stringify({
        ok: true,
        modo: fullFetch ? "completo (desde o início do ciclo)" : `incremental (últimos ${REFRESH_DAYS} dias)`,
        janelaBuscada: `${startTime} a ${endTime}`,
        ocorrenciasRecebidas: raw.length,
        ordensConsultadas: idsParaBuscar.length,
        duplicatasDoMesmoDiaRemovidas: duplicatasRemovidas,
        ocorrenciasNoHistorico: records.length,
        planosUnicos: planosUnicos.size,
        equipamentosCadastrados: equipamentosById.size,
        equipamentosUnicosNoHistorico: equipamentosUnicos.size,
        ocorrenciasSemTagResolvida: semTag,
        ocorrenciasDescartadasFimDeSemana: registrosDescartadosFimDeSemana.count,
        ocorrenciasDescartadasPreReinicioDoPlano: registrosDescartadosPreReinicio.count,
        planosComPeriodicidadeResolvida: fmpById.size,
        ocorrenciasProjetadas: projetadas.length,
        amostraPlanos: Array.from(new Set(records.map((r) => r.tagFmp).filter(Boolean))).slice(0, 8),
        paresProjetados: paresReais.size,
      }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e && (e as Error).message || e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
});
