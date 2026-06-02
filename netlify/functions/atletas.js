const handler = async (event, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

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

    if (!mercadoRes.ok) throw new Error("Cartola API error: " + mercadoRes.status);

    const mercado = await mercadoRes.json();
    const status = statusRes.ok ? await statusRes.json() : {};
    const partidasData = partidasRes.ok ? await partidasRes.json() : {};
    const posicoes = { 1: "GOL", 2: "LAT", 3: "ZAG", 4: "MEI", 5: "ATA", 6: "TEC" };

    // ── Força de cada clube baseado nos TOP 11 atletas (média ponderada) ──
    // Isso reflete qualidade real do elenco e serve como proxy da posição na tabela
    const atletasArr = mercado.atletas || [];
    const clubeAtletas = {};
    atletasArr.forEach(function(a) {
      if (!clubeAtletas[a.clube_id]) clubeAtletas[a.clube_id] = [];
      if ((a.media_num || 0) > 0 && (a.jogos_num || 0) >= 3) {
        clubeAtletas[a.clube_id].push(a.media_num);
      }
    });

    // Score de força: média dos top 11 atletas de cada clube (0-10)
    const forcaClube = {};
    Object.keys(clubeAtletas).forEach(function(id) {
      const medias = clubeAtletas[id].sort(function(a,b){return b-a;}).slice(0, 11);
      const media = medias.length > 0 ? medias.reduce(function(s,v){return s+v;},0) / medias.length : 3;
      forcaClube[id] = parseFloat(media.toFixed(2));
    });

    // Normalizar força para ranking 1-20 (1=mais fraco, 20=mais forte)
    const clubeIds = Object.keys(forcaClube);
    const forcaOrdenada = clubeIds.sort(function(a,b){ return forcaClube[a]-forcaClube[b]; });
    const rankingClube = {}; // clube_id -> posição 1(fraco) a 20(forte)
    forcaOrdenada.forEach(function(id, i) {
      rankingClube[id] = i + 1;
    });
    const totalClubes = forcaOrdenada.length;

    // Processar partidas
    const partidas = [];
    const clubeAdversario = {};
    const clubePartida = {};
    const listaPartidas = partidasData.partidas || [];
    listaPartidas.forEach(function(p) {
      const mid = p.clube_casa_id;
      const vid = p.clube_visitante_id;
      const partida = {
        id: p.partida_id,
        mandante_id: mid, visitante_id: vid,
        mandante: (mercado.clubes && mercado.clubes[mid]) ? mercado.clubes[mid].nome : "—",
        visitante: (mercado.clubes && mercado.clubes[vid]) ? mercado.clubes[vid].nome : "—",
        mandante_abrev: (mercado.clubes && mercado.clubes[mid]) ? mercado.clubes[mid].abreviacao : "—",
        visitante_abrev: (mercado.clubes && mercado.clubes[vid]) ? mercado.clubes[vid].abreviacao : "—",
        data: p.partida_data || null,
        local: p.local || null,
        valida: p.valida,
      };
      partidas.push(partida);
      clubeAdversario[mid] = { adversario_id: vid, mando: "casa" };
      clubeAdversario[vid] = { adversario_id: mid, mando: "fora" };
      clubePartida[mid] = partida;
      clubePartida[vid] = partida;
    });

    // Processar atletas com score inteligente
    const atletas = atletasArr
      .filter(function(a) { return a.status_id === 7; })
      .map(function(a) {
        const media = a.media_num || 0;
        const preco = a.preco_num || 1;
        const variacao = a.variacao_num || 0;
        const cb_score = preco > 0 ? media / preco : 0;

        const confronto = clubeAdversario[a.clube_id] || null;
        const mando = confronto ? confronto.mando : "—";
        const adversario_id = confronto ? confronto.adversario_id : null;
        const partida = clubePartida[a.clube_id] || null;

        // Força do clube do atleta (1=fraco, totalClubes=forte)
        const forcaAtleta = rankingClube[a.clube_id] || Math.floor(totalClubes / 2);
        // Força do adversário (1=fraco, totalClubes=forte)
        const forcaAdv = adversario_id ? (rankingClube[adversario_id] || Math.floor(totalClubes / 2)) : Math.floor(totalClubes / 2);

        // Dificuldade real do confronto:
        // Considera tanto a força do adversário QUANTO a fraqueza do próprio clube
        // Se o clube é fraco (ranking baixo) vs adversário forte = muito difícil
        // Se o clube é forte vs adversário fraco = fácil
        const diferencaForca = forcaAdv - forcaAtleta; // positivo = adversário mais forte
        let dificuldade;
        if (diferencaForca >= 8) dificuldade = 5;       // adversário muito superior
        else if (diferencaForca >= 4) dificuldade = 4;  // adversário superior
        else if (diferencaForca >= -2) dificuldade = 3; // equilibrado
        else if (diferencaForca >= -6) dificuldade = 2; // clube superior
        else dificuldade = 1;                            // clube muito superior

        // Bônus/penalidade de mando
        const mandoBonus = mando === "casa" ? 0.5 : 0;

        // Score final: cb_score + forma + ajuste confronto + mando
        // Penaliza FORTEMENTE jogadores de times fracos contra times fortes
        const ajusteConfrontoMax = 1.5;
        const ajusteConfronto = -((dificuldade - 1) / 4) * ajusteConfrontoMax;
        const forcaRelativa = (forcaAtleta / totalClubes); // 0-1, mais alto = clube mais forte
        const score_final = Math.max(0, cb_score + (variacao > 0 ? 0.1 : 0) + ajusteConfronto + mandoBonus * 0.2 + forcaRelativa * 0.3);

        const cId = String(a.clube_id);
        return {
          id: a.atleta_id,
          nome: a.apelido || a.nome,
          posicao: posicoes[a.posicao_id] || "?",
          posicao_id: a.posicao_id,
          clube_id: a.clube_id,
          clube: (mercado.clubes && mercado.clubes[cId]) ? mercado.clubes[cId].nome : "—",
          clube_abrev: (mercado.clubes && mercado.clubes[cId]) ? mercado.clubes[cId].abreviacao : "—",
          foto: a.foto ? a.foto.replace("FORMATO", "140x140") : null,
          escudo: (mercado.clubes && mercado.clubes[cId]) ? (mercado.clubes[cId].escudos && mercado.clubes[cId].escudos["45x45"]) : null,
          preco: preco, media: media,
          pontos_rodada: a.pontos_num || 0,
          variacao: variacao,
          jogos: a.jogos_num || 0,
          cb_score: parseFloat(cb_score.toFixed(3)),
          score_final: parseFloat(score_final.toFixed(3)),
          mando: mando,
          adversario_id: adversario_id || null,
          adversario: adversario_id && mercado.clubes && mercado.clubes[adversario_id] ? mercado.clubes[adversario_id].abreviacao : "—",
          adversario_nome: adversario_id && mercado.clubes && mercado.clubes[adversario_id] ? mercado.clubes[adversario_id].nome : "—",
          adversario_escudo: adversario_id && mercado.clubes && mercado.clubes[adversario_id] ? (mercado.clubes[adversario_id].escudos && mercado.clubes[adversario_id].escudos["45x45"]) : null,
          dificuldade: dificuldade,
          forca_clube: forcaAtleta,        // ranking do clube (1=fraco, N=forte)
          forca_adversario: forcaAdv,      // ranking do adversário
          ranking_clube: forcaAtleta,
          total_clubes: totalClubes,
          partida_data: partida ? partida.data : null,
        };
      });

    const clubes = {};
    Object.entries(mercado.clubes || {}).forEach(function(entry) {
      const id = entry[0], c = entry[1];
      clubes[id] = { id: parseInt(id), nome: c.nome, abrev: c.abreviacao, escudo: c.escudos ? c.escudos["45x45"] : null, forca: forcaClube[id] || 3, ranking: rankingClube[id] || 1 };
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        rodada: status.rodada_atual || (mercado.rodada && mercado.rodada.rodada_atual) || "—",
        mercado_status: status.status_mercado || 1,
        total_atletas: atletas.length,
        atletas: atletas,
        clubes: clubes,
        partidas: partidas,
        forcaRanking: rankingClube,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

exports.handler = handler;
