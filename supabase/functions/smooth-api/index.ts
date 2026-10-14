// ============================================================
// Supabase Edge Function: sync-melvin-preventivas
// Busca os dados de preventivas (FMP) através da API oficial de
// integração do Melvin (PowerBI/GetDadosIntegracao, mesmo endpoint
// usado pela Programação -- ver sync-melvin-programacao pro histórico
// completo de por que migramos pra cá). Grava no Supabase na chave
// que o painel lê (painelPreventivas_data_v1), mesmo formato de
// sempre -- index.html não precisou mudar nada.
//
// COMO IDENTIFICAR UMA OCORRÊNCIA DE PREVENTIVA nesse feed: toda
// Ordem de Serviço que tem o campo FichaManutencaoPreventiva
// preenchido (um código tipo "LIMP001EL1") veio de um plano de
// preventiva -- independente do campo Tipo específico (Limpeza,
// Lubrificação de Mancal, Inspeção, Calibração, "Preventiva
// Periódica" etc., todos contam). Isso substitui o antigo
// Fmp/GetHistoricoGeracao.
//
// LIMITAÇÃO ESTRUTURAL (igual Programação): esse feed é centrado em
// Ordem de Serviço -- só traz o que já existe no Melvin. O Melvin só
// gera a OS de uma preventiva perto da data (não o ciclo inteiro
// adiantado), então a janela de busca sozinha deixa boa parte do mapa
// de 52 semanas vazia pra frente. A solução antiga buscava a
// periodicidade cadastrada de cada plano (Fmp/GetById +
// Periodicidade/GetPeriodicidades) pra projetar -- endpoints que são
// da MESMA categoria "interna" que causou o bloqueio original, então
// não dá mais pra usar. Em vez disso, a periodicidade agora é
// CALCULADA a partir das próprias datas reais que já temos (mediana
// do intervalo entre ocorrências consecutivas do mesmo par
// plano+equipamento) -- não depende de nenhum endpoint extra, só do
// histórico que já veio na mesma chamada.
//
// PAR PLANO+EQUIPAMENTO: um plano "rota" (ex.: ronda de inspeção que
// passa por vários equipamentos) não tem uma TAG de equipamento fixa
// por plano -- por isso o agrupamento (e a projeção) é sempre pelo
// PAR (FichaManutencaoPreventiva, TagAtivo), igual já era antes com
// (idFmp, idEquipamento). Quando TagAtivo vem vazio, agrupa só pelo
// código do plano (equivalente ao antigo "idEquipamento null").
//
// DIA DA SEMANA: plano com periodicidade de ~1 dia (diário) não tem
// execução esperada aos sábados/domingos -- mesma regra já usada
// antes, só que agora aplicada na hora de PROJETAR (os dados reais já
// não vêm com data de fim de semana, porque ninguém faz a rotina
// nesses dias).
//
// O QUE FICOU DE FORA (vs. a versão antiga): "nao_iniciado" (plano
// cadastrado no Melvin mas que nunca gerou nenhuma OS) não tem como
// aparecer nesse feed -- ele só lista OS's que já existem. Na
// prática, um plano assim nunca teria uma ocorrência real pra ancorar
// a projeção de qualquer forma, então simplesmente não aparece como
// linha no mapa (em vez de aparecer com uma linha vazia "não
// iniciado" como antes) -- degradação aceitável, não falsifica nada.
// ============================================================

const STORAGE_KEY = "painelPreventivas_data_v1";
const INTEGRATION_URL = "https://api-novo.oimelvin.com.br/api/services/app/PowerBI/GetDadosIntegracao";
const CODIGO_INTEGRACAO = "e2a31022-86f6-412d-b9f5-ccd1f1d36cff";
// a Fertgrow só começou a usar o Melvin em agosto/2026 -- mesma janela de início da Programação
const CYCLE_START = "2026-08-01";
// o mapa mostra 52 semanas pra frente a partir de hoje, mas isso é PROJEÇÃO NOSSA (ver acima) --
// a chamada à API em si só precisa trazer o histórico real recente, não o ano inteiro
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
const API_FETCH_END = addDiasIso(hojeIso(), 120);      // janela real buscada na Melvin
const PROJECTION_HORIZON = addDiasIso(hojeIso(), 364); // até onde projetamos (52 semanas), calculado por nós

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// setor "Manutenção de Equipamentos Móveis" não faz parte da gestão do PCM -- nenhuma ordem desse
// setor deve aparecer em nenhum painel. O campo Setor da API vem VAZIO pra esse setor específico
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
// mediana do intervalo (em dias) entre ocorrências consecutivas -- usada como "periodicidade
// calculada" do par plano+equipamento, pra projetar as próximas ocorrências sem depender de nenhum
// endpoint de cadastro de periodicidade
function periodicidadeMediana(datasOrdenadasIso: string[]): number | null {
  if (datasOrdenadasIso.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 1; i < datasOrdenadasIso.length; i++) {
    const a = new Date(datasOrdenadasIso[i - 1] + "T00:00:00").getTime();
    const b = new Date(datasOrdenadasIso[i] + "T00:00:00").getTime();
    const dias = Math.round((b - a) / 86400000);
    if (dias > 0) deltas.push(dias);
  }
  if (!deltas.length) return null;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 ? deltas[mid] : Math.round((deltas[mid - 1] + deltas[mid]) / 2);
}

