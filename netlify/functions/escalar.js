const handler = async (event, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada" }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { atletas, orcamento = 140, esquema = "4-3-3", rodada } = body;

    if (!atletas || atletas.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Nenhum atleta fornecido" }) };
    }

    const por_posicao = {};
    atletas.forEach((a) => {
      if (!por_posicao[a.posicao]) por_posicao[a.posicao] = [];
      por_posicao[a.posicao].push(a);
    });

    const top_atletas = [];
    ["GOL", "LAT", "ZAG", "MEI", "ATA"].forEach((pos) => {
      const lista = (por_posicao[pos] || []).sort((a, b) => b.cb_score - a.cb_score).slice(0, 15);
      top_atletas.push(...lista);
    });

    const prompt = `Você é especialista em Cartola FC. Monte o melhor time para a rodada ${rodada || "atual"}.

Orçamento: C$ ${orcamento} | Esquema: ${esquema}

Vagas por esquema:
- 4-3-3: 1 GOL, 2 LAT, 2 ZAG, 3 MEI, 3 ATA
- 4-4-2: 1 GOL, 2 LAT, 2 ZAG, 4 MEI, 2 ATA
- 3-5-2: 1 GOL, 1 LAT, 3 ZAG, 5 MEI, 2 ATA
- 5-3-2: 1 GOL, 3 LAT, 3 ZAG, 3 MEI, 2 ATA

Monte 11 titulares + 1 reserva. Soma dos preços <= C$ ${orcamento}.

Atletas disponíveis:
${JSON.stringify(top_atletas.map(a => ({ id: a.id, nome: a.nome, pos: a.posicao, clube: a.clube_abrev, preco: a.preco, media: a.media, variacao: a.variacao, cb_score: a.cb_score })))}

Responda APENAS com JSON puro sem markdown:
{"time":[{"id":0,"nome":"","posicao":"","clube":"","preco":0,"media":0,"titular":true,"capitao":false,"vice":false,"justificativa":""}],"capitao":{"id":0,"nome":""},"vice_capitao":{"id":0,"nome":""},"custo_total":0,"pontuacao_esperada":0,"analise":"","alertas":[]}`;

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

    if (!response.ok) throw new Error(`Claude API error: ${response.status}`);

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    let escalacao;
    try {
      escalacao = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) escalacao = JSON.parse(match[0]);
      else throw new Error("Resposta da IA não pôde ser parseada");
    }

    if (escalacao.time) {
      escalacao.time = escalacao.time.map((t) => {
        const original = atletas.find((a) => a.id === t.id);
        return { ...t, foto: original?.foto || null, escudo: original?.escudo || null };
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, escalacao }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

exports.handler = handler;
