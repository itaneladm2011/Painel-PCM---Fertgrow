// ============================================================
// Supabase Edge Function: sync-melvin-solicitacoes
// Busca Solicitações de Serviço pela API oficial NOVA que a Melvin
// liberou em 2026-11-10 (suporte, Arthur), depois de um caso aberto
// pedindo especificamente esse dado: SolicitacaoServico/GetAll,
// autenticada com credencial de API (x-api-key-id/x-api-secret),
// módulo "solicitacoes" -- diferente da PowerBI/GetDadosIntegracao
// usada por Programação/Preventivas (essa aqui é centrada em
// SOLICITAÇÃO, não em Ordem de Serviço, então enxerga também as que
// ainda não viraram OS ("Em Aberto"/pendente) e as "Arquivada" --
// o gap que ficou faltando desde o bloqueio de 2026-10-08.
//
// NÃO migra Programação/Preventivas pra esse modelo de credencial
// (GetDadosIntegracao continua sendo usado por elas, por pedido
// explícito do usuário em 2026-11-10) -- essa function é só pra
// Solicitações, que não tinha nenhuma solução completa antes.
//
// SEGREDOS (Edge Functions > Manage secrets): MELVIN_BI_API_KEY_ID e
// MELVIN_BI_API_SECRET (credencial de produção, escopo "bi" -- o
// mesmo escopo libera SolicitacaoServico/GetAll, confirmado em
// 2026-11-10). SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem
// automaticamente.
//
// DATAS E NÚMERO DA OS VINCULADA: SolicitacaoServico/GetAll traz o id
// da OS gerada (idOrdemServico), mas NÃO as datas de abertura/
// encerramento -- e o campo que deveria trazer o número dela
// (codigoOrdemServicoDestino) vem sempre null nesse endpoint, mesmo
// com idOrdemServico preenchido (confirmado em várias solicitações
// reais já vinculadas a OS -- bug/particularidade do Melvin, não é
// falta de permissão). Em vez de chamar o Melvin de novo pra buscar
// cada OS individualmente (padrão antigo que causou o bloqueio de
// outubro), cruzamos com o histórico que a sincronização de
// Programação (sync-melvin-programacao) já salvou em
// painelProgramacao_data_v1 -- mesma fonte de dado (GetDadosIntegracao),
// já tem idOrdemServico + codOrdem (número) + dataCriada +
// dataEncerramento de toda OS do ciclo. Sem chamada extra ao Melvin.
// Se a OS vinculada ainda não apareceu nesse histórico (ex.: acabou
// de ser criada, antes da próxima sincronização de Programação
// rodar), fica sem número/data/descrição por enquanto -- aparece na
// sincronização seguinte, igual já acontecia antes. Mesmo cruzamento
// também resolve "descricaoOs" (texto da OS gerada, pro detalhe que
// o painel abre ao clicar na solicitação). "justificativaArquivar"
// vem direto do Melvin, sem precisar de cruzamento nenhum.
//
// SETOR: a lista (GetAll) não traz descrição de setor em texto, só
// o id (GUID) dentro de equipamento.idsetor. Por isso o "setor"
// exibido aqui é o código curto extraído do meio da TAG do ativo
// (ex.: "MTZ-PL01-EST" -> "PL01"), igual ao padrão já usado nos
// outros painéis (Disponibilidade, Programação) -- antes a versão
// pré-bloqueio mostrava texto completo ("PLANTA 01"), mas a API
// atual não devolve mais isso.
//
// Sem incremental/merge: a cada sincronização busca tudo nessa
// janela e substitui o histórico inteiro (mesma decisão tomada em
// sync-melvin-programacao) -- mais simples, sem risco de divergência,
// e o volume (centenas de solicitações) não justifica a
// complexidade de um merge incremental.
// ============================================================

const STORAGE_KEY = "painelSolicitacoes_data_v1";
const PROG_STORAGE_KEY = "painelProgramacao_data_v1";
const MELVIN_BI_BASE = "https://api-prod.oimelvin.com.br";
const CYCLE_START = "2026-08-01"; // a Fertgrow só começou a usar o Melvin em agosto/2026
const PAGE_SIZE = 100; // limite máximo aceito pela API (confirmado por tentativa: "O máximo por página é 100 registros")

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function dateOnly(iso: string | null | undefined): string | null {
  if (!iso || typeof iso !== "string") return null;
  return iso.slice(0, 10);
}

// código curto do setor a partir do meio da TAG (ex.: "MTZ-PL01-EST" -> "PL01"); ver comentário no topo
function setorDaTag(tag: string | null | undefined): string {
  const partes = (tag || "").split("-");
  return partes.length >= 2 ? partes[1] : "";
}
function ehSetorExcluido(tag: string | null | undefined): boolean {
  return setorDaTag(tag) === "MEM";
}

