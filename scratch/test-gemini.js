const geminiHandler = require('../api/gemini.js');

// Simula req e res da Vercel
const mockReq = {
  method: 'POST',
  body: {
    prompt: 'Olá Gemini, responda apenas a palavra OK se estiver funcionando.'
  }
};

const mockRes = {
  statusCode: 200,
  headers: {},
  setHeader(name, val) {
    this.headers[name] = val;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(data) {
    console.log(`[STATUS ${this.statusCode}] JSON RESPONSE:`, JSON.stringify(data, null, 2));
  },
  end() {
    console.log(`[STATUS ${this.statusCode}] END RESPONSE`);
  }
};

console.log("Executando teste local da API do Gemini...");
geminiHandler(mockReq, mockRes).catch(err => {
  console.error("Erro na execução do handler:", err);
});