function projetarOcorrenciasDoPar(
  idFmp: string, idEquipamento: string | null, tagFmp: string, descricaoFmp: string,
  equipamentoTag: string, equipamentoDescricao: string,
  datasReaisOrdenadas: string[], periodDias: number, todayIso: string, horizonteFim: string,
) {
  if (!periodDias || periodDias <= 0 || !datasReaisOrdenadas.length) return [];
  const datasReaisSet = new Set(datasReaisOrdenadas);
  const diario = periodDias === 1;
  const out: any[] = [];
  let cursor = new Date(datasReaisOrdenadas[datasReaisOrdenadas.length - 1] + "T00:00:00");
  cursor = new Date(cursor.getTime() + periodDias * 86400000);
  let guard = 0;
  while (dateOnly(cursor.toISOString())! <= horizonteFim && guard < 400) {
    const cursorIso = dateOnly(cursor.toISOString())!;
    const fimDeSemana = diario && (cursor.getDay() === 0 || cursor.getDay() === 6);
    if (cursorIso >= todayIso && !fimDeSemana && !datasReaisSet.has(cursorIso)) {
      out.push({
        idFmp, tagFmp, descricaoFmp, idEquipamento, equipamentoTag, equipamentoDescricao,
        dataExecucaoPrevista: cursorIso,
        idOrdemServico: null, codOrdem: null,
        osDataEncerramento: null, osDataExclusao: null,
        projetado: true,
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes (deveriam existir automaticamente).");
    const sbHeaders = { "apikey": serviceRoleKey, "Authorization": `Bearer ${serviceRoleKey}` };

    const url = `${INTEGRATION_URL}?codigoIntegracao=${CODIGO_INTEGRACAO}&dataInicio=${CYCLE_START}&dataFim=${API_FETCH_END}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      throw new Error(`Melvin respondeu ${resp.status} em PowerBI/GetDadosIntegracao: ${bodyText.slice(0, 300)}`);
    }
    const json = await resp.json();
    if (json.success === false) throw new Error(`Melvin retornou success=false: ${JSON.stringify(json).slice(0, 300)}`);
    const raw: any[] = (json.result ?? []).filter((r: any) => !!r.FichaManutencaoPreventiva && !ehSetorExcluido(r));

    const reais = raw.map((r) => {
      const dataProgramacaoRaw = (r.DatasProgramacao && r.DatasProgramacao.length) ? r.DatasProgramacao[0] : null;
      return {
        idFmp: r.FichaManutencaoPreventiva,
        tagFmp: r.FichaManutencaoPreventiva,
        descricaoFmp: r.Tipo || r.Descricao || "",
        idEquipamento: r.TagAtivo || null,
        equipamentoTag: r.TagAtivo || "",
        equipamentoDescricao: r.NomeAtivo || "",
        dataExecucaoPrevista: dateOnly(dataProgramacaoRaw) || dateOnly(r.DataAbertura),
        idOrdemServico: r.Id,
        codOrdem: r.Numero,
        osDataEncerramento: latestDataValidacao(r.Acoes),
        osDataExclusao: r.Status === "Cancelada" ? dateOnly(r.DataAbertura) : null,
        projetado: false,
      };
    }).filter((r) => r.dataExecucaoPrevista && r.dataExecucaoPrevista >= CYCLE_START);

    // agrupa por par (plano, equipamento) pra calcular a periodicidade real e projetar daí pra frente
    const pares = new Map<string, { idFmp: string; idEquipamento: string | null; tagFmp: string; descricaoFmp: string; equipamentoTag: string; equipamentoDescricao: string; datas: string[] }>();
    reais.forEach((r) => {
      const chave = `${r.idFmp}|${r.idEquipamento || "semequip"}`;
      if (!pares.has(chave)) {
        pares.set(chave, { idFmp: r.idFmp, idEquipamento: r.idEquipamento, tagFmp: r.tagFmp, descricaoFmp: r.descricaoFmp, equipamentoTag: r.equipamentoTag, equipamentoDescricao: r.equipamentoDescricao, datas: [] });
      }
      pares.get(chave)!.datas.push(r.dataExecucaoPrevista!);
    });

    const todayIso = hojeIso();
    const projetadas: any[] = [];
    pares.forEach((p) => {
      const datasOrdenadas = Array.from(new Set(p.datas)).sort();
      const periodDias = periodicidadeMediana(datasOrdenadas);
      if (!periodDias) return;
      projetadas.push(...projetarOcorrenciasDoPar(
        p.idFmp, p.idEquipamento, p.tagFmp, p.descricaoFmp, p.equipamentoTag, p.equipamentoDescricao,
        datasOrdenadas, periodDias, todayIso, PROJECTION_HORIZON,
      ));
    });

    const records = reais.concat(projetadas);
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
        file_name: "melvin-integracao-powerbi",
        updated_at: new Date().toISOString(),
      }),
    });
    if (!upsertResp.ok) {
      const bodyText = await upsertResp.text().catch(() => "");
      throw new Error(`Falha ao gravar no Supabase (${upsertResp.status}): ${bodyText.slice(0, 300)}`);
    }

    const planosUnicos = new Set(records.map((r) => r.idFmp).filter(Boolean));
    return new Response(
      JSON.stringify({
        ok: true,
        fonte: "PowerBI/GetDadosIntegracao (API oficial Melvin)",
        janelaBuscadaNaMelvin: `${CYCLE_START} a ${API_FETCH_END}`,
        horizonteProjetado: PROJECTION_HORIZON,
        ocorrenciasRecebidas: raw.length,
        ocorrenciasReais: reais.length,
        ocorrenciasProjetadas: projetadas.length,
        totalNoHistorico: records.length,
        paresComPeriodicidadeCalculada: Array.from(pares.values()).filter((p) => periodicidadeMediana(Array.from(new Set(p.datas)).sort())).length,
        paresSemPeriodicidadeCalculavel: pares.size - Array.from(pares.values()).filter((p) => periodicidadeMediana(Array.from(new Set(p.datas)).sort())).length,
        planosUnicos: planosUnicos.size,
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
