export default async function handler(req, context) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada" }), { status: 500, headers });
  }

  try {
    const body = await req.json();
    const { atletas, orcamento = 140, esquema = "4-3-3", rodada, clubes_adversarios } = body;

    if (!atletas || atletas.length === 0) {
      return new Response(JSON.stringify({ error: "Nenhum atleta fornecido" }), { status: 400, headers });
    }

    // Separar por posição e pegar top atletas para o prompt (limitar tokens)
    const por_posicao = {};
    atletas.forEach((a) => {
      if (!por_posicao[a.posicao]) por_posicao[a.posicao] = [];
      por_posicao[a.posicao].push(a);
    });

    // Top 15 por posição ordenados por cb_score
    const top_atletas = [];
    ["GOL", "LAT", "ZAG", "MEI", "ATA"].forEach((pos) => {
      const lista = (por_posicao[pos] || [])
        .sort((a, b) => b.cb_score - a.cb_score)
        .slice(0, 15);
      top_atletas.push(...lista);
    });

    // Montar prompt estruturado
    const prompt = `Você é um especialista em Cartola FC (fantasy game do Campeonato Brasileiro).
Sua tarefa é montar o melhor time possível para a rodada ${rodada || "atual"}.

## Parâmetros
- Orçamento: C$ ${orcamento}
- Esquema: ${esquema}
- Rodada: ${rodada || "atual"}

## Esquemas e vagas por posição
- 4-3-3: 1 GOL, 2 LAT, 2 ZAG, 3 MEI, 3 ATA
- 4-4-2: 1 GOL, 2 LAT, 2 ZAG, 4 MEI, 2 ATA
- 3-5-2: 1 GOL, 1 LAT, 3 ZAG, 5 MEI, 2 ATA
- 5-3-2: 1 GOL, 3 LAT, 3 ZAG, 3 MEI, 2 ATA

Para o esquema ${esquema}, monte o time completo (11 titulares + 1 reserva de qualquer posição).

## Atletas disponíveis (ordenados por custo-benefício)
${JSON.stringify(top_atletas.map(a => ({
  id: a.id,
  nome: a.nome,
  pos: a.posicao,
  clube: a.clube_abrev,
  preco: a.preco,
  media: a.media,
  variacao: a.variacao,
  cb_score: a.cb_score,
  forma_score: a.forma_score,
})), null, 2)}

## Critérios de análise
1. **Forma recente**: priorize atletas com media alta e variação positiva
2. **Custo-benefício** (cb_score): media / preço — quanto maior, melhor
3. **Orçamento**: a soma dos preços dos 12 atletas NÃO pode ultrapassar C$ ${orcamento}
4. **Capitão**: dobra os pontos — escolha o de maior expectativa de pontuação
5. **Vice-capitão**: substitui o capitão se ele não jogar

## Formato da resposta (JSON PURO, sem markdown)
{
  "time": [
    { "id": 123, "nome": "...", "posicao": "GOL", "clube": "...", "preco": 10.5, "media": 7.2, "titular": true, "capitao": false, "vice": false, "justificativa": "..." },
    ...12 atletas total...
  ],
  "capitao": { "id": 123, "nome": "..." },
  "vice_capitao": { "id": 456, "nome": "..." },
  "custo_total": 138.5,
  "pontuacao_esperada": 82.3,
  "analise": "Texto explicando as escolhas principais, destaques da rodada e riscos (2-3 parágrafos)",
  "alertas": ["alerta 1", "alerta 2"],
  "esquema_visual": "${esquema}"
}`;

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
      const err = await response.text();
      throw new Error(`Claude API error: ${response.status} — ${err}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    // Parse JSON da resposta
    let escalacao;
    try {
      const clean = text.replace(/```json|```/g, "").trim();
      escalacao = JSON.parse(clean);
    } catch {
      // Tentar extrair JSON do texto
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        escalacao = JSON.parse(match[0]);
      } else {
        throw new Error("Resposta da IA não pôde ser parseada como JSON");
      }
    }

    // Enriquecer com dados de foto/escudo dos atletas originais
    if (escalacao.time) {
      escalacao.time = escalacao.time.map((t) => {
        const original = atletas.find((a) => a.id === t.id);
        return { ...t, foto: original?.foto || null, escudo: original?.escudo || null };
      });
    }

    return new Response(JSON.stringify({ ok: true, escalacao }), { status: 200, headers });
  } catch (err) {
    console.error("escalar error:", err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers });
  }
}

export const config = { path: "/api/escalar" };
