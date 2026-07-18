/**
 * AdvControl - Webhook Serverless para Vercel (Z-API + Supabase + Gemini 3.5 Flash)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Inicializa o cliente Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://becotkevgluahhisyxrr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_UwT3uRZVQiHqToKlMfiRow_45c85BoQ';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6LIaHB84e2gofarA2d5ROLtHBLxUnBaMaijuiWE-rCWgA';

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || '3F63B567036F020A3F3E1A3C88EF3679';
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || '035A544ACE49F1BAFA81935E';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function getMockCaseAndamentos(caseTitle) {
  const title = (caseTitle || '').toLowerCase();
  
  if (title.includes('trabalhista') || title.includes('reclamacao') || title.includes('demissao')) {
    return [
      "14/07/2026 - Expedida notificação postal de audiência de instrução e julgamento para as partes.",
      "22/06/2026 - Apresentada contestação com documentos sob sigilo pela reclamada.",
      "10/05/2026 - Certidão de decurso de prazo para manifestação sobre cálculos homologatórios.",
      "18/04/2026 - Despacho: intime-se o reclamante para se manifestar sobre a defesa no prazo de 10 dias."
    ].join("\n");
  }

  if (title.includes('alimentos') || title.includes('familia') || title.includes('guarda') || title.includes('divorcio')) {
    return [
      "12/07/2026 - Conclusos para despacho/decisão de fixação de alimentos provisórios e designação de audiência.",
      "30/06/2026 - Juntada de parecer do Ministério Público opinando pela concessão de tutela de alimentos provisórios à menor.",
      "18/06/2026 - Certidão de juntada de comprovante de citação do réu via oficial de justiça."
    ].join("\n");
  }

  return [
    "15/07/2026 - Conclusos para sentença de mérito na secretaria da 4ª Vara Cível.",
    "18/06/2026 - Juntada de petição de Alegações Finais por Memoriais pelo Autor.",
    "05/06/2026 - Decisão: declaro encerrada a fase de instrução processual e concedo prazo para alegações finais."
  ].join("\n");
}

module.exports = async (req, res) => {
  // Apenas aceita requisições do tipo POST (Z-API Webhook)
  if (req.method !== 'POST') {
    return res.status(405).send('Método Não Permitido. Utilize POST.');
  }

  const payload = req.body;
  console.log("PAYLOAD RECEBIDO DO Z-API (Vercel):", JSON.stringify(payload, null, 2));

  // Extrai o telefone de forma flexível
  const senderPhone = payload.phone || (payload.sender && payload.sender.phone);
  if (!senderPhone) {
    return res.status(200).send('Ignorando payload sem número de telefone.');
  }

  // Extrai o texto da mensagem de forma flexível
  let incomingMessage = "";
  if (payload.text && typeof payload.text.message === 'string') {
    incomingMessage = payload.text.message;
  } else if (payload.message && typeof payload.message === 'string') {
    incomingMessage = payload.message;
  } else if (payload.text && typeof payload.text === 'string') {
    incomingMessage = payload.text;
  } else if (payload.text === null || payload.text === undefined) {
    return res.status(200).send('Payload sem texto de mensagem.');
  }

  incomingMessage = incomingMessage.toLowerCase().trim();
  console.log(`Mensagem limpa de ${senderPhone}: "${incomingMessage}"`);

  // Filtra se a mensagem está buscando o processo
  if (!incomingMessage.includes('processo') && !incomingMessage.includes('andamento') && !incomingMessage.includes('como esta')) {
    await sendZapiText(senderPhone, 
      `Olá! Sou o assistente virtual do escritório. ⚖️\n\n` +
      `Para saber o andamento do seu caso atualizado pela nossa IA, basta digitar a palavra *processo* em sua mensagem!`
    );
    return res.status(200).json({ success: true, message: 'Menu enviado.' });
  }

  try {
    const cleanPhoneDigits = senderPhone.replace(/\D/g, '').slice(-8); // últimos 8 dígitos

    const { data: clients, error: clientErr } = await supabase
      .from('clients')
      .select('id, name')
      .ilike('phone', `%${cleanPhoneDigits}%`);

    if (clientErr) throw clientErr;

    if (!clients || clients.length === 0) {
      await sendZapiText(senderPhone, 
        `Desculpe, não encontrei nenhum cliente cadastrado com o número de telefone *${senderPhone}* no nosso sistema. 😔\n\n` +
        `Entre em contato com a nossa recepção para atualizar seu cadastro.`
      );
      return res.status(200).json({ success: true, message: 'Cliente não localizado.' });
    }

    const client = clients[0];

    const { data: cases, error: casesErr } = await supabase
      .from('cases')
      .select('id, title, case_number, status')
      .eq('client_id', client.id);

    if (casesErr) throw casesErr;

    if (!cases || cases.length === 0) {
      await sendZapiText(senderPhone, 
        `Olá, *${client.name}*! Encontrei seu cadastro, mas você ainda não possui nenhum processo ativo associado no nosso sistema.`
      );
      return res.status(200).json({ success: true, message: 'Sem processos cadastrados.' });
    }

    // Processa cada caso com o Gemini
    for (const caseObj of cases) {
      const andamentos = getMockCaseAndamentos(caseObj.title);
      const aiResponse = await callGeminiAI(client.name, caseObj.title, andamentos);

      const responseMessage = 
        `⚖️ *AdvControl - Atualização de Processo*\n\n` +
        `Olá, *${client.name}*!\n` +
        `Aqui está o andamento simplificado do seu caso (*${caseObj.title}*):\n\n` +
        `📌 *Status Simplificado:*\n${aiResponse.status_simplificado}\n\n` +
        `📖 *Doutor IA Explica:*\n${aiResponse.explicacao_juridiquez}\n\n` +
        `🕒 *O que esperar a seguir:*\n${aiResponse.proximos_passos_cliente}`;

      await sendZapiText(senderPhone, responseMessage);
    }

    return res.status(200).json({ success: true, message: 'Andamentos enviados com sucesso.' });

  } catch (error) {
    console.error("Erro no processamento Vercel:", error);
    return res.status(500).json({ error: error.message });
  }
};

async function callGeminiAI(clientName, caseTitle, andamentos) {
  const prompt = `
Você é o assistente virtual inteligente e amigável ("Doutor IA") do escritório AdvControl.
O cliente chamado "${clientName}" pediu o andamento do processo dele de título "${caseTitle}".
O andamento técnico extraído do sistema judicial é o seguinte:
${andamentos}

Você deve responder obrigatoriamente com um objeto JSON contendo exatamente estes 3 campos:
1. "status_simplificado": Resumo de 1 frase.
2. "explicacao_juridiquez": Explicação simples.
3. "proximos_passos_cliente": Expectativa do cliente.

Retorne APENAS o JSON puro. Não inclua blocos markdown na resposta.
`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    })
  });

  if (!response.ok) {
    throw new Error(`Erro na API Gemini: ${response.statusText}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return JSON.parse(text.trim());
}

async function sendZapiText(phone, message) {
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone, message: message })
    });
  } catch (error) {
    console.error(`Erro ao enviar via Z-API:`, error);
  }
}