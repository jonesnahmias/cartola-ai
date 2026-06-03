const https = require("https");

function callClaude(apiKey, prompt) {
  return new Promise(function(resolve, reject) {
    var payload = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }]
    });
    var options = {
      hostname: "api.anthropic.com",
      port: 443,
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(payload)
      }
    };
    var req = https.request(options, function(res) {
      var chunks = [];
      res.on("data", function(c) { chunks.push(c); });
      res.on("end", function() {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "API key nao configurada" }) };

  try {
    const body = JSON.parse(event.body);
    const atletas = body.atletas || [];
    const orcamento = body.orcamento || 140;
    const esquema = body.esquema || "4-3-3";
    const rodada = body.rodada || "atual";
    const partidas = body.partidas || [];
    const clubes = body.clubes || {};
    const estrategia = body.estrategia || "misto";
    if (!atletas.length) return { statusCode: 400, headers, body: JSON.stringify({ error: "Sem atletas" }) };

    const vagasMap = {
      "4-3-3":{GOL:1,LAT:2,ZAG:2,MEI:3,ATA:3},
      "4-4-2":{GOL:1,LAT:2,ZAG:2,MEI:4,ATA:2},
      "3-5-2":{GOL:1,LAT:1,ZAG:3,MEI:5,ATA:2},
      "5-3-2":{GOL:1,LAT:3,ZAG:3,MEI:3,ATA:2},
    };
    const vagas = vagasMap[esquema] || vagasMap["4-3-3"];
    const totalClubes = (atletas[0] && atletas[0].total_clubes) || 20;

    const posTab = {};
    Object.keys(clubes).forEach(function(id) {
      if (clubes[id] && clubes[id].abrev && clubes[id].ranking)
        posTab[clubes[id].abrev] = totalClubes - clubes[id].ranking + 1;
    });

    // Calcular nota e selecionar TOP 5 por posicao
    const por_pos = {};
    atletas.forEach(function(a) {
      var posC = a.total_clubes - a.ranking_clube + 1;
      var posA = a.total_clubes - a.forca_adversario + 1;
      var fav = (a.mando==="casa"?2:0) + (posA-posC>=6?3:posA-posC>=2?2:posA-posC>=-2?1:-1);
      var cb = a.preco>0 ? a.media/a.preco : 0;
      var nota = a.media*0.4 + fav*0.25 + cb*6*0.15 - (a.dificuldade>=4?1:0)*0.5;
      if (!por_pos[a.posicao]) por_pos[a.posicao] = [];
      por_pos[a.posicao].push({id:a.id,n:a.nome,cl:a.clube_abrev,pc:posC,pa:posA,pr:a.preco,md:parseFloat(a.media.toFixed(1)),mn:a.mando==="casa"?"H":"F",nt:parseFloat(nota.toFixed(1))});
    });
    ["GOL","LAT","ZAG","MEI","ATA","TEC"].forEach(function(pos) {
      if (por_pos[pos]) por_pos[pos].sort(function(a,b){return b.nt-a.nt;}).splice(5);
    });

    var jogos = partidas.slice(0,10).map(function(p) {
      return (posTab[p.mandante_abrev]?p.mandante_abrev+"("+posTab[p.mandante_abrev]+")":p.mandante_abrev)+" x "+(posTab[p.visitante_abrev]?p.visitante_abrev+"("+posTab[p.visitante_abrev]+")":p.visitante_abrev);
    }).join("|");

    var vagStr = Object.entries(vagas).map(function(e){return e[1]+e[0];}).join("+");
    var modo = estrategia==="pontuacao"?"pts":estrategia==="valorizacao"?"val":"mix";
    var tmpl = '{"time":[{"id":0,"nome":"","posicao":"","clube":"","preco":0,"media":0,"mando":"","adversario":"","dificuldade":2,"capitao":false,"vice":false,"justificativa":""}],"capitao":{"id":0,"nome":"","pts_capitao":0},"vice_capitao":{"id":0,"nome":""},"custo_total":0,"pontuacao_esperada":0,"perfil":"","analise":"","alertas":[],"oportunidades":[]}';

    var prompt = "CartolaCup R"+rodada+"|"+esquema+"="+vagStr+"+TEC=12|C$<="+orcamento+"|"+modo+"\n" +
      "Jogos:"+jogos+"\n" +
      "Rules:max3/club,noRepeatId,cap=highMd+highPa,avoidHighPcVsLowPa\n" +
      "GOL"+vagas.GOL+":"+JSON.stringify(por_pos.GOL||[])+" " +
      "LAT"+vagas.LAT+":"+JSON.stringify(por_pos.LAT||[])+" " +
      "ZAG"+vagas.ZAG+":"+JSON.stringify(por_pos.ZAG||[])+" " +
      "MEI"+vagas.MEI+":"+JSON.stringify(por_pos.MEI||[])+" " +
      "ATA"+vagas.ATA+":"+JSON.stringify(por_pos.ATA||[])+" " +
      "TEC1:"+JSON.stringify(por_pos.TEC||[]) + "\n" +
      "JSON ONLY NO MARKDOWN:\n" + tmpl;

    const res = await callClaude(KEY, prompt);
    if (res.status !== 200) throw new Error("Claude " + res.status + ": " + res.body.slice(0,100));

    const data = JSON.parse(res.body);
    const text = data.content && data.content[0] ? data.content[0].text : "";
    const clean = text.replace(/```json/g,"").replace(/```/g,"").trim();

    let esc;
    try { esc = JSON.parse(clean); }
    catch(e) {
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) esc = JSON.parse(m[0]);
      else throw new Error("JSON invalido");
    }

    if (esc.time) {
      const seen = new Set();
      esc.time = esc.time
        .filter(function(t){ if(seen.has(t.id))return false; seen.add(t.id); return true; })
        .map(function(t){
          const o = atletas.find(function(a){return a.id===t.id;});
          return Object.assign({},t,{
            foto:o?o.foto:null, escudo:o?o.escudo:null,
            adversario_escudo:o?o.adversario_escudo:null,
            mando:o?o.mando:(t.mando||"?"),
            adversario:o?o.adversario:(t.adversario||"?"),
            dificuldade:o?o.dificuldade:(t.dificuldade||3),
            variacao:o?o.variacao:0, jogos:o?o.jogos:0,
          });
        });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, escalacao: esc }) };
  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
exports.handler = handler;
