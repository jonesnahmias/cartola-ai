const handler = async (event, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  try {
    const [mercadoRes, statusRes] = await Promise.all([
      fetch("https://api.cartola.globo.com/atletas/mercado", {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      }),
      fetch("https://api.cartola.globo.com/mercado/status", {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      }),
    ]);

    if (!mercadoRes.ok) throw new Error(`Cartola API error: ${mercadoRes.status}`);

    const mercado = await mercadoRes.json();
    const status = statusRes.ok ? await statusRes.json() : {};
    const posicoes = { 1: "GOL", 2: "LAT", 3: "ZAG", 4: "MEI", 5: "ATA", 6: "TEC" };

    const atletas = (mercado.atletas || [])
      .filter((a) => a.status_id === 7)
      .map((a) => {
        const media = a.media_num || 0;
        const preco = a.preco_num || 1;
        const cb_score = preco > 0 ? media / preco : 0;
        const forma_score = media * 0.7 + (a.variacao_num > 0 ? a.variacao_num * 0.3 : 0);
        return {
          id: a.atleta_id,
          nome: a.apelido || a.nome,
          posicao: posicoes[a.posicao_id] || "?",
          posicao_id: a.posicao_id,
          clube_id: a.clube_id,
          clube: mercado.clubes?.[a.clube_id]?.nome || "—",
          clube_abrev: mercado.clubes?.[a.clube_id]?.abreviacao || "—",
          foto: a.foto ? a.foto.replace("FORMATO", "140x140") : null,
          preco, media,
          pontos_rodada: a.pontos_num || 0,
          variacao: a.variacao_num || 0,
          jogos: a.jogos_num || 0,
          cb_score: parseFloat(cb_score.toFixed(3)),
          forma_score: parseFloat(forma_score.toFixed(2)),
          escudo: mercado.clubes?.[a.clube_id]?.escudos?.["45x45"] || null,
        };
      });

    const clubes = {};
    Object.entries(mercado.clubes || {}).forEach(([id, c]) => {
      clubes[id] = { id: parseInt(id), nome: c.nome, abrev: c.abreviacao, escudo: c.escudos?.["45x45"] || null };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        rodada: status.rodada_atual || mercado.rodada?.rodada_atual || "—",
        mercado_status: status.status_mercado || 1,
        total_atletas: atletas.length,
        atletas, clubes,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

exports.handler = handler;
