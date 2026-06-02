const handler = async (event, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  try {
    const [mercadoRes, statusRes, partidasRes] = await Promise.all([
      fetch("https://api.cartola.globo.com/atletas/mercado", { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }),
      fetch("https://api.cartola.globo.com/mercado/status", { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }),
      fetch("https://api.cartola.globo.com/partidas", { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }),
    ]);
    if (!mercadoRes.ok) throw new Error("Cartola API error: " + mercadoRes.status);
    const mercado = await mercadoRes.json();
    const status = statusRes.ok ? await statusRes.json() : {};
    const partidasData = partidasRes.ok ? await partidasRes.json() : {};
    const posicoes = { 1: "GOL", 2: "LAT", 3: "ZAG", 4: "MEI", 5: "ATA", 6: "TEC" };
    const atletasArr = mercado.atletas || [];

    // Calcular forca de cada clube pela media dos top 11 atletas
    const clubeAtletas = {};
    atletasArr.forEach(function(a) {
      if (!clubeAtletas[a.clube_id]) clubeAtletas[a.clube_id] = [];
      if ((a.media_num || 0) > 0 && (a.jogos_num || 0) >= 3) {
        clubeAtletas[a.clube_id].push(a.media_num);
      }
    });
    const forcaClube = {};
    Object.keys(clubeAtletas).forEach(function(id) {
      const medias = clubeAtletas[id].sort(function(a,b){return b-a;}).slice(0, 11);
      forcaClube[id] = medias.length > 0 ? medias.reduce(function(s,v){return s+v;},0) / medias.length : 3;
    });
    const clubeIds = Object.keys(forcaClube);
    const forcaOrdenada = clubeIds.slice().sort(function(a,b){ return forcaClube[a]-forcaClube[b]; });
    const rankingClube = {};
    forcaOrdenada.forEach(function(id, i) { rankingClube[id] = i + 1; });
    const totalClubes = forcaOrdenada.length || 20;

    // Processar partidas
    const partidas = [];
    const clubeAdversario = {};
    const clubePartida = {};
    const listaPartidas = partidasData.partidas || [];
    listaPartidas.forEach(function(p) {
      const mid = p.clube_casa_id;
      const vid = p.clube_visitante_id;
      const cl = mercado.clubes || {};
      const partida = {
        id: p.partida_id,
        mandante_id: mid, visitante_id: vid,
        mandante: cl[mid] ? cl[mid].nome : "?",
        visitante: cl[vid] ? cl[vid].nome : "?",
        mandante_abrev: cl[mid] ? cl[mid].abreviacao : "?",
        visitante_abrev: cl[vid] ? cl[vid].abreviacao : "?",
        data: p.partida_data || null,
        local: p.local || null,
      };
      partidas.push(partida);
      clubeAdversario[mid] = { adversario_id: vid, mando: "casa" };
      clubeAdversario[vid] = { adversario_id: mid, mando: "fora" };
      clubePartida[mid] = partida;
      clubePartida[vid] = partida;
    });

    const atletas = atletasArr.filter(function(a) { return a.status_id === 7; }).map(function(a) {
      const media = a.media_num || 0;
      const preco = a.preco_num || 1;
      const variacao = a.variacao_num || 0;
      const cb_score = preco > 0 ? media / preco : 0;
      const confronto = clubeAdversario[a.clube_id] || null;
      const mando = confronto ? confronto.mando : "?";
      const adversario_id = confronto ? confronto.adversario_id : null;
      const partida = clubePartida[a.clube_id] || null;
      const forcaAtleta = rankingClube[a.clube_id] || Math.floor(totalClubes / 2);
      const forcaAdv = adversario_id ? (rankingClube[adversario_id] || Math.floor(totalClubes / 2)) : Math.floor(totalClubes / 2);
      const diff = forcaAdv - forcaAtleta;
      let dificuldade = 3;
      if (diff >= 8) dificuldade = 5;
      else if (diff >= 4) dificuldade = 4;
      else if (diff >= -2) dificuldade = 3;
      else if (diff >= -6) dificuldade = 2;
      else dificuldade = 1;
      const ajusteConfronto = -((dificuldade - 1) / 4) * 1.5;
      const mandoBonus = mando === "casa" ? 0.1 : 0;
      const forcaRel = forcaAtleta / totalClubes;
      const score_final = Math.max(0, cb_score + (variacao > 0 ? 0.1 : 0) + ajusteConfronto + mandoBonus + forcaRel * 0.3);
      const cl = mercado.clubes || {};
      const cId = String(a.clube_id);
      const aId = adversario_id ? String(adversario_id) : null;
      return {
        id: a.atleta_id,
        nome: a.apelido || a.nome,
        posicao: posicoes[a.posicao_id] || "?",
        posicao_id: a.posicao_id,
        clube_id: a.clube_id,
        clube: cl[cId] ? cl[cId].nome : "?",
        clube_abrev: cl[cId] ? cl[cId].abreviacao : "?",
        foto: a.foto ? a.foto.replace("FORMATO", "140x140") : null,
        escudo: cl[cId] && cl[cId].escudos ? cl[cId].escudos["45x45"] : null,
        preco: preco, media: media,
        pontos_rodada: a.pontos_num || 0,
        variacao: variacao,
        jogos: a.jogos_num || 0,
        cb_score: parseFloat(cb_score.toFixed(3)),
        score_final: parseFloat(score_final.toFixed(3)),
        mando: mando,
        adversario_id: adversario_id || null,
        adversario: aId && cl[aId] ? cl[aId].abreviacao : "?",
        adversario_nome: aId && cl[aId] ? cl[aId].nome : "?",
        adversario_escudo: aId && cl[aId] && cl[aId].escudos ? cl[aId].escudos["45x45"] : null,
        dificuldade: dificuldade,
        ranking_clube: forcaAtleta,
        forca_adversario: forcaAdv,
        total_clubes: totalClubes,
        partida_data: partida ? partida.data : null,
      };
    });

    const clubes = {};
    Object.entries(mercado.clubes || {}).forEach(function(entry) {
      const id = entry[0], c = entry[1];
      clubes[id] = {
        id: parseInt(id), nome: c.nome, abrev: c.abreviacao,
        escudo: c.escudos ? c.escudos["45x45"] : null,
        forca: parseFloat((forcaClube[id] || 3).toFixed(2)),
        ranking: rankingClube[id] || 1,
        total: totalClubes,
      };
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        rodada: status.rodada_atual || (mercado.rodada && mercado.rodada.rodada_atual) || "?",
        mercado_status: status.status_mercado || 1,
        total_atletas: atletas.length,
        atletas: atletas, clubes: clubes, partidas: partidas,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
exports.handler = handler;
