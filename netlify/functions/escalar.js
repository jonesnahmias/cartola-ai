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
    const estrategia = body.estrategia || "misto";
    if (!atletas.length) return { statusCode: 400, headers, body: JSON.stringify({ error: "Nenhum atleta fornecido" }) };

    const vagasMap = {
      "4-3-3": { GOL:1, LAT:2, ZAG:2, MEI:3, ATA:3 },
      "4-4-2": { GOL:1, LAT:2, ZAG:2, MEI:4, ATA:2 },
      "3-5-2": { GOL:1, LAT:1, ZAG:3, MEI:5, ATA:2 },
      "5-3-2": { GOL:1, LAT:3, ZAG:3, MEI:3, ATA:2 },
      "3-4-3": { GOL:1, LAT:0, ZAG:3, MEI:4, ATA:3 },
    };
    const vagas = vagasMap[esquema] || vagasMap["4-3-3"];
    const vagasStr = Object.entries(vagas).filter(function(e){return e[1]>0;}).map(function(e){return e[1]+" "+e[0];}).join(", ");

    const totalClubes = atletas.length > 0 && atletas[0].total_clubes ? atletas[0].total_clubes : 20;

    // Posicao na tabela de cada clube (1=lider, N=lanterna)
    const posTabela = {};
    Object.keys(clubes).forEach(function(id) {
      if (clubes[id] && clubes[id].ranking && clubes[id].abrev) {
        posTabela[clubes[id].abrev] = totalClubes - clubes[id].ranking + 1;
      }
    });

    // Mapear confrontos com contexto completo
    const confrontoMap = {};
    partidas.forEach(function(p) {
      var pm = posTabela[p.mandante_abrev] || "?";
      var pv = posTabela[p.visitante_abrev] || "?";
      confrontoMap[p.mandante_abrev] = { adv: p.visitante_abrev, mando: "casa", pos_clube: pm, pos_adv: pv };
      confrontoMap[p.visitante_abrev] = { adv: p.mandante_abrev, mando: "fora", pos_clube: pv, pos_adv: pm };
    });

    const partidasStr = partidas.map(function(p) {
      var pm = posTabela[p.mandante_abrev] ? p.mandante_abrev+"("+posTabela[p.mandante_abrev]+")" : p.mandante_abrev;
      var pv = posTabela[p.visitante_abrev] ? p.visitante_abrev+"("+posTabela[p.visitante_abrev]+")" : p.visitante_abrev;
      return pm + " x " + pv;
    }).join(", ");

    // Calcular nota estrategica por atleta
    var atletasComNota = atletas.map(function(a) {
      var confronto = confrontoMap[a.clube_abrev] || {};
      var posC = a.total_clubes - a.ranking_clube + 1;
      var posA = a.total_clubes - a.forca_adversario + 1;
      var diff = posA - posC;

      // Favorabilidade: quanto maior, mais favoravel
      var favorabilidade = 0;
      if (a.mando === "casa") favorabilidade += 2;
      if (diff >= 8) favorabilidade += 3;       // clube muito superior
      else if (diff >= 4) favorabilidade += 2;
      else if (diff >= 0) favorabilidade += 1;
      else if (diff <= -8) favorabilidade -= 3; // adversario muito superior
      else if (diff <= -4) favorabilidade -= 2;
      else favorabilidade -= 1;

      // Regularidade: media / max(variacao absoluta, 1) — proxy
      var regularidade = a.media > 0 ? Math.min(10, a.media * 0.8 + (a.variacao > 0 ? 1 : -0.5)) : 0;

      // Teto: jogadores caros tendem a ter maior teto
      var teto = Math.min(10, a.preco / 4 + a.media * 0.5);

      // Custo-beneficio
      var cb = a.preco > 0 ? a.media / a.preco : 0;

      // Risco: adversario forte + visitante = risco alto
      var risco = 0;
      if (a.mando === "fora") risco += 1;
      if (posA <= 3) risco += 2; // adversario no top 3
      if (a.dificuldade >= 4) risco += 1;

      // Nota final ponderada
      var nota = (a.media * 0.35) + (regularidade * 0.15) + (favorabilidade * 0.15) + (cb * 10 * 0.10) + (teto * 0.05) - (risco * 0.5);

      return Object.assign({}, a, {
        nota_estrategica: parseFloat(nota.toFixed(3)),
        favorabilidade: favorabilidade,
        risco: risco,
        pos_tabela_clube: posC,
        pos_tabela_adv: posA,
      });
    });

    // Top por posicao com nota estrategica
    var por_posicao = {};
    atletasComNota.forEach(function(a) {
      if (!por_posicao[a.posicao]) por_posicao[a.posicao] = [];
      por_posicao[a.posicao].push(a);
    });

    var top = function(pos, n) {
      return (por_posicao[pos] || [])
        .sort(function(a,b){return (b.nota_estrategica||0)-(a.nota_estrategica||0);})
        .slice(0, n)
        .map(function(a){
          return {
            id: a.id, nome: a.nome, clube: a.clube_abrev,
            pos_clube: a.pos_tabela_clube, pos_adv: a.pos_tabela_adv,
            preco: a.preco, media: a.media, var: a.variacao, jogos: a.jogos,
            mando: a.mando, adv: a.adversario, dif: a.dificuldade,
            favorabilidade: a.favorabilidade, risco: a.risco,
            nota: a.nota_estrategica, cb: parseFloat((a.preco>0?a.media/a.preco:0).toFixed(3))
          };
        });
    };

    var estrategiaTexto = {
      "pontuacao": "MODO PONTUACAO: maximizar pontos. Priorizar teto alto, aceitar jogadores caros se forem fortes candidatos a mitar. Capitao com alto teto e alta seguranca.",
      "valorizacao": "MODO VALORIZACAO: aumentar patrimonio. Priorizar jogadores baratos com boa relacao custo-beneficio. Evitar jogadores muito caros. Buscar atletas que desvalorizaram mas continuam titulares.",
      "misto": "MODO MISTO: equilibrar pontuacao e valorizacao. Base segura com bom custo-beneficio + 2-3 jogadores de alto potencial. Capitao com seguranca e teto."
    };

    var prompt =
      "Voce e especialista em Cartola FC. Monte o melhor time para Rodada " + rodada + ".\n\n" +

      "CONFIGURACAO:\n" +
      "- Esquema: " + esquema + " = " + vagasStr + " + 1 TEC = 12 atletas total\n" +
      "- Orcamento maximo: C$ " + orcamento + "\n" +
      "- Estrategia: " + (estrategiaTexto[estrategia] || estrategiaTexto["misto"]) + "\n\n" +

      "REGRAS OBRIGATORIAS:\n" +
      "1. Escalar EXATAMENTE " + vagasStr + " + 1 TEC (total 12 atletas)\n" +
      "2. SEM reserva\n" +
      "3. Cada id deve aparecer uma unica vez\n" +
      "4. Soma dos precos <= C$ " + orcamento + "\n" +
      "5. pos_clube = posicao do clube na tabela (1=lider, alto=lanterna)\n" +
      "6. pos_adv = posicao do adversario (1=forte, alto=fraco)\n" +
      "7. nota = score estrategico calculado (use como base principal)\n\n" +

      "REGRAS DE QUALIDADE:\n" +
      "- NUNCA escale jogador de time lanterna (pos_clube alto) contra time forte (pos_adv baixo)\n" +
      "- Mando casa da vantagem APENAS se times sao equilibrados ou clube da casa e superior\n" +
      "- Max 3 jogadores do mesmo clube (excecao: ate 4 se time muito favorito em casa)\n" +
      "- Evite mais de 4 jogadores no mesmo jogo\n" +
      "- Evite combinar goleiro/zagueiro de um time com atacante adversario no mesmo jogo\n" +
      "- Favorabilidade alta (>2) = confronto excelente; baixa (<0) = confronto ruim\n" +
      "- Risco alto (>2) = cuidado; prefira jogadores com risco <= 1 para a base\n\n" +

      "REGRA DO CAPITAO:\n" +
      "- Pontuacao multiplicada por 1.5x\n" +
      "- Deve ser: provavel titular, confronto favoravel (pos_adv alto = adv fraco), alto teto\n" +
      "- Preferencia: atacante/meia cobrador de penalti ou bola parada\n" +
      "- Evitar: goleiro, zagueiro dependente de SG, jogador visitante azarao\n\n" +

      "GOLEIRO (escolha " + (vagas.GOL||1) + "):\n" + JSON.stringify(top("GOL", 6)) + "\n\n" +
      "LATERAIS (escolha " + (vagas.LAT||2) + "):\n" + JSON.stringify(top("LAT", 8)) + "\n\n" +
      "ZAGUEIROS (escolha " + (vagas.ZAG||2) + "):\n" + JSON.stringify(top("ZAG", 8)) + "\n\n" +
      "MEIAS (escolha " + (vagas.MEI||3) + "):\n" + JSON.stringify(top("MEI", 10)) + "\n\n" +
      "ATACANTES (escolha " + (vagas.ATA||3) + "):\n" + JSON.stringify(top("ATA", 8)) + "\n\n" +
      "TECNICOS (escolha 1):\n" + JSON.stringify(top("TEC", 5)) + "\n\n" +

      "JOGOS RODADA " + rodada + " (pos entre parenteses = posicao tabela):\n" +
      (partidasStr || "nao disponivel") + "\n\n" +

      "RESPONDA APENAS JSON PURO:\n" +
      "{\"time\":[{\"id\":0,\"nome\":\"\",\"posicao\":\"GOL\",\"clube\":\"\",\"preco\":0,\"media\":0,\"pontuacao_esperada\":0,\"mando\":\"\",\"adversario\":\"\",\"dificuldade\":2,\"risco\":\"seguro\",\"titular\":true,\"capitao\":false,\"vice\":false,\"justificativa\":\"\"}]," +
      "\"capitao\":{\"id\":0,\"nome\":\"\",\"motivo\":\"\",\"pts_normal\":0,\"pts_capitao\":0}," +
      "\"vice_capitao\":{\"id\":0,\"nome\":\"\"}," +
      "\"custo_total\":0,\"pontuacao_esperada\":0," +
      "\"perfil\":\"equilibrada\"," +
      "\"analise\":\"\",\"alertas\":[],\"oportunidades\":[]}";

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
      if (match) { try { escalacao = JSON.parse(match[0]); } catch(e2) { throw new Error("JSON invalido"); } }
      else throw new Error("Sem JSON na resposta");
    }

    if (escalacao.time) {
      const idsVistos = new Set();
      escalacao.time = escalacao.time.filter(function(t) {
        if (idsVistos.has(t.id)) return false;
        idsVistos.add(t.id);
        return true;
      });
      escalacao.time = escalacao.time.map(function(t) {
        const orig = atletas.find(function(a){ return a.id === t.id; });
        return Object.assign({}, t, {
          foto: orig ? orig.foto : null,
          escudo: orig ? orig.escudo : null,
          adversario_escudo: orig ? orig.adversario_escudo : null,
          mando: orig ? orig.mando : (t.mando || "?"),
          adversario: orig ? orig.adversario : (t.adversario || "?"),
          dificuldade: orig ? orig.dificuldade : (t.dificuldade || 3),
          variacao: orig ? orig.variacao : 0,
          jogos: orig ? orig.jogos : 0,
          nota_estrategica: orig ? orig.nota_estrategica : null,
        });
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, escalacao: escalacao }) };
  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
exports.handler = handler;
