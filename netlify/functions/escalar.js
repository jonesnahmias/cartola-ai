const handler = async (event, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY nao configurada" }) };
  try {
    const body = JSON.parse(event.body);
    const atletas = body.atletas || [];
    const orcamento = body.orcamento || 140;
    const esquema = body.esquema || "4-3-3";
    const rodada = body.rodada || "atual";
    const partidas = body.partidas || [];
    const clubes = body.clubes || {};
    if (!atletas.length) return { statusCode: 400, headers, body: JSON.stringify({ error: "Nenhum atleta fornecido" }) };

    const por_posicao = {};
    atletas.forEach(function(a) {
      if (!por_posicao[a.posicao]) por_posicao[a.posicao] = [];
      por_posicao[a.posicao].push(a);
    });

    const top_atletas = [];
    ["GOL","LAT","ZAG","MEI","ATA"].forEach(function(pos) {
      const lista = (por_posicao[pos] || []).sort(function(a,b){ return (b.score_final||0)-(a.score_final||0); }).slice(0, 12);
      lista.forEach(function(a){ top_atletas.push(a); });
    });

    // Top 5 tecnicos
    const tecnicos = (por_posicao["TEC"] || []).sort(function(a,b){ return (b.score_final||0)-(a.score_final||0); }).slice(0, 5);

    const totalClubes = top_atletas.length > 0 && top_atletas[0].total_clubes ? top_atletas[0].total_clubes : 20;

    const posTabela = {};
    Object.keys(clubes).forEach(function(id) {
      if (clubes[id] && clubes[id].ranking && clubes[id].abrev) {
        posTabela[clubes[id].abrev] = totalClubes - clubes[id].ranking + 1;
      }
    });

    const partidasStr = partidas.map(function(p) {
      const mp = posTabela[p.mandante_abrev] ? p.mandante_abrev + "(" + posTabela[p.mandante_abrev] + ")" : p.mandante_abrev;
      const vp = posTabela[p.visitante_abrev] ? p.visitante_abrev + "(" + posTabela[p.visitante_abrev] + ")" : p.visitante_abrev;
      return mp + " x " + vp;
    }).join(", ");

    const vagasMap = {
      "4-3-3": { "GOL": 1, "LAT": 2, "ZAG": 2, "MEI": 3, "ATA": 3 },
      "4-4-2": { "GOL": 1, "LAT": 2, "ZAG": 2, "MEI": 4, "ATA": 2 },
      "3-5-2": { "GOL": 1, "LAT": 1, "ZAG": 3, "MEI": 5, "ATA": 2 },
      "5-3-2": { "GOL": 1, "LAT": 3, "ZAG": 3, "MEI": 3, "ATA": 2 },
    };
    const vagas = vagasMap[esquema] || vagasMap["4-3-3"];
    const vagasStr = Object.entries(vagas).map(function(e){ return e[1] + " " + e[0]; }).join(", ");
    const totalTitulares = Object.values(vagas).reduce(function(s,v){return s+v;}, 0);

    const fmt = function(a) {
      return { id: a.id, nome: a.nome, clube: a.clube_abrev,
        tab_clube: a.total_clubes - a.ranking_clube + 1,
        tab_adv: a.total_clubes - a.forca_adversario + 1,
        preco: a.preco, media: a.media, var: a.variacao,
        mando: a.mando, adv: a.adversario, dif: a.dificuldade, score: a.score_final };
    };

    const prompt =
      "Voce e especialista em Cartola FC. Monte o melhor time para a Rodada " + rodada + ".\n\n" +
      "ESQUEMA: " + esquema + " = " + vagasStr + "\n" +
      "TOTAL: " + totalTitulares + " titulares + 1 tecnico + 1 reserva de campo = 13 atletas\n" +
      "ORCAMENTO MAXIMO: C$ " + orcamento + "\n\n" +
      "ESTRUTURA DO TIME NO CARTOLA FC:\n" +
      "- " + totalTitulares + " jogadores de campo titulares (" + vagasStr + ")\n" +
      "- 1 TECNICO (posicao=TEC, fica fora do campo, nao conta nas vagas acima)\n" +
      "- 1 RESERVA de campo (qualquer posicao GOL/LAT/ZAG/MEI/ATA, titular=false)\n" +
      "Total = " + (totalTitulares + 2) + " atletas no array time\n\n" +
      "REGRAS CRITICAS:\n" +
      "- NUNCA coloque TEC como reserva de campo. TEC tem posicao='TEC' separado\n" +
      "- NUNCA repita o mesmo atleta (mesmo id) duas vezes\n" +
      "- tab_clube = posicao do clube na tabela (1=lider, alto=lanterna)\n" +
      "- tab_adv = posicao do adversario (1=lider, alto=lanterna)\n" +
      "- EVITE atletas de times fracos (tab_clube alto) contra times fortes (tab_adv baixo)\n" +
      "- Mando casa so ajuda se times sao equilibrados ou time da casa e superior\n\n" +
      "JOGOS: " + (partidasStr || "nao disponivel") + "\n\n" +
      "GOLEIROS (escolha " + vagas["GOL"] + "):\n" + JSON.stringify((por_posicao["GOL"]||[]).sort(function(a,b){return (b.score_final||0)-(a.score_final||0);}).slice(0,8).map(fmt)) + "\n\n" +
      "LATERAIS (escolha " + vagas["LAT"] + "):\n" + JSON.stringify((por_posicao["LAT"]||[]).sort(function(a,b){return (b.score_final||0)-(a.score_final||0);}).slice(0,10).map(fmt)) + "\n\n" +
      "ZAGUEIROS (escolha " + vagas["ZAG"] + "):\n" + JSON.stringify((por_posicao["ZAG"]||[]).sort(function(a,b){return (b.score_final||0)-(a.score_final||0);}).slice(0,10).map(fmt)) + "\n\n" +
      "MEIAS (escolha " + vagas["MEI"] + "):\n" + JSON.stringify((por_posicao["MEI"]||[]).sort(function(a,b){return (b.score_final||0)-(a.score_final||0);}).slice(0,12).map(fmt)) + "\n\n" +
      "ATACANTES (escolha " + vagas["ATA"] + "):\n" + JSON.stringify((por_posicao["ATA"]||[]).sort(function(a,b){return (b.score_final||0)-(a.score_final||0);}).slice(0,10).map(fmt)) + "\n\n" +
      "TECNICOS (escolha 1):\n" + JSON.stringify(tecnicos.map(fmt)) + "\n\n" +
      "RESERVA (escolha 1 jogador de campo, NAO pode ser TEC):\n" + JSON.stringify(top_atletas.slice(0,10).map(fmt)) + "\n\n" +
      "RESPONDA APENAS COM JSON PURO:\n" +
      "{\"time\":[" +
      "{\"id\":0,\"nome\":\"\",\"posicao\":\"GOL\",\"clube\":\"\",\"preco\":0,\"media\":0,\"mando\":\"\",\"adversario\":\"\",\"dificuldade\":\"\",\"titular\":true,\"capitao\":false,\"vice\":false,\"justificativa\":\"\"}," +
      "{\"id\":0,\"nome\":\"\",\"posicao\":\"TEC\",\"clube\":\"\",\"preco\":0,\"media\":0,\"mando\":\"\",\"adversario\":\"\",\"dificuldade\":\"\",\"titular\":true,\"capitao\":false,\"vice\":false,\"justificativa\":\"\"}," +
      "{\"id\":0,\"nome\":\"\",\"posicao\":\"ATA\",\"clube\":\"\",\"preco\":0,\"media\":0,\"mando\":\"\",\"adversario\":\"\",\"dificuldade\":\"\",\"titular\":false,\"capitao\":false,\"vice\":false,\"justificativa\":\"reserva\"}" +
      "],\"capitao\":{\"id\":0,\"nome\":\"\"},\"vice_capitao\":{\"id\":0,\"nome\":\"\"},\"custo_total\":0,\"pontuacao_esperada\":0,\"analise\":\"\",\"alertas\":[]}";

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) throw new Error("Claude API error: " + response.status);
    const data = await response.json();
    const text = (data.content && data.content[0]) ? data.content[0].text : "";
    const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();

    let escalacao;
    try { escalacao = JSON.parse(clean); }
    catch(e) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) { try { escalacao = JSON.parse(match[0]); } catch(e2) { throw new Error("JSON invalido: " + e2.message); } }
      else throw new Error("Sem JSON: " + clean.substring(0, 300));
    }

    if (escalacao.time) {
      // Remover duplicatas por ID
      const idsVistos = new Set();
      escalacao.time = escalacao.time.filter(function(t) {
        if (idsVistos.has(t.id)) return false;
        idsVistos.add(t.id);
        return true;
      });
      // Enriquecer com dados originais
      escalacao.time = escalacao.time.map(function(t) {
        const orig = atletas.find(function(a){ return a.id === t.id; });
        return Object.assign({}, t, {
          foto: orig ? orig.foto : null,
          escudo: orig ? orig.escudo : null,
          adversario_escudo: orig ? orig.adversario_escudo : null,
          mando: orig ? orig.mando : (t.mando || "?"),
          adversario: orig ? orig.adversario : (t.adversario || "?"),
          dificuldade: orig ? orig.dificuldade : null,
          variacao: orig ? orig.variacao : 0,
          jogos: orig ? orig.jogos : 0,
          ranking_clube: orig ? orig.ranking_clube : null,
          total_clubes: orig ? orig.total_clubes : 20,
        });
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, escalacao: escalacao }) };
  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
exports.handler = handler;
