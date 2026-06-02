export default async function handler(req, context) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    // API pública do Cartola FC
    const [mercadoRes, statusRes] = await Promise.all([
      fetch("https://api.cartola.globo.com/atletas/mercado", {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      }),
      fetch("https://api.cartola.globo.com/mercado/status", {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      }),
    ]);

    if (!mercadoRes.ok) {
      throw new Error(`Cartola API error: ${mercadoRes.status}`);
    }

    const mercado = await mercadoRes.json();
    const status = statusRes.ok ? await statusRes.json() : {};

    // Mapear posições
    const posicoes = { 1: "GOL", 2: "LAT", 3: "ZAG", 4: "MEI", 5: "ATA", 6: "TEC" };

    // Processar atletas
    const atletas = (mercado.atletas || [])
      .filter((a) => a.status_id === 7) // provável
      .map((a) => {
        const media = a.media_num || 0;
        const preco = a.preco_num || 1;
        const pontos = a.pontos_num || 0;
        const variacao = a.variacao_num || 0;

        // Score de custo-benefício
        const cb_score = preco > 0 ? media / preco : 0;

        // Score de forma (últimas rodadas via média ponderada)
        // API não fornece histórico direto, usamos média + variação como proxy
        const forma_score = media * 0.7 + (variacao > 0 ? variacao * 0.3 : 0);

        return {
          id: a.atleta_id,
          nome: a.apelido || a.nome,
          posicao: posicoes[a.posicao_id] || "?",
          posicao_id: a.posicao_id,
          clube_id: a.clube_id,
          clube: mercado.clubes?.[a.clube_id]?.nome || "—",
          clube_abrev: mercado.clubes?.[a.clube_id]?.abreviacao || "—",
          foto: a.foto?.replace("FORMATO", "140x140") || null,
          preco: preco,
          media: media,
          pontos_rodada: pontos,
          variacao: variacao,
          jogos: a.jogos_num || 0,
          status_id: a.status_id,
          cb_score: parseFloat(cb_score.toFixed(3)),
          forma_score: parseFloat(forma_score.toFixed(2)),
          // Escudos
          escudo: mercado.clubes?.[a.clube_id]?.escudos?.["45x45"] || null,
        };
      });

    // Clubes para matchup analysis
    const clubes = {};
    Object.entries(mercado.clubes || {}).forEach(([id, c]) => {
      clubes[id] = {
        id: parseInt(id),
        nome: c.nome,
        abrev: c.abreviacao,
        escudo: c.escudos?.["45x45"] || null,
      };
    });

    return new Response(
      JSON.stringify({
        ok: true,
        rodada: status.rodada_atual || mercado.rodada?.rodada_atual || "—",
        mercado_status: status.status_mercado || 1,
        total_atletas: atletas.length,
        atletas,
        clubes,
      }),
      { status: 200, headers }
    );
  } catch (err) {
    console.error("atletas error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers }
    );
  }
}

export const config = { path: "/api/atletas" };