async function fetchTodasSolicitacoes(headers: Record<string, string>) {
  const items: any[] = [];
  let skip = 0;
  for (;;) {
    const url = `${MELVIN_BI_BASE}/api/services/app/SolicitacaoServico/GetAll?maxResultCount=${PAGE_SIZE}&skipCount=${skip}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      throw new Error(`Melvin respondeu ${resp.status} em SolicitacaoServico/GetAll: ${bodyText.slice(0, 300)}`);
    }
    const json = await resp.json();
    const pageItems: any[] = json?.result?.items ?? [];
    items.push(...pageItems);
    const total = json?.result?.totalCount ?? pageItems.length;
    skip += PAGE_SIZE;
    if (skip >= total || pageItems.length === 0) break;
  }
  return items;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  try {
    const apiKeyId = Deno.env.get("MELVIN_BI_API_KEY_ID");
    const apiSecret = Deno.env.get("MELVIN_BI_API_SECRET");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!apiKeyId || !apiSecret) throw new Error("MELVIN_BI_API_KEY_ID / MELVIN_BI_API_SECRET não configurados nos secrets do projeto.");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes (deveriam existir automaticamente).");
    const sbHeaders = { "apikey": serviceRoleKey, "Authorization": `Bearer ${serviceRoleKey}` };
    const melvinHeaders = { "x-api-key-id": apiKeyId, "x-api-secret": apiSecret };

    // histórico de Programação já sincronizado, pra resolver as datas da OS vinculada sem chamar o Melvin de novo
    const progResp = await fetch(`${supabaseUrl}/rest/v1/app_state?key=eq.${PROG_STORAGE_KEY}&select=data`, { headers: sbHeaders });
    const progRows = progResp.ok ? await progResp.json() : [];
    const progRecords: any[] = progRows?.[0]?.data?.records ?? [];
    const osById = new Map<string, { codOrdem: unknown; dataCriada: string | null; dataEncerramento: string | null; descricaoOs: string }>(
      progRecords.filter((r) => r.idOrdemServico).map((r) => [r.idOrdemServico, { codOrdem: r.codOrdem, dataCriada: r.dataCriada, dataEncerramento: r.dataEncerramento, descricaoOs: r.descricaoOs || "" }])
    );

    const raw = await fetchTodasSolicitacoes(melvinHeaders);

    const records = raw
      .filter((r) => !ehSetorExcluido(r.equipamento?.tag))
      .map((r) => {
        const os = r.idOrdemServico ? osById.get(r.idOrdemServico) : null;
        return {
          id: r.id,
          codigo: r.codigo ?? null,
          dataAbertura: dateOnly(r.dataAbertura),
          status: r.status ?? null,
          statusTexto: r.statusTexto || "",
          arquivada: !!r.arquivada,
          idOrdemServico: r.idOrdemServico ?? null,
          // "codigoOrdemServicoDestino" da API vem sempre null (ver comentário no topo) -- o número de
          // verdade vem do cruzamento com Programação; só cai pro campo cru se ainda não tiver cruzamento
          codigoOrdemServicoDestino: os?.codOrdem != null ? String(os.codOrdem) : (r.codigoOrdemServicoDestino != null ? String(r.codigoOrdemServicoDestino) : ""),
          osDataAbertura: os?.dataCriada ?? null,
          osDataEncerramento: os?.dataEncerramento ?? null,
          descricaoOs: os?.descricaoOs || "",
          justificativaArquivar: r.justificativaArquivar || "",
          solicitante: r.solicitante || "",
          canalTexto: r.canalTexto || "",
          prioridade: r.prioridade?.descricao || "",
          equipamento: r.equipamento?.tag || r.equipamento?.descricao || "",
          oficina: r.oficina || "",
          setor: setorDaTag(r.equipamento?.tag),
          solicitacao: r.solicitacao || "",
        };
      })
      .filter((r) => r.dataAbertura && r.dataAbertura >= CYCLE_START);

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
        file_name: "melvin-api-solicitacaoservico",
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
        fonte: "SolicitacaoServico/GetAll (API oficial Melvin, credencial própria)",
        solicitacoesRecebidas: raw.length,
        solicitacoesNoHistorico: records.length,
        pendentes: records.filter((r) => !r.idOrdemServico && !r.arquivada).length,
        atendidas: records.filter((r) => r.idOrdemServico && !r.osDataEncerramento).length,
        concluidas: records.filter((r) => r.osDataEncerramento).length,
        arquivadas: records.filter((r) => r.arquivada && !r.idOrdemServico).length,
        datasDeOsResolvidasPeloCruzamento: records.filter((r) => r.idOrdemServico && r.osDataAbertura).length,
        numerosDeOsResolvidos: records.filter((r) => r.idOrdemServico && r.codigoOrdemServicoDestino).length,
      }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message || e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
});
