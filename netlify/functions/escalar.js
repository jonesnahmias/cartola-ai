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

    const vagasMap = {
      "4-3-3": { "GOL": 1, "LAT": 2, "ZAG": 2, "MEI": 3, "ATA": 3 },
      "4-4-2": { "GOL": 1, "LAT": 2, "ZAG": 2, "MEI": 4, "ATA": 2 },
      "3-5-2": { "GOL": 1, "LAT": 1, "ZAG": 3, "MEI": 5, "ATA": 2 },
      "5-3-2": { "GOL": 1, "LAT": 3, "ZAG": 3, "MEI": 3, "ATA": 2 },
    };
    const vagas = vagasMap[esquema] || vagasMap["4-3-3"];
    const vagasStr = Object.entries(vagas).map(function(e){ return e[1] + " " + e[0]; }).join(", ");

    const totalClubes = atletas.length > 0 && atletas[0].total_clubes ? atletas[0].total_clubes : 20;
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

    const fmt = function(a) {
      const posC = a.total_clubes - a.ranking_clube + 1;
      const posA = a.total_clubes - a.forca_adversario + 1;
      return { id: a.id, nome: a.nome, clube: a.clube_abrev,
        tab_clube: posC, tab_adv: posA,
        preco: a.preco, media: a.media, var: a.variacao,
        mando: a.mando, adv: a.adversario,
        dif: a.dificuldade, score: a.score_final };
    };

    const top = function(pos, n) {
      return (por_posicao[pos] || []).sort(function(a,b){return (b.score_final||0)-(a.score_final||0);}).slice(0,n).map(fmt);
    };

    const prompt =
      "Especialista em Cartola FC. Monte o melhor time Rodada " + rodada + ".\n\n" +
      "ESQUEMA " + esquema + ": " + vagasStr + " + 1 TEC = 12 atletas total\n" +
      "ORCAMENTO: C$ " + orcamento + "\n\n" +
      "REGRAS:\n" +
      "- 12 atletas: " + vagasStr + " + 1 TEC\n" +
      "- SEM reserva\n" +
      "- Cada id unico, sem repeticao\n" +
      "- tab_clube: posicao do clube (1=lider, alto=lanterna)\n" +
      "- tab_adv: posicao adversario (1=forte, alto=fraco)\n" +
      "- Evite tab_clube alto vs tab_adv baixo (time fraco vs time forte)\n" +
      "- Capitao: maior media + confronto favoravel\n\n" +
      "JOGOS: " + (partidasStr || "nao disponivel") + "\n\n" +
      "GOLEIROS:\n" + JSON.stringify(top("GOL", 6)) + "\n\n" +
      "LATERAIS:\n" + JSON.stringify(top("LAT", 8)) + "\n\n" +
      "ZAGUEIROS:\n" + JSON.stringify(top("ZAG", 8)) + "\n\n" +
      "MEIAS:\n" + JSON.stringify(top("MEI", 10)) + "\n\n" +
      "ATACANTES:\n" + JSON.stringify(top("ATA", 8)) + "\n\n" +
      "TECNICOS:\n" + JSON.stringify(top("TEC", 5)) + "\n\n" +
      "JSON puro sem markdown:\n" +
      "{\"time\":[{\"id\":0,\"nome\":\"\",\"posicao\":\"GOL\",\"clube\":\"\",\"preco\":0,\"media\":0,\"mando\":\"\",\"adversario\":\"\",\"dificuldade\":2,\"titular\":true,\"capitao\":false,\"vice\":false,\"justificativa\":\"\"}],\"capitao\":{\"id\":0,\"nome\":\"\"},\"vice_capitao\":{\"id\":0,\"nome\":\"\"},\"custo_total\":0,\"pontuacao_esperada\":0,\"analise\":\"\",\"alertas\":[]}";

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
        });
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, escalacao: escalacao }) };
  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
exports.handler = handler;
