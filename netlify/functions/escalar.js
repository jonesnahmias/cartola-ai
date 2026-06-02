const handler = async (event, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada" }) };

  try {
    const body = JSON.parse(event.body);
    const { atletas, orcamento = 140, esquema = "4-3-3", rodada, partidas = [] } = body;

    if (!atletas || atletas.length === 0) return { statusCode: 400, headers, body: JSON.stringify({ error: "Nenhum atleta fornecido" }) };

    const por_posicao = {};
    atletas.forEach((a) => {
      if (!por_posicao[a.posicao]) por_posicao[a.posicao] = [];
      por_posicao[a.posicao].push(a);
    });

    const top_atletas = [];
    ["GOL", "LAT", "ZAG", "MEI", "ATA"].forEach((pos) => {
      const lista = (por_posicao[pos] || []).sort((a, b) => b.score_final - a.score_final).slice(0, 15);
      top_atletas.push(...lista);
    });

    // Resumo das partidas para o prompt
    const partidasResumo = partidas.map(p =>
      `${p.mandante_abrev} x ${p.visitante_abrev}${p.data ? " (" + new Date(p.data).toLocaleDateString("pt-BR") + ")" : ""}`
    ).join(", ");

    const prompt = `Você é especialista em Cartola FC (fantasy game do Brasileirão). Monte o melhor time para a Rodada ${rodada || "atual"}.

## Configuração
- Orçamento: C$ ${orcamento}
- Esquema: ${esquema}
- Vagas: 4-3-3 = 1 GOL + 2 LAT + 2 ZAG + 3 MEI + 3 ATA | 4-4-2 = 1 GOL + 2 LAT + 2 ZAG + 4 MEI + 2 ATA | 3-5-2 = 1 GOL + 1 LAT + 3 ZAG + 5 MEI + 2 ATA | 5-3-2 = 1 GOL + 3 LAT + 3 ZAG + 3 MEI + 2 ATA
- Total: 11 titulares + 1 reserva. Soma dos preços <= C$ ${orcamento}

## Jogos da Rodada ${rodada}
${partidasResumo || "Não disponível"}

## Atletas disponíveis (ordenados por score_final = cb_score ajustado por confronto e mando)
${JSON.stringify(top_atletas.map(a => ({
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
  dificuldade: a.dificuldade + "/5",
  cb_score: a.cb_score,
  score_final: a.score_final,
})), null, 2)}

## Critérios de análise
1. **score_final** = melhor indicador geral (já pondera confronto e mando)
2. **Mando "casa"** = vantagem real, prefira jogadores em casa
3. **Dificuldade do adversário** (1=fácil, 5=difícil) — evite atletas com dificuldade 4-5
4. **Variação positiva** = atleta em alta, priorize
5. **Capitão** = maior expectativa de pontuação + confronto favorável
6. **Orçamento**: não precisa gastar tudo, qualidade > quantidade

## Formato da resposta (JSON PURO, sem markdown, sem \`\`\`)
{"time":[{"id":0,"nome":"","posicao":"","clube":"","preco":0,"media":0,"mando":"","adversario":"","dificuldade":"","titular":true,"capitao":false,"vice":false,"justificativa":"texto explicando por que este atleta foi escolhido considerando confronto e forma"}],"capitao":{"id":0,"nome":""},"vice_capitao":{"id":0,"nome":""},"custo_total":0,"pontuacao_esperada":0,"analise":"2-3 parágrafos analisando o time montado, destaques da rodada e estratégia","alertas":["alerta 1","alerta 2"]}`;

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

    if (!response.ok) throw new Error(`Claude API error: ${response.status} — ${await response.text()}`);

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    let escalacao;
    try {
      escalacao = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) escalacao = JSON.parse(match[0]);
      else throw new Error("Resposta da IA não pôde ser parseada como JSON");
    }

    if (escalacao.time) {
      escalacao.time = escalacao.time.map((t) => {
        const original = atletas.find((a) => a.id === t.id);
        return {
          ...t,
          foto: original?.foto || null,
          escudo: original?.escudo || null,
          adversario_escudo: original?.adversario_escudo || null,
          mando: original?.mando || t.mando || "—",
          adversario: original?.adversario || t.adversario || "—",
          dificuldade: original?.dificuldade || null,
          variacao: original?.variacao || 0,
          jogos: original?.jogos || 0,
        };
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, escalacao }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

exports.handler = handler;
