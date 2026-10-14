// ============================================================
// Supabase Edge Function: sync-melvin-solicitacoes
// Busca Solicitações de Serviço através da API oficial de integração
// do Melvin (PowerBI/GetDadosIntegracao, mesmo endpoint usado por
// Programação e Preventivas -- ver sync-melvin-programacao pro
// histórico completo de por que migramos pra cá). Grava no Supabase
// na chave que o painel lê (painelSolicitacoes_data_v1).
//
// LIMITAÇÃO IMPORTANTE (confirmada pela própria Melvin na reunião de
// 2026-10-13, e por eles mesmos no retorno escrito): esse feed é
// centrado em Ordem de Serviço. Uma solicitação só aparece aqui
// quando já virou uma OS (campo Solicitacoes[] aninhado dentro da
// OS). Uma solicitação que AINDA NÃO virou OS ("pendente") ou que foi
// arquivada/descartada pelo planejador sem nunca virar OS
// ("arquivada") simplesmente não existe nesse feed -- a Melvin já
// está desenvolvendo uma API separada pra cobrir essa parte, sem
// prazo definido ainda.
//
// Por isso, esta sincronização só consegue preencher os estados
// "atendida" (OS aberta, ainda não encerrada) e "concluida" (OS
// encerrada) -- "pendente" e "arquivada" sempre vêm como zero daqui,
// NÃO porque não existam de verdade, mas porque não há como
// enxergá-las por este caminho. O painel mostra um aviso sobre isso
// (ver index.html, painel de Solicitações) pra não passar a
// impressão de que a fila de pendências está vazia.
// ============================================================

const STORAGE_KEY = "painelSolicitacoes_data_v1";
const INTEGRATION_URL = "https://api-novo.oimelvin.com.br/api/services/app/PowerBI/GetDadosIntegracao";
const CODIGO_INTEGRACAO = "e2a31022-86f6-412d-b9f5-ccd1f1d36cff";
const CYCLE_START = "2026-08-01"; // a Fertgrow só começou a usar o Melvin em agosto/2026
function hojeIso(): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDiasIso(iso: string, dias: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + dias);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const CYCLE_END = addDiasIso(hojeIso(), 120);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// setor "Manutenção de Equipamentos Móveis" não faz parte da gestão do PCM -- nenhuma ordem/solicitação
// desse setor deve aparecer em nenhum painel. O campo Setor da API vem VAZIO pra esse setor específico
// (confirmado comparando com a tela do Melvin, print da OS 619 -- bug/particularidade deles), então
// o filtro confiável é pelo meio da TAG do ativo (ex.: "MTZ-MEM-PC12", onde "MEM" é o código desse
// setor) -- o campo Setor entra só como reforço, caso um dia a API passe a preenchê-lo certo.
function normalizarTexto(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toUpperCase();
}
const SETOR_EXCLUIDO_NORMALIZADO = normalizarTexto("Manutenção de Equipamentos Moveis");
function ehSetorExcluido(r: any): boolean {
  const tag = r.TagAtivo || "";
  const partes = tag.split("-");
  if (partes.length >= 2 && partes[1] === "MEM") return true;
  const setor = r.Setor || "";
  return !!setor && normalizarTexto(setor).includes(SETOR_EXCLUIDO_NORMALIZADO);
}

function dateOnly(iso: string | null | undefined): string | null {
  if (!iso || typeof iso !== "string") return null;
  return iso.slice(0, 10);
}
function latestDataValidacao(acoes: any[] | undefined): string | null {
  if (!acoes || !acoes.length) return null;
  const datas = acoes.map((a) => a.DataValidacao).filter((d) => !!d).sort();
  return datas.length ? datas[datas.length - 1] : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes (deveriam existir automaticamente).");
    const sbHeaders = { "apikey": serviceRoleKey, "Authorization": `Bearer ${serviceRoleKey}` };

    const url = `${INTEGRATION_URL}?codigoIntegracao=${CODIGO_INTEGRACAO}&dataInicio=${CYCLE_START}&dataFim=${CYCLE_END}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      throw new Error(`Melvin respondeu ${resp.status} em PowerBI/GetDadosIntegracao: ${bodyText.slice(0, 300)}`);
    }
    const json = await resp.json();
    if (json.success === false) throw new Error(`Melvin retornou success=false: ${JSON.stringify(json).slice(0, 300)}`);
    const raw: any[] = (json.result ?? []).filter((r: any) => r.Solicitacoes && r.Solicitacoes.length && !ehSetorExcluido(r));

    const records: any[] = [];
    raw.forEach((r) => {
      const osDataEncerramento = latestDataValidacao(r.Acoes);
      (r.Solicitacoes as any[]).forEach((s, idx) => {
        records.push({
          id: `${r.Id}_${idx}`,
          codigo: s.NumeroSolicitacao ?? null,
          dataAbertura: dateOnly(s.DataSolicitacao),
          status: null,
          statusTexto: osDataEncerramento ? "Concluída" : "Atendida",
          arquivada: false, // nunca detectável por este feed -- ver comentário no topo do arquivo
          idOrdemServico: r.Id,
          codigoOrdemServicoDestino: r.Numero != null ? String(r.Numero) : "",
          osDataAbertura: dateOnly(r.DataAbertura),
          osDataEncerramento,
          solicitante: s.NomeSolicitante || "",
          canalTexto: "",
          prioridade: r.Prioridade || "",
          equipamento: r.TagAtivo || r.NomeAtivo || "",
          oficina: r.Oficina || "",
          setor: r.Setor || "",
          solicitacao: s.DescricaoSolicitacao || "",
        });
      });
    });
    const filtradas = records.filter((r) => r.dataAbertura && r.dataAbertura >= CYCLE_START);

    const data = { records: filtradas, coverageStart: CYCLE_START };

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
        file_name: "melvin-integracao-powerbi",
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
        fonte: "PowerBI/GetDadosIntegracao (API oficial Melvin) -- parcial: só atendida/concluída, ver aviso no painel",
        janelaBuscada: `${CYCLE_START} a ${CYCLE_END}`,
        ordensComSolicitacaoVinculada: raw.length,
        solicitacoesNoHistorico: filtradas.length,
        concluidas: filtradas.filter((r) => r.osDataEncerramento).length,
        atendidasAindaAbertas: filtradas.filter((r) => !r.osDataEncerramento).length,
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
