/**
 * AdvControl - Webhook de Integração Z-API + Supabase + Gemini 3.5 Flash
 * 
 * Este script roda um servidor local (Node.js + Express) que ouve as mensagens
 * recebidas no Z-API, busca o cliente no Supabase pelo número de telefone,
 * traduz o andamento processual com a IA do Gemini e envia de volta ao WhatsApp.
 */

// Carrega variáveis do arquivo .env se estiver rodando localmente
require('dotenv').config();

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// =========================================================================
// CONFIGURAÇÕES (Variáveis de Ambiente / Fallback Local)
// =========================================================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://becotkevgluahhisyxrr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_UwT3uRZVQiHqToKlMfiRow_45c85BoQ';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6LIaHB84e2gofarA2d5ROLtHBLxUnBaMaijuiWE-rCWgA';

// Credenciais da sua instância no Z-API
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || '3F63B567036F020A3F3E1A3C88EF3679';
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || '035A544ACE49F1BAFA81935E';
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || 'SEU_CLIENT_TOKEN_ZAPI'; // (Opcional)

// Inicializa cliente do Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// =========================================================================
// HISTÓRICOS SIMULADOS DE ANDAMENTO JUDICIAL
// =========================================================================
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

// =========================================================================
// ROTA WEBHOOK: Recebe eventos do Z-API
// =========================================================================
app.post('/webhook-zapi', async (req, res) => {
  const payload = req.body;

  // Log do payload para diagnóstico fácil
  console.log("PAYLOAD RECEBIDO DO Z-API:", JSON.stringify(payload, null, 2));

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
    // Caso de payload sem texto
    return res.status(200).send('Payload sem texto de mensagem.');
  }

  incomingMessage = incomingMessage.toLowerCase().trim();
  console.log(`Mensagem limpa recebida de ${senderPhone}: "${incomingMessage}"`);

  // Detecta se o cliente está perguntando pelo processo
  if (!incomingMessage.includes('processo') && !incomingMessage.includes('andamento') && !incomingMessage.includes('como esta')) {
    // Menu de Ajuda Simples se não souber o que responder
    await sendZapiText(senderPhone, 
      `Olá! Sou o assistente virtual do escritório. ⚖️\n\n` +
      `Para saber o andamento do seu caso atualizado pela nossa IA, basta digitar a palavra *processo* em sua mensagem!`
    );
    return res.status(200).send('Menu de ajuda enviado.');
  }

  try {
    // 1. Busca o cliente no Supabase pelo número de telefone
    // Dica de ouro: limpamos os dígitos para evitar incompatibilidades de DDI (+55) ou nono dígito
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
      return res.status(200).send('Cliente não localizado.');
    }

    const client = clients[0];

    // 2. Busca os processos ativos do cliente no Supabase
    const { data: cases, error: casesErr } = await supabase
      .from('cases')
      .select('id, title, case_number, status')
      .eq('client_id', client.id);

    if (casesErr) throw casesErr;

    if (!cases || cases.length === 0) {
      await sendZapiText(senderPhone,
        `Olá, *${client.name}*! Encontrei seu cadastro, mas você ainda não possui nenhum processo ativo associado no nosso sistema.`
      );
      return res.status(200).send('Cliente sem processos.');
    }

    // 3. Processa o andamento de cada processo do cliente
    for (const caseObj of cases) {
      const andamentos = getMockCaseAndamentos(caseObj.title);

      // 4. Pergunta ao Gemini 3.5 Flash para traduzir o andamento
      const aiResponse = await callGeminiAI(client.name, caseObj.title, andamentos);

      // 5. Envia a resposta de volta ao WhatsApp do cliente
      const responseMessage =
        `⚖️ *AdvControl - Atualização de Processo*\n\n` +
        `Olá, *${client.name}*!\n` +
        `Aqui está o andamento simplificado do seu caso (*${caseObj.title}*):\n\n` +
        `📌 *Status Simplificado:*\n${aiResponse.status_simplificado}\n\n` +
        `📖 *Doutor IA Explica (Linguagem Simples):*\n${aiResponse.explicacao_juridiquez}\n\n` +
        `🕒 *O que esperar a seguir:*\n${aiResponse.proximos_passos_cliente}`;

      await sendZapiText(senderPhone, responseMessage);
    }

    return res.status(200).send('Andamento enviado com sucesso.');

  } catch (error) {
    console.error("Erro interno no Webhook:", error);
    return res.status(500).send('Erro interno do servidor.');
  }
});

// =========================================================================
// FUNÇÃO: INTEGRAÇÃO DIRETA COM GOOGLE GEMINI 3.5 FLASH
// =========================================================================
async function callGeminiAI(clientName, caseTitle, andamentos) {
  const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

  const prompt = `
Você é o assistente virtual inteligente e amigável ("Doutor IA") do escritório AdvControl.
O cliente chamado "${clientName}" pediu o andamento do processo dele de título "${caseTitle}".
O andamento técnico extraído do sistema judicial é o seguinte:
${andamentos}

Você deve obrigatoriamente responder com um objeto JSON estruturado contendo exatamente estes 3 campos:
1. "status_simplificado": Resumo de 1 frase direta e amigável da situação.
2. "explicacao_juridiquez": Uma explicação calma e simples sobre o que aconteceu nas últimas movimentações judiciais sem jargões difíceis.
3. "proximos_passos_cliente": O que o cliente deve esperar ou fazer nas próximas semanas.

Retorne APENAS o JSON puro. Não inclua blocos markdown (como \`\`\`json) na resposta.
`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
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
  let cleanText = text.trim();
  if (cleanText.startsWith('```')) {
    cleanText = cleanText.replace(/^```(?:json|text)?\n?/i, '').replace(/\n?```$/i, '');
  }
  cleanText = cleanText.trim();

  const startIdx = cleanText.indexOf('{');
  const endIdx = cleanText.lastIndexOf('}');
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    cleanText = cleanText.slice(startIdx, endIdx + 1);
  }

  return JSON.parse(cleanText);
}

// =========================================================================
// FUNÇÃO: ENVIA MENSAGEM DE TEXTO VIA Z-API
// =========================================================================
async function sendZapiText(phone, message) {
  const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        phone: phone,
        message: message
      })
    });

    const data = await response.json();
    console.log(`Resposta Z-API para ${phone}:`, data);
  } catch (error) {
    console.error(`Erro ao enviar mensagem via Z-API para ${phone}:`, error);
  }
}

// Inicializa o servidor na porta 5000 (ou qualquer porta configurável)
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Webhook do AdvControl rodando com sucesso na porta ${PORT}!`);
  console.log(`Configure a URL de Webhook no painel da Z-API para: http://SEU_IP_OU_DOMINIO/webhook-zapi`);
});