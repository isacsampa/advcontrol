/**
 * AdvControl - Servidor Proxy de IA do Gemini para Vercel
 * Evita vazamento de chaves de API no frontend e contorna restrições CORS.
 */
require('dotenv').config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6LIaHB84e2gofarA2d5ROLtHBLxUnBaMaijuiWE-rCWgA';

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

  const { prompt, mimeType, base64Data, responseJson } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Parâmetro prompt é obrigatório.' });
  }

  try {
    const model = "gemini-1.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

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
