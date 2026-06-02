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

    if (!atletas.length) return { statusCode: 400, headers, body: JSON.stringify({ error: "Nenhum atleta fornecido" }) };

    // Separar top 15 por posicao ordenado por score_final
    const por_posicao = {};
    atletas.forEach(function(a) {
      if (!por_posicao[a.posicao]) por_posicao[a.posicao] = [];
      por_posicao[a.posicao].push(a);
    });

    const top_atletas = [];
    ["GOL","LAT","ZAG","MEI","ATA"].forEach(function(pos) {
      const lista = (por_posicao[pos] || [])
        .sort(function(a,b){ return (b.score_final||0) - (a.score_final||0); })
        .slice(0, 15);
      lista.forEach(function(a){ top_atletas.push(a); });
    });

    // Resumo das partidas
    const partidasStr = partidas.map(function(p){
      return (p.mandante_abrev || "?") + " x " + (p.visitante_abrev || "?");
    }).join(", ");

    // Vagas por esquema
    const vagas = {
      "4-3-3": "1 GOL, 2 LAT, 2 ZAG, 3 MEI, 3 ATA",
      "4-4-2": "1 GOL, 2 LAT, 2 ZAG, 4 MEI, 2 ATA",
      "3-5-2": "1 GOL, 1 LAT, 3 ZAG, 5 MEI, 2 ATA",
      "5-3-2": "1 GOL, 3 LAT, 3 ZAG, 3 MEI, 2 ATA",
    };

    const atletasParaPrompt = top_atletas.map(function(a){
      return {
        id: a.id,
        nome: a.nome,
        pos: a.posicao,
        clube: a.clube_abrev,
        preco: a.preco,
        media: a.media,
        variacao: a.variacao,
        jogos: a.jogos,
        mando: a.mando,
        adversario: a.adversario,
        dificuldade: (a.dificuldade||3) + "/5",
        score: a.score_final
      };
    });

    const prompt = "Voce e especialista em Cartola FC. Monte o melhor time para a Rodada " + rodada + ".\n\n" +
      "Orcamento: C$ " + orcamento + " | Esquema: " + esquema + " | Vagas: " + (vagas[esquema] || vagas["4-3-3"]) + "\n" +
      "Monte 11 titulares + 1 reserva. Soma dos precos <= C$ " + orcamento + "\n\n" +
      "Jogos da rodada: " + (partidasStr || "nao disponivel") + "\n\n" +
      "Criterios: 1) score alto = melhor custo-beneficio ajustado por confronto. 2) Prefira mando=casa. 3) Dificuldade 1-2 = adversario fraco (bom). 4) Variacao positiva = atleta em alta. 5) Capitao = maior expectativa de pontos.\n\n" +
      "Atletas disponiveis:\n" + JSON.stringify(atletasParaPrompt) + "\n\n" +
      "RESPONDA APENAS COM JSON PURO SEM MARKDOWN:\n" +
      '{"time":[{"id":0,"nome":"","posicao":"","clube":"","preco":0,"media":0,"mando":"","adversario":"","dificuldade":"","titular":true,"capitao":false,"vice":false,"justificativa":""}],"capitao":{"id":0,"nome":""},"vice_capitao":{"id":0,"nome":""},"custo_total":0,"pontuacao_esperada":0,"analise":"","alertas":[]}';

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

    if (!response.ok) {
      const errText = await response.text();
      throw new Error("Claude API error: " + response.status + " - " + errText);
    }

    const data = await response.json();
    const text = (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : "";

    // Parse robusto do JSON
    let escalacao;
    const clean = text.replace(/```json/g,"").replace(/```/g,"").trim();
    try {
      escalacao = JSON.parse(clean);
    } catch(e1) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        try { escalacao = JSON.parse(match[0]); }
        catch(e2) { throw new Error("JSON invalido: " + e2.message + " | texto: " + clean.substring(0,200)); }
      } else {
        throw new Error("Nenhum JSON encontrado na resposta: " + clean.substring(0,200));
      }
    }

    // Enriquecer com dados originais
    if (escalacao.time) {
      escalacao.time = escalacao.time.map(function(t) {
        const orig = atletas.find(function(a){ return a.id === t.id; });
        return Object.assign({}, t, {
          foto: orig ? orig.foto : null,
          escudo: orig ? orig.escudo : null,
          adversario_escudo: orig ? orig.adversario_escudo : null,
          mando: (orig && orig.mando) ? orig.mando : (t.mando || "—"),
          adversario: (orig && orig.adversario) ? orig.adversario : (t.adversario || "—"),
          dificuldade: orig ? orig.dificuldade : null,
          variacao: orig ? orig.variacao : 0,
          jogos: orig ? orig.jogos : 0,
        });
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, escalacao: escalacao }) };

  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

exports.handler = handler;
