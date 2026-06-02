const handler = async (event, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  try {
    const [mercadoRes, statusRes, partidasRes] = await Promise.all([
      fetch("https://api.cartola.globo.com/atletas/mercado", {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      }),
      fetch("https://api.cartola.globo.com/mercado/status", {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      }),
      fetch("https://api.cartola.globo.com/partidas", {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      }),
    ]);

    if (!mercadoRes.ok) throw new Error(`Cartola API error: ${mercadoRes.status}`);

    const mercado = await mercadoRes.json();
    const status = statusRes.ok ? await statusRes.json() : {};
    const partidasData = partidasRes.ok ? await partidasRes.json() : {};

    const posicoes = { 1: "GOL", 2: "LAT", 3: "ZAG", 4: "MEI", 5: "ATA", 6: "TEC" };

    // Processar partidas da rodada
    const partidas = [];
    const clubeAdversario = {}; // clube_id -> { adversario_id, mando }
    const clubePartida = {};    // clube_id -> dados da partida

    const listaPartidas = partidasData.partidas || [];
    listaPartidas.forEach((p) => {
      const mandante_id = p.clube_casa_id;
      const visitante_id = p.clube_visitante_id;
      const partida = {
        id: p.partida_id,
        mandante_id,
        visitante_id,
        mandante: mercado.clubes?.[mandante_id]?.nome || "—",
        visitante: mercado.clubes?.[visitante_id]?.nome || "—",
        mandante_abrev: mercado.clubes?.[mandante_id]?.abreviacao || "—",
        visitante_abrev: mercado.clubes?.[visitante_id]?.abreviacao || "—",
        data: p.partida_data || null,
        local: p.local || null,
        placar_mandante: p.placar_oficial_mandante,
        placar_visitante: p.placar_oficial_visitante,
        valida: p.valida,
      };
      partidas.push(partida);

      clubeAdversario[mandante_id] = { adversario_id: visitante_id, mando: "casa" };
      clubeAdversario[visitante_id] = { adversario_id: mandante_id, mando: "fora" };
      clubePartida[mandante_id] = partida;
      clubePartida[visitante_id] = partida;
    });

    // Calcular força defensiva dos clubes (baseado em gols sofridos — proxy)
    // Usando pontuacao_media dos atletas do clube como indicador
    const forcaClube = {};
    const atletasArr = mercado.atletas || [];
    atletasArr.forEach((a) => {
      if (!forcaClube[a.clube_id]) forcaClube[a.clube_id] = { total: 0, count: 0 };
      if (a.media_num > 0) {
        forcaClube[a.clube_id].total += a.media_num;
        forcaClube[a.clube_id].count++;
      }
    });

    // Processar atletas
    const atletas = atletasArr
      .filter((a) => a.status_id === 7)
      .map((a) => {
        const media = a.media_num || 0;
        const preco = a.preco_num || 1;
        const variacao = a.variacao_num || 0;
        const cb_score = preco > 0 ? media / preco : 0;
        const forma_score = media * 0.7 + (variacao > 0 ? variacao * 0.3 : 0);

        const confronto = clubeAdversario[a.clube_id] || null;
        const partida = clubePartida[a.clube_id] || null;
        const adversario_id = confronto?.adversario_id;
        const mando = confronto?.mando || "—";

        // Score do adversário (quanto maior, mais difícil)
        const advMedia = adversario_id && forcaClube[adversario_id]
          ? forcaClube[adversario_id].total / (forcaClube[adversario_id].count || 1)
          : 5;

        // Dificuldade: 1 (fácil) a 5 (difícil)
        const dificuldade = Math.min(5, Math.max(1, Math.round(advMedia / 2)));

        // Score final ponderado
        const matchup_bonus = mando === "casa" ? 0.1 : 0;
        const dificuldade_penalty = (dificuldade - 3) * 0.05;
        const score_final = cb_score * (1 + matchup_bonus - dificuldade_penalty);

        return {
          id: a.atleta_id,
          nome: a.apelido || a.nome,
          posicao: posicoes[a.posicao_id] || "?",
          posicao_id: a.posicao_id,
          clube_id: a.clube_id,
          clube: mercado.clubes?.[a.clube_id]?.nome || "—",
          clube_abrev: mercado.clubes?.[a.clube_id]?.abreviacao || "—",
          foto: a.foto ? a.foto.replace("FORMATO", "140x140") : null,
          escudo: mercado.clubes?.[a.clube_id]?.escudos?.["45x45"] || null,
          preco,
          media,
          pontos_rodada: a.pontos_num || 0,
          variacao,
          jogos: a.jogos_num || 0,
          cb_score: parseFloat(cb_score.toFixed(3)),
          forma_score: parseFloat(forma_score.toFixed(2)),
          score_final: parseFloat(score_final.toFixed(3)),
          // Dados do confronto
          mando,
          adversario_id: adversario_id || null,
          adversario: adversario_id ? (mercado.clubes?.[adversario_id]?.abreviacao || "—") : "—",
          adversario_nome: adversario_id ? (mercado.clubes?.[adversario_id]?.nome || "—") : "—",
          adversario_escudo: adversario_id ? (mercado.clubes?.[adversario_id]?.escudos?.["45x45"] || null) : null,
          dificuldade,
          partida_data: partida?.data || null,
          partida_local: partida?.local || null,
        };
      });

    const clubes = {};
    Object.entries(mercado.clubes || {}).forEach(([id, c]) => {
      clubes[id] = {
        id: parseInt(id),
        nome: c.nome,
        abrev: c.abreviacao,
        escudo: c.escudos?.["45x45"] || null,
      };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        rodada: status.rodada_atual || mercado.rodada?.rodada_atual || "—",
        mercado_status: status.status_mercado || 1,
        total_atletas: atletas.length,
        atletas,
        clubes,
        partidas,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};

exports.handler = handler;
