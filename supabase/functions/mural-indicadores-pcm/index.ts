// ============================================================
// Supabase Edge Function: mural-indicadores-pcm
// Resumo público (sem login) de 3 indicadores do painel PCM — Custos,
// Disponibilidade e Aderência à Programação — pra alimentar slides no
// Mural de HH (TV de gestão), que roda sem ninguém logado.
//
// NÃO busca nada nas APIs do Melvin/Evocon: só lê as 3 linhas que o
// painel admin (index.html) já sincroniza na tabela app_state (mesmos
// dados mostrados no card "Painel Geral" de lá) e devolve um resumo já
// calculado. Usa a SUPABASE_SERVICE_ROLE_KEY (automática, nunca fica
// exposta ao navegador) pra ler app_state sem depender de RLS/login —
// só esse resumo agregado sai público, a tabela em si continua
// protegida igual sempre esteve.
//
// Toda a matemática abaixo (computeDispRange, computePlantStats,
// computeProgRange, executadaNoPrazo/Semana, etc.) é cópia fiel das
// mesmas funções do index.html — qualquer mudança de regra lá
// (ex.: "o que conta como aderência") precisa ser replicada aqui
// manualmente, os dois arquivos não compartilham código.
// ============================================================

const STORAGE_KEY = "painelOrcadoRealizado_data_v1";      // Custos
const DISP_STORAGE_KEY = "painelDisponibilidade_data_v1"; // Disponibilidade
const PROG_STORAGE_KEY = "painelProgramacao_data_v1";     // Programação
const CYCLE_START = "2026-07-01";
const RCA_TRIGGER = 3;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ---------- datas (cópia de dOnly/dAdd/dParseIso/dWeekStartSunday do index.html) ----------
function dOnly(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function dAdd(d: Date, n: number) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function dParseIso(s: string) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function dWeekStartSunday(d: Date) { const r = dOnly(d); r.setDate(r.getDate() - r.getDay()); return r; }

// ---------- Programação: executadaNoPrazo / executadaNoPrazoSemana (cópia fiel) ----------
function executadaNoPrazo(dataProgramacao: Date | null, dataExecucao: Date | null) {
  if (!dataProgramacao || !dataExecucao) return false;
  const execDay = dOnly(dataExecucao);
  if (+execDay <= +dataProgramacao) return true;
  const diffDays = Math.round((+execDay - +dataProgramacao) / 86400000);
  const execMinutes = dataExecucao.getHours() * 60 + dataExecucao.getMinutes();
  if (diffDays === 1 && execMinutes <= 420) return true;
  return false;
}
function executadaNoPrazoSemana(dataProgramacao: Date | null, dataExecucao: Date | null) {
  if (!dataProgramacao || !dataExecucao) return false;
  const execDay = dOnly(dataExecucao);
  if (+execDay <= +dataProgramacao) return true;
  const diffDays = Math.round((+execDay - +dataProgramacao) / 86400000);
  const execMinutes = dataExecucao.getHours() * 60 + dataExecucao.getMinutes();
  if (diffDays === 1 && execMinutes <= 420) return true;
  return +dWeekStartSunday(dataProgramacao) === +dWeekStartSunday(execDay);
}

// ---------- Disponibilidade: computeDispRange / computePlantStats / computeDailySeries ----------
function computeDispRange(records: any[], start: Date, end: Date, plantCount: number) {
  const days = Math.max(1, Math.round((+dOnly(end) - +dOnly(start)) / 86400000) + 1);
  const inRange = records.filter(r => r.date >= start && r.date <= end);
  const totalHours = inRange.reduce((s, r) => s + r.hours, 0);
  const poolHours = days * 16 * Math.max(1, plantCount || 1);
  const disponibilidade = poolHours > 0 ? Math.max(0, (1 - totalHours / poolHours) * 100) : 100;
  return { days, records: inRange, totalHours, poolHours, disponibilidade, count: inRange.length };
}
function computePlantStats(records: any[], days: number, allPlants: string[]) {
  const poolHours = days * 16;
  const byPlant: Record<string, { planta: string; count: number; hours: number }> = {};
  (allPlants || []).forEach(p => { byPlant[p] = { planta: p, count: 0, hours: 0 }; });
  records.forEach(r => {
    if (!byPlant[r.planta]) byPlant[r.planta] = { planta: r.planta, count: 0, hours: 0 };
    byPlant[r.planta].count += 1;
    byPlant[r.planta].hours += r.hours;
  });
  return Object.values(byPlant).map(p => ({
    planta: p.planta, count: p.count, hours: p.hours,
    mttr: p.count > 0 ? p.hours / p.count : 0,
    mtbf: p.count > 0 ? Math.max(0, poolHours - p.hours) / p.count : Math.max(0, poolHours),
    disponibilidade: poolHours > 0 ? Math.max(0, (1 - p.hours / poolHours) * 100) : 100,
  }));
}
function computeDailySeries(records: any[], start: Date, end: Date) {
  const days: { date: Date; hours: number; count: number }[] = [];
  for (let d = dOnly(start); d <= dOnly(end); d = dAdd(d, 1)) {
    const dayRecords = records.filter(r => +r.date === +d);
    const hours = dayRecords.reduce((s, r) => s + r.hours, 0);
    days.push({ date: new Date(d), hours, count: dayRecords.length });
  }
  return days;
}

// ---------- Programação: computeProgRange / computeProgMonthlySeries (cópia fiel) ----------
function computeProgRange(records: any[], start: Date, end: Date) {
  const inRangeProg = records.filter(r => r.dataProgramacao && r.dataProgramacao >= start && r.dataProgramacao <= end && !r.dataExclusao);
  const inRangeExec = records.filter(r => r.dataExecucao && dOnly(r.dataExecucao) >= start && dOnly(r.dataExecucao) <= end && !r.dataExclusao);

  const ontem = dOnly(new Date(Date.now() - 86400000));
  const fimKpi = end < ontem ? end : ontem;
  const inRangeProgKpi = inRangeProg.filter(r => r.dataProgramacao <= fimKpi);
  const inRangeExecKpi = inRangeExec.filter(r => dOnly(r.dataExecucao) <= fimKpi);

  const programadas = inRangeProgKpi.length;
  const executadasNoPrazo = inRangeProgKpi.filter(r => r.dataExecucao && executadaNoPrazoSemana(r.dataProgramacao, r.dataExecucao)).length;
  const aderencia = programadas > 0 ? (executadasNoPrazo / programadas) * 100 : 0;

  const foraDePrazoProgramadas = inRangeProgKpi.filter(r => r.dataExecucao && !executadaNoPrazo(r.dataProgramacao, r.dataExecucao));
  const foraDeProgramacaoNaoProgramadas = inRangeExecKpi.filter(r => !r.dataProgramacao).length;
  const foraDeProgramacao = foraDePrazoProgramadas.length + foraDeProgramacaoNaoProgramadas;
  const pctForaDeProgramacao = programadas > 0 ? (foraDeProgramacao / programadas) * 100 : 0;

  const desvioMedioDias = foraDePrazoProgramadas.length > 0
    ? foraDePrazoProgramadas.reduce((s, r) => s + (+dOnly(r.dataExecucao) - +r.dataProgramacao) / 86400000, 0) / foraDePrazoProgramadas.length
    : 0;

  const comEncerramento = inRangeExecKpi.filter(r => r.dataEncerramento);
  const tempoMedioBaixaDias = comEncerramento.length > 0
    ? comEncerramento.reduce((s, r) => s + (+r.dataEncerramento - +r.dataExecucao) / 86400000, 0) / comEncerramento.length
    : 0;

  return { programadas, executadasNoPrazo, aderencia, foraDeProgramacao, pctForaDeProgramacao, desvioMedioDias, desvioCount: foraDePrazoProgramadas.length, tempoMedioBaixaDias };
}
function computeProgMonthlySeries(records: any[], rangeStart: Date, rangeEnd: Date) {
  const MESES_ABREV = ["JAN","FEV","MAR","ABR","MAI","JUN","JUL","AGO","SET","OUT","NOV","DEZ"];
  const months: { label: string; programadas: number; executadasNoPrazo: number; aderencia: number }[] = [];
  let cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
  while (cursor <= rangeEnd) {
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const start = cursor < rangeStart ? dOnly(rangeStart) : cursor;
    const end = monthEnd > rangeEnd ? dOnly(rangeEnd) : monthEnd;
    const monthRecords = records.filter(r => r.dataProgramacao && r.dataProgramacao >= start && r.dataProgramacao <= end && !r.dataExclusao);
    const programadas = monthRecords.length;
    const executadasNoPrazo = monthRecords.filter(r => r.dataExecucao && executadaNoPrazoSemana(r.dataProgramacao, r.dataExecucao)).length;
    const aderencia = programadas > 0 ? (executadasNoPrazo / programadas) * 100 : 0;
    months.push({ label: `${MESES_ABREV[start.getMonth()]}/${String(start.getFullYear()).slice(2)}`, programadas, executadasNoPrazo, aderencia });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return months;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes.");
    const sbHeaders = { "apikey": serviceRoleKey, "Authorization": `Bearer ${serviceRoleKey}` };

    const keys = [STORAGE_KEY, DISP_STORAGE_KEY, PROG_STORAGE_KEY];
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/app_state?key=in.(${keys.map(k => `"${k}"`).join(",")})&select=key,data`,
      { headers: sbHeaders },
    );
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      throw new Error(`Falha ao ler app_state (${resp.status}): ${bodyText.slice(0, 300)}`);
    }
    const rows: { key: string; data: any }[] = await resp.json();
    const byKey = new Map(rows.map(r => [r.key, r.data]));

    const cycleStart = dParseIso(CYCLE_START);
    const today = dOnly(new Date());

    // ---- Custos ----
    let custos = null;
    const custosData = byKey.get(STORAGE_KEY);
    if (custosData && custosData.consolidated) {
      const kpi = custosData.consolidated.ciclo;
      const aderencia = kpi.orcado ? (kpi.realizado / kpi.orcado) * 100 : 0;
      custos = { ciclo: kpi, aderencia, months: custosData.consolidated.months };
    }

    // ---- Disponibilidade ----
    let disponibilidade = null;
    const dispDataRaw = byKey.get(DISP_STORAGE_KEY);
    if (dispDataRaw && Array.isArray(dispDataRaw.records) && dispDataRaw.records.length) {
      const records = dispDataRaw.records.map((r: any) => ({ ...r, date: dParseIso(r.date) }));
      let minD = records[0].date;
      records.forEach((r: any) => { if (r.date < minD) minD = r.date; });
      const plantCount = Math.max(1, (dispDataRaw.plants || []).length);
      const rangeStats = computeDispRange(records, dOnly(minD), today, plantCount);
      const dailySeries = computeDailySeries(records, dOnly(minD), today);
      const plantStats = computePlantStats(rangeStats.records, rangeStats.days, dispDataRaw.plants);
      disponibilidade = {
        disponibilidade: rangeStats.disponibilidade,
        totalHours: rangeStats.totalHours,
        count: rangeStats.count,
        days: rangeStats.days,
        falhasAcimaGatilho: dailySeries.filter(d => d.hours >= RCA_TRIGGER).length,
        plantas: plantStats,
      };
    }

    // ---- Programação ----
    let programacao = null;
    const progDataRaw = byKey.get(PROG_STORAGE_KEY);
    if (progDataRaw && Array.isArray(progDataRaw.records) && progDataRaw.records.length) {
      const records = progDataRaw.records.map((r: any) => ({
        ...r,
        dataProgramacao: r.dataProgramacao ? dParseIso(r.dataProgramacao) : null,
        dataExclusao: r.dataExclusao ? dParseIso(r.dataExclusao) : null,
        dataExecucao: r.dataExecucao ? new Date(r.dataExecucao) : null,
        dataEncerramento: r.dataEncerramento ? new Date(r.dataEncerramento) : null,
      }));
      const range = computeProgRange(records, cycleStart, today);
      const series = computeProgMonthlySeries(records, cycleStart, today);
      programacao = { ...range, series };
    }

    return new Response(
      JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), custos, disponibilidade, programacao }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message || e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
