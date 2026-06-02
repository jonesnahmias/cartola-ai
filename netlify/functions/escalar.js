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
      const lista = (por_posicao[pos] || [])
        .sort(function(a,b){ return (b.score_final||0)-(a.score_final||0); })
        .slice(0, 15);
      lista.forEach(function(a){ top_atletas.push(a); });
    });

    
    const totalClubes = top_atletas.length > 0 ? (top_atletas[0].total_clubes || 20) : 20;
    const clubesRanking = {};
    Object.keys(clubes).forEach(function(id) {
      if (clubes[id].ranking) {
        clubesRanking[clubes[id].abrev] = {
          ranking: clubes[id].ranking,
          total: totalClubes,
          posicao_tabela: totalClubes - clubes[id].ranking + 1, 
        };
      }
    });

    
    const partidasStr = partidas.map(function(p) {
      const mRank = clubesRanking[p.mandante_abrev];
      const vRank = clubesRanking[p.visitante_abrev];
      const mPos = mRank ? mRank.posicao_tabela : "?";
      const vPos = vRank ? vRank.posicao_tabela : "?";
      return p.mandante_abrev + "("+mPos+") x " + p.visitante_abrev + "("+vPos+")";
    }).join(", ");

    const vagas = {
      "4-3-3": "1 GOL, 2 LAT, 2 ZAG, 3 MEI, 3 ATA",
      "4-4-2": "1 GOL, 2 LAT, 2 ZAG, 4 MEI, 2 ATA",
      "3-5-2": "1 GOL, 1 LAT, 3 ZAG, 5 MEI, 2 ATA",
      "5-3-2": "1 GOL, 3 LAT, 3 ZAG, 3 MEI, 2 ATA",
    };

    const atletasPrompt = top_atletas.map(function(a) {
      const posClube = a.total_clubes - a.ranking_clube + 1; 
      const posAdv = a.total_clubes - a.forca_adversario + 1;
      return {
        id: a.id,
        nome: a.nome,
        pos: a.posicao,
        clube: a.clube_abrev,
        pos_tabela_clube: posClube + "",  
        preco: a.preco,
        media: a.media,
        variacao: a.variacao,
        jogos: a.jogos,
        mando: a.mando,
        adversario: a.adversario,
        pos_tabela_adv: posAdv + "",      
        dificuldade: a.dificuldade + "/5",
        score_final: a.score_final,
      };
    });

    const prompt =
      "Voce e especialista em Cartola FC. Monte o melhor time para a Rodada " + rodada + ".\n\n" +
      "Orcamento: C$ " + orcamento + " | Esquema: " + esquema + " | Vagas: " + (vagas[esquema]||vagas["4-3-3"]) + "\n" +
      "Monte 11 titulares + 1 reserva. Soma dos precos <= C$ " + orcamento + "\n\n" +
      "JOGOS DA RODADA " + rodada + " (numero entre parenteses = posicao estimada na tabela, 1=lider, maior=lanterna):\n" +
      (partidasStr || "nao disponivel") + "\n\n" +
      "CRITERIOS EM ORDEM DE PRIORIDADE:\n" +
      "1. score_final = melhor indicador geral (ja pondera todos os fatores)\n" +
      "2. FORCA DO CLUBE vs ADVERSARIO: pos_tabela_clube vs pos_tabela_adv eh FUNDAMENTAL\n" +
      "   - Clube lanterna (pos alta) contra lider (pos 1) = confronto PESSIMO, evitar\n" +
      "   - Mesmo jogando em casa, clube fraco contra equipe forte raramente pontua bem\n" +
      "   - Prefira atletas de clubes de medio a alto nivel da tabela\n" +
      "3. Mando CASA da vantagem APENAS se os clubes sao equilibrados ou o time da casa e superior\n" +
      "4. Dificuldade 1-2 = confronto favoravel. Dificuldade 4-5 = evitar mesmo se media alta\n" +
      "5. Variacao positiva = atleta em alta de forma\n" +
      "6. Capitao = maior expectativa real considerando FORCA DO CLUBE + confronto + forma\n\n" +
      "ATENCAO ESPECIAL: NAO escale jogadores de times lanternas contra times fortes mesmo que " +
      "o jogo seja em casa. A posicao na tabela reflete a qualidade real do elenco.\n\n" +
      "Atletas disponiveis (ordenados por score_final):\n" +
      JSON.stringify(atletasPrompt) + "\n\n" +
      "RESPONDA APENAS COM JSON PURO SEM MARKDOWN:\n" +
      "{\"time\":[{\"id\":0,\"nome\":\"\",\"posicao\":\"\",\"clube\":\"\",\"preco\":0,\"media\":0," +
      "\"mando\":\"\",\"adversario\":\"\",\"dificuldade\":\"\",\"titular\":true,\"capitao\":false," +
      "\"vice\":false,\"justificativa\":\"explique considerando forca do clube e do adversario\"}]," +
      "\"capitao\":{\"id\":0,\"nome\":\"\"},\"vice_capitao\":{\"id\":0,\"nome\":\"\"}," +
      "\"custo_total\":0,\"pontuacao_esperada\":0," +
      "\"analise\":\"analise considerando posicao dos clubes na tabela e qualidade dos confrontos\"," +
      "\"alertas\":[]}";

    const response = await fetch("https:
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
    const clean = text.replace(/```json/g,"").replace(/```/g,"").trim();

    let escalacao;
    try { escalacao = JSON.parse(clean); }
    catch(e) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) { try { escalacao = JSON.parse(match[0]); } catch(e2) { throw new Error("JSON invalido: " + e2.message); } }
      else throw new Error("Sem JSON na resposta: " + clean.substring(0,200));
    }

    if (escalacao.time) {
      escalacao.time = escalacao.time.map(function(t) {
        const orig = atletas.find(function(a){ return a.id === t.id; });
        return Object.assign({}, t, {
          foto: orig ? orig.foto : null,
          escudo: orig ? orig.escudo : null,
          adversario_escudo: orig ? orig.adversario_escudo : null,
          mando: orig ? orig.mando : (t.mando || "-"),
          adversario: orig ? orig.adversario : (t.adversario || "-"),
          dificuldade: orig ? orig.dificuldade : null,
          variacao: orig ? orig.variacao : 0,
          jogos: orig ? orig.jogos : 0,
          ranking_clube: orig ? orig.ranking_clube : null,
          forca_adversario: orig ? orig.forca_adversario : null,
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
