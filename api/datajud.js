/**
 * AdvControl - Servidor Proxy de Busca de Processos do Datajud CNJ para Vercel
 */
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método Não Permitido. Utilize POST.' });
  }

  const { numeroProcesso } = req.body;
  if (!numeroProcesso) {
    return res.status(400).json({ error: 'Parâmetro numeroProcesso é obrigatório.' });
  }

  // Limpa caracteres especiais do processo (mantém apenas números)
  const cleanNumber = numeroProcesso.replace(/\D/g, '');
  if (cleanNumber.length !== 20) {
    return res.status(200).json({ success: false, error: 'Número de processo CNJ inválido. Deve possuir 20 dígitos.' });
  }

  // Identifica o tribunal pelo padrão CNJ: NNNNNNN-DD.AAAA.J.TR.OOOO
  // O JTR está nos dígitos nas posições de índice 13 a 15 do número limpo
  const jtr = cleanNumber.substring(13, 16);
  let tribunal = 'tjsp'; // tribunal padrão

  const tribunalMap = {
    '818': 'tjpi',
    '826': 'tjsp',
    '819': 'tjrj',
    '813': 'tjmg',
    '821': 'tjrs',
    '809': 'tjgo',
    '805': 'tjba',
    '806': 'tjce',
    '817': 'tjpe',
    '816': 'tjpr',
    '824': 'tjsc',
    '808': 'tjes',
    '812': 'tjms',
    '811': 'tjmt',
    '815': 'tjpb',
    '820': 'tjrn',
    '801': 'tjac',
    '802': 'tjal',
    '803': 'tjam',
    '804': 'tjap',
    '822': 'tjro',
    '823': 'tjrr',
    '825': 'tjse',
    '827': 'tjto',
    '807': 'tjdft',
    '401': 'trf1',
    '402': 'trf2',
    '403': 'trf3',
    '404': 'trf4',
    '405': 'trf5',
    '406': 'trf6'
  };

  // Se for Justiça do Trabalho (J = 5)
  if (cleanNumber.charAt(13) === '5') {
    const trDigit = cleanNumber.substring(14, 16);
    tribunal = `trt${parseInt(trDigit, 10)}`;
  } else if (tribunalMap[jtr]) {
    tribunal = tribunalMap[jtr];
  }

  const apiKey = 'cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==';
  const url = `https://api-publica.datajud.cnj.jus.br/api_publica_${tribunal}/_search`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `APIKey ${apiKey}`
      },
      body: JSON.stringify({
        query: {
          match: {
            numeroProcesso: cleanNumber
          }
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(200).json({ 
        success: false, 
        error: `Erro na busca do Datajud: ${response.statusText}`, 
        detail: errText 
      });
    }

    const data = await response.json();
    const hits = data.hits?.hits || [];

    if (hits.length === 0) {
      return res.status(200).json({ 
        success: false, 
        error: 'Processo não localizado na base pública do Datajud.' 
      });
    }

    // Processa os movimentos reais
    const source = hits[0]._source;
    const classe = source.classe?.nome || 'Classe não informada';
    const orgaoJulgador = source.orgaoJulgador?.nome || 'Órgão não informado';
    const dataHoraUltimaAtualizacao = source.dataHoraUltimaAtualizacao || '';

    const movimentosRaw = source.movimentos || [];
    // Ordena por data decrescente (mais recentes primeiro)
    const movimentosSorted = movimentosRaw.sort((a, b) => new Date(b.dataHora) - new Date(a.dataHora));

    const movimentos = movimentosSorted.map(mov => {
      const date = new Date(mov.dataHora).toLocaleString('pt-BR');
      const nome = mov.nome || 'Movimentação sem descrição';
      return `${date} - ${nome}`;
    }).slice(0, 15); // limitados a 15 movimentos recentes para não estourar contexto

    return res.status(200).json({
      success: true,
      classe,
      orgaoJulgador,
      dataHoraUltimaAtualizacao,
      movimentos: movimentos.join('\n')
    });

  } catch (error) {
    console.error('Erro na chamada da API Datajud:', error);
    return res.status(200).json({ success: false, error: error.message });
  }
};
