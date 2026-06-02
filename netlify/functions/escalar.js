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
      const lista = (por_posicao[pos] || []).sort(function(a,b){ return (b.score_final||0)-(a.score_final||0); }).slice(0, 15);
      lista.forEach(function(a){ top_atletas.push(a); });
    });

    const totalClubes = top_atletas.length > 0 && top_atletas[0].total_clubes ? top_atletas[0].total_clubes : 20;

    // Montar posicao na tabela de cada clube (1=lider, N=lanterna)
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

    const vagas = {
      "4-3-3": "1 GOL, 2 LAT, 2 ZAG, 3 MEI, 3 ATA",
      "4-4-2": "1 GOL, 2 LAT, 2 ZAG, 4 MEI, 2 ATA",
      "3-5-2": "1 GOL, 1 LAT, 3 ZAG, 5 MEI, 2 ATA",
      "5-3-2": "1 GOL, 3 LAT, 3 ZAG, 3 MEI, 2 ATA",
    };

    const atletasPrompt = top_atletas.map(function(a) {
      const posC = a.total_clubes - a.ranking_clube + 1;
      const posA = a.total_clubes - a.forca_adversario + 1;
      return {
        id: a.id, nome: a.nome, pos: a.posicao, clube: a.clube_abrev,
        pos_tabela_clube: posC, pos_tabela_adv: posA,
        preco: a.preco, media: a.media, variacao: a.variacao, jogos: a.jogos,
        mando: a.mando, adversario: a.adversario,
        dificuldade: a.dificuldade + "/5", score: a.score_final,
      };
    });

    const prompt = "Voce e especialista em Cartola FC. Monte o melhor time para a Rodada " + rodada + ".\n\n" +
      "Orcamento: C$ " + orcamento + " | Esquema: " + esquema + " | Vagas: " + (vagas[esquema] || vagas["4-3-3"]) + "\n" +
      "Monte 11 titulares + 1 reserva. Soma dos precos <= C$ " + orcamento + "\n\n" +
      "JOGOS DA RODADA (numero entre parenteses = posicao na tabela, 1=lider, maior=lanterna):\n" +
      (partidasStr || "nao disponivel") + "\n\n" +
      "REGRAS OBRIGATORIAS:\n" +
      "1. score eh o melhor indicador geral, use como base\n" +
      "2. pos_tabela_clube indica forca do clube. pos_tabela_adv indica forca do adversario\n" +
      "3. NUNCA escale jogador de time lanterna (pos_tabela_clube alto) contra time forte (pos_tabela_adv baixo)\n" +
      "4. Mando casa so ajuda se os times sao equilibrados ou o time da casa e superior\n" +
      "5. Exemplo ruim: clube pos 18 vs adversario pos 2 mesmo em casa = evitar\n" +
      "6. Exemplo bom: clube pos 3 vs adversario pos 15 = otimo confronto\n" +
      "7. Capitao deve ter media alta E confronto favoravel (pos_tabela_adv alta = adversario fraco)\n\n" +
      "Atletas:\n" + JSON.stringify(atletasPrompt) + "\n\n" +
      "RESPONDA SO COM JSON PURO SEM MARKDOWN:\n" +
      "{\"time\":[{\"id\":0,\"nome\":\"\",\"posicao\":\"\",\"clube\":\"\",\"preco\":0,\"media\":0,\"mando\":\"\",\"adversario\":\"\",\"dificuldade\":\"\",\"titular\":true,\"capitao\":false,\"vice\":false,\"justificativa\":\"\"}],\"capitao\":{\"id\":0,\"nome\":\"\"},\"vice_capitao\":{\"id\":0,\"nome\":\"\"},\"custo_total\":0,\"pontuacao_esperada\":0,\"analise\":\"\",\"alertas\":[]}";

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
      else throw new Error("Sem JSON: " + clean.substring(0, 200));
    }

    if (escalacao.time) {
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
