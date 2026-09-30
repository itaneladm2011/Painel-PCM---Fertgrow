// ============================================================
// Supabase Edge Function: sync-evocon
// Busca as paradas de manutenção não planejadas da API da Evocon e
// grava no Supabase, na mesma chave que o painel de Disponibilidade
// já lê (painelDisponibilidade_data_v1).
//
// HISTÓRICO DO CICLO: na primeira execução (ou com ?full=1 na URL) busca
// tudo desde CYCLE_START. Nas execuções seguintes (agendamento de hora
// em hora) busca só os últimos REFRESH_DAYS dias e mescla com o histórico
// já salvo — leve o bastante pra rodar toda hora mesmo com o ciclo de
// 12 meses completo, e ainda pega reclassificações recentes feitas na Evocon.
//
// SEGREDOS (Edge Functions > Manage secrets): EVOCON_API_KEY e
// EVOCON_SECRET_KEY. Nunca escreva as chaves neste arquivo.
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem automaticamente.
//
// Quando começar um novo ciclo, atualize CYCLE_START abaixo e rode uma
// vez com ?full=1 pra refazer o histórico.
// ============================================================

const STORAGE_KEY = "painelDisponibilidade_data_v1";
const EVOCON_BASE = "https://api.evocon.com/api/reports/losses_json";
const CYCLE_START = "2026-07-01"; // início do ciclo 26/27
const REFRESH_DAYS = 45;          // janela reprocessada a cada execução

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

// nomes da Evocon ("Planta 2 - Mistura") ficam compridos e sobrepõem nos gráficos;
// padroniza pro código curto PL01, PL02, PL03... extraindo o número da planta
function plantCode(stationName: string | undefined | null): string {
  const m = /Planta\s*0*(\d+)/i.exec(stationName ?? "");
  if (m) return "PL" + m[1].padStart(2, "0");
  return stationName && stationName.trim() ? stationName : "—";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  try {
    const apiKey = Deno.env.get("EVOCON_API_KEY");
    const secretKey = Deno.env.get("EVOCON_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!apiKey || !secretKey) throw new Error("EVOCON_API_KEY / EVOCON_SECRET_KEY não configurados nos secrets da função.");
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
    const endTime = dIso(end);

    const basic = btoa(`${apiKey}:${secretKey}`);
    const url = `${EVOCON_BASE}?startTime=${startTime}&endTime=${endTime}`;
    const evoResp = await fetch(url, { headers: { Authorization: `Basic ${basic}` } });
    if (!evoResp.ok) {
      const bodyText = await evoResp.text().catch(() => "");
      throw new Error(`Evocon respondeu ${evoResp.status}: ${bodyText.slice(0, 300)}`);
    }
    const raw = await evoResp.json();

    // só entram no indicador de disponibilidade as paradas NÃO PLANEJADAS cujo motivo é MANUTENÇÃO
    // (equipe de manutenção só contabiliza falha de equipamento, não parada operacional/não-operacional,
    // e não conta manutenção preventiva PLANEJADA como falha). Turno "3°" excluído: fábrica não produz
    // nesse horário (23:30-07:30), então parada registrada ali não representa perda de disponibilidade real.
    const unplanned = (raw as any[]).filter((r) =>
      r.stopType === "Unplanned" && r.stopGroup === "Paradas Manutenção" && r.shiftName !== "3°"
    );

    const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

    const fetched = unplanned.map((r) => {
      const startDt = new Date(r.start);
      const endDt = new Date(r.end);
      return {
        date: dIso(startDt),
        turno: r.shiftName ?? "",
        planta: plantCode(r.station),
        codFalha: r.stopGroup ?? "",
        falha: r.stop ?? "",
        descricao: r.comment && r.comment.trim() ? r.comment : (r.stop ?? ""),
        horaInicio: hhmm(startDt),
        horaFim: hhmm(endDt),
        // "stopMinutes" no retorno da Evocon está, na prática, em SEGUNDOS
        // (confirmado batendo com a diferença entre start/end nos exemplos reais)
        hours: (Number(r.stopMinutes) || 0) / 3600,
      };
    });

    let records: any[];
    if (fullFetch) {
      records = fetched;
    } else {
      // mantém o histórico anterior à janela e troca só o que foi rebuscado
      const kept = existing.records.filter((r: any) => r.date < startTime);
      records = kept.concat(fetched.filter((r) => r.date >= startTime));
    }
    records = records.filter((r) => r.date >= CYCLE_START);

    const plants = Array.from(new Set(records.map((r) => r.planta))).sort();
    const data = { sheetName: "evocon", plants, records, coverageStart: CYCLE_START };

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
        file_name: "evocon-api",
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
        totalParadasRecebidas: raw.length,
        paradasNoHistorico: records.length,
        plantas: plants,
      }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
