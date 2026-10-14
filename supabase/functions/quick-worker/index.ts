// ============================================================
// Supabase Edge Function: sync-melvin-programacao
// Busca os dados de Ordens de Serviço no Melvin através da API
// oficial de integração (PowerBI/GetDadosIntegracao, liberada pela
// Melvin especificamente pra Fertgrow em 2026-10 após o bloqueio dos
// endpoints internos que a gente usava antes -- ver histórico desta
// função no git pra referência do que mudou e por quê).
//
// Essa API devolve, numa chamada só, TODAS as ordens de serviço do
// período com tudo embutido (datas de programação, ações de
// conclusão, apontamentos de hora, plano de preventiva vinculado) --
// não precisa mais autenticar com usuário/senha nem buscar cada OS
// individualmente (o padrão antigo de centenas de chamadas
// OrdemServico/Get que gerava a carga que a Melvin reclamou).
//
// CÓDIGO DE INTEGRAÇÃO: é específico da Fertgrow, veio por e-mail da
// Melvin depois da reunião de 2026-10-13. Não é segredo (funciona só
// como um identificador de qual integração/cliente está chamando),
// mas também não precisa ficar em nenhum outro lugar além daqui.
//
// MAPEAMENTO DE CAMPOS (não é 1:1 óbvio, documentado aqui pra não se
// perder depois):
//   - dataProgramacao: vem em DatasProgramacao[], um valor repetido
//     por recurso/pessoa alocada na OS (3 pessoas = 3 datas iguais)
//     -- usamos só a primeira.
//   - dataExecucao: NÃO é Acoes[].DataValidacao (isso é quando a OS foi
//     "baixada"/fechada no sistema, que pode ser dias depois do
//     trabalho em si -- confirmado pelo usuário com um caso real: OS
//     executada em 02/10 segundo o apontamento, mas baixada só em
//     05/10). A data de execução de verdade vem de
//     ApontamentosHoras[].DataInicio + HoraInicio (campos separados,
//     combinados em dataExecucaoReal()) -- usamos o apontamento mais
//     antigo, que é quando o trabalho de fato começou. Sem nenhum
//     apontamento registrado (raro), cai pra DataValidacao como
//     aproximação.
//   - dataEncerramento: esse sim é Acoes[].DataValidacao -- confirmado
//     presente em todas as 514 ordens Status=Encerrada da amostra
//     inicial, e ausente em ordens ainda em aberto. É a data de
//     "baixa" no sistema, distinta da execução (ver acima) -- com essa
//     separação "tempo médio de baixa" volta a fazer sentido de novo.
//   - dataExclusao: a API não traz uma data de cancelamento separada,
//     só o status "Cancelada" + a justificativa (texto). Usamos a
//     própria DataAbertura como valor não-nulo nesse campo só pra
//     continuar funcionando o filtro "!r.dataExclusao" que o painel
//     já usa pra excluir ordens canceladas -- a data em si não é
//     usada em nenhum cálculo, só a presença/ausência dela.
//   - tipoManutencao: vem direto no campo Tipo -- não precisa mais
//     buscar OrdemServico/Get pra cada OS só pra pegar isso.
//   - executante: a API pode listar várias pessoas (apontamentos de
//     hora, recursos utilizados) numa mesma OS; o painel só guarda UM
//     executante por ordem, então pegamos o primeiro nome que
//     aparecer (apontamento de hora tem prioridade sobre recurso
//     planejado, por ser mais próximo da execução real).
//
// Sem incremental/merge com histórico salvo: a chamada já traz o
// ciclo inteiro de uma vez (a API aceita até 12 meses por consulta),
// então a cada sincronização a gente simplesmente substitui tudo --
// mais simples e sem risco de os dois lados divergirem.
// ============================================================

