// ============================================================
// Supabase Edge Function: mural-indicadores-pcm
// Resumo público (sem login) dos indicadores do painel PCM -- Custos,
// Disponibilidade e Programação -- pra alimentar slides no Mural de
// HH (TV de gestão), que roda sem ninguém logado.
//
// NÃO busca nada nas APIs do Melvin/Evocon: só lê as 3 linhas que o
// painel admin (index.html) já sincroniza na tabela app_state (mesmos
// dados mostrados nos painéis de lá) e devolve um resumo já calculado.
// Usa a SUPABASE_SERVICE_ROLE_KEY (automática, nunca fica exposta ao
// navegador) pra ler app_state sem depender de RLS/login -- só esse
// resumo agregado sai público, a tabela em si continua protegida
// igual sempre esteve.
//
// Toda a matemática abaixo (computePlantStats, computeWeeklySeries,
// computeEquipmentStats, computeProgRange, computeProgWeeklySeries,
// computeProgDailySeries, executadaNoPrazo/Semana, presets de
// semana/mês, etc.) é cópia fiel das mesmas funções do index.html --
// qualquer mudança de regra lá precisa ser replicada aqui
// manualmente, os dois arquivos não compartilham código.
// ============================================================

const STORAGE_KEY = "painelOrcadoRealizado_data_v1";      // Custos
const DISP_STORAGE_KEY = "painelDisponibilidade_data_v1"; // Disponibilidade
const PROG_STORAGE_KEY = "painelProgramacao_data_v1";     // Programação
const RCA_TRIGGER = 3;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ---------- datas (cópia de dOnly/dAdd/dParseIso/dWeekStartSunday/weekNumberSunday do index.html) ----------
function dOnly(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function dAdd(d: Date, n: number) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function dParseIso(s: string) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function dWeekStartSunday(d: Date) { const r = dOnly(d); r.setDate(r.getDate() - r.getDay()); return r; }
function weekNumberSunday(d: Date) {
  const jan1WeekStart = dWeekStartSunday(new Date(d.getFullYear(), 0, 1));
  const thisWeekStart = dWeekStartSunday(d);
  const diffDays = Math.round((+thisWeekStart - +jan1WeekStart) / 86400000);
  return Math.floor(diffDays / 7) + 1;
}
const pad = (n: number) => String(n).padStart(2, "0");

// presets "semana"/"mes" -- cópia fiel de applyDispPreset/applyProgPreset (idênticos nos dois painéis):
// semana = domingo a sábado da semana corrente (sem capar em hoje, igual ao admin); mês = dia 1 até
// hoje (mês truncado enquanto estiver em curso, não o mês calendário cheio)
function presetRange(kind: "semana" | "mes", today: Date) {
  if (kind === "semana") {
    const start = dWeekStartSunday(today);
    return { start, end: dAdd(start, 6) };
  }
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  return { start, end: monthEnd > today ? today : monthEnd };
}

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

// ---------- Disponibilidade: computeDispRange / computePlantStats / computeDailySeries / computeWeeklySeries / computeEquipmentStats ----------
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
// cumulativo: cada ponto soma do INÍCIO do range filtrado até o fim daquela semana (não é a semana
// isolada) -- cópia fiel de computeWeeklySeries, inclusive o corte em "hoje" (não projeta semana futura)
function computeWeeklySeries(records: any[], rangeStart: Date, rangeEnd: Date, plantCount: number, today: Date) {
  const plants = Math.max(1, plantCount || 1);
  const firstWeekStart = dWeekStartSunday(rangeStart);
  const lastWeekStart = dWeekStartSunday(rangeEnd);
  const weeks: { start: Date; end: Date; hours: number; disponibilidade: number; count: number }[] = [];
  for (let ws = firstWeekStart; ws <= lastWeekStart; ws = dAdd(ws, 7)) {
    if (ws > today) continue;
    const weEnd = dAdd(ws, 6);
    const periodEnd = weEnd > today ? today : weEnd;
    const daysElapsed = Math.max(1, Math.round((+periodEnd - +rangeStart) / 86400000) + 1);
    const cumRecords = records.filter(r => r.date >= rangeStart && r.date <= periodEnd);
    const hours = cumRecords.reduce((s, r) => s + r.hours, 0);
    const pool = daysElapsed * 16 * plants;
    const disponibilidade = pool > 0 ? Math.max(0, (1 - hours / pool) * 100) : 100;
    weeks.push({ start: ws, end: weEnd, hours, disponibilidade, count: cumRecords.length });
  }
  return weeks;
}
// agrupa por (planta, falha) -- não existe campo "equipamento" nos dados, "falha" é o texto livre
// da planilha que o admin trata como identificador do equipamento no gráfico "por equipamento"
function computeEquipmentStats(records: any[]) {
  const byEquip = new Map<string, { label: string; hours: number; count: number }>();
  records.forEach(r => {
    const equip = (r.falha && String(r.falha).trim()) || "—";
    const planta = (r.planta && String(r.planta).trim()) || "—";
    const key = `${planta}||${equip}`;
    if (!byEquip.has(key)) byEquip.set(key, { label: `${planta} · ${equip}`, hours: 0, count: 0 });
    const e = byEquip.get(key)!;
    e.hours += r.hours; e.count++;
  });
  return Array.from(byEquip.values()).sort((a, b) => b.hours - a.hours);
}

// ---------- Programação: computeProgRange / computeProgWeeklySeries / computeProgDailySeries (cópia fiel) ----------
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
function computeProgDailySeries(records: any[], rangeStart: Date, rangeEnd: Date) {
  const days: { label: string; programadas: number; executadasNoPrazo: number; aderencia: number }[] = [];
  for (let d = dOnly(rangeStart); d <= dOnly(rangeEnd); d = dAdd(d, 1)) {
    const dayRecords = records.filter(r => r.dataProgramacao && +r.dataProgramacao === +d && !r.dataExclusao);
    const programadas = dayRecords.length;
    const executadasNoPrazo = dayRecords.filter(r => r.dataExecucao && executadaNoPrazoSemana(r.dataProgramacao, r.dataExecucao)).length;
    const aderencia = programadas > 0 ? (executadasNoPrazo / programadas) * 100 : 0;
    days.push({ label: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`, programadas, executadasNoPrazo, aderencia });
  }
  return days;
}
function computeProgWeeklySeries(records: any[], rangeStart: Date, rangeEnd: Date) {
  const firstWeekStart = dWeekStartSunday(rangeStart);
  const lastWeekStart = dWeekStartSunday(rangeEnd);
  const weeks: { label: string; programadas: number; executadasNoPrazo: number; aderencia: number }[] = [];
  for (let ws = firstWeekStart; ws <= lastWeekStart; ws = dAdd(ws, 7)) {
    const weEnd = dAdd(ws, 6);
    const clipStart = ws < rangeStart ? rangeStart : ws;
    const clipEnd = weEnd > rangeEnd ? rangeEnd : weEnd;
    const weekRecords = records.filter(r => r.dataProgramacao && r.dataProgramacao >= clipStart && r.dataProgramacao <= clipEnd && !r.dataExclusao);
    const programadas = weekRecords.length;
    const executadasNoPrazo = weekRecords.filter(r => r.dataExecucao && executadaNoPrazoSemana(r.dataProgramacao, r.dataExecucao)).length;
    const aderencia = programadas > 0 ? (executadasNoPrazo / programadas) * 100 : 0;
    weeks.push({ label: `SEM ${weekNumberSunday(ws)}`, programadas, executadasNoPrazo, aderencia });
  }
  return weeks;
}

function computeDispBlock(records: any[], plants: string[], range: { start: Date; end: Date }, today: Date) {
  const plantCount = Math.max(1, (plants || []).length);
  const rangeStats = computeDispRange(records, range.start, range.end, plantCount);
  const dailySeries = computeDailySeries(records, range.start, range.end);
  const plantStats = computePlantStats(rangeStats.records, rangeStats.days, plants);
  const weeklyEvolution = computeWeeklySeries(records, range.start, range.end, plantCount, today)
    .map(w => ({ label: `SEM ${weekNumberSunday(w.start)}`, disponibilidade: w.disponibilidade }));
  return {
    disponibilidade: rangeStats.disponibilidade,
    totalHours: rangeStats.totalHours,
    count: rangeStats.count,
    days: rangeStats.days,
    falhasAcimaGatilho: dailySeries.filter(d => d.hours >= RCA_TRIGGER).length,
    plantas: plantStats,
    dailySeries: dailySeries.map(d => ({ label: `${pad(d.date.getDate())}/${pad(d.date.getMonth() + 1)}`, hours: d.hours })),
    weeklyEvolution,
    porEquipamento: computeEquipmentStats(rangeStats.records).slice(0, 10),
  };
}
function computeProgBlock(records: any[], range: { start: Date; end: Date }, granularity: "dia" | "semana") {
  const kpi = computeProgRange(records, range.start, range.end);
  const series = granularity === "dia" ? computeProgDailySeries(records, range.start, range.end) : computeProgWeeklySeries(records, range.start, range.end);
  return { ...kpi, series };
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

    const today = dOnly(new Date());
    const MESES_FULL = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
    const currentMonthLabel = `${MESES_FULL[today.getMonth()]}/${today.getFullYear()}`;

    // ---- Custos: mês atual consolidado (todas as contas) + evolução do ciclo + detalhamento por conta ----
    let custos = null;
    const custosData = byKey.get(STORAGE_KEY);
    if (custosData && custosData.consolidated) {
      const mes = (custosData.consolidated.months || []).find((m: any) => m.label === currentMonthLabel);
      if (mes) {
        const aderencia = mes.orcado ? (mes.realizado / mes.orcado) * 100 : 0;
        const months = custosData.consolidated.months;
        const aderenciaSeries = months.map((m: any) => ({ label: m.label, aderencia: m.orcado ? (m.realizado / m.orcado) * 100 : 0 }));
        // "detalhamento por conta e despesa": todas as contas de todos os grupos, achatadas, só do mês
        // atual, ordenadas pelas que mais estouraram o orçado (saldo mais negativo primeiro)
        const detalhamento: { grupo: string; conta: string; orcado: number; realizado: number; saldo: number }[] = [];
        (custosData.groups || []).forEach((g: any) => {
          (g.accounts || []).forEach((a: any) => {
            const am = (a.months || []).find((m: any) => m.label === currentMonthLabel);
            if (am && (am.orcado || am.realizado)) {
              detalhamento.push({ grupo: g.title, conta: a.name, orcado: am.orcado, realizado: am.realizado, saldo: am.saldo });
            }
          });
        });
        detalhamento.sort((a, b) => a.saldo - b.saldo);
        custos = { mes, aderencia, months, aderenciaSeries, detalhamento: detalhamento.slice(0, 15) };
      }
      // se não achar o mês atual na planilha (ainda não chegou/não foi carregado), custos fica null
      // -- melhor não mostrar o slide do que mostrar um "mês atual" com zero errado
    }

    // ---- Disponibilidade: semana atual + mês atual ----
    let disponibilidade = null;
    const dispDataRaw = byKey.get(DISP_STORAGE_KEY);
    if (dispDataRaw && Array.isArray(dispDataRaw.records) && dispDataRaw.records.length) {
      const records = dispDataRaw.records.map((r: any) => ({ ...r, date: dParseIso(r.date) }));
      disponibilidade = {
        semana: computeDispBlock(records, dispDataRaw.plants, presetRange("semana", today), today),
        mes: computeDispBlock(records, dispDataRaw.plants, presetRange("mes", today), today),
      };
    }

    // ---- Programação: semana atual (granularidade diária) + mês atual (granularidade semanal) ----
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
      programacao = {
        semana: computeProgBlock(records, presetRange("semana", today), "dia"),
        mes: computeProgBlock(records, presetRange("mes", today), "semana"),
      };
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
