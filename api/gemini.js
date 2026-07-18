/**
 * AdvControl - Servidor Proxy de IA do Gemini para Vercel
 * Evita vazamento de chaves de API no frontend e contorna restrições CORS.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://becotkevgluahhisyxrr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_UwT3uRZVQiHqToKlMfiRow_45c85BoQ';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6LIaHB84e2gofarA2d5ROLtHBLxUnBaMaijuiWE-rCWgA';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

module.exports = async (req, res) => {
  // Configura CORS
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

  const { prompt, mimeType, base64Data, responseJson, tenantId } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Parâmetro prompt é obrigatório.' });
  }

  // Tenta ler chave de API customizada do Supabase
  let activeApiKey = GEMINI_API_KEY;
  if (tenantId) {
    try {
      const { data, error } = await supabase
        .from('tenant_settings')
        .select('gemini_api_key')
        .eq('tenant_id', tenantId)
        .maybeSingle();

      if (data && data.gemini_api_key) {
        activeApiKey = data.gemini_api_key;
        console.log(`Chave customizada do Gemini carregada para o tenant: ${tenantId}`);
      }
    } catch (e) {
      console.warn("Coluna gemini_api_key não encontrada ou erro na consulta do Supabase:", e.message);
    }
  }

  try {
    const model = "gemini-3.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${activeApiKey}`;

    let parts = [{ text: prompt }];

    // Se houver dados multimodais anexados (imagens, PDFs, etc.)
    if (mimeType && base64Data) {
      parts.push({
        inlineData: {
          mimeType: mimeType,
          data: base64Data
        }
      });
    }

    const requestBody = {
      contents: [{ parts }]
    };

    if (responseJson) {
      requestBody.generationConfig = {
        responseMimeType: "application/json"
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Erro na API do Gemini: ${response.statusText} - ${errText}`);
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (error) {
    console.error("Erro no proxy do Gemini:", error);
    return res.status(500).json({ error: error.message });
  }
};