const STORAGE_KEY = "painelProgramacao_data_v1";
const INTEGRATION_URL = "https://api-novo.oimelvin.com.br/api/services/app/PowerBI/GetDadosIntegracao";
const CODIGO_INTEGRACAO = "e2a31022-86f6-412d-b9f5-ccd1f1d36cff";
// a Fertgrow só começou a usar o Melvin em agosto/2026 -- pedir desde julho (como os outros painéis,
// que têm outra fonte de dado) só faria a Melvin escanear um mês inteiro sem nenhum registro, à toa.
// CYCLE_START aqui é só o início da JANELA DE BUSCA nessa API específica, não precisa bater com o
// "início do ciclo" usado nos outros painéis (Custos/Disponibilidade), que não dependem do Melvin.
const CYCLE_START = "2026-08-01";
// fim dinâmico (~120 dias à frente de hoje) em vez de fixar um ano inteiro -- a API aceita até 12
// meses por consulta, mas pedir mais do que existe de fato só deixa a consulta mais pesada à toa
// (a busca de teste do ciclo inteiro levou ~100s); preventivas programadas com tanta antecedência
// assim não são o cenário comum, e isso se auto-atualiza a cada execução sem precisar editar o código
function janelaFim(): string {
  const d = new Date();
  d.setDate(d.getDate() + 120);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const CYCLE_END = janelaFim();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function dateOnly(iso: string | null | undefined): string | null {
  if (!iso || typeof iso !== "string") return null;
  return iso.slice(0, 10);
}

function latestDataValidacao(acoes: any[] | undefined): string | null {
  if (!acoes || !acoes.length) return null;
  const datas = acoes.map((a) => a.DataValidacao).filter((d) => !!d).sort();
  return datas.length ? datas[datas.length - 1] : null;
}

// junta DataInicio (só a data, vem sempre com hora zerada) + HoraInicio (só a hora, campo separado)
// num timestamp só -- confirmado com o usuário (print do Melvin, OS 457) que ApontamentosHoras é o
// dado real de QUANDO o trabalho foi feito, diferente de Acoes[].DataValidacao (quando foi "baixada"
// no sistema, que pode ser dias depois -- no exemplo, executada 02/10 mas baixada só em 05/10)
function combineDataHora(dataIso: string | null | undefined, hora: string | null | undefined): string | null {
  if (!dataIso) return null;
  const datePart = dataIso.slice(0, 10);
  return hora ? `${datePart}T${hora}` : `${datePart}T00:00:00`;
}

function dataExecucaoReal(r: any): string | null {
  const apontamentos = r.ApontamentosHoras;
  if (apontamentos && apontamentos.length) {
    const timestamps = (apontamentos as any[])
      .map((a) => combineDataHora(a.DataInicio, a.HoraInicio))
      .filter((t): t is string => !!t)
      .sort();
    if (timestamps.length) return timestamps[0];
  }
  // sem apontamento registrado (raro) -- melhor usar a data de baixa como aproximação do que deixar nulo
  return latestDataValidacao(r.Acoes);
}

function primeiroExecutante(r: any): string {
  if (r.ApontamentosHoras && r.ApontamentosHoras.length && r.ApontamentosHoras[0].Funcionario) {
    return r.ApontamentosHoras[0].Funcionario;
  }
  if (r.RecursosUtilizados && r.RecursosUtilizados.length && r.RecursosUtilizados[0].Descricao) {
    return r.RecursosUtilizados[0].Descricao;
  }
  if (r.RecursosPlanejados && r.RecursosPlanejados.length && r.RecursosPlanejados[0].Descricao) {
    return r.RecursosPlanejados[0].Descricao;
  }
  return "";
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
    const raw: any[] = json.result ?? [];

    const records = raw.map((r) => {
      const dataProgramacaoRaw = (r.DatasProgramacao && r.DatasProgramacao.length) ? r.DatasProgramacao[0] : null;
      return {
        codOrdem: r.Numero,
        tag: r.TagAtivo || "",
        descricaoOs: r.Descricao || "",
        descricaoEquipamento: r.NomeAtivo || "",
        dataCriada: dateOnly(r.DataAbertura),
        dataProgramacao: dateOnly(dataProgramacaoRaw),
        dataExclusao: r.Status === "Cancelada" ? dateOnly(r.DataAbertura) : null,
        dataExecucao: dataExecucaoReal(r),
        dataEncerramento: latestDataValidacao(r.Acoes),
        executante: primeiroExecutante(r),
        tipoManutencao: r.Tipo || "",
      };
    }).filter((r) => (r.dataProgramacao && r.dataProgramacao >= CYCLE_START) || (r.dataExecucao && r.dataExecucao >= CYCLE_START) || (!r.dataProgramacao && !r.dataExecucao));

    const data = { sheetName: "melvin-api-integracao", records, coverageStart: CYCLE_START };

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
        fonte: "PowerBI/GetDadosIntegracao (API oficial Melvin)",
        janelaBuscada: `${CYCLE_START} a ${CYCLE_END}`,
        ordensRecebidas: raw.length,
        ordensNoHistorico: records.length,
        comDataProgramacao: records.filter((r) => r.dataProgramacao).length,
        comDataExecucao: records.filter((r) => r.dataExecucao).length,
        canceladas: records.filter((r) => r.dataExclusao).length,
      }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message || e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
