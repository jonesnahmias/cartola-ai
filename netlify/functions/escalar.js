const https = require("https");

function httpPost(hostname, path, headers, body) {
  return new Promise(function(resolve, reject) {
    var data = JSON.stringify(body);
    var options = {
      hostname: hostname,
      port: 443,
      path: path,
      method: "POST",
      headers: Object.assign({}, headers, {
        "Content-Length": Buffer.byteLength(data)
      })
    };
    var req = https.request(options, function(res) {
      var chunks = [];
      res.on("data", function(c) { chunks.push(c); });
      res.on("end", function() {
        var body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body: body });
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

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
    };
    const vagas = vagasMap[esquema] || vagasMap["4-3-3"];
    const vagasStr = Object.entries(vagas).filter(function(e){return e[1]>0;}).map(function(e){return e[1]+" "+e[0];}).join(", ");
    const totalClubes = atletas.length > 0 && atletas[0].total_clubes ? atletas[0].total_clubes : 20;

    const posTabela = {};
    Object.keys(clubes).forEach(function(id) {
      if (clubes[id] && clubes[id].ranking && clubes[id].abrev) {
        posTabela[clubes[id].abrev] = totalClubes - clubes[id].ranking + 1;
      }
    });

    const partidasStr = partidas.map(function(p) {
      var pm = posTabela[p.mandante_abrev] ? p.mandante_abrev+"("+posTabela[p.mandante_abrev]+")" : p.mandante_abrev;
      var pv = posTabela[p.visitante_abrev] ? p.visitante_abrev+"("+posTabela[p.visitante_abrev]+")" : p.visitante_abrev;
      return pm + " x " + pv;
    }).join(", ");

    // Calcular nota estrategica
    var atletasComNota = atletas.map(function(a) {
      var posC = a.total_clubes - a.ranking_clube + 1;
      var posA = a.total_clubes - a.forca_adversario + 1;
      var diff = posA - posC;
      var favorabilidade = (a.mando === "casa" ? 2 : 0) +
        (diff >= 8 ? 3 : diff >= 4 ? 2 : diff >= 0 ? 1 : diff >= -4 ? -1 : diff >= -8 ? -2 : -3);
      var regularidade = a.media > 0 ? Math.min(10, a.media * 0.8 + (a.variacao > 0 ? 1 : -0.5)) : 0;
      var cb = a.preco > 0 ? a.media / a.preco : 0;
      var risco = (a.mando === "fora" ? 1 : 0) + (posA <= 3 ? 2 : 0) + (a.dificuldade >= 4 ? 1 : 0);
      var nota = (a.media * 0.35) + (regularidade * 0.15) + (favorabilidade * 0.15) + (cb * 10 * 0.10) - (risco * 0.5);
      return Object.assign({}, a, { nota: parseFloat(nota.toFixed(3)), favorabilidade: favorabilidade, risco: risco, posC: posC, posA: posA });
    });

    var por_posicao = {};
    atletasComNota.forEach(function(a) {
      if (!por_posicao[a.posicao]) por_posicao[a.posicao] = [];
      por_posicao[a.posicao].push(a);
    });

    var top = function(pos, n) {
      return (por_posicao[pos] || [])
        .sort(function(a,b){return (b.nota||0)-(a.nota||0);})
        .slice(0, n)
        .map(function(a){
          return { id:a.id, nome:a.nome, clube:a.clube_abrev,
            pos_clube:a.posC, pos_adv:a.posA,
            preco:a.preco, media:a.media, var:a.variacao,
            mando:a.mando, adv:a.adversario, dif:a.dificuldade,
            fav:a.favorabilidade, risco:a.risco, nota:a.nota,
            cb:parseFloat((a.preco>0?a.media/a.preco:0).toFixed(3)) };
        });
    };

    var modos = {
      "pontuacao": "MODO PONTUACAO: maximize pontos. Priorize alto teto, aceite caros se candidatos a mitar.",
      "valorizacao": "MODO VALORIZACAO: maximize valorizacao. Priorize custo-beneficio alto, evite caros.",
      "misto": "MODO MISTO: equilibre pontuacao e valorizacao. Base segura + 2-3 de alto potencial."
    };

    var prompt =
      "Especialista Cartola FC. Monte o melhor time Rodada " + rodada + ".\n\n" +
      "ESQUEMA: " + esquema + " = " + vagasStr + " + 1 TEC = 12 atletas\n" +
      "ORCAMENTO: C$ " + orcamento + "\n" +
      "ESTRATEGIA: " + (modos[estrategia] || modos["misto"]) + "\n\n" +
      "REGRAS:\n" +
      "- Exatamente " + vagasStr + " + 1 TEC, sem reserva\n" +
      "- IDs unicos, soma precos <= C$ " + orcamento + "\n" +
      "- pos_clube=posicao na tabela (1=lider, alto=lanterna)\n" +
      "- pos_adv=posicao adversario\n" +
      "- nota=score estrategico (use como base)\n" +
      "- fav>2: confronto otimo | fav<0: confronto ruim\n" +
      "- EVITE time lanterna (pos_clube alto) vs time forte (pos_adv baixo)\n" +
      "- Max 3 jogadores mesmo clube\n" +
      "- Capitao: alto teto + confronto favoravel + provavel titular\n\n" +
      "JOGOS: " + (partidasStr||"N/A") + "\n\n" +
      "GOLEIROS:\n" + JSON.stringify(top("GOL",6)) + "\n\n" +
      "LATERAIS:\n" + JSON.stringify(top("LAT",8)) + "\n\n" +
      "ZAGUEIROS:\n" + JSON.stringify(top("ZAG",8)) + "\n\n" +
      "MEIAS:\n" + JSON.stringify(top("MEI",10)) + "\n\n" +
      "ATACANTES:\n" + JSON.stringify(top("ATA",8)) + "\n\n" +
      "TECNICOS:\n" + JSON.stringify(top("TEC",5)) + "\n\n" +
      "RESPONDA JSON PURO:\n" +
      "{\"time\":[{\"id\":0,\"nome\":\"\",\"posicao\":\"GOL\",\"clube\":\"\",\"preco\":0,\"media\":0,\"pontuacao_esperada\":0,\"mando\":\"\",\"adversario\":\"\",\"dificuldade\":2,\"risco\":\"seguro\",\"titular\":true,\"capitao\":false,\"vice\":false,\"justificativa\":\"\"}],\"capitao\":{\"id\":0,\"nome\":\"\",\"motivo\":\"\",\"pts_capitao\":0},\"vice_capitao\":{\"id\":0,\"nome\":\"\"},\"custo_total\":0,\"pontuacao_esperada\":0,\"perfil\":\"equilibrada\",\"analise\":\"\",\"alertas\":[],\"oportunidades\":[]}";

    var res = await httpPost("api.anthropic.com", "/v1/messages", {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    }, {
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    if (res.status !== 200) throw new Error("Claude API error: " + res.status + " " + res.body.slice(0,200));

    var data = JSON.parse(res.body);
    var text = (data.content && data.content[0]) ? data.content[0].text : "";
    var clean = text.replace(/```json/g, "").replace(/```/g, "").trim();

    var escalacao;
    try { escalacao = JSON.parse(clean); }
    catch(e) {
      var match = clean.match(/\{[\s\S]*\}/);
      if (match) { try { escalacao = JSON.parse(match[0]); } catch(e2) { throw new Error("JSON invalido"); } }
      else throw new Error("Sem JSON: " + clean.slice(0,200));
    }

    if (escalacao.time) {
      var seen = new Set();
      escalacao.time = escalacao.time.filter(function(t) {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      }).map(function(t) {
        var orig = atletas.find(function(a){ return a.id === t.id; });
        return Object.assign({}, t, {
          foto: orig ? orig.foto : null,
          escudo: orig ? orig.escudo : null,
          adversario_escudo: orig ? orig.adversario_escudo : null,
          mando: orig ? orig.mando : (t.mando||"?"),
          adversario: orig ? orig.adversario : (t.adversario||"?"),
          dificuldade: orig ? orig.dificuldade : (t.dificuldade||3),
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
