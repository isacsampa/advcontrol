require('dotenv').config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function run() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.models) {
      console.log("SUPPORTED MODELS FOR GENERATECONTENT:");
      data.models.forEach(m => {
        if (m.supportedGenerationMethods.includes('generateContent')) {
          console.log(`- ${m.name} (${m.displayName})`);
        }
      });
    } else {
      console.log("No models returned:", data);
    }
  } catch (err) {
    console.error("ERROR listing models:", err);
  }
}

run();
