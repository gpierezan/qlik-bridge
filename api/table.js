const enigma = require('enigma.js');
const schema = require('enigma.js/schemas/12.612.0.json');
const WebSocket = require('ws');

// Variáveis de ambiente (configuradas no painel da Vercel)
const TENANT = process.env.QLIK_TENANT;       // ex: mpx.us.qlikcloud.com
const API_KEY = process.env.QLIK_API_KEY;     // chave de API gerada no Qlik
const MAKE_TOKEN = process.env.MAKE_TOKEN;    // senha que você inventa para proteger este endereço
const DEFAULT_APP_ID = process.env.APP_ID;    // opcional
const DEFAULT_OBJECT_ID = process.env.OBJECT_ID; // opcional

// Limpa nomes de coluna vindos como expressão crua do Qlik
function cleanHeader(raw, i, used) {
  let s = String(raw == null ? '' : raw);
  s = s.split(/[\r\n]/)[0];        // só a primeira linha
  s = s.replace(/\s*\/\/.*$/, '');   // remove comentário //
  s = s.trim();
  if (!s) s = `coluna_${i + 1}`;
  let name = s;
  let n = 2;
  while (used.has(name)) name = `${s}_${n++}`;
  used.add(name);
  return name;
}

module.exports = async (req, res) => {
  // 1. Proteção: só quem tem a senha entra
  const token = req.headers['x-token'] || req.query.token;
  if (!MAKE_TOKEN || token !== MAKE_TOKEN) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const appId = req.query.appId || DEFAULT_APP_ID;
  const objectId = req.query.objectId || DEFAULT_OBJECT_ID;
  if (!appId || !objectId) {
    return res.status(400).json({ error: 'Faltou appId ou objectId' });
  }

  let session;
  try {
    // 2. Abre a conexão com o Qlik usando a chave de API
    session = enigma.create({
      schema,
      createSocket: () =>
        new WebSocket(`wss://${TENANT}/app/${appId}`, {
          headers: { Authorization: `Bearer ${API_KEY}` },
        }),
    });

    const global = await session.open();
    const app = await global.openDoc(appId);

    // MODO LISTA: /api/table?token=...&list=1  mostra as tabelas do app com os IDs reais
    if (req.query.list) {
      const infos = await app.getAllInfos();
      const tableTypes = ['sn-table', 'table', 'pivot-table', 'sn-pivot-table', 'straight-table'];
      const found = [];
      for (const info of infos) {
        if (!tableTypes.includes(info.qType)) continue;
        if (found.length >= 60) break;
        try {
          const o = await app.getObject(info.qId);
          const l = await o.getLayout();
          const hc = l.qHyperCube || {};
          found.push({
            id: info.qId,
            type: info.qType,
            title: l.title || l.qMeta?.title || '',
            colunas: [
              ...(hc.qDimensionInfo || []).map(d => d.qFallbackTitle),
              ...(hc.qMeasureInfo || []).map(m => m.qFallbackTitle),
            ],
            linhas: hc.qSize ? hc.qSize.qcy : null,
          });
        } catch (e) {
          found.push({ id: info.qId, type: info.qType, erro: e.message || 'falha ao ler' });
        }
      }
      return res.status(200).json({
        procurado: objectId,
        total_objetos_no_app: infos.length,
        tabelas: found,
      });
    }

    const obj = await app.getObject(objectId);
    const layout = await obj.getLayout();

    const hc = layout.qHyperCube;
    if (!hc) {
      return res.status(422).json({ error: 'Este objeto não tem tabela de dados (hypercube)' });
    }

    // 3. Monta os cabeçalhos das colunas
    const dims = hc.qDimensionInfo || [];
    const meas = hc.qMeasureInfo || [];
    const used = new Set();
    const headers = [
      ...dims.map(d => d.qFallbackTitle),
      ...meas.map(m => m.qFallbackTitle),
    ].map((t, i) => cleanHeader(t, i, used));

    // 4. Se a tabela tiver ordem de colunas customizada, respeita
    const order = hc.qEffectiveInterColumnSortOrder || null;
    const cols = hc.qSize.qcx;
    const total = hc.qSize.qcy;

    // 5. Lê os dados em blocos (o Qlik limita 10 mil células por leitura)
    const pageHeight = Math.max(1, Math.floor(10000 / cols));
    const rows = [];

    for (let top = 0; top < total; top += pageHeight) {
      const pages = await obj.getHyperCubeData('/qHyperCubeDef', [
        {
          qTop: top,
          qLeft: 0,
          qWidth: cols,
          qHeight: Math.min(pageHeight, total - top),
        },
      ]);
      for (const row of pages[0].qMatrix) {
        const rec = {};
        row.forEach((cell, i) => {
          rec[headers[i] || `coluna_${i + 1}`] = cell.qText;
          // versão numérica quando existir
          if (cell.qNum !== undefined && !Number.isNaN(cell.qNum)) {
            rec[`${headers[i] || `coluna_${i + 1}`}__num`] = cell.qNum;
          }
        });
        rows.push(rec);
      }
    }

    return res.status(200).json({ count: rows.length, headers, rows });
  } catch (err) {
    return res.status(500).json({
      error: 'Falha ao ler o Qlik',
      detail: err && (err.message || JSON.stringify(err)),
    });
  } finally {
    if (session) {
      try { await session.close(); } catch (e) {}
    }
  }
};
